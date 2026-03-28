ALTER TABLE "domain_inference_profiles"
ADD COLUMN "feedback_config" jsonb DEFAULT '{"enabled": true, "minSamples": 10, "maxAdjustment": 0.15}'::jsonb;
--> statement-breakpoint
ALTER TABLE "domain_inference_profiles"
ADD COLUMN "feedback_adjustments" jsonb DEFAULT '{}'::jsonb;
