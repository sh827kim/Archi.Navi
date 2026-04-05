ALTER TABLE "interaction_intents" ADD COLUMN "gateway_kind" text;
--> statement-breakpoint
ALTER TABLE "interaction_intents" ADD COLUMN "route_scope_kind" text;
--> statement-breakpoint
ALTER TABLE "interaction_intents" ADD COLUMN "external_route_pattern" text;
--> statement-breakpoint
ALTER TABLE "interaction_intents" ADD COLUMN "provider_hint" text;
--> statement-breakpoint
ALTER TABLE "interaction_intents" ADD COLUMN "target_service_hint" text;
--> statement-breakpoint
ALTER TABLE "interaction_intents" ADD COLUMN "route_transform_refs" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "interaction_intents" ADD COLUMN "method_constraint" text;
--> statement-breakpoint
ALTER TABLE "interaction_intents" DROP CONSTRAINT "chk_interaction_intents_type";
--> statement-breakpoint
ALTER TABLE "interaction_intents" ADD CONSTRAINT "chk_interaction_intents_type" CHECK ("intent_type" in ('http_call', 'http_gateway_route', 'db_access', 'message_publish', 'message_consume'));
--> statement-breakpoint
ALTER TABLE "interaction_intents" ADD CONSTRAINT "chk_interaction_intents_route_scope_kind" CHECK ("route_scope_kind" is null or "route_scope_kind" in ('exact', 'prefix', 'regex'));
--> statement-breakpoint
ALTER TABLE "interaction_intents" ADD CONSTRAINT "chk_interaction_intents_method_constraint" CHECK ("method_constraint" is null or "method_constraint" in ('unknown', 'any', 'exact'));
--> statement-breakpoint
ALTER TABLE "interaction_intents" ADD CONSTRAINT "chk_interaction_intents_gateway_route_required" CHECK (not ("intent_type" = 'http_gateway_route' and ("gateway_kind" is null or "route_scope_kind" is null or "external_route_pattern" is null)));
--> statement-breakpoint
ALTER TABLE "route_transforms" ADD COLUMN "match_mode" text DEFAULT 'exact' NOT NULL;
--> statement-breakpoint
ALTER TABLE "route_transforms" ADD COLUMN "path_capture_policy" text;
--> statement-breakpoint
ALTER TABLE "route_transforms" ADD COLUMN "route_mount_prefix" text;
--> statement-breakpoint
ALTER TABLE "route_transforms" ADD COLUMN "target_path_base_hint" text;
--> statement-breakpoint
ALTER TABLE "route_transforms" ADD CONSTRAINT "chk_route_transforms_match_mode" CHECK ("match_mode" in ('exact', 'prefix', 'regex'));
--> statement-breakpoint
ALTER TABLE "proof_states" ADD COLUMN "origin_intent_id" uuid;
--> statement-breakpoint
ALTER TABLE "proof_states" ADD COLUMN "parent_proof_state_id" uuid;
--> statement-breakpoint
UPDATE "proof_states" SET "origin_intent_id" = "intent_id" WHERE "origin_intent_id" is null;
--> statement-breakpoint
ALTER TABLE "proof_states" ADD CONSTRAINT "proof_states_origin_intent_id_interaction_intents_id_fk" FOREIGN KEY ("origin_intent_id") REFERENCES "public"."interaction_intents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "proof_states" ADD CONSTRAINT "proof_states_parent_proof_state_id_proof_states_id_fk" FOREIGN KEY ("parent_proof_state_id") REFERENCES "public"."proof_states"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "proof_states" DROP CONSTRAINT "uq_proof_states_ws_intent";
--> statement-breakpoint
ALTER TABLE "proof_states" DROP CONSTRAINT "chk_proof_states_type";
--> statement-breakpoint
ALTER TABLE "proof_states" ADD CONSTRAINT "chk_proof_states_type" CHECK ("proof_type" in ('http_call', 'http_gateway_route', 'db_access', 'message_publish', 'message_consume'));
--> statement-breakpoint
CREATE INDEX "idx_proof_states_ws_intent" ON "proof_states" USING btree ("workspace_id","intent_id");
--> statement-breakpoint
CREATE INDEX "idx_proof_states_ws_origin" ON "proof_states" USING btree ("workspace_id","origin_intent_id","status");
--> statement-breakpoint
CREATE INDEX "idx_proof_states_ws_parent" ON "proof_states" USING btree ("workspace_id","parent_proof_state_id","status");
