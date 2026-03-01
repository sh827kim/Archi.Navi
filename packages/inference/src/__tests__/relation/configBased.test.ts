/**
 * configBased.ts 통합 테스트
 * PGlite 인메모리 DB + 임시 파일 시스템으로 실제 추론 흐름 검증
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createPgliteClient } from '@archi-navi/db';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { objects, relationCandidates, objectRelations, evidences, workspaces } from '@archi-navi/db';
import { eq, and } from 'drizzle-orm';
import { inferRelationsFromConfig } from '../../relation/configBased';
import { generateId, buildUrn } from '@archi-navi/shared';

// vitest는 package 루트(packages/inference/)에서 실행됨
// 따라서 migrations 폴더는 ../db/src/migrations 로 상대 참조 가능
const MIGRATIONS_FOLDER = join(process.cwd(), '../db/src/migrations');

/** 테스트용 DB 초기화 (PGlite 메모리 + 마이그레이션 실행) */
async function createTestDb() {
  const db = createPgliteClient(); // memory://
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

/** 테스트용 워크스페이스 + 서비스 Object 생성 */
async function createTestFixtures(db: TestDb, workspaceId: string) {
  // 워크스페이스 생성
  await db.insert(workspaces).values({ id: workspaceId, name: 'test-workspace' });

  // 서비스 Object 생성
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

describe('inferRelationsFromConfig', () => {
  let db: TestDb;
  let tempDir: string;
  const workspaceId = '00000000-0000-0000-0000-000000000001';

  beforeEach(async () => {
    // DB 초기화
    db = await createTestDb();

    // 임시 디렉토리 생성
    tempDir = join(tmpdir(), `archi-navi-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    // 임시 디렉토리 정리
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // 정리 실패 무시
    }
  });

  // ─── application.yml 처리 ─────────────────────────────────────────────────────

  describe('application.yml 처리', () => {
    it('datasource.url에서 database Object와 read/write relation_candidate를 생성해야 한다', async () => {
      const { orderServiceId } = await createTestFixtures(db, workspaceId);

      // 테스트 파일 작성
      writeFileSync(
        join(tempDir, 'application.yml'),
        `
spring:
  application:
    name: order-service
  datasource:
    url: jdbc:mysql://db-host:3306/order_db
`,
      );

      const result = await inferRelationsFromConfig(db, { workspaceId, repoRoot: tempDir });

      // read + write = 2개 생성
      expect(result.candidateCount).toBe(2);
      expect(result.objectCount).toBe(1); // database Object 1개

      // database Object 확인
      const dbObjects = await db
        .select()
        .from(objects)
        .where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectType, 'database')));
      expect(dbObjects).toHaveLength(1);
      expect(dbObjects[0]?.name).toBe('order_db');

      // relation_candidates 확인
      const candidates = await db
        .select()
        .from(relationCandidates)
        .where(and(eq(relationCandidates.workspaceId, workspaceId), eq(relationCandidates.subjectObjectId, orderServiceId)));
      expect(candidates).toHaveLength(2);

      const readCandidate = candidates.find((c) => c.relationType === 'read');
      expect(readCandidate?.confidence).toBeCloseTo(0.9);
      expect(readCandidate?.status).toBe('PENDING');

      const writeCandidate = candidates.find((c) => c.relationType === 'write');
      expect(writeCandidate?.confidence).toBeCloseTo(0.9);
    });

    it('kafka 설정에서 message_broker Object와 consume relation_candidate를 생성해야 한다', async () => {
      const { orderServiceId } = await createTestFixtures(db, workspaceId);

      writeFileSync(
        join(tempDir, 'application.yml'),
        `
spring:
  application:
    name: order-service
  kafka:
    bootstrap-servers: kafka:9092
    consumer:
      group-id: order-group
      topics: order.created, payment.completed
`,
      );

      const result = await inferRelationsFromConfig(db, { workspaceId, repoRoot: tempDir });

      // consume 2개 (2 topics)
      expect(result.candidateCount).toBe(2);
      // message_broker 1개 + topic 2개 = 3개
      expect(result.objectCount).toBe(3);

      // consume candidates 확인
      const consumeCandidates = await db
        .select()
        .from(relationCandidates)
        .where(
          and(
            eq(relationCandidates.workspaceId, workspaceId),
            eq(relationCandidates.relationType, 'consume'),
            eq(relationCandidates.subjectObjectId, orderServiceId),
          ),
        );
      expect(consumeCandidates).toHaveLength(2);
      expect(consumeCandidates[0]?.confidence).toBeCloseTo(0.85);
    });

    it('kafka producer 설정에서 produce relation_candidate를 생성해야 한다', async () => {
      const { orderServiceId } = await createTestFixtures(db, workspaceId);

      writeFileSync(
        join(tempDir, 'application.yml'),
        `
spring:
  application:
    name: order-service
  kafka:
    bootstrap-servers: kafka:9092
    producer:
      key-serializer: org.apache.kafka.common.serialization.StringSerializer
`,
      );

      const result = await inferRelationsFromConfig(db, { workspaceId, repoRoot: tempDir });

      const produceCandidates = await db
        .select()
        .from(relationCandidates)
        .where(
          and(
            eq(relationCandidates.workspaceId, workspaceId),
            eq(relationCandidates.relationType, 'produce'),
            eq(relationCandidates.subjectObjectId, orderServiceId),
          ),
        );
      expect(produceCandidates).toHaveLength(1);
      expect(produceCandidates[0]?.confidence).toBeCloseTo(0.85);
    });

    it('서비스 이름이 매칭되지 않으면 relation_candidate를 생성하지 않아야 한다', async () => {
      await createTestFixtures(db, workspaceId);

      writeFileSync(
        join(tempDir, 'application.yml'),
        `
spring:
  application:
    name: unknown-service  # DB에 없는 서비스명
  datasource:
    url: jdbc:mysql://db-host:3306/order_db
`,
      );

      const result = await inferRelationsFromConfig(db, { workspaceId, repoRoot: tempDir });

      // 서비스 매칭 실패 → candidate 없음, Object는 생성될 수 있음
      expect(result.candidateCount).toBe(0);
    });

    it('서비스명 없으면 relation_candidate를 생성하지 않아야 한다', async () => {
      await createTestFixtures(db, workspaceId);

      writeFileSync(
        join(tempDir, 'application.yml'),
        `
spring:
  datasource:
    url: jdbc:mysql://db-host:3306/order_db
`,
      );

      const result = await inferRelationsFromConfig(db, { workspaceId, repoRoot: tempDir });
      expect(result.candidateCount).toBe(0);
    });

    it('서비스명 정규화(하이픈/언더스코어) 매칭이 동작해야 한다', async () => {
      await createTestFixtures(db, workspaceId);

      writeFileSync(
        join(tempDir, 'bootstrap.yaml'),
        `
spring:
  application:
    name: order_service
  datasource:
    url: jdbc:mysql://db-host:3306/order_db
`,
      );

      const result = await inferRelationsFromConfig(db, { workspaceId, repoRoot: tempDir });
      expect(result.candidateCount).toBe(2);
      expect(result.objectCount).toBe(1);
    });

    it('MANUAL 관계가 있으면 동일 후보 생성을 건너뛰어야 한다', async () => {
      const { orderServiceId } = await createTestFixtures(db, workspaceId);

      const dbObjectId = generateId();
      await db.insert(objects).values({
        id: dbObjectId,
        workspaceId,
        objectType: 'database',
        category: 'STORAGE',
        granularity: 'COMPOUND',
        name: 'order_db',
        urn: buildUrn(workspaceId, 'storage', 'database', 'db-host:order_db'),
        path: `/${dbObjectId}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      });

      await db.insert(objectRelations).values({
        id: generateId(),
        workspaceId,
        relationType: 'read',
        subjectObjectId: orderServiceId,
        objectId: dbObjectId,
        status: 'APPROVED',
        source: 'MANUAL',
        isDerived: false,
        metadata: {},
      });

      writeFileSync(
        join(tempDir, 'application.yml'),
        `
spring:
  application:
    name: order-service
  datasource:
    url: jdbc:mysql://db-host:3306/order_db
`,
      );

      const result = await inferRelationsFromConfig(db, { workspaceId, repoRoot: tempDir });

      // read는 MANUAL로 막히고, write만 생성
      expect(result.candidateCount).toBe(1);

      const readCandidates = await db
        .select()
        .from(relationCandidates)
        .where(
          and(
            eq(relationCandidates.workspaceId, workspaceId),
            eq(relationCandidates.relationType, 'read'),
          ),
        );
      expect(readCandidates).toHaveLength(0);
    });
  });

  // ─── docker-compose.yml 처리 ───────────────────────────────────────────────────

  describe('docker-compose.yml 처리', () => {
    it('depends_on에서 depend_on relation_candidate를 생성해야 한다', async () => {
      // 두 서비스 생성
      await db.insert(workspaces).values({ id: workspaceId, name: 'test-workspace' });
      const orderSvcId = generateId();
      const paymentSvcId = generateId();
      await db.insert(objects).values([
        {
          id: orderSvcId,
          workspaceId,
          objectType: 'service',
          category: 'COMPUTE',
          granularity: 'COMPOUND',
          name: 'order-service',
          path: `/${orderSvcId}`,
          depth: 0,
          visibility: 'VISIBLE',
          metadata: {},
        },
        {
          id: paymentSvcId,
          workspaceId,
          objectType: 'service',
          category: 'COMPUTE',
          granularity: 'COMPOUND',
          name: 'payment-service',
          path: `/${paymentSvcId}`,
          depth: 0,
          visibility: 'VISIBLE',
          metadata: {},
        },
      ]);

      writeFileSync(
        join(tempDir, 'docker-compose.yml'),
        `
services:
  order-service:
    image: order:latest
    depends_on:
      - payment-service
  payment-service:
    image: payment:latest
`,
      );

      const result = await inferRelationsFromConfig(db, { workspaceId, repoRoot: tempDir });

      expect(result.candidateCount).toBe(1);

      const candidate = await db
        .select()
        .from(relationCandidates)
        .where(
          and(
            eq(relationCandidates.workspaceId, workspaceId),
            eq(relationCandidates.relationType, 'depend_on'),
            eq(relationCandidates.subjectObjectId, orderSvcId),
            eq(relationCandidates.objectId, paymentSvcId),
          ),
        );
      expect(candidate).toHaveLength(1);
      expect(candidate[0]?.confidence).toBeCloseTo(0.6);
    });

    it('DB 이미지 서비스를 database Object로 생성해야 한다', async () => {
      await db.insert(workspaces).values({ id: workspaceId, name: 'test-workspace' });

      writeFileSync(
        join(tempDir, 'docker-compose.yml'),
        `
services:
  mysql-db:
    image: mysql:8.0
    environment:
      MYSQL_DATABASE: order_db
`,
      );

      const result = await inferRelationsFromConfig(db, { workspaceId, repoRoot: tempDir });

      // Object는 생성되지만 service 매칭 없으므로 candidate는 0
      expect(result.objectCount).toBe(1);

      const dbObjects = await db
        .select()
        .from(objects)
        .where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectType, 'database')));
      expect(dbObjects).toHaveLength(1);
      expect(dbObjects[0]?.name).toBe('order_db');
    });

    it('Broker 이미지 서비스도 message_broker Object로 생성되어야 한다', async () => {
      await db.insert(workspaces).values({ id: workspaceId, name: 'test-workspace' });
      const orderSvcId = generateId();
      await db.insert(objects).values({
        id: orderSvcId,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'order-service',
        path: `/${orderSvcId}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      });

      writeFileSync(
        join(tempDir, 'docker-compose.yaml'),
        `
services:
  order-service:
    image: order:latest
    depends_on:
      - kafka-broker
  kafka-broker:
    image: confluentinc/cp-kafka:7.0
`,
      );

      const result = await inferRelationsFromConfig(db, { workspaceId, repoRoot: tempDir });

      expect(result.objectCount).toBe(1); // message_broker
      expect(result.candidateCount).toBe(1); // depend_on

      const brokers = await db
        .select()
        .from(objects)
        .where(
          and(
            eq(objects.workspaceId, workspaceId),
            eq(objects.objectType, 'message_broker'),
          ),
        );
      expect(brokers).toHaveLength(1);
      expect(brokers[0]?.name).toBe('kafka-broker');
    });
  });

  describe('k8s manifest 처리', () => {
    it('k8s Deployment env에서 DB/Kafka 관계를 추론해야 한다', async () => {
      await createTestFixtures(db, workspaceId);
      const k8sDir = join(tempDir, 'k8s');
      mkdirSync(k8sDir, { recursive: true });

      writeFileSync(
        join(k8sDir, 'deployment.yaml'),
        `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
spec:
  template:
    spec:
      containers:
        - name: app
          image: order:latest
          env:
            - name: DB_URL
              value: jdbc:mysql://db-host:3306/order_db
            - name: KAFKA_BROKERS
              value: kafka:9092, kafka2:9092
`,
      );

      const result = await inferRelationsFromConfig(db, { workspaceId, repoRoot: tempDir });

      expect(result.objectCount).toBe(2); // database + message_broker
      expect(result.candidateCount).toBe(3); // read + write + produce

      const readWrite = await db
        .select()
        .from(relationCandidates)
        .where(
          and(
            eq(relationCandidates.workspaceId, workspaceId),
            eq(relationCandidates.relationType, 'read'),
          ),
        );
      expect(readWrite).toHaveLength(1);
      expect(readWrite[0]?.confidence).toBeCloseTo(0.7);
    });
  });

  // ─── evidence 저장 ─────────────────────────────────────────────────────────────

  it('evidence가 CONFIG 타입으로 저장되어야 한다', async () => {
    const { orderServiceId: _ } = await createTestFixtures(db, workspaceId);

    writeFileSync(
      join(tempDir, 'application.yml'),
      `
spring:
  application:
    name: order-service
  datasource:
    url: jdbc:mysql://db-host:3306/order_db
`,
    );

    await inferRelationsFromConfig(db, { workspaceId, repoRoot: tempDir });

    const savedEvidences = await db
      .select()
      .from(evidences)
      .where(eq(evidences.workspaceId, workspaceId));

    expect(savedEvidences.length).toBeGreaterThan(0);
    // evidence type이 CONFIG인지 확인
    expect(savedEvidences.every((e) => e.evidenceType === 'CONFIG')).toBe(true);
    // filePath가 저장되어 있는지 확인
    expect(savedEvidences.every((e) => e.filePath !== null)).toBe(true);
  });

  // ─── 중복 처리 ────────────────────────────────────────────────────────────────

  it('동일한 추론을 두 번 실행해도 candidate가 중복 생성되지 않아야 한다', async () => {
    await createTestFixtures(db, workspaceId);

    writeFileSync(
      join(tempDir, 'application.yml'),
      `
spring:
  application:
    name: order-service
  datasource:
    url: jdbc:mysql://db-host:3306/order_db
`,
    );

    // 두 번 실행
    await inferRelationsFromConfig(db, { workspaceId, repoRoot: tempDir });
    await inferRelationsFromConfig(db, { workspaceId, repoRoot: tempDir });

    const candidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));

    // 중복 없이 2개 (read + write)만 있어야 함
    expect(candidates).toHaveLength(2);
  });

  it('REJECTED 상태 후보만 존재할 때 신규 후보를 생성해야 한다 (설계 §2.5)', async () => {
    // REJECTED 후보는 조회에서 제외되므로 자동으로 신규 생성됨
    const { orderServiceId } = await createTestFixtures(db, workspaceId);

    writeFileSync(
      join(tempDir, 'application.yml'),
      `
spring:
  application:
    name: order-service
  datasource:
    url: jdbc:mysql://db-host:3306/order_db
`,
    );

    // 첫 번째 실행
    await inferRelationsFromConfig(db, { workspaceId, repoRoot: tempDir });

    // 생성된 후보를 REJECTED 상태로 변경
    await db
      .update(relationCandidates)
      .set({ status: 'REJECTED' })
      .where(eq(relationCandidates.workspaceId, workspaceId));

    // REJECTED 상태 확인
    const rejectedCandidates = await db
      .select()
      .from(relationCandidates)
      .where(and(eq(relationCandidates.workspaceId, workspaceId), eq(relationCandidates.status, 'REJECTED')));
    expect(rejectedCandidates).toHaveLength(2);

    // 두 번째 실행 → REJECTED는 무시하고 신규 후보 생성
    const result = await inferRelationsFromConfig(db, { workspaceId, repoRoot: tempDir });
    expect(result.candidateCount).toBe(2); // 신규 생성됨

    // 최종 PENDING 2개 + REJECTED 2개 = 총 4개
    const allCandidates = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.workspaceId, workspaceId));
    expect(allCandidates).toHaveLength(4);

    const pendingCandidates = allCandidates.filter((c) => c.status === 'PENDING');
    expect(pendingCandidates).toHaveLength(2);
  });

  // ─── 빈 디렉토리 처리 ─────────────────────────────────────────────────────────

  it('설정 파일이 없는 디렉토리에서는 빈 결과를 반환해야 한다', async () => {
    await db.insert(workspaces).values({ id: workspaceId, name: 'test-workspace' });

    const result = await inferRelationsFromConfig(db, { workspaceId, repoRoot: tempDir });

    expect(result.candidateCount).toBe(0);
    expect(result.objectCount).toBe(0);
  });

  it('node_modules 내부 설정 파일은 스캔에서 제외해야 한다', async () => {
    await createTestFixtures(db, workspaceId);
    const hiddenDir = join(tempDir, 'node_modules', 'fake-service');
    mkdirSync(hiddenDir, { recursive: true });
    writeFileSync(
      join(hiddenDir, 'application.yml'),
      `
spring:
  application:
    name: order-service
  datasource:
    url: jdbc:mysql://db-host:3306/order_db
`,
    );

    const result = await inferRelationsFromConfig(db, { workspaceId, repoRoot: tempDir });
    expect(result.candidateCount).toBe(0);
    expect(result.objectCount).toBe(0);
  });
});
