# Incremental Rollup Rebuild SPEC (Roadmap 3-1)

- 작성일: 2026-03-02
- 상태: Active
- 대상: `packages/core/src/rollup/builder.ts`, `apps/web/src/lib/rollup-change-events.ts`, Web API mutation routes
- 연계 문서: `../design/05-rollup-and-graph.md`

## 1. 목적
관계/도메인 변경 시 전체 rollup 재빌드 대신 변경 영향 범위만 갱신해 응답 지연과 비용을 줄이고, UI 조회 시점의 일관성을 유지한다.

## 2. 범위
1. `incrementalRebuild` 알고리즘 적용
2. API 변경 이벤트를 `ChangeEvent[]`로 표준화
3. 관계/도메인 승인 및 관계 삭제 경로의 자동 증분 리빌드 트리거
4. 증분 대상이 없거나 ACTIVE generation 부재 시 안전 fallback

## 3. 기능 요구사항
1. 이벤트 타입
- `RELATION_ADDED`
- `RELATION_REMOVED`
- `EXPOSE_CHANGED`
- `DOMAIN_AFFINITY_CHANGED`

2. 트리거 라우트
- `PATCH /api/inference/candidates/:id` (APPROVED)
- `PATCH /api/inference/domain-candidates/:id` (APPROVED)
- `POST /api/relations` (APPROVED 직접 생성)
- `DELETE /api/relations/:id`

3. 갱신 단위
- 레벨: `SERVICE_TO_SERVICE`, `SERVICE_TO_DATABASE`, `SERVICE_TO_BROKER`, `DOMAIN_TO_DOMAIN`
- 영향 노드: 이벤트 주체/대상 및 expose caller 역추적 노드 집합

## 4. 계약
### 4.1 입력
```ts
{
  workspaceId: string;
  events: ChangeEvent[];
  requestedBy?: string;
}
```

### 4.2 출력
```ts
{
  generationVersion: number;
  affectedLevels: string[];
  affectedObjectIds: string[];
  fallbackToFullRebuild: boolean;
}
```

## 5. 오류/예외 정책
1. 이벤트 파싱 실패: 요청 실패(4xx/5xx)로 반환
2. ACTIVE generation 없음: 증분 대신 full rebuild fallback
3. 증분 계산 실패: full rebuild fallback 후 결과 반환
4. fallback도 실패: mutation 요청 자체를 실패 처리(데이터 정합성 우선)

## 6. 비기능 요구사항
1. 동일 이벤트 입력에 대해 결정론적 결과를 반환한다.
2. 전체 재빌드 대비 평균 처리 시간을 단축한다(샘플 기준 50% 이상).
3. 증분 결과는 full rebuild와 의미적으로 동등해야 한다.

## 7. 수용 기준
1. 관계 승인/삭제 직후 수동 `/api/rollups` 호출 없이 query 응답이 최신 상태를 반영한다.
2. `EXPOSE_CHANGED` 이벤트에서 caller 영향 범위가 반영된다.
3. 증분 불가 조건에서 fallback 경로가 동작한다.
4. e2e 시나리오(승인→query)가 회귀 없이 통과한다.
