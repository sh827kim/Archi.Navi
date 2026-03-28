import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import {
  objectGraphStats,
  objectRelations,
  objectRollupProvenances,
  objectRollups,
  rollupGenerations,
} from '@archi-navi/db';
import type { ChangeEvent } from '../../../rollup/types';
import * as builder from '../../../rollup/builder.ts';

const incrementalRebuild =
  (builder as { incrementalRebuild?: typeof import('../../../rollup/builder').incrementalRebuild })
    .incrementalRebuild ??
  (
    builder as {
      default?: { incrementalRebuild?: typeof import('../../../rollup/builder').incrementalRebuild };
    }
  ).default?.incrementalRebuild;

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';

function id(suffix: string): string {
  return `00000000-0000-0000-0000-${suffix.padStart(12, '0')}`;
}

function makeObject(overrides: {
  id: string;
  objectType: string;
  name: string;
  parentId?: string | null;
}) {
  return {
    id: overrides.id,
    workspaceId: WORKSPACE_ID,
    objectType: overrides.objectType,
    category:
      overrides.objectType === 'service'
        ? 'COMPUTE'
        : overrides.objectType === 'database' || overrides.objectType === 'db_table'
          ? 'STORAGE'
          : 'META',
    granularity: ['service', 'database'].includes(overrides.objectType)
      ? 'COMPOUND'
      : 'ATOMIC',
    name: overrides.name,
    displayName: overrides.name,
    description: null,
    urn: null,
    parentId: overrides.parentId ?? null,
    path: overrides.name,
    depth: 0,
    visibility: 'VISIBLE' as const,
    metadata: {},
    validFrom: null,
    validTo: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeRelation(overrides: {
  id: string;
  relationType: string;
  subjectObjectId: string;
  objectId: string;
  confidence?: number | null;
}) {
  return {
    id: overrides.id,
    workspaceId: WORKSPACE_ID,
    relationType: overrides.relationType,
    subjectObjectId: overrides.subjectObjectId,
    objectId: overrides.objectId,
    interactionKind: null,
    direction: null,
    isDerived: false,
    confidence: overrides.confidence ?? null,
    status: 'APPROVED' as const,
    metadata: {},
    source: 'MANUAL' as const,
    validFrom: null,
    validTo: null,
    createdAt: new Date(),
  };
}

type RelationRow = ReturnType<typeof makeRelation>;
type ObjectRow = ReturnType<typeof makeObject>;
type RelationApprovedEvent = Extract<ChangeEvent, { type: 'RELATION_APPROVED' }>;

interface RollupState {
  rollups: Array<Record<string, unknown>>;
  provenances: Array<Record<string, unknown>>;
  graphStats: Array<Record<string, unknown>>;
}

interface GenerationRow {
  workspaceId: string;
  generationVersion: number;
  status: 'ACTIVE' | 'BUILDING' | 'ARCHIVED';
  meta: Record<string, unknown>;
  builtAt?: Date;
}

interface QueryCounters {
  selects: number;
  inserts: number;
  deletes: number;
  updates: number;
}

interface MeasurementOptions {
  eventCount: number;
  warmupSamples: number;
  measuredSamples: number;
  loopsPerSample: number;
}

function createReadApprovalDataset(eventCount: number) {
  const objectRows: ObjectRow[] = [];
  const relationRows: RelationRow[] = [];
  const events: RelationApprovedEvent[] = [];

  for (let index = 0; index < eventCount; index++) {
    const service = makeObject({
      id: id(`s${index}`),
      objectType: 'service',
      name: `service-${index}`,
    });
    const database = makeObject({
      id: id(`d${index}`),
      objectType: 'database',
      name: `database-${index}`,
    });
    const table = makeObject({
      id: id(`t${index}`),
      objectType: 'db_table',
      name: `table-${index}`,
      parentId: database.id,
    });
    const relation = makeRelation({
      id: id(`r${index}`),
      relationType: 'read',
      subjectObjectId: service.id,
      objectId: table.id,
      confidence: 0.6 + index * 0.01,
    });

    objectRows.push(service, database, table);
    relationRows.push(relation);
    events.push({
      type: 'RELATION_APPROVED',
      payload: {
        relationType: 'read',
        subjectObjectId: service.id,
        objectId: table.id,
      },
    });
  }

  return {
    objectRows,
    relationRows,
    events,
  };
}

function buildTableJoinedFromRelations(
  relations: RelationRow[],
  objectRows: ObjectRow[],
  relationType: 'read' | 'write',
  affectedServiceIds: Set<string>,
) {
  const objectMap = new Map(objectRows.map((objectRow) => [objectRow.id, objectRow]));
  return relations
    .filter(
      (relation) =>
        relation.relationType === relationType &&
        affectedServiceIds.has(relation.subjectObjectId),
    )
    .map((relation) => ({
      relation,
      tableParentId: objectMap.get(relation.objectId)?.parentId ?? null,
    }));
}

function createAwaitableQuery<T>(resultFactory: () => T[]) {
  return {
    then<TResult1 = T[], TResult2 = never>(
      onfulfilled?: ((value: T[]) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) {
      return Promise.resolve(resultFactory()).then(onfulfilled, onrejected);
    },
    orderBy() {
      return {
        limit() {
          return Promise.resolve(resultFactory());
        },
      };
    },
    limit() {
      return Promise.resolve(resultFactory());
    },
  };
}

function normalizeComparableState(state: RollupState) {
  const rollupKeyById = new Map<string, string>();
  const rollups = state.rollups
    .map((row) => {
      const key = [
        row['rollupLevel'],
        row['relationType'],
        row['subjectObjectId'],
        row['objectId'],
      ].join('|');
      const rowId = row['id'];
      if (typeof rowId === 'string' && rowId.length > 0) {
        rollupKeyById.set(rowId, key);
      }
      return {
        key,
        edgeWeight: row['edgeWeight'],
        confidence: row['confidence'] == null ? null : Number(row['confidence']),
      };
    })
    .sort((left, right) => left.key.localeCompare(right.key));

  const provenances = state.provenances
    .map((row) => ({
      rollupKey: rollupKeyById.get(String(row['rollupId'] ?? '')) ?? '',
      baseRelationId: row['baseRelationId'],
    }))
    .sort((left, right) => {
      const leftKey = `${left.rollupKey}|${left.baseRelationId}`;
      const rightKey = `${right.rollupKey}|${right.baseRelationId}`;
      return leftKey.localeCompare(rightKey);
    });

  const graphStats = state.graphStats
    .map((row) => ({
      rollupLevel: row['rollupLevel'],
      objectId: row['objectId'],
      outDegree: row['outDegree'],
      inDegree: row['inDegree'],
    }))
    .sort((left, right) => {
      const leftKey = `${left.rollupLevel}|${left.objectId}`;
      const rightKey = `${right.rollupLevel}|${right.objectId}`;
      return leftKey.localeCompare(rightKey);
    });

  return {
    rollups,
    provenances,
    graphStats,
  };
}

function summarize(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const sum = values.reduce((acc, value) => acc + value, 0);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle] ?? 0;

  return {
    meanMs: sum / values.length,
    medianMs: median,
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

function createPerfDb(dataset: {
  objectRows: ObjectRow[];
  approvedRelations: RelationRow[];
}) {
  const counters: QueryCounters = {
    selects: 0,
    inserts: 0,
    deletes: 0,
    updates: 0,
  };
  const state: RollupState = {
    rollups: [],
    provenances: [],
    graphStats: [],
  };
  const generations: GenerationRow[] = [
    {
      workspaceId: WORKSPACE_ID,
      generationVersion: 1,
      status: 'ACTIVE',
      meta: {},
    },
  ];
  let affectedServiceIds = new Set<string>();
  let relationQueryPhase = 0;

  const deleteRollupsForAffectedSubjects = () => {
    const removedRollupIds = new Set(
      state.rollups
        .filter(
          (row) =>
            row['rollupLevel'] === 'SERVICE_TO_DATABASE' &&
            affectedServiceIds.has(String(row['subjectObjectId'])),
        )
        .map((row) => String(row['id'] ?? ''))
        .filter((rowId) => rowId.length > 0),
    );

    state.rollups = state.rollups.filter(
      (row) =>
        !(
          row['rollupLevel'] === 'SERVICE_TO_DATABASE' &&
          affectedServiceIds.has(String(row['subjectObjectId']))
        ),
    );
    state.provenances = state.provenances.filter(
      (row) => !removedRollupIds.has(String(row['rollupId'] ?? '')),
    );
  };

  const currentGeneration = () =>
    generations.find((row) => row.status === 'ACTIVE') ?? generations[0];

  const selectRows = (
    table: unknown,
    selection?: Record<string, unknown>,
    joined?: boolean,
  ): unknown[] => {
    counters.selects += 1;

    if (table === rollupGenerations) {
      if (selection && 'generationVersion' in selection) {
        return currentGeneration() ? [{ generationVersion: currentGeneration()!.generationVersion }] : [];
      }

      if (selection && 'meta' in selection) {
        return currentGeneration() ? [{ meta: currentGeneration()!.meta }] : [];
      }

      return currentGeneration() ? [currentGeneration()!] : [];
    }

    if (table === objectRelations && joined) {
      const relationType = relationQueryPhase === 0 ? 'read' : 'write';
      relationQueryPhase = (relationQueryPhase + 1) % 2;
      return buildTableJoinedFromRelations(
        dataset.approvedRelations,
        dataset.objectRows,
        relationType,
        affectedServiceIds,
      );
    }

    if (table === objectRollups && selection && 'subjectObjectId' in selection) {
      return state.rollups
        .filter((row) => row['rollupLevel'] === 'SERVICE_TO_DATABASE')
        .map((row) => ({
          subjectObjectId: row['subjectObjectId'],
          objectId: row['objectId'],
        }));
    }

    return [];
  };

  const db = {
    select: (selection?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: () => createAwaitableQuery(() => selectRows(table, selection)),
        innerJoin: () => ({
          where: () => Promise.resolve(selectRows(table, selection, true)),
        }),
        orderBy: () => ({
          limit: () => Promise.resolve(selectRows(table, selection)),
        }),
        limit: () => Promise.resolve(selectRows(table, selection)),
      }),
    }),
    insert: (table: unknown) => ({
      values: (rows: unknown) => {
        counters.inserts += 1;
        const normalizedRows = Array.isArray(rows)
          ? rows
          : [rows as Record<string, unknown>];

        if (table === objectRollups) {
          state.rollups.push(...normalizedRows);
        } else if (table === objectRollupProvenances) {
          state.provenances.push(...normalizedRows);
        } else if (table === objectGraphStats) {
          state.graphStats.push(...normalizedRows);
        } else if (table === rollupGenerations) {
          generations.push(...(normalizedRows as GenerationRow[]));
        }

        return Promise.resolve();
      },
    }),
    delete: (table: unknown) => ({
      where: () => {
        counters.deletes += 1;
        if (table === objectRollups) {
          deleteRollupsForAffectedSubjects();
        } else if (table === objectGraphStats) {
          state.graphStats = state.graphStats.filter(
            (row) => row['rollupLevel'] !== 'SERVICE_TO_DATABASE',
          );
        }

        return Promise.resolve();
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          counters.updates += 1;
          if (table === rollupGenerations) {
            const generation = currentGeneration();
            if (generation) {
              Object.assign(generation, values);
            }
          }
          return Promise.resolve();
        },
      }),
    }),
  };

  return {
    db: db as unknown as Parameters<typeof incrementalRebuild>[0],
    counters,
    getState: () => ({
      rollups: state.rollups.map((row) => ({ ...row })),
      provenances: state.provenances.map((row) => ({ ...row })),
      graphStats: state.graphStats.map((row) => ({ ...row })),
    }),
    getMeta: () => ({ ...currentGeneration()?.meta }),
    setAffectedServiceIds: (serviceIds: string[]) => {
      affectedServiceIds = new Set(serviceIds);
      relationQueryPhase = 0;
    },
  };
}

