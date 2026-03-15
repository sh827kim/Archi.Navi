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
