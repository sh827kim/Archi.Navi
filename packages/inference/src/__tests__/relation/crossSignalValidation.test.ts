import { beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq, sql } from 'drizzle-orm';
import {
  createPgliteClient,
  objectRelations,
  evidences,
  objects,
  relationCandidateEvidences,
  relationCandidates,
  workspaces,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import { crossValidatePendingRelationCandidates } from '@/relation/crossSignalValidation';

const MIGRATIONS_FOLDER = join(process.cwd(), '../db/src/migrations');
const workspaceId = '00000000-0000-0000-0000-000000000061';

async function createTestDb() {
  const db = createPgliteClient();
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

async function seedBaseCandidate(db: TestDb, confidence = 0.6) {
  await db.insert(workspaces).values({ id: workspaceId, name: 'cross-validation-test' });

  const sourceServiceId = generateId();
  const targetServiceId = generateId();
  const candidateId = generateId();

  await db.insert(objects).values([
    {
      id: sourceServiceId,
      workspaceId,
      objectType: 'service',
      category: 'COMPUTE',
      granularity: 'COMPOUND',
      name: 'gateway',
      path: '/gateway',
      depth: 0,
      visibility: 'VISIBLE',
      metadata: {},
    },
    {
      id: targetServiceId,
      workspaceId,
      objectType: 'service',
      category: 'COMPUTE',
      granularity: 'COMPOUND',
      name: 'orders',
      path: '/orders',
      depth: 0,
      visibility: 'VISIBLE',
      metadata: {},
    },
  ]);

  await db.insert(relationCandidates).values({
    id: candidateId,
    workspaceId,
    relationType: 'call',
    subjectObjectId: sourceServiceId,
    objectId: targetServiceId,
    confidence,
    metadata: {},
    status: 'PENDING',
  });

  return { candidateId, sourceServiceId, targetServiceId };
}

async function seedDatabaseCandidate(db: TestDb, confidence = 0.9) {
  await db.insert(workspaces).values({ id: workspaceId, name: 'cross-validation-db-test' });

  const serviceId = generateId();
  const databaseId = generateId();
  const candidateId = generateId();

  await db.insert(objects).values([
    {
      id: serviceId,
      workspaceId,
      objectType: 'service',
      category: 'COMPUTE',
      granularity: 'COMPOUND',
      name: 'order-service',
      path: '/order-service',
      depth: 0,
      visibility: 'VISIBLE',
      metadata: {},
    },
    {
      id: databaseId,
      workspaceId,
      objectType: 'database',
      category: 'DATA',
      granularity: 'COMPOUND',
      name: 'order-db',
      path: '/order-db',
      depth: 0,
      visibility: 'VISIBLE',
      metadata: {},
    },
  ]);

  await db.insert(relationCandidates).values({
    id: candidateId,
    workspaceId,
    relationType: 'read',
    subjectObjectId: serviceId,
    objectId: databaseId,
    confidence,
    metadata: {},
    status: 'PENDING',
  });

  return { candidateId, serviceId, databaseId };
}

async function seedTopicCandidate(
  db: TestDb,
  input: { relationType?: 'produce' | 'consume'; confidence?: number },
) {
  await db.insert(workspaces).values({ id: workspaceId, name: 'cross-validation-topic-test' });

  const serviceId = generateId();
  const topicId = generateId();
  const candidateId = generateId();

  await db.insert(objects).values([
    {
      id: serviceId,
      workspaceId,
      objectType: 'service',
      category: 'COMPUTE',
      granularity: 'COMPOUND',
      name: 'notification-service',
      path: '/notification-service',
      depth: 0,
      visibility: 'VISIBLE',
      metadata: {},
    },
    {
      id: topicId,
      workspaceId,
      objectType: 'topic',
      category: 'CHANNEL',
      granularity: 'ATOMIC',
      name: 'order.created',
      path: '/order.created',
      depth: 0,
      visibility: 'VISIBLE',
      metadata: {},
    },
  ]);

  await db.insert(relationCandidates).values({
    id: candidateId,
    workspaceId,
    relationType: input.relationType ?? 'consume',
    subjectObjectId: serviceId,
    objectId: topicId,
    confidence: input.confidence ?? 0.85,
    metadata: {},
    status: 'PENDING',
  });

  return { candidateId, serviceId, topicId };
}

async function seedBrokerCandidate(
  db: TestDb,
  input: { relationType?: 'produce' | 'consume'; confidence?: number },
) {
  await db.insert(workspaces).values({ id: workspaceId, name: 'cross-validation-broker-test' });

  const serviceId = generateId();
  const brokerId = generateId();
  const candidateId = generateId();

  await db.insert(objects).values([
    {
      id: serviceId,
      workspaceId,
      objectType: 'service',
      category: 'COMPUTE',
      granularity: 'COMPOUND',
      name: 'notification-service',
      path: '/notification-service',
      depth: 0,
      visibility: 'VISIBLE',
      metadata: {},
    },
    {
      id: brokerId,
      workspaceId,
      objectType: 'message_broker',
      category: 'CHANNEL',
      granularity: 'COMPOUND',
      name: 'kafka',
      path: '/kafka',
      depth: 0,
      visibility: 'VISIBLE',
      metadata: {},
    },
  ]);

  await db.insert(relationCandidates).values({
    id: candidateId,
    workspaceId,
    relationType: input.relationType ?? 'produce',
    subjectObjectId: serviceId,
    objectId: brokerId,
    confidence: input.confidence ?? 0.85,
    metadata: {},
    status: 'PENDING',
  });

  return { candidateId, serviceId, brokerId };
}

async function seedCodeTopicCandidate(
  db: TestDb,
  input: { serviceId: string; topicId: string; relationType?: 'produce' | 'consume' },
) {
  const candidateId = generateId();

  await db.insert(relationCandidates).values({
    id: candidateId,
    workspaceId,
    relationType: input.relationType ?? 'consume',
    subjectObjectId: input.serviceId,
    objectId: input.topicId,
    confidence: 0.8,
    metadata: { source: 'CODE', kind: input.relationType ?? 'consume' },
    status: 'PENDING',
  });

  return { candidateId };
}

async function seedCodeDbTableCandidate(
  db: TestDb,
  input: { serviceId: string; databaseId: string; relationType?: 'read' | 'write' },
) {
  const tableId = generateId();
  const candidateId = generateId();
  await db.insert(objects).values({
    id: tableId,
    workspaceId,
    objectType: 'db_table',
    category: 'DATA',
    granularity: 'ATOMIC',
    name: 'orders',
    path: '/orders',
    depth: 1,
    parentId: input.databaseId,
    visibility: 'VISIBLE',
    metadata: {},
  });

  await db.insert(relationCandidates).values({
    id: candidateId,
    workspaceId,
    relationType: input.relationType ?? 'read',
    subjectObjectId: input.serviceId,
    objectId: tableId,
    confidence: 0.7,
    metadata: { source: 'CODE', kind: 'db_read' },
    status: 'PENDING',
  });

  return { candidateId, tableId };
}

async function seedFkReferenceCandidate(db: TestDb, confidence = 0.95) {
  await db.insert(workspaces).values({ id: workspaceId, name: 'cross-validation-fk-test' });

  const databaseId = generateId();
  const subjectTableId = generateId();
  const objectTableId = generateId();
  const candidateId = generateId();

  await db.insert(objects).values([
    {
      id: databaseId,
      workspaceId,
      objectType: 'database',
      category: 'DATA',
      granularity: 'COMPOUND',
      name: 'order-db',
      path: '/order-db',
      depth: 0,
      visibility: 'VISIBLE',
      metadata: {},
    },
    {
      id: subjectTableId,
      workspaceId,
      objectType: 'db_table',
      category: 'DATA',
      granularity: 'ATOMIC',
      name: 'order_items',
      path: '/order_items',
      depth: 1,
      parentId: databaseId,
      visibility: 'VISIBLE',
      metadata: {},
    },
    {
      id: objectTableId,
      workspaceId,
      objectType: 'db_table',
      category: 'DATA',
      granularity: 'ATOMIC',
      name: 'orders',
      path: '/orders',
      depth: 1,
      parentId: databaseId,
      visibility: 'VISIBLE',
      metadata: {},
    },
  ]);

  await db.insert(relationCandidates).values({
    id: candidateId,
    workspaceId,
    relationType: 'fk_reference',
    subjectObjectId: subjectTableId,
    objectId: objectTableId,
    confidence,
    metadata: { source: 'fk_constraint' },
    status: 'PENDING',
  });

  return { candidateId, subjectTableId, objectTableId };
}

async function seedCodeTableAccessCandidate(
  db: TestDb,
  input: { tableId: string; relationType?: 'read' | 'write' },
) {
  const serviceId = generateId();
  const candidateId = generateId();

  await db.insert(objects).values({
    id: serviceId,
    workspaceId,
    objectType: 'service',
    category: 'COMPUTE',
    granularity: 'COMPOUND',
    name: 'order-service',
    path: '/order-service',
    depth: 0,
    visibility: 'VISIBLE',
    metadata: {},
  });

  await db.insert(relationCandidates).values({
    id: candidateId,
    workspaceId,
    relationType: input.relationType ?? 'read',
    subjectObjectId: serviceId,
    objectId: input.tableId,
    confidence: 0.7,
    metadata: { source: 'CODE', kind: 'db_read' },
    status: 'PENDING',
  });

  return { candidateId, serviceId };
}

async function seedEndpointObject(
  db: TestDb,
  input: { serviceId: string; name?: string; path?: string },
) {
  const endpointId = generateId();

  await db.insert(objects).values({
    id: endpointId,
    workspaceId,
    objectType: 'api_endpoint',
    category: 'COMPUTE',
    granularity: 'ATOMIC',
    name: input.name ?? 'GET /api/orders',
    displayName: input.name ?? 'GET /api/orders',
    parentId: input.serviceId,
    path: input.path ?? '/orders/get-api-orders',
    depth: 1,
    visibility: 'VISIBLE',
    metadata: { method: 'GET', path: '/api/orders' },
  });

  return { endpointId };
}

async function seedEndpointCallCandidate(
  db: TestDb,
  input: { subjectObjectId: string; endpointId: string; source?: string },
) {
  const candidateId = generateId();

  await db.insert(relationCandidates).values({
    id: candidateId,
    workspaceId,
    relationType: 'call',
    subjectObjectId: input.subjectObjectId,
    objectId: input.endpointId,
    confidence: 0.7,
    metadata: {
      source: input.source ?? 'CODE',
      targetType: 'api_endpoint',
    },
    status: 'PENDING',
  });

  return { candidateId };
}

async function seedApprovedEndpointCallRelation(
  db: TestDb,
  input: { subjectObjectId: string; endpointId: string; source?: string | null },
) {
  const relationId = generateId();

  await db.insert(objectRelations).values({
    id: relationId,
    workspaceId,
    relationType: 'call',
    subjectObjectId: input.subjectObjectId,
    objectId: input.endpointId,
    confidence: 0.7,
    status: 'APPROVED',
    source: 'INFERRED',
    metadata: input.source ? { source: input.source, targetType: 'api_endpoint' } : {},
  });

  return { relationId };
}

async function linkEvidence(
  db: TestDb,
  candidateId: string,
  evidenceType: 'CONFIG' | 'FILE' | 'SCHEMA' | 'LLM_CONFIG' | 'LLM_CODE',
) {
  const evidenceId = generateId();
  await db.insert(evidences).values({
    id: evidenceId,
    workspaceId,
    evidenceType,
    excerpt: `${evidenceType} evidence`,
    metadata: {},
  });
  await db.insert(relationCandidateEvidences).values({
    workspaceId,
    candidateId,
    evidenceId,
  });

  return evidenceId;
}

async function seedDefaultCrossValidationProfile(
  db: TestDb,
  crossValidation: { enabled?: boolean; boostFactor?: number; penaltyFactor?: number },
) {
  await db.execute(sql`
    insert into domain_inference_profiles (
      workspace_id,
      name,
      kind,
      is_default,
      cross_validation
    ) values (
      ${workspaceId},
      'default',
      'NAMED',
      true,
      ${JSON.stringify({
        enabled: crossValidation.enabled ?? true,
        boostFactor: crossValidation.boostFactor ?? 0.3,
        penaltyFactor: crossValidation.penaltyFactor ?? 0.85,
      })}::jsonb
    )
  `);
}

describe('crossValidatePendingRelationCandidates', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
  });

  it('다중 소스 지지 후보의 confidence를 부스트하고 metadata를 기록해야 한다', async () => {
    const { candidateId } = await seedBaseCandidate(db, 0.6);
    await linkEvidence(db, candidateId, 'CONFIG');
    await linkEvidence(db, candidateId, 'FILE');

    const result = await crossValidatePendingRelationCandidates(db, { workspaceId });

    expect(result).toMatchObject({
      candidateCount: 1,
      validatedCount: 1,
      skippedSingleSourceCount: 0,
    });

    const rows = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId));
    const candidate = rows[0]!;
    const metadata = candidate.metadata as Record<string, unknown>;
    const crossValidation = metadata['crossValidation'] as Record<string, unknown>;

    expect(candidate.confidence).toBeCloseTo(0.9);
    expect(crossValidation['validated']).toBe(true);
    expect(crossValidation['supportingSources']).toEqual(['config', 'code']);
    expect(crossValidation['originalConfidence']).toBe(0.6);
    expect(crossValidation['adjustedConfidence']).toBeCloseTo(0.9);
  });

  it('LLM evidence 타입도 config/code 지원 소스로 인식해야 한다', async () => {
    const { candidateId } = await seedBaseCandidate(db, 0.6);
    await linkEvidence(db, candidateId, 'LLM_CONFIG');
    await linkEvidence(db, candidateId, 'LLM_CODE');

    const result = await crossValidatePendingRelationCandidates(db, { workspaceId });

    expect(result).toMatchObject({
      candidateCount: 1,
      validatedCount: 1,
      skippedSingleSourceCount: 0,
    });

    const [candidate] = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId));
    const crossValidation = (
      (candidate?.metadata as Record<string, unknown>)['crossValidation']
    ) as Record<string, unknown>;

    expect(candidate?.confidence).toBeCloseTo(0.9);
    expect(crossValidation['supportingSources']).toEqual(['config', 'code']);
    expect(crossValidation['validated']).toBe(true);
  });

  it('단일 소스 후보는 no-op 이어야 한다', async () => {
    const { candidateId } = await seedBaseCandidate(db, 0.65);
    await linkEvidence(db, candidateId, 'CONFIG');

    const result = await crossValidatePendingRelationCandidates(db, { workspaceId });

    expect(result).toMatchObject({
      candidateCount: 1,
      validatedCount: 0,
      skippedSingleSourceCount: 1,
    });

    const rows = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId));
    expect(rows[0]?.confidence).toBe(0.65);
    expect((rows[0]?.metadata as Record<string, unknown>)['crossValidation']).toBeUndefined();
  });

  it('재실행해도 originalConfidence 기준으로 같은 adjustedConfidence를 유지해야 한다', async () => {
    const { candidateId } = await seedBaseCandidate(db, 0.55);
    await linkEvidence(db, candidateId, 'CONFIG');
    await linkEvidence(db, candidateId, 'SCHEMA');

    await crossValidatePendingRelationCandidates(db, { workspaceId });
    await crossValidatePendingRelationCandidates(db, { workspaceId });

    const rows = await db
      .select()
      .from(relationCandidates)
      .where(
        and(
          eq(relationCandidates.workspaceId, workspaceId),
          eq(relationCandidates.id, candidateId),
        ),
      );
    const candidate = rows[0]!;
    const metadata = candidate.metadata as Record<string, unknown>;
    const crossValidation = metadata['crossValidation'] as Record<string, unknown>;

    expect(candidate.confidence).toBeCloseTo(0.85);
    expect(crossValidation['originalConfidence']).toBe(0.55);
    expect(crossValidation['adjustedConfidence']).toBeCloseTo(0.85);
  });

  it('다중 소스 후보가 단일 소스로 돌아가면 confidence와 crossValidation 상태를 원복해야 한다', async () => {
    const { candidateId } = await seedBaseCandidate(db, 0.55);
    await linkEvidence(db, candidateId, 'CONFIG');
    const codeEvidenceId = await linkEvidence(db, candidateId, 'FILE');

    await crossValidatePendingRelationCandidates(db, { workspaceId });

    await db.delete(relationCandidateEvidences).where(eq(relationCandidateEvidences.evidenceId, codeEvidenceId));
    await db.delete(evidences).where(eq(evidences.id, codeEvidenceId));

    const result = await crossValidatePendingRelationCandidates(db, { workspaceId });

    expect(result).toMatchObject({
      candidateCount: 1,
      validatedCount: 0,
      skippedSingleSourceCount: 1,
      contradictionCount: 0,
    });

    const [candidate] = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId));

    expect(candidate?.confidence).toBeCloseTo(0.55);
    expect((candidate?.metadata as Record<string, unknown>)['crossValidation']).toBeUndefined();
  });

  it('profile boostFactor 값을 사용해 multi-source boost를 계산해야 한다', async () => {
    const { candidateId } = await seedBaseCandidate(db, 0.6);
    await seedDefaultCrossValidationProfile(db, { boostFactor: 0.1 });
    await linkEvidence(db, candidateId, 'CONFIG');
    await linkEvidence(db, candidateId, 'FILE');

    await crossValidatePendingRelationCandidates(db, { workspaceId });

    const rows = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId));
    const candidate = rows[0]!;
    const crossValidation = (
      (candidate.metadata as Record<string, unknown>)['crossValidation']
    ) as Record<string, unknown>;

    expect(candidate.confidence).toBeCloseTo(0.7);
    expect(crossValidation['adjustedConfidence']).toBeCloseTo(0.7);
  });

  it('profile penaltyFactor 값을 사용해 contradiction penalty를 계산해야 한다', async () => {
    const { candidateId } = await seedDatabaseCandidate(db, 0.9);
    await seedDefaultCrossValidationProfile(db, { penaltyFactor: 0.9 });
    await linkEvidence(db, candidateId, 'CONFIG');

    await crossValidatePendingRelationCandidates(db, { workspaceId });

    const rows = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId));
    const candidate = rows[0]!;
    const crossValidation = (
      (candidate.metadata as Record<string, unknown>)['crossValidation']
    ) as Record<string, unknown>;

    expect(candidate.confidence).toBeCloseTo(0.8);
    expect(crossValidation['contradictions']).toEqual([
      { ruleId: 'C1', type: 'STALE_CONFIG', penalty: 0.1 },
    ]);
  });

  it('profile 에서 cross validation 이 비활성화되면 no-op 이어야 한다', async () => {
    const { candidateId } = await seedBaseCandidate(db, 0.6);
    await seedDefaultCrossValidationProfile(db, { enabled: false });
    await linkEvidence(db, candidateId, 'CONFIG');
    await linkEvidence(db, candidateId, 'FILE');

    const result = await crossValidatePendingRelationCandidates(db, { workspaceId });

    expect(result).toMatchObject({
      candidateCount: 0,
      validatedCount: 0,
      skippedSingleSourceCount: 0,
      contradictionCount: 0,
      staleConfigCount: 0,
    });

    const rows = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId));
    expect(rows[0]?.confidence).toBe(0.6);
    expect((rows[0]?.metadata as Record<string, unknown>)['crossValidation']).toBeUndefined();
  });

  it('profile 에서 cross validation 을 비활성화하면 기존 metadata와 confidence를 원복해야 한다', async () => {
    const { candidateId } = await seedBaseCandidate(db, 0.6);
    await linkEvidence(db, candidateId, 'CONFIG');
    await linkEvidence(db, candidateId, 'FILE');

    await crossValidatePendingRelationCandidates(db, { workspaceId });
    await seedDefaultCrossValidationProfile(db, { enabled: false });

    const result = await crossValidatePendingRelationCandidates(db, { workspaceId });

    expect(result).toMatchObject({
      candidateCount: 0,
      validatedCount: 0,
    });

    const [candidate] = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId));

    expect(candidate?.confidence).toBeCloseTo(0.6);
    expect((candidate?.metadata as Record<string, unknown>)['crossValidation']).toBeUndefined();
  });

  it('config 기반 database 후보에 code 하위 db_table 접근이 없으면 STALE_CONFIG를 기록해야 한다', async () => {
    const { candidateId } = await seedDatabaseCandidate(db, 0.9);
    await linkEvidence(db, candidateId, 'CONFIG');

    const result = await crossValidatePendingRelationCandidates(db, { workspaceId });

    expect(result).toMatchObject({
      candidateCount: 1,
      validatedCount: 0,
      skippedSingleSourceCount: 0,
      contradictionCount: 1,
      staleConfigCount: 1,
    });

    const rows = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId));
    const candidate = rows[0]!;
    const metadata = candidate.metadata as Record<string, unknown>;
    const crossValidation = metadata['crossValidation'] as Record<string, unknown>;

    expect(candidate.confidence).toBeCloseTo(0.75);
    expect(crossValidation['validated']).toBe(false);
    expect(crossValidation['supportingSources']).toEqual(['config']);
    expect(crossValidation['originalConfidence']).toBe(0.9);
    expect(crossValidation['adjustedConfidence']).toBeCloseTo(0.75);
    expect(crossValidation['contradictions']).toEqual([
      { ruleId: 'C1', type: 'STALE_CONFIG', penalty: 0.15 },
    ]);
  });

  it('같은 database 하위 db_table에 대한 code 후보가 있으면 STALE_CONFIG를 기록하지 않아야 한다', async () => {
    const { candidateId, serviceId, databaseId } = await seedDatabaseCandidate(db, 0.9);
    await linkEvidence(db, candidateId, 'CONFIG');
    await seedCodeDbTableCandidate(db, { serviceId, databaseId });

    const result = await crossValidatePendingRelationCandidates(db, { workspaceId });

    expect(result).toMatchObject({
      candidateCount: 2,
      validatedCount: 0,
      skippedSingleSourceCount: 2,
      contradictionCount: 0,
      staleConfigCount: 0,
    });

    const rows = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId));
    const candidate = rows[0]!;
    expect(candidate.confidence).toBe(0.9);
    expect((candidate.metadata as Record<string, unknown>)['crossValidation']).toBeUndefined();
  });

  it('code 기반 service call 후보에 endpoint 근거가 없으면 PHANTOM_CALL을 기록해야 한다', async () => {
    const { candidateId } = await seedBaseCandidate(db, 0.6);
    await linkEvidence(db, candidateId, 'FILE');

    const result = await crossValidatePendingRelationCandidates(db, { workspaceId });

    expect(result).toMatchObject({
      candidateCount: 1,
      validatedCount: 0,
      skippedSingleSourceCount: 0,
      contradictionCount: 1,
    });

    const rows = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId));
    const candidate = rows[0]!;
    const metadata = candidate.metadata as Record<string, unknown>;
    const crossValidation = metadata['crossValidation'] as Record<string, unknown>;

    expect(candidate.confidence).toBeCloseTo(0.45);
    expect(crossValidation['validated']).toBe(false);
    expect(crossValidation['supportingSources']).toEqual(['code']);
    expect(crossValidation['originalConfidence']).toBe(0.6);
    expect(crossValidation['adjustedConfidence']).toBeCloseTo(0.45);
    expect(crossValidation['contradictions']).toEqual([
      { ruleId: 'C2', type: 'PHANTOM_CALL', penalty: 0.15 },
    ]);
  });

  it('같은 서비스 쌍의 endpoint 후보 근거가 있으면 PHANTOM_CALL을 기록하지 않아야 한다', async () => {
    const { candidateId, sourceServiceId, targetServiceId } = await seedBaseCandidate(db, 0.6);
    await linkEvidence(db, candidateId, 'FILE');
    const { endpointId } = await seedEndpointObject(db, { serviceId: targetServiceId });
    await seedEndpointCallCandidate(db, { subjectObjectId: sourceServiceId, endpointId });

    const result = await crossValidatePendingRelationCandidates(db, { workspaceId });

    expect(result).toMatchObject({
      candidateCount: 2,
      validatedCount: 0,
      skippedSingleSourceCount: 2,
      contradictionCount: 0,
    });

    const rows = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId));
    const candidate = rows[0]!;
    expect(candidate.confidence).toBe(0.6);
    expect((candidate.metadata as Record<string, unknown>)['crossValidation']).toBeUndefined();
  });

  it('LLM_CODE endpoint 후보도 PHANTOM_CALL 근거로 사용해야 한다', async () => {
    const { candidateId, sourceServiceId, targetServiceId } = await seedBaseCandidate(db, 0.6);
    await linkEvidence(db, candidateId, 'FILE');
    const { endpointId } = await seedEndpointObject(db, { serviceId: targetServiceId });
    await seedEndpointCallCandidate(
      db,
      { subjectObjectId: sourceServiceId, endpointId, source: 'LLM_CODE' },
    );

    const result = await crossValidatePendingRelationCandidates(db, { workspaceId });

    expect(result).toMatchObject({
      candidateCount: 2,
      validatedCount: 0,
      skippedSingleSourceCount: 2,
      contradictionCount: 0,
    });

    const [candidate] = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId));

    expect((candidate?.metadata as Record<string, unknown>)['crossValidation']).toBeUndefined();
  });

  it('provenance 없는 승인 endpoint relation은 PHANTOM_CALL 근거로 사용하지 않아야 한다', async () => {
    const { candidateId, sourceServiceId, targetServiceId } = await seedBaseCandidate(db, 0.6);
    await linkEvidence(db, candidateId, 'FILE');
    const { endpointId } = await seedEndpointObject(db, { serviceId: targetServiceId });
    await seedApprovedEndpointCallRelation(db, { subjectObjectId: sourceServiceId, endpointId });

    const result = await crossValidatePendingRelationCandidates(db, { workspaceId });

    expect(result).toMatchObject({
      candidateCount: 1,
      validatedCount: 0,
      skippedSingleSourceCount: 0,
      contradictionCount: 1,
    });

    const [candidate] = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId));
    const crossValidation = (
      (candidate?.metadata as Record<string, unknown>)['crossValidation']
    ) as Record<string, unknown>;

    expect(crossValidation['contradictions']).toEqual([
      { ruleId: 'C2', type: 'PHANTOM_CALL', penalty: 0.15 },
    ]);
  });

  it('code provenance가 있는 승인 endpoint relation은 PHANTOM_CALL 근거로 사용해야 한다', async () => {
    const { candidateId, sourceServiceId, targetServiceId } = await seedBaseCandidate(db, 0.6);
    await linkEvidence(db, candidateId, 'FILE');
    const { endpointId } = await seedEndpointObject(db, { serviceId: targetServiceId });
    await seedApprovedEndpointCallRelation(
      db,
      { subjectObjectId: sourceServiceId, endpointId, source: 'CODE' },
    );

    const result = await crossValidatePendingRelationCandidates(db, { workspaceId });

    expect(result).toMatchObject({
      candidateCount: 1,
      validatedCount: 0,
      skippedSingleSourceCount: 1,
      contradictionCount: 0,
    });

    const [candidate] = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId));

    expect((candidate?.metadata as Record<string, unknown>)['crossValidation']).toBeUndefined();
  });

  it('config 기반 topic 후보에 code produce/consume 후보가 없으면 DEAD_TOPIC을 기록해야 한다', async () => {
    const { candidateId } = await seedTopicCandidate(db, { relationType: 'consume', confidence: 0.85 });
    await linkEvidence(db, candidateId, 'CONFIG');

    const result = await crossValidatePendingRelationCandidates(db, { workspaceId });

    expect(result).toMatchObject({
      candidateCount: 1,
      validatedCount: 0,
      skippedSingleSourceCount: 0,
      contradictionCount: 1,
    });

    const rows = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId));
    const candidate = rows[0]!;
    const metadata = candidate.metadata as Record<string, unknown>;
    const crossValidation = metadata['crossValidation'] as Record<string, unknown>;

    expect(candidate.confidence).toBeCloseTo(0.7);
    expect(crossValidation['validated']).toBe(false);
    expect(crossValidation['supportingSources']).toEqual(['config']);
    expect(crossValidation['originalConfidence']).toBe(0.85);
    expect(crossValidation['adjustedConfidence']).toBeCloseTo(0.7);
    expect(crossValidation['contradictions']).toEqual([
      { ruleId: 'C3', type: 'DEAD_TOPIC', penalty: 0.15 },
    ]);
  });

  it('같은 서비스와 topic에 대한 code produce/consume 후보가 있으면 DEAD_TOPIC을 기록하지 않아야 한다', async () => {
    const { candidateId, serviceId, topicId } = await seedTopicCandidate(db, { relationType: 'produce' });
    await linkEvidence(db, candidateId, 'CONFIG');
    await seedCodeTopicCandidate(db, { serviceId, topicId, relationType: 'produce' });

    const result = await crossValidatePendingRelationCandidates(db, { workspaceId });

    expect(result).toMatchObject({
      candidateCount: 2,
      validatedCount: 0,
      skippedSingleSourceCount: 2,
      contradictionCount: 0,
    });

    const rows = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId));
    const candidate = rows[0]!;
    expect(candidate.confidence).toBe(0.85);
    expect((candidate.metadata as Record<string, unknown>)['crossValidation']).toBeUndefined();
  });

  it('message_broker 대상 produce 후보는 DEAD_TOPIC 판정에서 제외해야 한다', async () => {
    const { candidateId } = await seedBrokerCandidate(db, { relationType: 'produce', confidence: 0.85 });
    await linkEvidence(db, candidateId, 'CONFIG');

    const result = await crossValidatePendingRelationCandidates(db, { workspaceId });

    expect(result).toMatchObject({
      candidateCount: 1,
      validatedCount: 0,
      skippedSingleSourceCount: 1,
      contradictionCount: 0,
    });

    const [candidate] = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId));

    expect(candidate?.confidence).toBeCloseTo(0.85);
    expect((candidate?.metadata as Record<string, unknown>)['crossValidation']).toBeUndefined();
  });

  it('db FK 기반 후보인데 code 테이블 접근이 없으면 ORPHAN_FK를 기록해야 한다', async () => {
    const { candidateId } = await seedFkReferenceCandidate(db, 0.95);
    await linkEvidence(db, candidateId, 'SCHEMA');

    const result = await crossValidatePendingRelationCandidates(db, { workspaceId });

    expect(result).toMatchObject({
      candidateCount: 1,
      validatedCount: 0,
      skippedSingleSourceCount: 0,
      contradictionCount: 1,
    });

    const rows = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId));
    const candidate = rows[0]!;
    const metadata = candidate.metadata as Record<string, unknown>;
    const crossValidation = metadata['crossValidation'] as Record<string, unknown>;

    expect(candidate.confidence).toBeCloseTo(0.8);
    expect(crossValidation['validated']).toBe(false);
    expect(crossValidation['supportingSources']).toEqual(['db']);
    expect(crossValidation['originalConfidence']).toBe(0.95);
    expect(crossValidation['adjustedConfidence']).toBeCloseTo(0.8);
    expect(crossValidation['contradictions']).toEqual([
      { ruleId: 'C4', type: 'ORPHAN_FK', penalty: 0.15 },
    ]);
  });

  it('db FK 기반 후보에 code 테이블 접근이 있으면 ORPHAN_FK를 기록하지 않아야 한다', async () => {
    const { candidateId, subjectTableId } = await seedFkReferenceCandidate(db, 0.95);
    await linkEvidence(db, candidateId, 'SCHEMA');
    await seedCodeTableAccessCandidate(db, { tableId: subjectTableId });

    const result = await crossValidatePendingRelationCandidates(db, { workspaceId });

    expect(result).toMatchObject({
      candidateCount: 2,
      validatedCount: 0,
      skippedSingleSourceCount: 2,
      contradictionCount: 0,
    });

    const rows = await db
      .select()
      .from(relationCandidates)
      .where(eq(relationCandidates.id, candidateId));
    const candidate = rows[0]!;
    expect(candidate.confidence).toBe(0.95);
    expect((candidate.metadata as Record<string, unknown>)['crossValidation']).toBeUndefined();
  });
});
