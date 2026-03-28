import type { DbClient } from '@archi-navi/db';
import { rollupGenerations } from '@archi-navi/db';
import { and, desc, eq } from 'drizzle-orm';
import {
  getActiveGeneration,
  incrementalRebuild,
  type ChangeEvent,
  updateGenerationMeta,
} from '@archi-navi/core';

interface RelationPayloadLike {
  relationType: string;
  subjectObjectId: string;
  objectId: string;
}

export interface RollupChangeNotification {
  type: 'ROLLUP_CHANGED';
  workspaceId: string;
  eventCount: number;
  events: ChangeEvent[];
  emittedAt: string;
}

export interface WorkspaceRollupChangeCursor {
  workspaceId: string;
  generationVersion: number;
  builtAt: string;
  changeToken: string;
}

const ROLLUP_CHANGE_TOKEN_KEY = 'rollupChangeToken';

export function createRelationChangeEvent(
  action: 'APPROVED' | 'DELETED',
  relation: RelationPayloadLike,
): ChangeEvent {
  if (relation.relationType === 'expose') {
    return {
      type: 'EXPOSE_CHANGED',
      payload: {
        relationType: relation.relationType,
        subjectObjectId: relation.subjectObjectId,
        objectId: relation.objectId,
      },
    };
  }

  return {
    type: action === 'APPROVED' ? 'RELATION_APPROVED' : 'RELATION_DELETED',
    payload: {
      relationType: relation.relationType,
      subjectObjectId: relation.subjectObjectId,
      objectId: relation.objectId,
    },
  };
}

export function createDomainAffinityChangedEvent(
  objectId: string,
  domainId: string,
): ChangeEvent {
  return {
    type: 'DOMAIN_AFFINITY_CHANGED',
    payload: {
      objectId,
      domainId,
    },
  };
}

export function isApprovedBaseRelation(
  status: string,
  isDerived: boolean,
): boolean {
  return status === 'APPROVED' && isDerived === false;
}

function getChangeTokenFromMeta(meta: unknown): string | null {
  if (!meta || typeof meta !== 'object') return null;
  const token = (meta as Record<string, unknown>)[ROLLUP_CHANGE_TOKEN_KEY];
  return typeof token === 'string' && token.length > 0 ? token : null;
}

export async function getWorkspaceRollupChangeCursor(
  db: DbClient,
  workspaceId: string,
): Promise<WorkspaceRollupChangeCursor | null> {
  const activeGeneration = await db
    .select({
      generationVersion: rollupGenerations.generationVersion,
      builtAt: rollupGenerations.builtAt,
      meta: rollupGenerations.meta,
    })
    .from(rollupGenerations)
    .where(
      and(
        eq(rollupGenerations.workspaceId, workspaceId),
        eq(rollupGenerations.status, 'ACTIVE'),
      ),
    )
    .orderBy(desc(rollupGenerations.generationVersion))
    .limit(1);

  const current = activeGeneration[0];
  if (!current) return null;

  const builtAtIso = current.builtAt.toISOString();
  const changeToken =
    getChangeTokenFromMeta(current.meta) ?? `${current.generationVersion}:${builtAtIso}`;

  return {
    workspaceId,
    generationVersion: current.generationVersion,
    builtAt: builtAtIso,
    changeToken,
  };
}

function createRollupChangeToken(events: ChangeEvent[]): string {
  const emittedAt = new Date().toISOString();
  return `${emittedAt}:${events.length}`;
}

export async function applyRollupChanges(
  db: DbClient,
  workspaceId: string,
  events: ChangeEvent[],
): Promise<void> {
  if (events.length === 0) return;

  await incrementalRebuild(db, workspaceId, events);

  const activeGeneration = await getActiveGeneration(db, workspaceId);
  if (activeGeneration === null) return;

  await updateGenerationMeta(db, workspaceId, activeGeneration, {
    [ROLLUP_CHANGE_TOKEN_KEY]: createRollupChangeToken(events),
  });
}
