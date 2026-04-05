ALTER TABLE "proof_patches"
  DROP CONSTRAINT IF EXISTS "chk_proof_patches_type";
--> statement-breakpoint
ALTER TABLE "proof_patches"
  ADD CONSTRAINT "chk_proof_patches_type"
  CHECK ("patch_type" in (
    'alias_binding',
    'function_summary_patch',
    'route_transform_patch',
    'endpoint_disambiguation',
    'method_path_hint',
    'provider_service_selection',
    'reject_patch'
  ));
