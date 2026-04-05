import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, real, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { inferenceRuns } from './audit';
import { objects, workspaces } from './core';

export const interactionIntents = pgTable(
  'interaction_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    createdRunId: uuid('created_run_id').references(() => inferenceRuns.id, { onDelete: 'set null' }),
    updatedRunId: uuid('updated_run_id').references(() => inferenceRuns.id, { onDelete: 'set null' }),
    intentType: text('intent_type').notNull(),
    sourceServiceId: uuid('source_service_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    sourceFunctionId: uuid('source_function_id').references(() => objects.id, { onDelete: 'set null' }),
    sourceFilePath: text('source_file_path'),
    methodHint: text('method_hint'),
    externalPathHint: text('external_path_hint'),
    gatewayKind: text('gateway_kind'),
    routeScopeKind: text('route_scope_kind'),
    externalRoutePattern: text('external_route_pattern'),
    providerHint: text('provider_hint'),
    targetServiceHint: text('target_service_hint'),
    routeTransformRefs: jsonb('route_transform_refs').notNull().default([]),
    methodConstraint: text('method_constraint'),
    hostHint: text('host_hint'),
    resourceHint: text('resource_hint'),
    dbSchemaHint: text('db_schema_hint'),
    dbTableHints: jsonb('db_table_hints').notNull().default([]),
    dbQueryFragmentHash: text('db_query_fragment_hash'),
    messageBrokerKind: text('message_broker_kind'),
    messageTopicHints: jsonb('message_topic_hints').notNull().default([]),
    messageQueueHints: jsonb('message_queue_hints').notNull().default([]),
    messageRoutingKeyHints: jsonb('message_routing_key_hints').notNull().default([]),
    configKeys: jsonb('config_keys').notNull().default([]),
    summaryRefs: jsonb('summary_refs').notNull().default([]),
    evidenceIds: jsonb('evidence_ids').notNull().default([]),
    status: text('status').notNull().default('NEW'),
    intentHash: text('intent_hash').notNull(),
    anchorHash: text('anchor_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('uq_interaction_intents_ws_hash').on(table.workspaceId, table.intentHash),
    check(
      'chk_interaction_intents_type',
      sql`${table.intentType} in ('http_call', 'http_gateway_route', 'db_access', 'message_publish', 'message_consume')`,
    ),
    check(
      'chk_interaction_intents_status',
      sql`${table.status} in ('NEW', 'RESOLVING', 'CLOSED_ATOMIC', 'FRONTIER', 'REJECTED')`,
    ),
    check(
      'chk_interaction_intents_route_scope_kind',
      sql`${table.routeScopeKind} is null or ${table.routeScopeKind} in ('exact', 'prefix', 'regex')`,
    ),
    check(
      'chk_interaction_intents_method_constraint',
      sql`${table.methodConstraint} is null or ${table.methodConstraint} in ('unknown', 'any', 'exact')`,
    ),
    check(
      'chk_interaction_intents_gateway_route_required',
      sql`not (
        ${table.intentType} = 'http_gateway_route'
        and (
          ${table.gatewayKind} is null
          or ${table.routeScopeKind} is null
          or ${table.externalRoutePattern} is null
        )
      )`,
    ),
    index('idx_interaction_intents_ws_status').on(table.workspaceId, table.status),
    index('idx_interaction_intents_ws_source').on(table.workspaceId, table.sourceServiceId, table.intentType),
    index('idx_interaction_intents_ws_function').on(table.workspaceId, table.sourceFunctionId),
  ],
);

export const functionSummaries = pgTable(
  'function_summaries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    createdRunId: uuid('created_run_id').references(() => inferenceRuns.id, { onDelete: 'set null' }),
    updatedRunId: uuid('updated_run_id').references(() => inferenceRuns.id, { onDelete: 'set null' }),
    functionId: uuid('function_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    summaryVersion: integer('summary_version').notNull().default(1),
    summaryKind: text('summary_kind').notNull(),
    outboundHttp: jsonb('outbound_http'),
    outboundDb: jsonb('outbound_db'),
    outboundMessage: jsonb('outbound_message'),
    callChainHints: jsonb('call_chain_hints').notNull().default([]),
    aliasHints: jsonb('alias_hints').notNull().default([]),
    signalSources: jsonb('signal_sources').notNull().default([]),
    provenanceEvidenceIds: jsonb('provenance_evidence_ids').notNull().default([]),
    extractionStrategy: text('extraction_strategy').notNull().default('legacy_edges_fallback'),
    unresolvedReasons: jsonb('unresolved_reasons').notNull().default([]),
    summaryCompleteness: real('summary_completeness').notNull().default(0),
    flags: jsonb('flags').notNull().default({}),
    confidence: real('confidence').notNull().default(0.5),
    sourceHash: text('source_hash').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('uq_function_summaries_ws_function_version').on(
      table.workspaceId,
      table.functionId,
      table.summaryVersion,
    ),
    check(
      'chk_function_summaries_kind',
      sql`${table.summaryKind} in ('http', 'db', 'message', 'mixed')`,
    ),
    check(
      'chk_function_summaries_status',
      sql`${table.status} in ('ACTIVE', 'SUPERSEDED')`,
    ),
    check(
      'chk_function_summaries_extraction_strategy',
      sql`${table.extractionStrategy} in ('ast_primary', 'mixed_signals', 'legacy_edges_fallback')`,
    ),
    check(
      'chk_function_summaries_completeness',
      sql`${table.summaryCompleteness} >= 0 and ${table.summaryCompleteness} <= 1`,
    ),
    index('idx_function_summaries_ws_function').on(table.workspaceId, table.functionId, table.status),
    index('idx_function_summaries_ws_service').on(table.workspaceId, table.serviceId, table.status),
    index('idx_function_summaries_ws_sourcehash').on(table.workspaceId, table.sourceHash),
  ],
);

export const routeTransforms = pgTable(
  'route_transforms',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    createdRunId: uuid('created_run_id').references(() => inferenceRuns.id, { onDelete: 'set null' }),
    updatedRunId: uuid('updated_run_id').references(() => inferenceRuns.id, { onDelete: 'set null' }),
    gatewayKind: text('gateway_kind').notNull(),
    ownerServiceId: uuid('owner_service_id').references(() => objects.id, { onDelete: 'set null' }),
    matchHost: text('match_host'),
    matchPath: text('match_path').notNull(),
    matchMode: text('match_mode').notNull().default('exact'),
    stripPrefixCount: integer('strip_prefix_count'),
    prependPrefix: text('prepend_prefix'),
    rewriteRegex: text('rewrite_regex'),
    rewriteReplacement: text('rewrite_replacement'),
    pathCapturePolicy: text('path_capture_policy'),
    routeMountPrefix: text('route_mount_prefix'),
    targetServiceHint: text('target_service_hint'),
    targetHostAlias: text('target_host_alias'),
    targetPathBaseHint: text('target_path_base_hint'),
    priority: integer('priority').notNull().default(0),
    evidenceIds: jsonb('evidence_ids').notNull().default([]),
    sourceHash: text('source_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('uq_route_transforms_ws_hash').on(table.workspaceId, table.sourceHash),
    check(
      'chk_route_transforms_gateway_kind',
      sql`${table.gatewayKind} in ('zuul', 'spring_cloud_gateway', 'kong', 'envoy', 'ingress', 'custom', 'gateway')`,
    ),
    check(
      'chk_route_transforms_match_mode',
      sql`${table.matchMode} in ('exact', 'prefix', 'regex')`,
    ),
    index('idx_route_transforms_ws_owner').on(table.workspaceId, table.ownerServiceId, table.gatewayKind),
    index('idx_route_transforms_ws_targethint').on(table.workspaceId, table.targetServiceHint),
    index('idx_route_transforms_ws_path').on(table.workspaceId, table.matchPath),
  ],
);

export const aliasBindings = pgTable(
  'alias_bindings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    createdRunId: uuid('created_run_id').references(() => inferenceRuns.id, { onDelete: 'set null' }),
    updatedRunId: uuid('updated_run_id').references(() => inferenceRuns.id, { onDelete: 'set null' }),
    bindingKind: text('binding_kind').notNull(),
    ownerServiceId: uuid('owner_service_id').references(() => objects.id, { onDelete: 'set null' }),
    aliasKey: text('alias_key').notNull(),
    aliasValue: text('alias_value').notNull(),
    resolvedServiceId: uuid('resolved_service_id').references(() => objects.id, { onDelete: 'set null' }),
    resolvedHost: text('resolved_host'),
    evidenceIds: jsonb('evidence_ids').notNull().default([]),
    confidence: real('confidence').notNull().default(0.5),
    sourceHash: text('source_hash').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('uq_alias_bindings_ws_hash').on(table.workspaceId, table.sourceHash),
    check(
      'chk_alias_bindings_kind',
      sql`${table.bindingKind} in ('base_url', 'service_discovery', 'gateway_target', 'property_alias')`,
    ),
    check(
      'chk_alias_bindings_status',
      sql`${table.status} in ('ACTIVE', 'SUPERSEDED')`,
    ),
    index('idx_alias_bindings_ws_key').on(table.workspaceId, table.aliasKey, table.status),
    index('idx_alias_bindings_ws_owner').on(table.workspaceId, table.ownerServiceId, table.status),
    index('idx_alias_bindings_ws_service').on(table.workspaceId, table.resolvedServiceId, table.status),
  ],
);

