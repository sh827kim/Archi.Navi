ALTER TABLE "domain_inference_profiles"
  ADD COLUMN "proof_confidence_config" jsonb DEFAULT '{
    "name": "intent-proof-default",
    "version": "v1",
    "weights": {
      "summaryQuality": 0.45,
      "slotCompleteness": 0.25,
      "corroborationPerSignal": 0.05,
      "corroborationCap": 0.2,
      "contradictionPenaltyPerItem": 0.2,
      "contradictionPenaltyCap": 0.6
    },
    "slotWeights": {
      "http": {
        "method": 0.2,
        "externalPath": 0.2,
        "internalPath": 0.2,
        "providerService": 0.2,
        "targetObject": 0.2
      },
      "db": {
        "action": 0.25,
        "table": 0.25,
        "schema": 0.15,
        "datasource": 0.1,
        "targetObject": 0.25
      },
      "message": {
        "channel": 0.4,
        "broker": 0.2,
        "objectType": 0.15,
        "targetObject": 0.25
      }
    }
  }'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "function_summaries"
  ADD COLUMN "extraction_strategy" text DEFAULT 'legacy_edges_fallback' NOT NULL;
--> statement-breakpoint
ALTER TABLE "function_summaries"
  ADD CONSTRAINT "chk_function_summaries_extraction_strategy"
  CHECK ("extraction_strategy" in ('ast_primary', 'mixed_signals', 'legacy_edges_fallback'));
