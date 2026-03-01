CREATE TABLE "object_rollup_provenances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"generation_version" bigint NOT NULL,
	"rollup_id" uuid NOT NULL,
	"base_relation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "object_rollup_provenances" ADD CONSTRAINT "object_rollup_provenances_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_rollup_provenances" ADD CONSTRAINT "object_rollup_provenances_rollup_id_object_rollups_id_fk" FOREIGN KEY ("rollup_id") REFERENCES "public"."object_rollups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_rollup_provenances" ADD CONSTRAINT "object_rollup_provenances_base_relation_id_object_relations_id_fk" FOREIGN KEY ("base_relation_id") REFERENCES "public"."object_relations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_rollup_prov_rollup" ON "object_rollup_provenances" USING btree ("workspace_id","generation_version","rollup_id");--> statement-breakpoint
CREATE INDEX "ix_rollup_prov_base" ON "object_rollup_provenances" USING btree ("workspace_id","generation_version","base_relation_id");
