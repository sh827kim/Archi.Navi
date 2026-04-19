-- 동일 워크스페이스 내에서 같은 path 의 domain 객체가 중복 생성되지 않도록 강제.
-- /api/domains/approve 의 check-then-insert 가 동시 실행될 때 두 트랜잭션이 모두
-- 기존 행을 못 보고 각각 INSERT 하는 race 를 DB 차원에서 막는다.
-- domain 타입에만 적용 (다른 object_type 은 path 중복이 정상이므로 partial index).
CREATE UNIQUE INDEX IF NOT EXISTS "ux_objects_ws_domain_path"
    ON "objects" ("workspace_id", "path")
    WHERE "object_type" = 'domain';
