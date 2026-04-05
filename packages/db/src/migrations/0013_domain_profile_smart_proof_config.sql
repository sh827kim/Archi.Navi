ALTER TABLE "domain_inference_profiles"
  ADD COLUMN IF NOT EXISTS "smart_proof_config" jsonb DEFAULT '{
    "enabled": false,
    "categories": {
      "preResolutionEnhancement": false,
      "frontierResolution": true,
      "ambiguityResolution": false,
      "crossProofCorrelation": false,
      "contradictionDetection": false
    },
    "budget": {
      "maxLlmCallsPerRun": 100,
      "maxLlmCallsPerIntent": 5,
      "maxInputTokensPerCall": 4000,
      "maxTotalTokensPerRun": 500000
    },
    "thresholds": {
      "autoAcceptConfidence": 0.8,
      "reviewConfidence": 0.5,
      "skipConfidence": 0.3
    },
    "temperature": 0.1
  }'::jsonb;
