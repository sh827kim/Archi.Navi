/**
 * Core 테이블 스키마
 * workspaces, objects, tags, object_tags, object_relations, relation_candidates
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// 워크스페이스 (멀티 워크스페이스 격리 단위)
export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// 통합 자산 저장소 (service, api_endpoint, database, topic, domain 등 모든 Object)
export const objects = pgTable(
  'objects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    // 분류
    objectType: text('object_type').notNull(), // service, api_endpoint, ...
    category: text('category'), // COMPUTE, STORAGE, CHANNEL
    granularity: text('granularity').notNull().default('ATOMIC'), // COMPOUND, ATOMIC

    // 식별자
    urn: text('urn'), // urn:{workspace}:{category}:{type}:{path}
    name: text('name').notNull(),
    displayName: text('display_name'),
    description: text('description'),

    // 계층
    parentId: uuid('parent_id'), // 자기 참조 (FK는 아래 relations에서 정의)
    path: text('path').notNull(), // materialized path
    depth: integer('depth').notNull().default(0),

    // 상태
    visibility: text('visibility').notNull().default('VISIBLE'), // VISIBLE, HIDDEN
    metadata: jsonb('metadata').notNull().default({}),

    // Temporal Architecture
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validTo: timestamp('valid_to', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('ux_objects_ws_urn')
      .on(table.workspaceId, table.urn)
      .where(sql`"urn" is not null`),
    // 동일 워크스페이스 내 동일 path 의 domain 객체 중복 방지 (concurrent approve race 차단).
    uniqueIndex('ux_objects_ws_domain_path')
      .on(table.workspaceId, table.path)
      .where(sql`"object_type" = 'domain'`),
    index('ix_objects_ws_type').on(table.workspaceId, table.objectType),
    index('ix_objects_ws_parent').on(table.workspaceId, table.parentId),
    index('ix_objects_ws_path').on(table.workspaceId, table.path),
  ],
);

// 태그 정의
export const tags = pgTable(
  'tags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique('uq_tags_ws_name').on(table.workspaceId, table.name)],
);

// Object-Tag N:M 관계
export const objectTags = pgTable(
  'object_tags',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    objectId: uuid('object_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (table) => [
    {
      pk: { columns: [table.workspaceId, table.objectId, table.tagId] },
    },
  ],
);

// 확정된 관계 (승인 완료)
export const objectRelations = pgTable(
  'object_relations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    relationType: text('relation_type').notNull(), // call, expose, read, write, produce, consume, depend_on, fk_reference
    subjectObjectId: uuid('subject_object_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    objectId: uuid('object_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),

    // Semantic Axis
    interactionKind: text('interaction_kind'), // CONTROL, DATA, ASYNC, STATIC
    direction: text('direction'), // IN, OUT

    isDerived: boolean('is_derived').notNull().default(false),
    confidence: real('confidence'), // 0~1
    status: text('status').notNull().default('APPROVED'), // APPROVED, REJECTED

    metadata: jsonb('metadata').notNull().default({}),
    source: text('source').notNull().default('MANUAL'), // MANUAL, INFERRED, ROLLUP

    // Temporal Architecture
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validTo: timestamp('valid_to', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('uq_object_relations').on(
      table.workspaceId,
      table.relationType,
      table.subjectObjectId,
      table.objectId,
      table.isDerived,
    ),
    index('ix_rel_ws_subject').on(table.workspaceId, table.subjectObjectId),
    index('ix_rel_ws_object').on(table.workspaceId, table.objectId),
    index('ix_rel_ws_type').on(table.workspaceId, table.relationType),
  ],
);

// 추론 후보 큐 (승인 전)
export const relationCandidates = pgTable(
  'relation_candidates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    relationType: text('relation_type').notNull(),
    subjectObjectId: uuid('subject_object_id')
      .notNull()
      .references(() => objects.id),
    objectId: uuid('object_id')
      .notNull()
      .references(() => objects.id),

    confidence: real('confidence').notNull(), // 0~1
    metadata: jsonb('metadata').notNull().default({}),

    status: text('status').notNull().default('PENDING'), // PENDING, APPROVED, REJECTED

    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: text('reviewed_by'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('ix_relcand_ws_status').on(table.workspaceId, table.status)],
);
