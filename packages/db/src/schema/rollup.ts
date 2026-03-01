/**
 * Rollup 테이블 스키마
 * object_rollups, rollup_generations, object_graph_stats
 */
import { bigint, index, integer, jsonb, pgTable, real, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { workspaces, objects, objectRelations } from './core';

// Materialized Roll-up 결과
export const objectRollups = pgTable(
  'object_rollups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    rollupLevel: text('rollup_level').notNull(), // SERVICE_TO_SERVICE, SERVICE_TO_DATABASE, ...
    relationType: text('relation_type').notNull(),

    subjectObjectId: uuid('subject_object_id')
      .notNull()
      .references(() => objects.id),
    objectId: uuid('object_id')
      .notNull()
      .references(() => objects.id),

    edgeWeight: integer('edge_weight').notNull().default(1), // base relation 수
    confidence: real('confidence'), // avg(base.confidence)
    generationVersion: bigint('generation_version', { mode: 'number' }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Outbound 탐색용
    index('ix_rollup_out').on(
      table.workspaceId,
      table.generationVersion,
      table.rollupLevel,
      table.subjectObjectId,
    ),
    // Inbound 탐색용
    index('ix_rollup_in').on(
      table.workspaceId,
      table.generationVersion,
      table.rollupLevel,
      table.objectId,
    ),
    // 타입별 필터용
    index('ix_rollup_type').on(
      table.workspaceId,
      table.generationVersion,
      table.rollupLevel,
      table.relationType,
    ),
  ],
);

// Rollup provenance (rollup edge -> base object_relations)
export const objectRollupProvenances = pgTable(
  'object_rollup_provenances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    generationVersion: bigint('generation_version', { mode: 'number' }).notNull(),
    rollupId: uuid('rollup_id')
      .notNull()
      .references(() => objectRollups.id, { onDelete: 'cascade' }),
    baseRelationId: uuid('base_relation_id')
      .notNull()
      .references(() => objectRelations.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('ix_rollup_prov_rollup').on(table.workspaceId, table.generationVersion, table.rollupId),
    index('ix_rollup_prov_base').on(table.workspaceId, table.generationVersion, table.baseRelationId),
  ],
);

// Generation 관리 테이블 (workspace당 ACTIVE generation은 1개)
export const rollupGenerations = pgTable('rollup_generations', {
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  generationVersion: bigint('generation_version', { mode: 'number' }).notNull(),
  builtAt: timestamp('built_at', { withTimezone: true }).notNull().defaultNow(),
  status: text('status').notNull().default('BUILDING'), // BUILDING, ACTIVE, ARCHIVED
  meta: jsonb('meta').notNull().default({}),
});

// 노드별 degree 통계 (허브 감지용)
export const objectGraphStats = pgTable('object_graph_stats', {
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  generationVersion: bigint('generation_version', { mode: 'number' }).notNull(),
  rollupLevel: text('rollup_level').notNull(),
  objectId: uuid('object_id')
    .notNull()
    .references(() => objects.id),
  outDegree: integer('out_degree').notNull(),
  inDegree: integer('in_degree').notNull(),
});
