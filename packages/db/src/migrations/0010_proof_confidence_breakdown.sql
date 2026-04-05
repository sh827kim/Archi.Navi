ALTER TABLE "proof_states"
  ADD COLUMN "confidence_breakdown" jsonb DEFAULT '{}'::jsonb NOT NULL;
