import type { DbClient } from '@archi-navi/db';
import { incrementalRebuild, type ChangeEvent } from '@archi-navi/core';

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

type RollupChangeListener = (notification: RollupChangeNotification) => void;

const rollupChangeListeners = new Map<string, Set<RollupChangeListener>>();

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

export function subscribeRollupChangeEvents(
  workspaceId: string,
  listener: RollupChangeListener,
): () => void {
  const listeners = rollupChangeListeners.get(workspaceId) ?? new Set<RollupChangeListener>();
  listeners.add(listener);
  rollupChangeListeners.set(workspaceId, listeners);

  return () => {
    const currentListeners = rollupChangeListeners.get(workspaceId);
    if (!currentListeners) return;

    currentListeners.delete(listener);
    if (currentListeners.size === 0) {
      rollupChangeListeners.delete(workspaceId);
    }
  };
}

export function publishRollupChangeNotification(
  workspaceId: string,
  events: ChangeEvent[],
): void {
  if (events.length === 0) return;

  const listeners = rollupChangeListeners.get(workspaceId);
  if (!listeners || listeners.size === 0) return;

  const notification: RollupChangeNotification = {
    type: 'ROLLUP_CHANGED',
    workspaceId,
    eventCount: events.length,
    events,
    emittedAt: new Date().toISOString(),
  };

  for (const listener of listeners) {
    try {
      listener(notification);
    } catch (error) {
      console.error('[publishRollupChangeNotification]', error);
    }
  }
}

export function resetRollupChangeEventSubscribersForTest(): void {
  rollupChangeListeners.clear();
}

export async function applyRollupChanges(
  db: DbClient,
  workspaceId: string,
  events: ChangeEvent[],
): Promise<void> {
  if (events.length === 0) return;
  await incrementalRebuild(db, workspaceId, events);
  publishRollupChangeNotification(workspaceId, events);
}
