CREATE TABLE "inference_run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"level" text DEFAULT 'INFO' NOT NULL,
	"event_type" text NOT NULL,
	"message" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inference_run_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_ref" text NOT NULL,
	"resolved_repo_root" text,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inference_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"trigger_type" text DEFAULT 'MANUAL' NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"requested_modes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requested_code_engine" text,
	"requested_incremental" boolean DEFAULT true NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 1 NOT NULL,
	"idempotency_key" text,
	"source_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inference_run_events" ADD CONSTRAINT "inference_run_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_run_events" ADD CONSTRAINT "inference_run_events_run_id_inference_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."inference_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_run_sources" ADD CONSTRAINT "inference_run_sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_run_sources" ADD CONSTRAINT "inference_run_sources_run_id_inference_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."inference_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_runs" ADD CONSTRAINT "inference_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_infrev_ws_run_created" ON "inference_run_events" USING btree ("workspace_id","run_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_infrunsrc_ws_run" ON "inference_run_sources" USING btree ("workspace_id","run_id");--> statement-breakpoint
CREATE INDEX "ix_infrunsrc_ws_type" ON "inference_run_sources" USING btree ("workspace_id","source_type");--> statement-breakpoint
CREATE INDEX "ix_infrun_ws_created" ON "inference_runs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "ix_infrun_ws_status_created" ON "inference_runs" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX "ix_infrun_ws_idempotency" ON "inference_runs" USING btree ("workspace_id","idempotency_key");
