CREATE TABLE "interaction_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_run_id" uuid,
	"updated_run_id" uuid,
	"intent_type" text NOT NULL,
	"source_service_id" uuid NOT NULL,
	"source_function_id" uuid,
	"source_file_path" text,
	"method_hint" text,
	"external_path_hint" text,
	"host_hint" text,
	"resource_hint" text,
	"db_schema_hint" text,
	"db_table_hints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"db_query_fragment_hash" text,
	"message_broker_kind" text,
	"message_topic_hints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"message_queue_hints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"message_routing_key_hints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"config_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'NEW' NOT NULL,
	"intent_hash" text NOT NULL,
	"anchor_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_interaction_intents_ws_hash" UNIQUE("workspace_id","intent_hash"),
	CONSTRAINT "chk_interaction_intents_type" CHECK ("intent_type" in ('http_call', 'db_access', 'message_publish', 'message_consume')),
	CONSTRAINT "chk_interaction_intents_status" CHECK ("status" in ('NEW', 'RESOLVING', 'CLOSED_ATOMIC', 'FRONTIER', 'REJECTED'))
);
--> statement-breakpoint
CREATE TABLE "function_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_run_id" uuid,
	"updated_run_id" uuid,
	"function_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"summary_version" integer DEFAULT 1 NOT NULL,
	"summary_kind" text NOT NULL,
	"outbound_http" jsonb,
	"outbound_db" jsonb,
	"outbound_message" jsonb,
	"call_chain_hints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"alias_hints" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"source_hash" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_function_summaries_ws_function_version" UNIQUE("workspace_id","function_id","summary_version"),
	CONSTRAINT "chk_function_summaries_kind" CHECK ("summary_kind" in ('http', 'db', 'message', 'mixed')),
	CONSTRAINT "chk_function_summaries_status" CHECK ("status" in ('ACTIVE', 'SUPERSEDED'))
);
--> statement-breakpoint
CREATE TABLE "route_transforms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_run_id" uuid,
	"updated_run_id" uuid,
	"gateway_kind" text NOT NULL,
	"owner_service_id" uuid,
	"match_host" text,
	"match_path" text NOT NULL,
	"strip_prefix_count" integer,
	"prepend_prefix" text,
	"rewrite_regex" text,
	"rewrite_replacement" text,
	"target_service_hint" text,
	"target_host_alias" text,
	"priority" integer DEFAULT 0 NOT NULL,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_route_transforms_ws_hash" UNIQUE("workspace_id","source_hash"),
	CONSTRAINT "chk_route_transforms_gateway_kind" CHECK ("gateway_kind" in ('zuul', 'spring_cloud_gateway', 'kong', 'envoy', 'ingress', 'custom', 'gateway'))
);
--> statement-breakpoint
CREATE TABLE "alias_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_run_id" uuid,
	"updated_run_id" uuid,
	"binding_kind" text NOT NULL,
	"owner_service_id" uuid,
	"alias_key" text NOT NULL,
	"alias_value" text NOT NULL,
	"resolved_service_id" uuid,
	"resolved_host" text,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"source_hash" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_alias_bindings_ws_hash" UNIQUE("workspace_id","source_hash"),
	CONSTRAINT "chk_alias_bindings_kind" CHECK ("binding_kind" in ('base_url', 'service_discovery', 'gateway_target', 'property_alias')),
	CONSTRAINT "chk_alias_bindings_status" CHECK ("status" in ('ACTIVE', 'SUPERSEDED'))
);
--> statement-breakpoint
CREATE TABLE "proof_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"intent_id" uuid NOT NULL,
	"proof_type" text NOT NULL,
	"status" text DEFAULT 'NEW' NOT NULL,
	"consumer_service_id" uuid NOT NULL,
	"source_function_id" uuid,
	"provider_service_id" uuid,
	"target_object_type" text,
	"target_object_id" uuid,
	"method_resolved" text,
	"external_path_resolved" text,
	"internal_path_resolved" text,
	"route_chain" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"slot_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ambiguity_count" integer DEFAULT 0 NOT NULL,
	"contradiction_count" integer DEFAULT 0 NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"closed_reason" text,
	"frontier_code" text,
	"rejected_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_proof_states_ws_intent" UNIQUE("workspace_id","intent_id"),
	CONSTRAINT "chk_proof_states_type" CHECK ("proof_type" in ('http_call', 'db_access', 'message_publish', 'message_consume')),
	CONSTRAINT "chk_proof_states_status" CHECK ("status" in ('NEW', 'RESOLVING', 'CLOSED_ATOMIC', 'FRONTIER', 'REJECTED')),
	CONSTRAINT "chk_proof_states_closed_target" CHECK (not ("status" = 'CLOSED_ATOMIC' and "target_object_id" is null))
);
--> statement-breakpoint
CREATE TABLE "proof_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proof_state_id" uuid NOT NULL,
	"step_order" integer NOT NULL,
	"step_type" text NOT NULL,
	"status" text NOT NULL,
	"input_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_proof_steps_order" UNIQUE("proof_state_id","step_order")
);
--> statement-breakpoint
CREATE TABLE "proof_frontiers" (
	"proof_state_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"frontier_reason" text NOT NULL,
	"frontier_class" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"retry_strategy" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_proof_frontiers_class" CHECK ("frontier_class" in ('ALIAS', 'ROUTE', 'PATH', 'METHOD', 'METHOD_PATH', 'TARGET', 'SUMMARY', 'CONTRADICTION', 'UNSUPPORTED')),
	CONSTRAINT "chk_proof_frontiers_retry" CHECK ("retry_strategy" in ('deterministic', 'agent_patch', 'manual_review'))
);
--> statement-breakpoint
CREATE TABLE "proof_patches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"proof_state_id" uuid,
	"patch_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_kind" text NOT NULL,
	"validation_status" text DEFAULT 'PENDING' NOT NULL,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_proof_patches_type" CHECK ("patch_type" in ('alias_binding', 'function_summary_patch', 'route_transform_patch', 'endpoint_disambiguation', 'method_path_hint', 'reject_patch')),
	CONSTRAINT "chk_proof_patches_source_kind" CHECK ("source_kind" in ('deterministic', 'agent', 'manual')),
	CONSTRAINT "chk_proof_patches_validation_status" CHECK ("validation_status" in ('PENDING', 'ACCEPTED', 'REJECTED'))
);
--> statement-breakpoint
CREATE TABLE "proof_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"proof_state_id" uuid NOT NULL,
	"source_run_id" uuid,
	"dependency_kind" text NOT NULL,
	"dependency_key" text NOT NULL,
	"dependency_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_proof_dependencies_ws_proof_kind_key" UNIQUE("workspace_id","proof_state_id","dependency_kind","dependency_key")
);
--> statement-breakpoint
ALTER TABLE "interaction_intents" ADD CONSTRAINT "interaction_intents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "interaction_intents" ADD CONSTRAINT "interaction_intents_created_run_id_inference_runs_id_fk" FOREIGN KEY ("created_run_id") REFERENCES "public"."inference_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "interaction_intents" ADD CONSTRAINT "interaction_intents_updated_run_id_inference_runs_id_fk" FOREIGN KEY ("updated_run_id") REFERENCES "public"."inference_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "interaction_intents" ADD CONSTRAINT "interaction_intents_source_service_id_objects_id_fk" FOREIGN KEY ("source_service_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "interaction_intents" ADD CONSTRAINT "interaction_intents_source_function_id_objects_id_fk" FOREIGN KEY ("source_function_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "function_summaries" ADD CONSTRAINT "function_summaries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "function_summaries" ADD CONSTRAINT "function_summaries_created_run_id_inference_runs_id_fk" FOREIGN KEY ("created_run_id") REFERENCES "public"."inference_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "function_summaries" ADD CONSTRAINT "function_summaries_updated_run_id_inference_runs_id_fk" FOREIGN KEY ("updated_run_id") REFERENCES "public"."inference_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "function_summaries" ADD CONSTRAINT "function_summaries_function_id_objects_id_fk" FOREIGN KEY ("function_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "function_summaries" ADD CONSTRAINT "function_summaries_service_id_objects_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "route_transforms" ADD CONSTRAINT "route_transforms_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "route_transforms" ADD CONSTRAINT "route_transforms_created_run_id_inference_runs_id_fk" FOREIGN KEY ("created_run_id") REFERENCES "public"."inference_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "route_transforms" ADD CONSTRAINT "route_transforms_updated_run_id_inference_runs_id_fk" FOREIGN KEY ("updated_run_id") REFERENCES "public"."inference_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "route_transforms" ADD CONSTRAINT "route_transforms_owner_service_id_objects_id_fk" FOREIGN KEY ("owner_service_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "alias_bindings" ADD CONSTRAINT "alias_bindings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "alias_bindings" ADD CONSTRAINT "alias_bindings_created_run_id_inference_runs_id_fk" FOREIGN KEY ("created_run_id") REFERENCES "public"."inference_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "alias_bindings" ADD CONSTRAINT "alias_bindings_updated_run_id_inference_runs_id_fk" FOREIGN KEY ("updated_run_id") REFERENCES "public"."inference_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "alias_bindings" ADD CONSTRAINT "alias_bindings_owner_service_id_objects_id_fk" FOREIGN KEY ("owner_service_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "alias_bindings" ADD CONSTRAINT "alias_bindings_resolved_service_id_objects_id_fk" FOREIGN KEY ("resolved_service_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "proof_states" ADD CONSTRAINT "proof_states_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "proof_states" ADD CONSTRAINT "proof_states_intent_id_interaction_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."interaction_intents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "proof_states" ADD CONSTRAINT "proof_states_consumer_service_id_objects_id_fk" FOREIGN KEY ("consumer_service_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "proof_states" ADD CONSTRAINT "proof_states_source_function_id_objects_id_fk" FOREIGN KEY ("source_function_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "proof_states" ADD CONSTRAINT "proof_states_provider_service_id_objects_id_fk" FOREIGN KEY ("provider_service_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "proof_states" ADD CONSTRAINT "proof_states_target_object_id_objects_id_fk" FOREIGN KEY ("target_object_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "proof_steps" ADD CONSTRAINT "proof_steps_proof_state_id_proof_states_id_fk" FOREIGN KEY ("proof_state_id") REFERENCES "public"."proof_states"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "proof_frontiers" ADD CONSTRAINT "proof_frontiers_proof_state_id_proof_states_id_fk" FOREIGN KEY ("proof_state_id") REFERENCES "public"."proof_states"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "proof_frontiers" ADD CONSTRAINT "proof_frontiers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "proof_patches" ADD CONSTRAINT "proof_patches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "proof_patches" ADD CONSTRAINT "proof_patches_proof_state_id_proof_states_id_fk" FOREIGN KEY ("proof_state_id") REFERENCES "public"."proof_states"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "proof_dependencies" ADD CONSTRAINT "proof_dependencies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "proof_dependencies" ADD CONSTRAINT "proof_dependencies_proof_state_id_proof_states_id_fk" FOREIGN KEY ("proof_state_id") REFERENCES "public"."proof_states"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "proof_dependencies" ADD CONSTRAINT "proof_dependencies_source_run_id_inference_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."inference_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_interaction_intents_ws_status" ON "interaction_intents" USING btree ("workspace_id","status");
--> statement-breakpoint
CREATE INDEX "idx_interaction_intents_ws_source" ON "interaction_intents" USING btree ("workspace_id","source_service_id","intent_type");
--> statement-breakpoint
CREATE INDEX "idx_interaction_intents_ws_function" ON "interaction_intents" USING btree ("workspace_id","source_function_id");
--> statement-breakpoint
CREATE INDEX "idx_function_summaries_ws_function" ON "function_summaries" USING btree ("workspace_id","function_id","status");
--> statement-breakpoint
CREATE INDEX "idx_function_summaries_ws_service" ON "function_summaries" USING btree ("workspace_id","service_id","status");
--> statement-breakpoint
CREATE INDEX "idx_function_summaries_ws_sourcehash" ON "function_summaries" USING btree ("workspace_id","source_hash");
--> statement-breakpoint
CREATE INDEX "idx_route_transforms_ws_owner" ON "route_transforms" USING btree ("workspace_id","owner_service_id","gateway_kind");
--> statement-breakpoint
CREATE INDEX "idx_route_transforms_ws_targethint" ON "route_transforms" USING btree ("workspace_id","target_service_hint");
--> statement-breakpoint
CREATE INDEX "idx_route_transforms_ws_path" ON "route_transforms" USING btree ("workspace_id","match_path");
--> statement-breakpoint
CREATE INDEX "idx_alias_bindings_ws_key" ON "alias_bindings" USING btree ("workspace_id","alias_key","status");
--> statement-breakpoint
CREATE INDEX "idx_alias_bindings_ws_owner" ON "alias_bindings" USING btree ("workspace_id","owner_service_id","status");
--> statement-breakpoint
CREATE INDEX "idx_alias_bindings_ws_service" ON "alias_bindings" USING btree ("workspace_id","resolved_service_id","status");
--> statement-breakpoint
CREATE INDEX "idx_proof_states_ws_status" ON "proof_states" USING btree ("workspace_id","status");
--> statement-breakpoint
CREATE INDEX "idx_proof_states_ws_consumer_status" ON "proof_states" USING btree ("workspace_id","consumer_service_id","status");
--> statement-breakpoint
CREATE INDEX "idx_proof_states_ws_provider_status" ON "proof_states" USING btree ("workspace_id","provider_service_id","status");
--> statement-breakpoint
CREATE INDEX "idx_proof_states_ws_target" ON "proof_states" USING btree ("workspace_id","target_object_id");
--> statement-breakpoint
CREATE INDEX "idx_proof_steps_proof_order" ON "proof_steps" USING btree ("proof_state_id","step_order");
--> statement-breakpoint
CREATE INDEX "idx_proof_frontiers_ws_reason" ON "proof_frontiers" USING btree ("workspace_id","frontier_reason");
--> statement-breakpoint
CREATE INDEX "idx_proof_frontiers_ws_priority" ON "proof_frontiers" USING btree ("workspace_id","priority");
--> statement-breakpoint
CREATE INDEX "idx_proof_patches_ws_status" ON "proof_patches" USING btree ("workspace_id","validation_status","source_kind");
--> statement-breakpoint
CREATE INDEX "idx_proof_patches_ws_proof" ON "proof_patches" USING btree ("workspace_id","proof_state_id","validation_status");
--> statement-breakpoint
CREATE INDEX "idx_proof_dependencies_ws_proof" ON "proof_dependencies" USING btree ("workspace_id","proof_state_id");
--> statement-breakpoint
CREATE INDEX "idx_proof_dependencies_ws_kind_key" ON "proof_dependencies" USING btree ("workspace_id","dependency_kind","dependency_key");
--> statement-breakpoint
CREATE INDEX "idx_proof_dependencies_ws_hash" ON "proof_dependencies" USING btree ("workspace_id","dependency_hash");