export const proofStates = pgTable(
  'proof_states',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    intentId: uuid('intent_id')
      .notNull()
      .references(() => interactionIntents.id, { onDelete: 'cascade' }),
    originIntentId: uuid('origin_intent_id').references(() => interactionIntents.id, { onDelete: 'cascade' }),
    parentProofStateId: uuid('parent_proof_state_id'),
    proofType: text('proof_type').notNull(),
    status: text('status').notNull().default('NEW'),
    consumerServiceId: uuid('consumer_service_id')
      .notNull()
      .references(() => objects.id, { onDelete: 'cascade' }),
    sourceFunctionId: uuid('source_function_id').references(() => objects.id, { onDelete: 'set null' }),
    providerServiceId: uuid('provider_service_id').references(() => objects.id, { onDelete: 'set null' }),
    targetObjectType: text('target_object_type'),
    targetObjectId: uuid('target_object_id').references(() => objects.id, { onDelete: 'set null' }),
    methodResolved: text('method_resolved'),
    externalPathResolved: text('external_path_resolved'),
    internalPathResolved: text('internal_path_resolved'),
    routeChain: jsonb('route_chain').notNull().default([]),
    slotState: jsonb('slot_state').notNull().default({}),
    ambiguityCount: integer('ambiguity_count').notNull().default(0),
    contradictionCount: integer('contradiction_count').notNull().default(0),
    confidence: real('confidence').notNull().default(0),
    confidenceBreakdown: jsonb('confidence_breakdown').notNull().default({}),
    closedReason: text('closed_reason'),
    frontierCode: text('frontier_code'),
    rejectedReason: text('rejected_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'chk_proof_states_type',
      sql`${table.proofType} in ('http_call', 'http_gateway_route', 'db_access', 'message_publish', 'message_consume')`,
    ),
    check(
      'chk_proof_states_status',
      sql`${table.status} in ('NEW', 'RESOLVING', 'CLOSED_ATOMIC', 'FRONTIER', 'REJECTED')`,
    ),
    check(
      'chk_proof_states_closed_target',
      sql`not (${table.status} = 'CLOSED_ATOMIC' and ${table.targetObjectId} is null)`,
    ),
    index('idx_proof_states_ws_status').on(table.workspaceId, table.status),
    index('idx_proof_states_ws_intent').on(table.workspaceId, table.intentId),
    index('idx_proof_states_ws_consumer_status').on(table.workspaceId, table.consumerServiceId, table.status),
    index('idx_proof_states_ws_provider_status').on(table.workspaceId, table.providerServiceId, table.status),
    index('idx_proof_states_ws_target').on(table.workspaceId, table.targetObjectId),
    index('idx_proof_states_ws_origin').on(table.workspaceId, table.originIntentId, table.status),
    index('idx_proof_states_ws_parent').on(table.workspaceId, table.parentProofStateId, table.status),
  ],
);

