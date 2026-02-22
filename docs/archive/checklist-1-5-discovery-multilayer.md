# 1-5 Discovery 다중 레이어 통합 체크리스트

> 작성일: 2026-02-22
> 참조: `docs/03-inference-engine.md` §4.2 멀티 레이어 가중 그래프 구성
> 브랜치: `feature/inference-engine`

---

## 목표

`discovery.ts` (Track B Seed-less Discovery)가 현재 `SERVICE_TO_SERVICE` rollup만
사용하는 것을 확장하여, `SERVICE_TO_DATABASE` / `SERVICE_TO_BROKER` rollup도
그래프 엣지로 포함시킨다. `domain_inference_profiles`의 엣지 가중치와
`enabled_layers`를 반영하여 워크스페이스별 튜닝이 가능하게 한다.

### 설계 기반 엣지 가중치 (기본값)

| 레이어 | Rollup Level | 프로필 키 | 기본 가중치 |
|--------|-------------|----------|-----------|
| call | SERVICE_TO_SERVICE | `edge_w_call` | 1.0 |
| db | SERVICE_TO_DATABASE | `edge_w_rw` | 0.8 |
| msg | SERVICE_TO_BROKER | `edge_w_msg` | 0.6 |

---

## 구현 체크리스트

### A. `discovery.ts` 수정 (`packages/inference`)

- [x] `domainInferenceProfiles` import 추가
- [x] 프로필 조회 로직 추가 (profileId 있으면 DB에서 조회)
- [x] `enabledLayers` 결정 (프로필 → 없으면 기본값 `['call','db','msg']`)
- [x] 엣지 가중치 결정 (프로필 → 없으면 기본값)
  - [x] `edge_w_call` (기본 1.0)
  - [x] `edge_w_rw` (기본 0.8)
  - [x] `edge_w_msg` (기본 0.6)
- [x] `minClusterSize` / `resolution` 프로필 폴백 처리
- [x] `addOrMergeEdge` 내부 헬퍼 구현 (동일 노드 쌍의 가중치 누적)
- [x] 그래프 구성 멀티 레이어 지원
  - [x] `enabled_layers` 에 'call' 포함 → SERVICE_TO_SERVICE 쿼리 + 엣지 추가
  - [x] `enabled_layers` 에 'db' 포함 → SERVICE_TO_DATABASE 쿼리 + 엣지 추가
  - [x] `enabled_layers` 에 'msg' 포함 → SERVICE_TO_BROKER 쿼리 + 엣지 추가
- [x] 빈 그래프 조기 반환: `s2sEdges.length === 0` → `graph.order === 0`
- [x] `domainDiscoveryRuns.inputLayers` → 실제 사용된 레이어 목록으로 업데이트
- [x] `domainDiscoveryRuns.parameters` → 엣지 가중치 포함 (디버깅용)

### B. 테스트 (`packages/inference`)

- [x] `packages/inference/src/__tests__/domain/discovery.test.ts` 신규 생성
  - [x] T1: 롤업 데이터 없음 → clusterCount=0, run 기록 생성
  - [x] T2: enabled_layers=['call'] 프로필 + S2DB 데이터만 → clusterCount=0 (call 엣지 없음)
  - [x] T3: enabled_layers=['db'] 프로필 + S2DB 데이터 → 공유 DB로 서비스 클러스터링
  - [x] T4: enabled_layers=['msg'] 프로필 + S2BROKER 데이터 → 공유 브로커로 서비스 클러스터링
  - [x] T5: enabled_layers=['call','db'] → 두 레이어 모두 반영 → inputLayers=['call','db']
  - [x] T6: 프로필 없음 (기본) + S2S 데이터 → default enabled_layers 사용
  - [x] T7: 프로필 edgeWRw=0 → S2DB 가중치 0 → 엣지 추가 안됨 (weight=0 필터)

### C. 빌드 검증

- [x] `pnpm --filter @archi-navi/inference exec tsc --noEmit` 에러 없음
- [x] `pnpm --filter @archi-navi/inference test:unit` 전체 GREEN (~131개 이상)
- [x] 기존 테스트 영향 없음 (regression 없음)

---

## 신규/수정 파일 목록

| 파일 | 상태 |
|------|------|
| `docs/checklist-1-5-discovery-multilayer.md` | 신규 |
| `packages/inference/src/domain/discovery.ts` | 수정 |
| `packages/inference/src/__tests__/domain/discovery.test.ts` | 신규 |
