/**
 * Domain 추론 관련 테이블 스키마
 * object_domain_affinities, domain_inference_profiles
 */
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { workspaces, objects } from './core';

const DEFAULT_PROOF_CONFIDENCE_CONFIG = {
  name: 'intent-proof-default',
  version: 'v1',
  weights: {
    summaryQuality: 0.45,
    slotCompleteness: 0.25,
    corroborationPerSignal: 0.05,
    corroborationCap: 0.2,
    contradictionPenaltyPerItem: 0.2,
    contradictionPenaltyCap: 0.6,
  },
  slotWeights: {
    http: {
      method: 0.2,
      externalPath: 0.2,
      internalPath: 0.2,
      providerService: 0.2,
      targetObject: 0.2,
    },
    db: {
      action: 0.25,
      table: 0.25,
      schema: 0.15,
      datasource: 0.1,
      targetObject: 0.25,
    },
    message: {
      channel: 0.4,
      broker: 0.2,
      objectType: 0.15,
      targetObject: 0.25,
    },
  },
} as const;

const DEFAULT_SMART_PROOF_CONFIG = {
  enabled: false,
  categories: {
    preResolutionEnhancement: false,
    frontierResolution: true,
    ambiguityResolution: false,
    crossProofCorrelation: false,
    contradictionDetection: false,
  },
  budget: {
    maxLlmCallsPerRun: 100,
    maxLlmCallsPerIntent: 5,
    maxInputTokensPerCall: 4000,
    maxTotalTokensPerRun: 500000,
  },
  thresholds: {
    autoAcceptConfidence: 0.8,
    reviewConfidence: 0.5,
    skipConfidence: 0.3,
  },
  temperature: 0.1,
} as const;

// 확정된 도메인 소속 분포 (Affinity Distribution)
export const objectDomainAffinities = pgTable(
  'object_domain_affinities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),

    objectId: uuid('object_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    domainId: uuid('domain_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }), // object_type='domain'

    affinity: real('affinity').notNull(), // 0~1 (정규화된 분포)
    confidence: real('confidence'), // 0~1
    source: text('source').notNull().default('APPROVED_INFERENCE'), // MANUAL, APPROVED_INFERENCE, DISCOVERY

    generationVersion: bigint('generation_version', { mode: 'number' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('uq_oda').on(table.workspaceId, table.objectId, table.domainId),
    index('ix_oda_ws_object').on(table.workspaceId, table.objectId),
    index('ix_oda_ws_domain').on(table.workspaceId, table.domainId),
  ],
);

// 도메인 추론 설정 프로필 (워크스페이스별 튜닝)
export const domainInferenceProfiles = pgTable(
  'domain_inference_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind').notNull().default('NAMED'), // NAMED, DISCOVERY

    isDefault: boolean('is_default').default(false),

    // Seed 기반 가중치
    wCode: real('w_code').default(0.5),
    wDb: real('w_db').default(0.3),
    wMsg: real('w_msg').default(0.2),
    heuristicDomainCap: real('heuristic_domain_cap').default(0.3),
    secondaryThreshold: real('secondary_threshold').default(0.25),

    // Discovery 엣지 가중치
    edgeWCall: real('edge_w_call').default(1.0),
    edgeWRw: real('edge_w_rw').default(0.8),
    edgeWMsg: real('edge_w_msg').default(0.6),
    edgeWFk: real('edge_w_fk').default(0.4),
    edgeWCode: real('edge_w_code').default(0.7),

    minClusterSize: integer('min_cluster_size').default(3),
    resolution: real('resolution'),

    enabledLayers: jsonb('enabled_layers').default(['call', 'db', 'msg', 'code']),
    feedbackConfig: jsonb('feedback_config').default({
      enabled: true,
      minSamples: 10,
      maxAdjustment: 0.15,
    }),
    feedbackAdjustments: jsonb('feedback_adjustments').default({}),
    domainFeedbackConfig: jsonb('domain_feedback_config').default({
      enabled: true,
      minSamples: 10,
      maxAdjustment: 0.15,
    }),
    domainFeedbackAdjustments: jsonb('domain_feedback_adjustments').default({}),
    crossValidation: jsonb('cross_validation').default({
      enabled: true,
      boostFactor: 0.3,
      penaltyFactor: 0.85,
    }),
    scanConfig: jsonb('scan_config').default({
      enableDbScan: false,
    }),
    proofConfidenceConfig: jsonb('proof_confidence_config').default(DEFAULT_PROOF_CONFIDENCE_CONFIG),
    smartProofConfig: jsonb('smart_proof_config').default(DEFAULT_SMART_PROOF_CONFIG),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [unique('uq_profile_ws_name').on(table.workspaceId, table.name)],
);
