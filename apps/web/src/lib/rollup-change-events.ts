import type { DbClient } from '@archi-navi/db';
import { incrementalRebuild, type ChangeEvent } from '@archi-navi/core';

interface RelationPayloadLike {
  relationType: string;
  subjectObjectId: string;
  objectId: string;
}

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

export async function applyRollupChanges(
  db: DbClient,
  workspaceId: string,
  events: ChangeEvent[],
): Promise<void> {
  if (events.length === 0) return;
  await incrementalRebuild(db, workspaceId, events);
}
