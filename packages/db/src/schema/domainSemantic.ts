/**
 * 도메인 의미 프로파일 테이블
 * 도메인 1개 = 1 row. 추출 결과(state/actions/invariants/events/collaborators/scenarios)를 jsonb 로 보관한다.
 * 신호 수집기 + LLM 합성기의 산출물을 그대로 영속화하므로, 타입은 @archi-navi/shared 의 DomainSemanticProfile* 와 동일.
 */
import {
    index,
    jsonb,
    pgTable,
    text,
    timestamp,
    unique,
    uuid,
} from 'drizzle-orm/pg-core';
import type {
    DomainSemanticAction,
    DomainSemanticCollaborator,
    DomainSemanticEvent,
    DomainSemanticEvidence,
    DomainSemanticInvariant,
    DomainSemanticProfileStatus,
    DomainSemanticScenario,
    DomainSemanticState,
} from '@archi-navi/shared';
import { workspaces, objects } from './core';

export const domainSemanticProfiles = pgTable(
    'domain_semantic_profiles',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        workspaceId: uuid('workspace_id')
            .notNull()
            .references(() => workspaces.id, { onDelete: 'cascade' }),

        domainId: uuid('domain_id')
            .notNull()
            .references(() => objects.id, { onDelete: 'cascade' }),

        schemaVersion: text('schema_version').notNull().default('1.0'),

        domainName: text('domain_name').notNull(),
        responsibility: text('responsibility').notNull(),

        state: jsonb('state').$type<DomainSemanticState[]>().notNull().default([]),
        actions: jsonb('actions').$type<DomainSemanticAction[]>().notNull().default([]),
        invariants: jsonb('invariants').$type<DomainSemanticInvariant[]>().notNull().default([]),
        events: jsonb('events').$type<DomainSemanticEvent[]>().notNull().default([]),
        collaborators: jsonb('collaborators').$type<DomainSemanticCollaborator[]>().notNull().default([]),
        scenarios: jsonb('scenarios').$type<DomainSemanticScenario[]>().notNull().default([]),
        evidence: jsonb('evidence').$type<DomainSemanticEvidence[]>().notNull().default([]),

        status: text('status').$type<DomainSemanticProfileStatus>().notNull().default('DRAFT'),

        generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
        generatedBy: text('generated_by').notNull().default('manual'),
        llmModel: text('llm_model').notNull(),

        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        // 도메인당 1개의 최신 프로파일만 유지 (재추출 시 update). 이력 보존이 필요하면 후속에서 status='SUPERSEDED' 사용.
        unique('uq_dsp_ws_domain').on(table.workspaceId, table.domainId),
        index('ix_dsp_ws_status').on(table.workspaceId, table.status),
    ],
);
