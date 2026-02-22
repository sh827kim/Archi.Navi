/**
 * Discovery 다중 레이어 통합 테스트
 * PGlite 인메모리 DB로 enabled_layers + 엣지 가중치 반영 검증
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'path';
import { createPgliteClient } from '@archi-navi/db';
import { migrate } from 'drizzle-orm/pglite/migrator';
import {
    objects,
    workspaces,
    objectRollups,
    domainInferenceProfiles,
    domainDiscoveryRuns,
    domainDiscoveryMemberships,
} from '@archi-navi/db';
import { eq } from 'drizzle-orm';
import { generateId } from '@archi-navi/shared';
import { runDiscovery } from '../../domain/discovery.js';

const MIGRATIONS_FOLDER = join(process.cwd(), '../db/src/migrations');

async function createTestDb() {
    const db = createPgliteClient();
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    return db;
}

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const workspaceId = '00000000-0000-0000-0000-000000000030';

async function setupWorkspace(db: TestDb) {
    await db.insert(workspaces).values({ id: workspaceId, name: 'test-workspace' });
}

/** service object 생성 헬퍼 */
async function createService(db: TestDb, name: string): Promise<string> {
    const id = generateId();
    await db.insert(objects).values({
        id,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name,
        path: `/${id}`,
        depth: 0,
        metadata: {},
    });
    return id;
}

/** database object 생성 헬퍼 */
async function createDatabase(db: TestDb, name: string): Promise<string> {
    const id = generateId();
    await db.insert(objects).values({
        id,
        workspaceId,
        objectType: 'database',
        granularity: 'COMPOUND',
        name,
        path: `/${id}`,
        depth: 0,
        metadata: {},
    });
    return id;
}

/** message_broker object 생성 헬퍼 */
async function createBroker(db: TestDb, name: string): Promise<string> {
    const id = generateId();
    await db.insert(objects).values({
        id,
        workspaceId,
        objectType: 'message_broker',
        granularity: 'COMPOUND',
        name,
        path: `/${id}`,
        depth: 0,
        metadata: {},
    });
    return id;
}

/** rollup 레코드 삽입 헬퍼 */
async function insertRollup(
    db: TestDb,
    rollupLevel: string,
    subjectId: string,
    objectId: string,
    edgeWeight: number,
    generationVersion: number,
): Promise<void> {
    await db.insert(objectRollups).values({
        workspaceId,
        rollupLevel,
        relationType: 'test',
        subjectObjectId: subjectId,
        objectId,
        edgeWeight,
        generationVersion,
    });
}

/** 프로필 생성 헬퍼 */
async function createProfile(
    db: TestDb,
    name: string,
    enabledLayers: string[],
    edgeWCall?: number,
    edgeWRw?: number,
    edgeWMsg?: number,
    minClusterSize?: number,
): Promise<string> {
    const id = generateId();
    await db.insert(domainInferenceProfiles).values({
        id,
        workspaceId,
        name,
        enabledLayers,
        ...(edgeWCall !== undefined ? { edgeWCall } : {}),
        ...(edgeWRw !== undefined ? { edgeWRw } : {}),
        ...(edgeWMsg !== undefined ? { edgeWMsg } : {}),
        ...(minClusterSize !== undefined ? { minClusterSize } : {}),
    });
    return id;
}

