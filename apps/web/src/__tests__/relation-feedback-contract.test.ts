// @vitest-environment node

import { beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { and, eq } from 'drizzle-orm';
import {
  createPgliteClient,
  domainInferenceProfiles,
  objects,
  relationCandidates,
  workspaces,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import { approveRelationCandidate } from '../../../../packages/inference/src/relation/approveRelationCandidate';
import { applyFeedbackToRelationCandidateInput } from '../../../../packages/inference/src/relation/feedbackLoop';

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

  it('code-origin + framework/language가 있으면 specialized v2 key를 사용해야 한다', async () => {
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

    expect(Object.keys(adjustments)).toEqual(['CALL:code:call:spring_boot:java']);
    expect(adjustments['CALL:code:call:spring_boot:java']).toMatchObject({
      approved: 1,
      rejected: 0,
      total: 1,
    });
  });

  it('다음 run에 적용되는 feedback metadata도 specialized key와 observability 필드만 일관되게 만든다', async () => {
    const [profile] = await db
      .select({ id: domainInferenceProfiles.id })
      .from(domainInferenceProfiles)
      .where(
        and(
          eq(domainInferenceProfiles.workspaceId, workspaceId),
          eq(domainInferenceProfiles.isDefault, true),
        ),
      );

    await db
      .update(domainInferenceProfiles)
      .set({
        feedbackConfig: {
          enabled: true,
          minSamples: 10,
          maxAdjustment: 0.15,
        },
        feedbackAdjustments: {
          'CALL:code:call:spring_boot:java': {
            approved: 9,
            rejected: 1,
            total: 10,
            approvalRate: 0.9,
            adjustment: 0.06,
          },
        },
      })
      .where(eq(domainInferenceProfiles.id, profile!.id));

    const adjusted = await applyFeedbackToRelationCandidateInput(db, {
      workspaceId,
      relationType: 'call',
      subjectObjectId,
      objectId,
      confidence: 0.7,
      metadata: {
        source: 'CODE',
        signalKind: 'call',
        framework: 'spring-boot',
        language: 'java',
      },
    });

    expect(adjusted.confidence).toBe(0.76);
    expect(adjusted.metadata).toMatchObject({
      feedback: {
        key: 'CALL:code:call:spring_boot:java',
        applied: true,
        sampleCount: 10,
        adjustment: 0.06,
        baseConfidence: 0.7,
        adjustedConfidence: 0.76,
      },
    });
    expect((adjusted.metadata.feedback as Record<string, unknown>)['sourceFamily']).toBe('code');
    expect((adjusted.metadata.feedback as Record<string, unknown>)['signalKind']).toBe('call');
    expect((adjusted.metadata.feedback as Record<string, unknown>)).not.toHaveProperty('keyVersion');
  });

  it('framework/language가 없으면 legacy v1 key로 fallback 해야 한다', async () => {
    const [profile] = await db
      .select({ id: domainInferenceProfiles.id })
      .from(domainInferenceProfiles)
      .where(
        and(
          eq(domainInferenceProfiles.workspaceId, workspaceId),
          eq(domainInferenceProfiles.isDefault, true),
        ),
      );

    await db
      .update(domainInferenceProfiles)
      .set({
        feedbackConfig: {
          enabled: true,
          minSamples: 10,
          maxAdjustment: 0.15,
        },
        feedbackAdjustments: {
          'CALL:code:call': {
            approved: 9,
            rejected: 1,
            total: 10,
            approvalRate: 0.9,
            adjustment: 0.06,
          },
        },
      })
      .where(eq(domainInferenceProfiles.id, profile!.id));

    const adjusted = await applyFeedbackToRelationCandidateInput(db, {
      workspaceId,
      relationType: 'call',
      subjectObjectId,
      objectId,
      confidence: 0.7,
      metadata: {
        source: 'CODE',
        signalKind: 'call',
      },
    });

    expect(adjusted.confidence).toBe(0.76);
    expect(adjusted.metadata).toMatchObject({
      feedback: {
        key: 'CALL:code:call',
        applied: true,
        sampleCount: 10,
        adjustment: 0.06,
        baseConfidence: 0.7,
        adjustedConfidence: 0.76,
      },
    });
  });
});
