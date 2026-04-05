ALTER TABLE "proof_patches"
  DROP CONSTRAINT IF EXISTS "chk_proof_patches_source_kind";
--> statement-breakpoint
ALTER TABLE "proof_patches"
  ADD CONSTRAINT "chk_proof_patches_source_kind"
  CHECK ("source_kind" in ('deterministic', 'agent', 'smart_agent', 'manual'));
--> statement-breakpoint
CREATE TABLE "smart_proof_llm_calls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "run_id" uuid REFERENCES "inference_runs"("id") ON DELETE SET NULL,
  "proof_state_id" uuid REFERENCES "proof_states"("id") ON DELETE SET NULL,
  "call_category" text NOT NULL,
  "frontier_reason" text,
  "model" text NOT NULL,
  "temperature" real DEFAULT 0.1 NOT NULL,
  "input_tokens" integer NOT NULL,
  "output_tokens" integer NOT NULL,
  "estimated_cost_usd" real,
  "prompt_hash" text NOT NULL,
  "response_hash" text NOT NULL,
  "prompt_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "response_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "confidence" real,
  "accepted" boolean,
  "patch_id" uuid REFERENCES "proof_patches"("id") ON DELETE SET NULL,
  "duration_ms" integer,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "chk_smart_proof_llm_calls_category"
    CHECK ("call_category" in (
      'pre_resolution_enhancement',
      'frontier_resolution',
      'ambiguity_resolution',
      'cross_proof_correlation',
      'contradiction_detection'
    ))
);
--> statement-breakpoint
CREATE INDEX "idx_smart_proof_llm_calls_ws_run"
  ON "smart_proof_llm_calls" ("workspace_id", "run_id");
--> statement-breakpoint
CREATE INDEX "idx_smart_proof_llm_calls_proof"
  ON "smart_proof_llm_calls" ("proof_state_id");
