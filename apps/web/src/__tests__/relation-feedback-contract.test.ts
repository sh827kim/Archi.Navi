// @vitest-environment node

import { beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { eq } from 'drizzle-orm';
import {
  createPgliteClient,
  domainInferenceProfiles,
  objects,
  relationCandidates,
  workspaces,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import { approveRelationCandidate } from '../../../../packages/inference/src/relation/approveRelationCandidate';

const MIGRATIONS_FOLDER = join(process.cwd(), '../../packages/db/src/migrations');
const workspaceId = '00000000-0000-0000-0000-000000000091';

async function createTestDb() {
  const db = createPgliteClient();
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

describe('relation feedback contract', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let subjectObjectId: string;
  let objectId: string;

  beforeEach(async () => {
    db = await createTestDb();
    await db.insert(workspaces).values({ id: workspaceId, name: 'feedback-contract-test' });

    subjectObjectId = generateId();
    objectId = generateId();

    await db.insert(objects).values([
      {
        id: subjectObjectId,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'gateway',
        path: `/gateway/${subjectObjectId}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
      {
        id: objectId,
        workspaceId,
        objectType: 'service',
        category: 'COMPUTE',
        granularity: 'COMPOUND',
        name: 'orders',
        path: `/orders/${objectId}`,
        depth: 0,
        visibility: 'VISIBLE',
        metadata: {},
      },
    ]);

    await db.insert(domainInferenceProfiles).values({
      id: generateId(),
      workspaceId,
      name: 'default',
      kind: 'NAMED',
      isDefault: true,
    });
  });

  it('feedback key는 relationType + sourceFamily + signalKind canonical key만 사용해야 한다', async () => {
    const candidateId = generateId();

    await db.insert(relationCandidates).values({
      id: candidateId,
      workspaceId,
      relationType: 'call',
      subjectObjectId,
      objectId,
      confidence: 0.74,
      metadata: {
        source: 'CODE',
        signalKind: 'call',
        framework: 'spring-boot',
        language: 'java',
      },
      status: 'PENDING',
    });

    await approveRelationCandidate(db, candidateId, 'APPROVED');

    const [profile] = await db
      .select({ feedbackAdjustments: domainInferenceProfiles.feedbackAdjustments })
      .from(domainInferenceProfiles)
      .where(eq(domainInferenceProfiles.workspaceId, workspaceId));
    const adjustments = (profile?.feedbackAdjustments ?? {}) as Record<string, {
      approved: number;
      rejected: number;
      total: number;
    }>;

    expect(Object.keys(adjustments)).toEqual(['CALL:code:call']);
    expect(adjustments['CALL:code:call']).toMatchObject({
      approved: 1,
      rejected: 0,
      total: 1,
    });
  });
});
