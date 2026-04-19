-- 동일 워크스페이스 내에서 같은 path 의 domain 객체가 중복 생성되지 않도록 강제.
-- /api/domains/approve 의 check-then-insert 가 동시 실행될 때 두 트랜잭션이 모두
-- 기존 행을 못 보고 각각 INSERT 하는 race 를 DB 차원에서 막는다.
-- domain 타입에만 적용 (다른 object_type 은 path 중복이 정상이므로 partial index).

-- 선행 정리: 과거 race 로 이미 중복 생성된 (workspace_id, path) 도메인 행이 존재하면
-- 유니크 인덱스 생성이 실패해 롤아웃이 막힌다. 가장 오래된(created_at 오름차순, id 오름차순)
-- 행을 survivor 로 선택하고, 중복 행의 멤버십을 survivor 로 병합한 뒤 중복 행을 삭제한다.
-- object_domain_affinities.domain_id 는 ON DELETE CASCADE FK 이므로 중복 domain 행
-- 삭제 시 병합되지 못한 affinity 는 자동 정리된다 (같은 (workspace, object) 쌍이 survivor
-- 에도 있어 이관이 충돌로 skip 된 경우).

WITH ranked AS (
    SELECT
        id,
        workspace_id,
        path,
        ROW_NUMBER() OVER (
            PARTITION BY workspace_id, path
            ORDER BY created_at ASC, id ASC
        ) AS rn,
        FIRST_VALUE(id) OVER (
            PARTITION BY workspace_id, path
            ORDER BY created_at ASC, id ASC
        ) AS survivor_id
    FROM objects
    WHERE object_type = 'domain'
),
to_merge AS (
    SELECT id AS dup_id, survivor_id
    FROM ranked
    WHERE rn > 1
)
UPDATE object_domain_affinities oda
SET domain_id = tm.survivor_id
FROM to_merge tm
WHERE oda.domain_id = tm.dup_id
  AND NOT EXISTS (
      SELECT 1
      FROM object_domain_affinities existing
      WHERE existing.workspace_id = oda.workspace_id
        AND existing.object_id = oda.object_id
        AND existing.domain_id = tm.survivor_id
  );
--> statement-breakpoint

-- rollup / graph stats 는 materialized 파생 데이터라 duplicate domain 의 ID를
-- 기계적으로 survivor 로 합치면 edge/stat 중복이 생길 수 있다.
-- 중복 domain 을 참조하는 파생 row 를 먼저 제거해 FK 위반 없이 dedup + unique index 생성이
-- 진행되도록 하고, 이후 rollup 재생성 시 survivor 기준으로 다시 계산되게 둔다.
WITH ranked AS (
    SELECT
        id,
        ROW_NUMBER() OVER (
            PARTITION BY workspace_id, path
            ORDER BY created_at ASC, id ASC
        ) AS rn
    FROM objects
    WHERE object_type = 'domain'
),
dup_ids AS (
    SELECT id
    FROM ranked
    WHERE rn > 1
)
DELETE FROM object_graph_stats
WHERE object_id IN (SELECT id FROM dup_ids);
--> statement-breakpoint

WITH ranked AS (
    SELECT
        id,
        ROW_NUMBER() OVER (
            PARTITION BY workspace_id, path
            ORDER BY created_at ASC, id ASC
        ) AS rn
    FROM objects
    WHERE object_type = 'domain'
),
dup_ids AS (
    SELECT id
    FROM ranked
    WHERE rn > 1
)
DELETE FROM object_rollups
WHERE subject_object_id IN (SELECT id FROM dup_ids)
   OR object_id IN (SELECT id FROM dup_ids);
--> statement-breakpoint

WITH ranked AS (
    SELECT
        id,
        ROW_NUMBER() OVER (
            PARTITION BY workspace_id, path
            ORDER BY created_at ASC, id ASC
        ) AS rn
    FROM objects
    WHERE object_type = 'domain'
)
DELETE FROM objects
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "ux_objects_ws_domain_path"
    ON "objects" ("workspace_id", "path")
    WHERE "object_type" = 'domain';
