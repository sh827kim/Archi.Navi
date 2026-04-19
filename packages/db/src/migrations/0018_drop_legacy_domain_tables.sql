-- Phase 1/2 도메인 추론 엔진 신설로 폐기되는 레거시 테이블 정리
-- domain_inference_profiles 는 Smart Proof 등에서 계속 사용 중이므로 유지
DROP TABLE IF EXISTS "domain_candidate_evidences" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "domain_discovery_memberships" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "domain_discovery_runs" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "domain_candidates" CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS "domain_rollup_provenances" CASCADE;
