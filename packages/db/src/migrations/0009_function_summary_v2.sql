ALTER TABLE "function_summaries"
  ADD COLUMN "signal_sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
  ADD COLUMN "provenance_evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  ADD COLUMN "unresolved_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
  ADD COLUMN "summary_completeness" real DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "function_summaries"
  ADD CONSTRAINT "chk_function_summaries_completeness" CHECK ("summary_completeness" >= 0 and "summary_completeness" <= 1);
