alter table "domain_inference_profiles"
  add column if not exists "scan_config" jsonb default '{"enableDbScan":false}'::jsonb;

update "domain_inference_profiles"
set "scan_config" = '{"enableDbScan":false}'::jsonb
where "scan_config" is null;
