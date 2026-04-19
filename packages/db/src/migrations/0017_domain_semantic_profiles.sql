CREATE TABLE "domain_semantic_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"domain_id" uuid NOT NULL,
	"schema_version" text DEFAULT '1.0' NOT NULL,
	"domain_name" text NOT NULL,
	"responsibility" text NOT NULL,
	"state" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"invariants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"collaborators" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scenarios" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"generated_by" text DEFAULT 'manual' NOT NULL,
	"llm_model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_dsp_ws_domain" UNIQUE("workspace_id","domain_id"),
	CONSTRAINT "chk_dsp_status" CHECK ("status" in ('DRAFT', 'APPROVED'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "domain_semantic_profiles" ADD CONSTRAINT "domain_semantic_profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "domain_semantic_profiles" ADD CONSTRAINT "domain_semantic_profiles_domain_id_objects_id_fk" FOREIGN KEY ("domain_id") REFERENCES "objects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_dsp_ws_status" ON "domain_semantic_profiles" ("workspace_id","status");
