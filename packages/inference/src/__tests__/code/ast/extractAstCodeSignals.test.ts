/**
 * extractAstCodeSignals 통합 테스트 (Phase 2)
 * PGlite 인메모리 DB + 임시 파일 시스템으로 실제 추출 흐름 검증
 * Phase 1 extractCodeSignals와 동일한 인터페이스 확인
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createPgliteClient } from '@archi-navi/db';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { codeArtifacts, codeCallEdges, evidences, objects, workspaces } from '@archi-navi/db';
import { eq, and } from 'drizzle-orm';
import { extractAstCodeSignals } from '@/code/ast/extractAstCodeSignals';
import { generateId } from '@archi-navi/shared';

const MIGRATIONS_FOLDER = join(process.cwd(), '../db/src/migrations');

async function createTestDb() {
    const db = createPgliteClient();
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    return db;
}

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const workspaceId = '00000000-0000-0000-0000-000000000099';

async function createFixtures(db: TestDb) {
    await db.insert(workspaces).values({ id: workspaceId, name: 'test-workspace-ast' });

    const orderServiceId = generateId();
    await db.insert(objects).values({
        id: orderServiceId,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'order-service',
        path: `/${orderServiceId}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
    });

    return { orderServiceId };
}

describe('extractAstCodeSignals — 통합 테스트 (Phase 2)', () => {
    let db: TestDb;
    let tempDir: string;

    beforeEach(async () => {
        db = await createTestDb();
        tempDir = join(tmpdir(), `archi-navi-ast-test-${Date.now()}`);
        mkdirSync(tempDir, { recursive: true });
    });

    afterEach(() => {
        try {
            rmSync(tempDir, { recursive: true, force: true });
        } catch {
            // 정리 실패 무시
        }
    });

    // ─── Java 파일 처리 ───────────────────────────────────────────────────────

    it('Java 파일 AST 스캔 시 code_artifacts + code_call_edges + evidences를 저장해야 한다', async () => {
        await createFixtures(db);

        const javaDir = join(tempDir, 'order-service', 'src');
        mkdirSync(javaDir, { recursive: true });
        writeFileSync(
            join(javaDir, 'OrderController.java'),
            `package com.example.order;
@GetMapping("/api/orders")
public class OrderController {
    String r = restTemplate.getForObject("http://payment/pay", String.class);
}`,
        );

        const result = await extractAstCodeSignals(db, { workspaceId, repoRoot: tempDir });

        expect(result.fileCount).toBe(1);
        expect(result.artifactCount).toBe(1);
        expect(result.signalCount).toBeGreaterThanOrEqual(2);
        expect(result.skippedCount).toBe(0);

        const artifacts = await db
            .select()
            .from(codeArtifacts)
            .where(eq(codeArtifacts.workspaceId, workspaceId));
        expect(artifacts).toHaveLength(1);
        expect(artifacts[0]?.language).toBe('java');

        const edges = await db
            .select()
            .from(codeCallEdges)
            .where(eq(codeCallEdges.workspaceId, workspaceId));
        expect(edges.length).toBeGreaterThanOrEqual(2);
    });

    it('interProcedural=false면 기존 AST 저장 결과를 유지해야 한다', async () => {
        await createFixtures(db);

        const srcDir = join(tempDir, 'src');
        mkdirSync(srcDir, { recursive: true });
        writeFileSync(
            join(srcDir, 'Client.java'),
            `package com.example.order;
interface PaymentClient {}
class PaymentClientImpl implements PaymentClient {}
@GetMapping("/api/orders")
public class Client {
    String r = restTemplate.getForObject("http://payment/pay", String.class);
}`,
        );

        const baseline = await extractAstCodeSignals(db, { workspaceId, repoRoot: tempDir });
        const forced = await extractAstCodeSignals(db, {
            workspaceId,
            repoRoot: tempDir,
            forceRescan: true,
            interProcedural: false,
            maxCallChainDepth: 3,
            resolveProperties: true,
        });

        expect(forced.fileCount).toBe(baseline.fileCount);
        expect(forced.signalCount).toBe(baseline.signalCount);

        const savedEdges = await db
            .select()
            .from(codeCallEdges)
            .where(eq(codeCallEdges.workspaceId, workspaceId));
        expect(savedEdges.map((edge) => edge.calleeSymbol).sort()).toEqual([
            '/api/orders',
            'http://payment/pay',
        ]);
    });

    it('interProcedural=true면 depth-1 내부 서비스 메서드 호출을 HTTP call로 확장해야 한다', async () => {
        await createFixtures(db);

        const srcDir = join(tempDir, 'src');
        mkdirSync(srcDir, { recursive: true });
        writeFileSync(
            join(srcDir, 'PaymentService.java'),
            `package com.example.order;
public class PaymentService {
    void callPayment() {
        restTemplate.getForObject("http://payment/pay", String.class);
    }
}`,
        );
        writeFileSync(
            join(srcDir, 'OrderService.java'),
            `package com.example.order;
public class OrderService {
    private PaymentService paymentService;

    void placeOrder() {
        paymentService.callPayment();
    }
}`,
        );

        const result = await extractAstCodeSignals(db, {
            workspaceId,
            repoRoot: tempDir,
            interProcedural: true,
            maxCallChainDepth: 3,
        });

        const edges = await db
            .select()
            .from(codeCallEdges)
            .where(eq(codeCallEdges.workspaceId, workspaceId));
        expect(edges.map((edge) => edge.calleeSymbol).sort()).toEqual([
            'http://payment/pay',
            'http://payment/pay',
        ]);
    });

    it('interProcedural=true면 same-class unqualified 호출도 depth-1 HTTP call로 확장해야 한다', async () => {
        await createFixtures(db);

        const srcDir = join(tempDir, 'src');
        mkdirSync(srcDir, { recursive: true });
        writeFileSync(
            join(srcDir, 'OrderService.java'),
            `package com.example.order;
public class OrderService {
    void placeOrder() {
        callPayment();
    }

    void callPayment() {
        restTemplate.getForObject("http://payment/pay", String.class);
    }
}`,
        );

        await extractAstCodeSignals(db, {
            workspaceId,
            repoRoot: tempDir,
            interProcedural: true,
            maxCallChainDepth: 3,
        });

        const savedEdges = await db
            .select()
            .from(codeCallEdges)
            .where(eq(codeCallEdges.workspaceId, workspaceId));
        expect(savedEdges.map((edge) => edge.calleeSymbol).sort()).toEqual([
            'http://payment/pay',
            'http://payment/pay',
        ]);
    });

    it('interProcedural=true면 locally called helper 메서드도 depth-1 호출 해석 대상이어야 한다', async () => {
        await createFixtures(db);

        const srcDir = join(tempDir, 'src');
        mkdirSync(srcDir, { recursive: true });
        writeFileSync(
            join(srcDir, 'PaymentService.java'),
            `package com.example.order;
public class PaymentService {
    void callPayment() {
        restTemplate.getForObject("http://payment/pay", String.class);
    }
}`,
        );
        writeFileSync(
            join(srcDir, 'OrderService.java'),
            `package com.example.order;
public class OrderService {
    private PaymentService paymentService;

    void placeOrder() {
        invokePayment();
    }

    void invokePayment() {
        paymentService.callPayment();
    }
}`,
        );

        await extractAstCodeSignals(db, {
            workspaceId,
            repoRoot: tempDir,
            interProcedural: true,
            maxCallChainDepth: 3,
        });

        const savedEdges = await db
            .select()
            .from(codeCallEdges)
            .where(eq(codeCallEdges.workspaceId, workspaceId));
        expect(savedEdges.map((edge) => edge.calleeSymbol).sort()).toEqual([
            'http://payment/pay',
            'http://payment/pay',
            'http://payment/pay',
        ]);
    });

    it('interProcedural=true면 인터페이스의 단일 구현체 메서드 내부 HTTP call을 해석해야 한다', async () => {
        await createFixtures(db);

        const srcDir = join(tempDir, 'src');
        mkdirSync(srcDir, { recursive: true });
        writeFileSync(
            join(srcDir, 'PaymentGateway.java'),
            `package com.example.order;
public interface PaymentGateway {
    void charge();
}`,
        );
        writeFileSync(
            join(srcDir, 'PaymentGatewayImpl.java'),
            `package com.example.order;
public class PaymentGatewayImpl implements PaymentGateway {
    public void charge() {
        restTemplate.getForObject("http://payment/pay", String.class);
    }
}`,
        );
        writeFileSync(
            join(srcDir, 'OrderService.java'),
            `package com.example.order;
public class OrderService {
    private PaymentGateway paymentGateway;

    void placeOrder() {
        paymentGateway.charge();
    }
}`,
        );

        const result = await extractAstCodeSignals(db, {
            workspaceId,
            repoRoot: tempDir,
            interProcedural: true,
            maxCallChainDepth: 3,
        });

        const savedEdges = await db
            .select()
            .from(codeCallEdges)
            .where(eq(codeCallEdges.workspaceId, workspaceId));
        expect(savedEdges.map((edge) => edge.calleeSymbol).sort()).toEqual([
            'http://payment/pay',
            'http://payment/pay',
        ]);
    });

    it('interProcedural=true면 Kotlin depth-1 내부 서비스 메서드 호출도 HTTP call로 확장해야 한다', async () => {
        await createFixtures(db);

        const srcDir = join(tempDir, 'src');
        mkdirSync(srcDir, { recursive: true });
        writeFileSync(
            join(srcDir, 'PaymentService.kt'),
            `package com.example.order
class PaymentService {
    fun callPayment() {
        restTemplate.getForObject("http://payment/pay", String::class.java)
    }
}`,
        );
        writeFileSync(
            join(srcDir, 'OrderService.kt'),
            `package com.example.order
class OrderService {
    private val paymentService: PaymentService = PaymentService()

    fun placeOrder() {
        paymentService.callPayment()
    }
}`,
        );

        await extractAstCodeSignals(db, {
            workspaceId,
            repoRoot: tempDir,
            interProcedural: true,
            maxCallChainDepth: 3,
        });

        const savedEdges = await db
            .select()
            .from(codeCallEdges)
            .where(eq(codeCallEdges.workspaceId, workspaceId));
        expect(savedEdges.map((edge) => edge.calleeSymbol).sort()).toEqual([
            'http://payment/pay',
            'http://payment/pay',
        ]);
    });

    it('maxCallChainDepth=2면 depth-2 helper까지는 추적하고 depth-3 전파는 중단해야 한다', async () => {
        await createFixtures(db);

        const srcDir = join(tempDir, 'src');
        mkdirSync(srcDir, { recursive: true });
        writeFileSync(
            join(srcDir, 'OrderService.java'),
            `package com.example.order;
public class OrderService {
    void entryPoint() {
        placeOrder();
    }

    void placeOrder() {
        callPayment();
    }

    void callPayment() {
        doHttp();
    }

    void doHttp() {
        restTemplate.getForObject("http://payment/pay", String.class);
    }
}`,
        );

        await extractAstCodeSignals(db, {
            workspaceId,
            repoRoot: tempDir,
            interProcedural: true,
            maxCallChainDepth: 2,
        });

        const savedEdges = await db
            .select()
            .from(codeCallEdges)
            .where(eq(codeCallEdges.workspaceId, workspaceId));
        expect(savedEdges.map((edge) => edge.calleeSymbol).sort()).toEqual([
            'http://payment/pay',
            'http://payment/pay',
            'http://payment/pay',
        ]);
    });

    it('resolveProperties=true면 @Value 필드에 주입된 application.yml 값을 HTTP call URL로 해석해야 한다', async () => {
        await createFixtures(db);

        const serviceDir = join(tempDir, 'order-service');
        const srcDir = join(serviceDir, 'src');
        mkdirSync(srcDir, { recursive: true });
        writeFileSync(
            join(serviceDir, 'application.yml'),
            `payment:
  url: http://payment/property-pay
`,
        );
        writeFileSync(
            join(srcDir, 'OrderService.java'),
            `package com.example.order;
import org.springframework.beans.factory.annotation.Value;
public class OrderService {
    @Value("\${payment.url}")
    private String paymentUrl;

    void placeOrder() {
        restTemplate.getForObject(paymentUrl, String.class);
    }
}`,
        );

        await extractAstCodeSignals(db, {
            workspaceId,
            repoRoot: tempDir,
            resolveProperties: true,
        });

        const savedEdges = await db
            .select()
            .from(codeCallEdges)
            .where(eq(codeCallEdges.workspaceId, workspaceId));
        expect(savedEdges.map((edge) => edge.calleeSymbol)).toContain('http://payment/property-pay');
    });

    it('resolveProperties=true면 application-{profile}.yml 값이 기본 application.yml 값을 덮어써야 한다', async () => {
        await createFixtures(db);

        const serviceDir = join(tempDir, 'order-service');
        const srcDir = join(serviceDir, 'src');
        mkdirSync(srcDir, { recursive: true });
        writeFileSync(
            join(serviceDir, 'application.yml'),
            `payment:
  url: http://payment/base
`,
        );
        writeFileSync(
            join(serviceDir, 'application-prod.yml'),
            `payment:
  url: http://payment/profile
`,
        );
        writeFileSync(
            join(srcDir, 'OrderService.java'),
            `package com.example.order;
import org.springframework.beans.factory.annotation.Value;
public class OrderService {
    @Value("\${payment.url}")
    private String paymentUrl;

    void placeOrder() {
        restTemplate.getForObject(paymentUrl, String.class);
    }
}`,
        );

        await extractAstCodeSignals(db, {
            workspaceId,
            repoRoot: tempDir,
            resolveProperties: true,
        });

        const savedEdges = await db
            .select()
            .from(codeCallEdges)
            .where(eq(codeCallEdges.workspaceId, workspaceId));
        expect(savedEdges.map((edge) => edge.calleeSymbol)).toContain('http://payment/profile');
    });

    it('resolveProperties=false면 @Value 필드는 기존처럼 미해결 상태로 남아야 한다', async () => {
        await createFixtures(db);

        const serviceDir = join(tempDir, 'order-service');
        const srcDir = join(serviceDir, 'src');
        mkdirSync(srcDir, { recursive: true });
        writeFileSync(
            join(serviceDir, 'application.yml'),
            `payment:
  url: http://payment/property-pay
`,
        );
        writeFileSync(
            join(srcDir, 'OrderService.java'),
            `package com.example.order;
import org.springframework.beans.factory.annotation.Value;
public class OrderService {
    @Value("\${payment.url}")
    private String paymentUrl;

    void placeOrder() {
        restTemplate.getForObject(paymentUrl, String.class);
    }
}`,
        );

        await extractAstCodeSignals(db, {
            workspaceId,
            repoRoot: tempDir,
            resolveProperties: false,
        });

        const savedEdges = await db
            .select()
            .from(codeCallEdges)
            .where(eq(codeCallEdges.workspaceId, workspaceId));
        expect(savedEdges.map((edge) => edge.calleeSymbol)).not.toContain('http://payment/property-pay');
    });

    it('interProcedural + resolveProperties=true면 helper 메서드 내부 @Value 기반 HTTP call도 depth-1으로 확장해야 한다', async () => {
        await createFixtures(db);

        const serviceDir = join(tempDir, 'order-service');
        const srcDir = join(serviceDir, 'src');
        mkdirSync(srcDir, { recursive: true });
        writeFileSync(
            join(serviceDir, 'application.yml'),
            `payment:
  url: http://payment/property-pay
`,
        );
        writeFileSync(
            join(srcDir, 'PaymentService.java'),
            `package com.example.order;
import org.springframework.beans.factory.annotation.Value;
public class PaymentService {
    @Value("\${payment.url}")
    private String paymentUrl;

    void callPayment() {
        restTemplate.getForObject(paymentUrl, String.class);
    }
}`,
        );
        writeFileSync(
            join(srcDir, 'OrderService.java'),
            `package com.example.order;
public class OrderService {
    private PaymentService paymentService;

    void placeOrder() {
        paymentService.callPayment();
    }
}`,
        );

        await extractAstCodeSignals(db, {
            workspaceId,
            repoRoot: tempDir,
            interProcedural: true,
            maxCallChainDepth: 3,
            resolveProperties: true,
        });

        const savedEdges = await db
            .select()
            .from(codeCallEdges)
            .where(eq(codeCallEdges.workspaceId, workspaceId));
        expect(savedEdges.map((edge) => edge.calleeSymbol).sort()).toEqual([
            'http://payment/property-pay',
            'http://payment/property-pay',
        ]);
    });

    it('interProcedural call evidence에는 interfaceImpl, resolvedUrl, ambiguous metadata가 저장되어야 한다', async () => {
        await createFixtures(db);

        const srcDir = join(tempDir, 'src');
        mkdirSync(srcDir, { recursive: true });
        writeFileSync(
            join(srcDir, 'PaymentGateway.java'),
            `package com.example.order;
public interface PaymentGateway {
    void charge();
}`,
        );
        writeFileSync(
            join(srcDir, 'PaymentGatewayImpl.java'),
            `package com.example.order;
public class PaymentGatewayImpl implements PaymentGateway {
    public void charge() {
        restTemplate.getForObject("http://payment/pay", String.class);
    }
}`,
        );
        writeFileSync(
            join(srcDir, 'OrderService.java'),
            `package com.example.order;
public class OrderService {
    private PaymentGateway paymentGateway;

    void placeOrder() {
        paymentGateway.charge();
    }
}`,
        );

        await extractAstCodeSignals(db, {
            workspaceId,
            repoRoot: tempDir,
            interProcedural: true,
            maxCallChainDepth: 1,
        });

        const savedEvidences = await db
            .select()
            .from(evidences)
            .where(and(eq(evidences.workspaceId, workspaceId), eq(evidences.filePath, join(srcDir, 'OrderService.java'))));
        const propagatedEvidence = savedEvidences.find((row) =>
            (row.metadata as Record<string, unknown>)['interfaceImpl'] === 'PaymentGatewayImpl');

        expect(propagatedEvidence).toBeDefined();
        expect((propagatedEvidence?.metadata as Record<string, unknown>)['resolvedUrl']).toBe('http://payment/pay');
        expect((propagatedEvidence?.metadata as Record<string, unknown>)['ambiguous']).toBe(false);
    });

    it('다중 구현체면 ambiguous metadata와 구현체별 propagated call을 남겨야 한다', async () => {
        await createFixtures(db);

        const srcDir = join(tempDir, 'src');
        mkdirSync(srcDir, { recursive: true });
        writeFileSync(
            join(srcDir, 'PaymentGateway.java'),
            `package com.example.order;
public interface PaymentGateway {
    void charge();
}`,
        );
        writeFileSync(
            join(srcDir, 'PrimaryGateway.java'),
            `package com.example.order;
public class PrimaryGateway implements PaymentGateway {
    public void charge() {
        restTemplate.getForObject("http://payment/primary", String.class);
    }
}`,
        );
        writeFileSync(
            join(srcDir, 'BackupGateway.java'),
            `package com.example.order;
public class BackupGateway implements PaymentGateway {
    public void charge() {
        restTemplate.getForObject("http://payment/backup", String.class);
    }
}`,
        );
        writeFileSync(
            join(srcDir, 'OrderService.java'),
            `package com.example.order;
public class OrderService {
    private PaymentGateway paymentGateway;

    void placeOrder() {
        paymentGateway.charge();
    }
}`,
        );

        await extractAstCodeSignals(db, {
            workspaceId,
            repoRoot: tempDir,
            interProcedural: true,
            maxCallChainDepth: 1,
        });

        const savedEvidences = await db
            .select()
            .from(evidences)
            .where(and(eq(evidences.workspaceId, workspaceId), eq(evidences.filePath, join(srcDir, 'OrderService.java'))));

        const propagated = savedEvidences.filter((row) =>
            (row.metadata as Record<string, unknown>)['ambiguous'] === true);

        expect(propagated).toHaveLength(2);
        expect(propagated.map((row) => (row.metadata as Record<string, unknown>)['interfaceImpl']).sort()).toEqual([
            'BackupGateway',
            'PrimaryGateway',
        ]);
    });

    it('depth-2 chain에서 FeignClient 호출도 최종 URL까지 해석해야 한다', async () => {
        await createFixtures(db);

        const srcDir = join(tempDir, 'src');
        mkdirSync(srcDir, { recursive: true });
        writeFileSync(
            join(srcDir, 'PaymentClient.java'),
            `package com.example.order;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.GetMapping;
@FeignClient(name = "payment")
public interface PaymentClient {
    @GetMapping("/api/charge")
    String charge();
}`,
        );
        writeFileSync(
            join(srcDir, 'PaymentGateway.java'),
            `package com.example.order;
public interface PaymentGateway {
    void charge();
}`,
        );
        writeFileSync(
            join(srcDir, 'PaymentGatewayImpl.java'),
            `package com.example.order;
public class PaymentGatewayImpl implements PaymentGateway {
    private PaymentClient paymentClient;

    public void charge() {
        paymentClient.charge();
    }
}`,
        );
        writeFileSync(
            join(srcDir, 'OrderService.java'),
            `package com.example.order;
public class OrderService {
    private PaymentGateway paymentGateway;

    void placeOrder() {
        paymentGateway.charge();
    }
}`,
        );

        await extractAstCodeSignals(db, {
            workspaceId,
            repoRoot: tempDir,
            interProcedural: true,
            maxCallChainDepth: 2,
        });

        const savedEdges = await db
            .select()
            .from(codeCallEdges)
            .where(eq(codeCallEdges.workspaceId, workspaceId));
        expect(savedEdges.map((edge) => edge.calleeSymbol)).toContain('http://payment/api/charge');
    });

    // ─── 변수 추적 통합 테스트 (Phase 2 핵심 차별점) ─────────────────────────

    it('Java에서 상수 URL을 추적하여 code_call_edges에 저장해야 한다', async () => {
        await createFixtures(db);

        const srcDir = join(tempDir, 'src');
        mkdirSync(srcDir, { recursive: true });
        writeFileSync(
            join(srcDir, 'OrderService.java'),
            `private static final String PAYMENT_URL = "http://payment-service/pay";
String result = restTemplate.getForObject(PAYMENT_URL, String.class);`,
        );

        const result = await extractAstCodeSignals(db, { workspaceId, repoRoot: tempDir });
        expect(result.signalCount).toBeGreaterThanOrEqual(1);

        const edges = await db
            .select()
            .from(codeCallEdges)
            .where(eq(codeCallEdges.workspaceId, workspaceId));
        const symbols = edges.map((e) => e.calleeSymbol);
        // Phase 2: 상수 URL 추적
        expect(symbols).toContain('http://payment-service/pay');
    });

    it('TypeScript에서 상수 URL을 추적하여 code_call_edges에 저장해야 한다', async () => {
        await createFixtures(db);

        const tsDir = join(tempDir, 'src');
        mkdirSync(tsDir, { recursive: true });
        writeFileSync(
            join(tsDir, 'client.ts'),
            `const INVENTORY_URL = 'http://inventory/stock';
const response = await fetch(INVENTORY_URL);`,
        );

        await extractAstCodeSignals(db, { workspaceId, repoRoot: tempDir });

        const edges = await db
            .select()
            .from(codeCallEdges)
            .where(eq(codeCallEdges.workspaceId, workspaceId));
        const symbols = edges.map((e) => e.calleeSymbol);
        expect(symbols).toContain('http://inventory/stock');
    });

    // ─── TypeScript 파일 처리 ─────────────────────────────────────────────────

    it('TypeScript 파일 AST 스캔 시 신호를 저장해야 한다', async () => {
        await createFixtures(db);

        const tsDir = join(tempDir, 'order-service', 'src');
        mkdirSync(tsDir, { recursive: true });
        writeFileSync(
            join(tsDir, 'orderRoutes.ts'),
            `app.get('/api/orders', async (req, res) => {
    const data = await fetch('http://payment/pay');
    res.json({});
});`,
        );

        const result = await extractAstCodeSignals(db, { workspaceId, repoRoot: tempDir });
        expect(result.artifactCount).toBe(1);
        expect(result.signalCount).toBeGreaterThanOrEqual(2);

        const edges = await db
            .select()
            .from(codeCallEdges)
            .where(eq(codeCallEdges.workspaceId, workspaceId));
        const symbols = edges.map((e) => e.calleeSymbol);
        expect(symbols).toContain('/api/orders');
        expect(symbols).toContain('http://payment/pay');
    });

    // ─── Python 파일 처리 ─────────────────────────────────────────────────────

    it('Python 파일 AST 스캔 시 신호를 저장해야 한다', async () => {
        await createFixtures(db);

        const pyDir = join(tempDir, 'order-service');
        mkdirSync(pyDir, { recursive: true });
        writeFileSync(
            join(pyDir, 'app.py'),
            `@app.route('/api/orders')
def orders():
    response = requests.get('http://inventory/stock')
    return jsonify([])`,
        );

        const result = await extractAstCodeSignals(db, { workspaceId, repoRoot: tempDir });
        expect(result.artifactCount).toBe(1);
        expect(result.signalCount).toBeGreaterThanOrEqual(2);
    });

    // ─── Phase 2 메타데이터 확인 ─────────────────────────────────────────────

    it('evidences에 phase: 2 메타데이터가 저장되어야 한다', async () => {
        await createFixtures(db);

        const srcDir = join(tempDir, 'src');
        mkdirSync(srcDir, { recursive: true });
        writeFileSync(
            join(srcDir, 'Controller.java'),
            `@GetMapping("/api/orders")
public class C {}`,
        );

        await extractAstCodeSignals(db, { workspaceId, repoRoot: tempDir });

        const savedEvidences = await db
            .select()
            .from(evidences)
            .where(eq(evidences.workspaceId, workspaceId));

        expect(savedEvidences.length).toBeGreaterThan(0);
        // Phase 2 메타데이터 확인
        const allPhase2 = savedEvidences.every(
            (e) => (e.metadata as Record<string, unknown>)['phase'] === 2,
        );
        expect(allPhase2).toBe(true);
    });

    // ─── SHA256 증분 스캔 ─────────────────────────────────────────────────────

    it('SHA256 미변경 파일은 두 번째 실행에서 스킵해야 한다', async () => {
        await createFixtures(db);

        const srcDir = join(tempDir, 'src');
        mkdirSync(srcDir, { recursive: true });
        writeFileSync(
            join(srcDir, 'OrderController.java'),
            `@GetMapping("/api/orders")
public class OrderController {}`,
        );

        const first = await extractAstCodeSignals(db, { workspaceId, repoRoot: tempDir });
        expect(first.artifactCount).toBe(1);
        expect(first.skippedCount).toBe(0);

        const second = await extractAstCodeSignals(db, { workspaceId, repoRoot: tempDir });
        expect(second.artifactCount).toBe(0);
        expect(second.skippedCount).toBe(1);
        expect(second.signalCount).toBe(0);
    });


    it('interProcedural=true이면 SHA256 미변경 파일도 재처리해야 한다', async () => {
        await createFixtures(db);

        const srcDir = join(tempDir, 'src');
        mkdirSync(srcDir, { recursive: true });
        writeFileSync(
            join(srcDir, 'OrderController.java'),
            `@Service
public class OrderController {
  private final PaymentService paymentService;

  public OrderController(PaymentService paymentService) {
    this.paymentService = paymentService;
  }

  public void placeOrder() {
    paymentService.callPayment();
  }
}`,
        );
        writeFileSync(
            join(srcDir, 'PaymentService.java'),
            `@Service
public class PaymentService {
  public String callPayment() {
    return restTemplate.getForObject("http://payment-service/pay", String.class);
  }
}`,
        );

        const first = await extractAstCodeSignals(db, {
            workspaceId,
            repoRoot: tempDir,
            interProcedural: true,
        });
        expect(first.skippedCount).toBe(0);

        const second = await extractAstCodeSignals(db, {
            workspaceId,
            repoRoot: tempDir,
            interProcedural: true,
        });

        expect(second.fileCount).toBeGreaterThanOrEqual(2);
        expect(second.skippedCount).toBe(0);
    });

    it('SHA256 변경 시 기존 code_call_edges를 삭제하고 재생성해야 한다', async () => {
        await createFixtures(db);

        const srcDir = join(tempDir, 'src');
        mkdirSync(srcDir, { recursive: true });
        const filePath = join(srcDir, 'Controller.java');

        writeFileSync(filePath, `@GetMapping("/api/orders")\npublic class C {}`);
        await extractAstCodeSignals(db, { workspaceId, repoRoot: tempDir });

        writeFileSync(filePath, `@GetMapping("/api/orders")\n@PostMapping("/api/orders")\npublic class C {}`);
        await extractAstCodeSignals(db, { workspaceId, repoRoot: tempDir });

        const edges = await db
            .select()
            .from(codeCallEdges)
            .where(eq(codeCallEdges.workspaceId, workspaceId));
        expect(edges).toHaveLength(2);
    });

    // ─── ownerObjectId 매칭 ───────────────────────────────────────────────────

    it('파일 경로에 서비스명이 포함되면 ownerObjectId를 설정해야 한다', async () => {
        const { orderServiceId } = await createFixtures(db);

        const svcDir = join(tempDir, 'order-service', 'src');
        mkdirSync(svcDir, { recursive: true });
        writeFileSync(
            join(svcDir, 'OrderController.java'),
            `@GetMapping("/api/orders")\npublic class OrderController {}`,
        );

        await extractAstCodeSignals(db, { workspaceId, repoRoot: tempDir });

        const artifacts = await db
            .select()
            .from(codeArtifacts)
            .where(
                and(
                    eq(codeArtifacts.workspaceId, workspaceId),
                    eq(codeArtifacts.language, 'java'),
                ),
            );

        expect(artifacts).toHaveLength(1);
        expect(artifacts[0]?.ownerObjectId).toBe(orderServiceId);
    });

    // ─── 빈 디렉토리 ─────────────────────────────────────────────────────────

    it('소스 파일이 없는 디렉토리에서는 빈 결과를 반환해야 한다', async () => {
        await db.insert(workspaces).values({ id: workspaceId, name: 'test-workspace-ast' });

        const result = await extractAstCodeSignals(db, { workspaceId, repoRoot: tempDir });
        expect(result.fileCount).toBe(0);
        expect(result.artifactCount).toBe(0);
        expect(result.signalCount).toBe(0);
    });

    // ─── confidence 향상 확인 ─────────────────────────────────────────────────

    it('evidence에 저장된 confidence가 Phase 1 대비 높아야 한다', async () => {
        await createFixtures(db);

        const srcDir = join(tempDir, 'src');
        mkdirSync(srcDir, { recursive: true });
        writeFileSync(
            join(srcDir, 'Controller.java'),
            `restTemplate.getForObject("http://payment/pay", String.class);`,
        );

        await extractAstCodeSignals(db, { workspaceId, repoRoot: tempDir });

        const savedEvidences = await db
            .select()
            .from(evidences)
            .where(eq(evidences.workspaceId, workspaceId));

        expect(savedEvidences.length).toBeGreaterThan(0);
        // Phase 2 confidence (0.9) > Phase 1 confidence (0.7)
        const allHighConfidence = savedEvidences.every(
            (e) => ((e.metadata as Record<string, unknown>)['confidence'] as number) >= 0.85,
        );
        expect(allHighConfidence).toBe(true);
    });
});