describe('runDiscovery — 다중 레이어 통합', () => {
    let db: TestDb;
    const GEN = 1;

    beforeEach(async () => {
        db = await createTestDb();
        await setupWorkspace(db);
    });

    it('T1: rollup 데이터 없음 → clusterCount=0, run 기록 생성', async () => {
        const result = await runDiscovery(db, {
            workspaceId,
            generationVersion: GEN,
            minClusterSize: 2,
        });

        expect(result.clusterCount).toBe(0);
        expect(result.runId).toBeTruthy();

        // run 기록 확인
        const runs = await db
            .select()
            .from(domainDiscoveryRuns)
            .where(eq(domainDiscoveryRuns.id, result.runId));
        expect(runs).toHaveLength(1);
    });

    it('T2: enabled_layers=[call] + S2DB 데이터만 → 그래프 엣지 없음 → clusterCount=0', async () => {
        // S2DB 롤업만 존재 (call 레이어 데이터 없음)
        const svcA = await createService(db, 'serviceA');
        const svcB = await createService(db, 'serviceB');
        const svcC = await createService(db, 'serviceC');
        const dbObj = await createDatabase(db, 'mainDb');

        await insertRollup(db, 'SERVICE_TO_DATABASE', svcA, dbObj, 1, GEN);
        await insertRollup(db, 'SERVICE_TO_DATABASE', svcB, dbObj, 1, GEN);
        await insertRollup(db, 'SERVICE_TO_DATABASE', svcC, dbObj, 1, GEN);

        // 'call'만 활성화 → S2DB 무시
        const profileId = await createProfile(db, 'call-only', ['call'], undefined, undefined, undefined, 2);
        const result = await runDiscovery(db, {
            workspaceId,
            profileId,
            generationVersion: GEN,
            minClusterSize: 2,
        });

        expect(result.clusterCount).toBe(0);

        // inputLayers에 'call'만 기록
        const runs = await db
            .select()
            .from(domainDiscoveryRuns)
            .where(eq(domainDiscoveryRuns.id, result.runId));
        expect(runs[0]?.inputLayers).toEqual(['call']);
    });

    it('T3: enabled_layers=[db] + S2DB 데이터 → 공유 DB로 서비스 클러스터링', async () => {
        // 3개 서비스가 같은 DB를 공유 → star 그래프 → 하나의 클러스터
        const svcA = await createService(db, 'serviceA');
        const svcB = await createService(db, 'serviceB');
        const svcC = await createService(db, 'serviceC');
        const dbObj = await createDatabase(db, 'sharedDb');

        await insertRollup(db, 'SERVICE_TO_DATABASE', svcA, dbObj, 1, GEN);
        await insertRollup(db, 'SERVICE_TO_DATABASE', svcB, dbObj, 1, GEN);
        await insertRollup(db, 'SERVICE_TO_DATABASE', svcC, dbObj, 1, GEN);

        const profileId = await createProfile(db, 'db-only', ['db'], undefined, undefined, undefined, 2);
        const result = await runDiscovery(db, {
            workspaceId,
            profileId,
            generationVersion: GEN,
            minClusterSize: 2,
        });

        // 최소 1개 클러스터 (4 노드가 star 구조 → 하나의 커뮤니티)
        expect(result.clusterCount).toBeGreaterThan(0);

        // inputLayers에 'db'만 기록
        const runs = await db
            .select()
            .from(domainDiscoveryRuns)
            .where(eq(domainDiscoveryRuns.id, result.runId));
        expect(runs[0]?.inputLayers).toEqual(['db']);

        // 멤버십 생성 확인
        const memberships = await db
            .select()
            .from(domainDiscoveryMemberships)
            .where(eq(domainDiscoveryMemberships.runId, result.runId));
        expect(memberships.length).toBeGreaterThanOrEqual(2);
    });

    it('T4: enabled_layers=[msg] + S2BROKER 데이터 → 공유 브로커로 클러스터링', async () => {
        const svcA = await createService(db, 'producerA');
        const svcB = await createService(db, 'consumerB');
        const svcC = await createService(db, 'consumerC');
        const broker = await createBroker(db, 'kafka');

        await insertRollup(db, 'SERVICE_TO_BROKER', svcA, broker, 1, GEN);
        await insertRollup(db, 'SERVICE_TO_BROKER', svcB, broker, 1, GEN);
        await insertRollup(db, 'SERVICE_TO_BROKER', svcC, broker, 1, GEN);

        const profileId = await createProfile(db, 'msg-only', ['msg'], undefined, undefined, undefined, 2);
        const result = await runDiscovery(db, {
            workspaceId,
            profileId,
            generationVersion: GEN,
            minClusterSize: 2,
        });

        expect(result.clusterCount).toBeGreaterThan(0);

        const runs = await db
            .select()
            .from(domainDiscoveryRuns)
            .where(eq(domainDiscoveryRuns.id, result.runId));
        expect(runs[0]?.inputLayers).toEqual(['msg']);
    });

    it('T5: enabled_layers=[call,db] → inputLayers에 두 레이어 모두 기록', async () => {
        const profileId = await createProfile(db, 'call-db', ['call', 'db']);
        const result = await runDiscovery(db, {
            workspaceId,
            profileId,
            generationVersion: GEN,
            minClusterSize: 2,
        });

        const runs = await db
            .select()
            .from(domainDiscoveryRuns)
            .where(eq(domainDiscoveryRuns.id, result.runId));
        expect(runs[0]?.inputLayers).toEqual(['call', 'db']);
    });

    it('T6: 프로필 없음 (기본) → enabled_layers=[call,db,msg] 사용', async () => {
        const result = await runDiscovery(db, {
            workspaceId,
            generationVersion: GEN,
            minClusterSize: 2,
        });

        const runs = await db
            .select()
            .from(domainDiscoveryRuns)
            .where(eq(domainDiscoveryRuns.id, result.runId));
        // 기본 레이어: call, db, msg
        expect(runs[0]?.inputLayers).toEqual(['call', 'db', 'msg']);
    });

    it('T7: 프로필 edgeWRw=0 → S2DB 가중치 0 → 엣지 추가 안됨 → clusterCount=0', async () => {
        // S2DB 데이터 존재하지만 가중치 0으로 설정
        const svcA = await createService(db, 'serviceA');
        const svcB = await createService(db, 'serviceB');
        const svcC = await createService(db, 'serviceC');
        const dbObj = await createDatabase(db, 'sharedDb');

        await insertRollup(db, 'SERVICE_TO_DATABASE', svcA, dbObj, 1, GEN);
        await insertRollup(db, 'SERVICE_TO_DATABASE', svcB, dbObj, 1, GEN);
        await insertRollup(db, 'SERVICE_TO_DATABASE', svcC, dbObj, 1, GEN);

        // edgeWRw=0 → S2DB 엣지 추가 안됨
        const profileId = await createProfile(db, 'zero-rw', ['db'], undefined, 0, undefined, 2);
        const result = await runDiscovery(db, {
            workspaceId,
            profileId,
            generationVersion: GEN,
            minClusterSize: 2,
        });

        expect(result.clusterCount).toBe(0);
    });
});
