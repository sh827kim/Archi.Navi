ALTER TABLE "domain_inference_profiles"
ADD COLUMN "cross_validation" jsonb DEFAULT '{"enabled": true, "boostFactor": 0.3, "penaltyFactor": 0.85}'::jsonb;