export const proofSteps = pgTable(
  'proof_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proofStateId: uuid('proof_state_id')
      .notNull()
      .references(() => proofStates.id, { onDelete: 'cascade' }),
    stepOrder: integer('step_order').notNull(),
    stepType: text('step_type').notNull(),
    status: text('status').notNull(),
    inputSnapshot: jsonb('input_snapshot').notNull().default({}),
    outputSnapshot: jsonb('output_snapshot').notNull().default({}),
    evidenceIds: jsonb('evidence_ids').notNull().default([]),
    message: text('message'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('uq_proof_steps_order').on(table.proofStateId, table.stepOrder),
    index('idx_proof_steps_proof_order').on(table.proofStateId, table.stepOrder),
  ],
);

export const proofFrontiers = pgTable(
  'proof_frontiers',
  {
    proofStateId: uuid('proof_state_id')
      .primaryKey()
      .references(() => proofStates.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    frontierReason: text('frontier_reason').notNull(),
    frontierClass: text('frontier_class').notNull(),
    detail: jsonb('detail').notNull().default({}),
    retryStrategy: text('retry_strategy').notNull(),
    priority: integer('priority').notNull().default(100),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'chk_proof_frontiers_class',
      sql`${table.frontierClass} in ('ALIAS', 'ROUTE', 'PATH', 'METHOD', 'METHOD_PATH', 'TARGET', 'SUMMARY', 'CONTRADICTION', 'UNSUPPORTED')`,
    ),
    check(
      'chk_proof_frontiers_retry',
      sql`${table.retryStrategy} in ('deterministic', 'agent_patch', 'manual_review')`,
    ),
    index('idx_proof_frontiers_ws_reason').on(table.workspaceId, table.frontierReason),
    index('idx_proof_frontiers_ws_priority').on(table.workspaceId, table.priority),
  ],
);