async function runScenario(
  strategy: 'sequential' | 'batch',
  eventCount: number,
) {
  const dataset = createReadApprovalDataset(eventCount);
  const approvedRelations: RelationRow[] = [];
  const perfDb = createPerfDb({
    objectRows: dataset.objectRows,
    approvedRelations,
  });

  if (strategy === 'sequential') {
    for (const [index, event] of dataset.events.entries()) {
      approvedRelations.push(dataset.relationRows[index]!);
      perfDb.setAffectedServiceIds([event.payload.subjectObjectId]);
      await incrementalRebuild(perfDb.db, WORKSPACE_ID, [event]);
    }
  } else {
    approvedRelations.push(...dataset.relationRows);
    perfDb.setAffectedServiceIds(
      dataset.events.map((event) => event.payload.subjectObjectId),
    );
    await incrementalRebuild(perfDb.db, WORKSPACE_ID, dataset.events);
  }

  return {
    counters: { ...perfDb.counters },
    state: normalizeComparableState(perfDb.getState()),
    meta: perfDb.getMeta(),
  };
}

async function measure(options: MeasurementOptions) {
  for (let sample = 0; sample < options.warmupSamples; sample++) {
    await runScenario('sequential', options.eventCount);
    await runScenario('batch', options.eventCount);
  }

  const sequentialSamples: number[] = [];
  const batchSamples: number[] = [];

  for (let sample = 0; sample < options.measuredSamples; sample++) {
    const strategies: Array<'sequential' | 'batch'> =
      sample % 2 === 0 ? ['sequential', 'batch'] : ['batch', 'sequential'];

    for (const strategy of strategies) {
      const startedAt = performance.now();
      for (let loop = 0; loop < options.loopsPerSample; loop++) {
        await runScenario(strategy, options.eventCount);
      }
      const elapsedMs = (performance.now() - startedAt) / options.loopsPerSample;

      if (strategy === 'sequential') {
        sequentialSamples.push(elapsedMs);
      } else {
        batchSamples.push(elapsedMs);
      }
    }
  }

  const sequentialSingleRun = await runScenario('sequential', options.eventCount);
  const batchSingleRun = await runScenario('batch', options.eventCount);

  if (JSON.stringify(sequentialSingleRun.state) !== JSON.stringify(batchSingleRun.state)) {
    throw new Error('Sequential and batch final states diverged');
  }

  const sequentialSummary = summarize(sequentialSamples);
  const batchSummary = summarize(batchSamples);
  const improvementPct =
    sequentialSummary.meanMs === 0
      ? 0
      : ((sequentialSummary.meanMs - batchSummary.meanMs) / sequentialSummary.meanMs) *
        100;

  return {
    config: options,
    operationCounts: {
      sequential: sequentialSingleRun.counters,
      batch: batchSingleRun.counters,
    },
    timing: {
      sequential: sequentialSummary,
      batch: batchSummary,
      improvementPct,
    },
    finalState: batchSingleRun.state,
    meta: {
      sequential: sequentialSingleRun.meta,
      batch: batchSingleRun.meta,
    },
  };
}

function parseArgs(argv: string[]): MeasurementOptions {
  const defaults: MeasurementOptions = {
    eventCount: 10,
    warmupSamples: 5,
    measuredSamples: 25,
    loopsPerSample: 10,
  };

  for (const arg of argv) {
    const [flag, value] = arg.split('=');
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) continue;

    if (flag === '--event-count') defaults.eventCount = parsed;
    if (flag === '--warmup') defaults.warmupSamples = parsed;
    if (flag === '--samples') defaults.measuredSamples = parsed;
    if (flag === '--loops') defaults.loopsPerSample = parsed;
  }

  return defaults;
}

export async function main() {
  const result = await measure(parseArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
