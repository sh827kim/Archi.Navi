/**
 * codeSignalExtractor.ts 통합 테스트
 * PGlite 인메모리 DB + 임시 파일 시스템으로 실제 추출 흐름 검증
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createPgliteClient } from '@archi-navi/db';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { codeArtifacts, codeCallEdges, evidences, objects, workspaces } from '@archi-navi/db';
import { eq, and } from 'drizzle-orm';
import { extractCodeSignals } from '@/code/codeSignalExtractor';
import { generateId } from '@archi-navi/shared';

const MIGRATIONS_FOLDER = join(process.cwd(), '../db/src/migrations');

async function createTestDb() {
    const db = createPgliteClient();
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    return db;
}

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const workspaceId = '00000000-0000-0000-0000-000000000002';

/** 테스트용 워크스페이스 + 서비스 Object 생성 */
async function createFixtures(db: TestDb) {
    await db.insert(workspaces).values({ id: workspaceId, name: 'test-workspace' });

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

describe('extractCodeSignals', () => {
    let db: TestDb;
    let tempDir: string;

    beforeEach(async () => {
        db = await createTestDb();
        tempDir = join(tmpdir(), `archi-navi-code-test-${Date.now()}`);
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

    it('Java 파일 스캔 시 code_artifacts + code_call_edges + evidences를 저장해야 한다', async () => {
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

        const result = await extractCodeSignals(db, { workspaceId, repoRoot: tempDir });

        expect(result.fileCount).toBe(1);
        expect(result.artifactCount).toBe(1);
        expect(result.signalCount).toBeGreaterThanOrEqual(2); // expose + call
        expect(result.skippedCount).toBe(0);

        // code_artifacts 확인
        const artifacts = await db
            .select()
            .from(codeArtifacts)
            .where(eq(codeArtifacts.workspaceId, workspaceId));
        expect(artifacts).toHaveLength(1);
        expect(artifacts[0]?.language).toBe('java');
        expect(artifacts[0]?.packageName).toBe('com.example.order');

        // code_call_edges 확인
        const edges = await db
            .select()
            .from(codeCallEdges)
            .where(eq(codeCallEdges.workspaceId, workspaceId));
        expect(edges.length).toBeGreaterThanOrEqual(2);
    });

    // ─── TypeScript 파일 처리 ─────────────────────────────────────────────────

    it('TypeScript 파일 스캔 시 신호를 저장해야 한다', async () => {
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

        const result = await extractCodeSignals(db, { workspaceId, repoRoot: tempDir });

        expect(result.artifactCount).toBe(1);
        expect(result.signalCount).toBeGreaterThanOrEqual(2); // expose + call

        const edges = await db
            .select()
            .from(codeCallEdges)
            .where(eq(codeCallEdges.workspaceId, workspaceId));
        const symbols = edges.map((e) => e.calleeSymbol);
        expect(symbols).toContain('/api/orders');
        expect(symbols).toContain('http://payment/pay');
    });

    // ─── Python 파일 처리 ─────────────────────────────────────────────────────

    it('Python 파일 스캔 시 신호를 저장해야 한다', async () => {
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

        const result = await extractCodeSignals(db, { workspaceId, repoRoot: tempDir });

        expect(result.artifactCount).toBe(1);
        expect(result.signalCount).toBeGreaterThanOrEqual(2);
    });

    // ─── SHA256 증분 스캔 ─────────────────────────────────────────────────────

    it('SHA256 미변경 파일은 두 번째 실행에서 스킵해야 한다', async () => {
        await createFixtures(db);

        const srcDir = join(tempDir, 'src');
        mkdirSync(srcDir, { recursive: true });
        const content = `@GetMapping("/api/orders")\npublic class OrderController {}`;
        writeFileSync(join(srcDir, 'OrderController.java'), content);

        // 첫 번째 실행
        const first = await extractCodeSignals(db, { workspaceId, repoRoot: tempDir });
        expect(first.artifactCount).toBe(1);
        expect(first.skippedCount).toBe(0);

        // 두 번째 실행 (동일 파일)
        const second = await extractCodeSignals(db, { workspaceId, repoRoot: tempDir });
        expect(second.artifactCount).toBe(0); // 새로 생성 없음
        expect(second.skippedCount).toBe(1);  // 스킵됨
        expect(second.signalCount).toBe(0);   // 신규 신호 없음
    });

    it('SHA256 변경 시 기존 code_call_edges를 삭제하고 재생성해야 한다', async () => {
        await createFixtures(db);

        const srcDir = join(tempDir, 'src');
        mkdirSync(srcDir, { recursive: true });
        const filePath = join(srcDir, 'Controller.java');

        // 첫 번째 실행: expose 1개
        writeFileSync(filePath, `@GetMapping("/api/orders")\npublic class C {}`);
        await extractCodeSignals(db, { workspaceId, repoRoot: tempDir });

        // 두 번째 실행: 내용 변경 (expose 2개)
        writeFileSync(filePath, `@GetMapping("/api/orders")\n@PostMapping("/api/orders")\npublic class C {}`);
        await extractCodeSignals(db, { workspaceId, repoRoot: tempDir });

        // 최신 신호 기준 edges 수 확인
        const edges = await db
            .select()
            .from(codeCallEdges)
            .where(eq(codeCallEdges.workspaceId, workspaceId));
        // 2개 (이전 1개 삭제 + 새로 2개)
        expect(edges).toHaveLength(2);
    });

    it('forceRescan 재처리 시 기존 evidence를 정리하고 최신 증거만 유지해야 한다', async () => {
        await createFixtures(db);

        const srcDir = join(tempDir, 'src');
        mkdirSync(srcDir, { recursive: true });
        const filePath = join(srcDir, 'Controller.java');
        writeFileSync(filePath, `@GetMapping("/api/orders")\npublic class C {}`);

        await extractCodeSignals(db, { workspaceId, repoRoot: tempDir });
        const firstEvidences = await db
            .select()
            .from(evidences)
            .where(eq(evidences.workspaceId, workspaceId));
        expect(firstEvidences).toHaveLength(1);

        await extractCodeSignals(db, { workspaceId, repoRoot: tempDir, forceRescan: true });
        const secondEvidences = await db
            .select()
            .from(evidences)
            .where(eq(evidences.workspaceId, workspaceId));
        const secondEdges = await db
            .select()
            .from(codeCallEdges)
            .where(eq(codeCallEdges.workspaceId, workspaceId));

        expect(secondEvidences).toHaveLength(1);
        expect(secondEdges).toHaveLength(1);
        expect(secondEdges[0]?.evidenceId).toBe(secondEvidences[0]?.id);
    });

    // ─── evidence 타입 확인 ────────────────────────────────────────────────────

    it('evidence가 FILE 타입으로 저장되어야 한다', async () => {
        await createFixtures(db);

        const srcDir = join(tempDir, 'src');
        mkdirSync(srcDir, { recursive: true });
        writeFileSync(
            join(srcDir, 'Controller.java'),
            `@GetMapping("/api/orders")\npublic class C {}`,
        );

        await extractCodeSignals(db, { workspaceId, repoRoot: tempDir });

        const savedEvidences = await db
            .select()
            .from(evidences)
            .where(eq(evidences.workspaceId, workspaceId));

        expect(savedEvidences.length).toBeGreaterThan(0);
        expect(savedEvidences.every((e) => e.evidenceType === 'FILE')).toBe(true);
        // lineStart가 저장되어 있는지 확인
        expect(savedEvidences.every((e) => e.lineStart !== null)).toBe(true);
    });

    // ─── ownerObjectId 매칭 ───────────────────────────────────────────────────

    it('파일 경로에 서비스명이 포함되면 ownerObjectId를 설정해야 한다', async () => {
        const { orderServiceId } = await createFixtures(db);

        // 파일 경로에 'order-service' 포함
        const svcDir = join(tempDir, 'order-service', 'src');
        mkdirSync(svcDir, { recursive: true });
        writeFileSync(
            join(svcDir, 'OrderController.java'),
            `@GetMapping("/api/orders")\npublic class OrderController {}`,
        );

        await extractCodeSignals(db, { workspaceId, repoRoot: tempDir });

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

    // ─── 빈 디렉토리 처리 ─────────────────────────────────────────────────────

    it('설정 파일이 없는 디렉토리에서는 빈 결과를 반환해야 한다', async () => {
        await db.insert(workspaces).values({ id: workspaceId, name: 'test-workspace' });

        const result = await extractCodeSignals(db, { workspaceId, repoRoot: tempDir });

        expect(result.fileCount).toBe(0);
        expect(result.artifactCount).toBe(0);
        expect(result.signalCount).toBe(0);
    });
});
