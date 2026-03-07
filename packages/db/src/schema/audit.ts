/**
 * Audit 테이블 스키마
 * change_logs (Append-only 변경 이력),
 * inference_runs/inference_run_sources/inference_run_events (오케스트레이션 이력)
 */
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { workspaces } from './core';

// Append-only 변경 이력
export const changeLogs = pgTable(
  'change_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    entityType: text('entity_type').notNull(), // OBJECT, RELATION, DOMAIN_AFFINITY
    entityId: uuid('entity_id').notNull(),
    action: text('action').notNull(), // CREATE, UPDATE, DELETE, APPROVE, REJECT

    beforeSnapshot: jsonb('before_snapshot'),
    afterSnapshot: jsonb('after_snapshot'),
    changedBy: text('changed_by'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('ix_changelog_ws_entity').on(table.workspaceId, table.entityType, table.entityId),
    index('ix_changelog_ws_time').on(table.workspaceId, table.createdAt),
  ],
);

// 비동기 추론 실행 이력
export const inferenceRuns = pgTable(
  'inference_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    triggerType: text('trigger_type').notNull().default('MANUAL'), // MANUAL, SCHEDULED, API, CLI
    status: text('status').notNull().default('QUEUED'), // QUEUED, RUNNING, SUCCEEDED, FAILED, CANCELED
    requestedModes: jsonb('requested_modes').notNull().default([]), // ["config","code","db"]
    requestedCodeEngine: text('requested_code_engine'), // ast, regex, hybrid
    requestedIncremental: boolean('requested_incremental').notNull().default(true),

    attemptCount: integer('attempt_count').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(1),
    idempotencyKey: text('idempotency_key'),

    sourceSummary: jsonb('source_summary').notNull().default({}),
    stats: jsonb('stats').notNull().default({}),
    warnings: jsonb('warnings').notNull().default([]),
    errors: jsonb('errors').notNull().default([]),
    errorMessage: text('error_message'),

    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('ix_infrun_ws_created').on(table.workspaceId, table.createdAt),
    index('ix_infrun_ws_status_created').on(table.workspaceId, table.status, table.createdAt),
    index('ix_infrun_ws_idempotency').on(table.workspaceId, table.idempotencyKey),
  ],
);

// 실행 소스 목록 (local/githubRepo/githubOrg 등)
export const inferenceRunSources = pgTable(
  'inference_run_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => inferenceRuns.id, { onDelete: 'cascade' }),

    sourceType: text('source_type').notNull(), // local, githubRepo, githubOrg
    sourceRef: text('source_ref').notNull(),
    resolvedRepoRoot: text('resolved_repo_root'),
    status: text('status').notNull().default('QUEUED'), // QUEUED, RUNNING, SUCCEEDED, FAILED, SKIPPED
    message: text('message'),
    metadata: jsonb('metadata').notNull().default({}),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('ix_infrunsrc_ws_run').on(table.workspaceId, table.runId),
    index('ix_infrunsrc_ws_type').on(table.workspaceId, table.sourceType),
  ],
);

// 실행 이벤트 로그
export const inferenceRunEvents = pgTable(
  'inference_run_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => inferenceRuns.id, { onDelete: 'cascade' }),

    level: text('level').notNull().default('INFO'), // INFO, WARN, ERROR
    eventType: text('event_type').notNull(), // RUN_CREATED, RUN_STARTED, RUN_COMPLETED 등
    message: text('message').notNull(),
    payload: jsonb('payload').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('ix_infrev_ws_run_created').on(table.workspaceId, table.runId, table.createdAt),
  ],
);