export const proofPatches = pgTable(
  'proof_patches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    proofStateId: uuid('proof_state_id').references(() => proofStates.id, { onDelete: 'cascade' }),
    patchType: text('patch_type').notNull(),
    payload: jsonb('payload').notNull().default({}),
    sourceKind: text('source_kind').notNull(),
    validationStatus: text('validation_status').notNull().default('PENDING'),
    evidenceIds: jsonb('evidence_ids').notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'chk_proof_patches_type',
      sql`${table.patchType} in ('alias_binding', 'function_summary_patch', 'route_transform_patch', 'endpoint_disambiguation', 'method_path_hint', 'provider_service_selection', 'contradiction_challenge', 'reject_patch')`,
    ),
    check(
      'chk_proof_patches_source_kind',
      sql`${table.sourceKind} in ('deterministic', 'agent', 'smart_agent', 'manual')`,
    ),
    check(
      'chk_proof_patches_validation_status',
      sql`${table.validationStatus} in ('PENDING', 'ACCEPTED', 'REJECTED')`,
    ),
    index('idx_proof_patches_ws_status').on(table.workspaceId, table.validationStatus, table.sourceKind),
    index('idx_proof_patches_ws_proof').on(table.workspaceId, table.proofStateId, table.validationStatus),
  ],
);

export const smartProofLlmCalls = pgTable(
  'smart_proof_llm_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references(() => inferenceRuns.id, { onDelete: 'set null' }),
    proofStateId: uuid('proof_state_id').references(() => proofStates.id, { onDelete: 'set null' }),
    callCategory: text('call_category').notNull(),
    frontierReason: text('frontier_reason'),
    model: text('model').notNull(),
    temperature: real('temperature').notNull().default(0.1),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    estimatedCostUsd: real('estimated_cost_usd'),
    promptHash: text('prompt_hash').notNull(),
    responseHash: text('response_hash').notNull(),
    promptSnapshot: jsonb('prompt_snapshot').notNull().default({}),
    responseSnapshot: jsonb('response_snapshot').notNull().default({}),
    confidence: real('confidence'),
    accepted: boolean('accepted'),
    patchId: uuid('patch_id').references(() => proofPatches.id, { onDelete: 'set null' }),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'chk_smart_proof_llm_calls_category',
      sql`${table.callCategory} in (
        'pre_resolution_enhancement',
        'frontier_resolution',
        'ambiguity_resolution',
        'cross_proof_correlation',
        'contradiction_detection'
      )`,
    ),
    index('idx_smart_proof_llm_calls_ws_run').on(table.workspaceId, table.runId),
    index('idx_smart_proof_llm_calls_proof').on(table.proofStateId),
  ],
);

export const proofDependencies = pgTable(
  'proof_dependencies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    proofStateId: uuid('proof_state_id')
      .notNull()
      .references(() => proofStates.id, { onDelete: 'cascade' }),
    sourceRunId: uuid('source_run_id').references(() => inferenceRuns.id, { onDelete: 'set null' }),
    dependencyKind: text('dependency_kind').notNull(),
    dependencyKey: text('dependency_key').notNull(),
    dependencyHash: text('dependency_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('uq_proof_dependencies_ws_proof_kind_key').on(
      table.workspaceId,
      table.proofStateId,
      table.dependencyKind,
      table.dependencyKey,
    ),
    index('idx_proof_dependencies_ws_proof').on(table.workspaceId, table.proofStateId),
    index('idx_proof_dependencies_ws_kind_key').on(table.workspaceId, table.dependencyKind, table.dependencyKey),
    index('idx_proof_dependencies_ws_hash').on(table.workspaceId, table.dependencyHash),
  ],
);
