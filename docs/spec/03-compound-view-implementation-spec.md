# Compound View Implementation SPEC

- 작성일: 2026-03-02
- 상태: Implemented
- 연계 문서: `../design/06-compound-view.md`, `../design/05-rollup-and-graph.md`

## 1. 목적
`../design/06-compound-view.md`의 개념 설계를 실제 구현 단위로 분해해, Compound View를 단계적으로 릴리스 가능한 형태로 정의한다.

## 2. 범위
### 2.1 MVP (Phase A)
1. ✅ Compound 1-level 그래프에서 edge 선택 시 Contributor Panel 오픈
2. ✅ 선택된 Compound 쌍에 대한 Atomic 근거 목록 조회
3. ✅ Evidence Chain(`relation_evidences -> evidences`) 연결 표시
4. ✅ Grouping 옵션 2종 우선 제공
- `targetCompound` (기본)
- `relationType`

### 2.2 확장 (Phase B)
1. ✅ Grouping 옵션 확장
- `sourceAtomic`
- `targetAtomic`
2. ✅ Scope Mode 전환
- `SUBTREE` (기본)
- `GLOBAL`
3. ✅ Affinity Compound(domain) subtree 해소
- `object_domain_affinities` 기반 가상 subtree

## 3. API/쿼리 계약
1. Contributor 조회 입력
- `workspaceId`
- `sourceCompoundId`
- `targetCompoundId`
- `scopeMode`
- `groupBy`
- `relationTypes?`

2. Contributor 조회 출력
- `summary`
  - `totalCount`
  - `byRelationType`
- `groups[]`
  - `groupKey`
  - `weight`
  - `relations[]`
    - `relationId`
    - `sourceAtomicId`
    - `targetAtomicId`
    - `relationType`
    - `confidence`
    - `evidenceCount`

## 4. 구현 순서
1. Query 계층
- contributor 조회 유스케이스 추가 (`packages/core/src/query-engine/`)
- `objects.path` + `object_domain_affinities` 기반 scope 해소

2. Web API
- `GET /api/mapping/contributors` 신규 라우트
- `workspaceId` 필수, query 파라미터 유효성 검사

3. UI
- Object Mapping 화면에 Contributor Panel 연결
- edge 클릭 시 패널 데이터 로딩 + grouping/scope 컨트롤 제공

4. 테스트
- 단위: contributor 집계/그룹핑/증거 연결
- e2e: edge 클릭 → 패널 오픈 → 근거 표시

## 7. 현재 구현 메모 (2026-03-02)
1. API: `GET /api/mapping/contributors` 구현 완료
- rollupId가 있으면 `object_rollup_provenances` 기반으로 base relation 조회
- rollupId가 없으면 source/target subtree fallback 조회
- relation별 evidence 체인(`relation_evidences -> evidences`) 포함
- 구현 위치: `packages/core/src/query-engine/contributors.ts` (API route는 thin wrapper)

2. UI: Object Mapping 3D 링크 클릭 기반 Contributor Panel 구현 완료
- `groupBy=targetCompound|relationType` 전환 지원
- 그룹/관계/evidence 요약 표시

3. 검증
- e2e: `mapping-contributors-api.spec.ts` 추가 및 통과

## 8. Phase B 구현 메모 (2026-03-02)
1. API
- `groupBy=sourceAtomic|targetAtomic` 지원
- `scopeMode=SUBTREE|GLOBAL` 지원
- domain 노드 입력 시 `object_domain_affinities(affinity >= 0.2)` 기반 서비스 subtree 해소

2. UI
- Contributor Panel에 groupBy 4종 + scope 2종 토글 추가
- 토글 변경 시 동일 링크 기준 재조회

3. 검증
- e2e: `mapping-contributors-api.spec.ts`에 scope/groupBy 확장 시나리오 추가 및 통과

## 9. 잔여 항목 반영 메모 (2026-03-02)
1. 페이지네이션
- Contributor API에 `limit`, `cursor` 추가
- 응답에 `pageInfo(limit, hasNext, nextCursor)` 포함

2. Evidence 표시
- 패널에 evidence `excerpt` 노출
- evidence가 없는 관계는 `"근거 없음"` 명시

3. 테스트 보강
- API e2e: pagination(`limit/cursor`) 시나리오 추가
- UI e2e: 링크 선택 시 Contributor 패널 오픈 검증 추가 (`mapping-contributor-panel-ui.spec.ts`)

## 5. 비기능 요구사항
1. 기본 응답 시간: 1s 이내(샘플 데이터 기준) — 측정/모니터링 체계는 별도
2. 대규모 그래프에서 패널 API는 페이지네이션(`limit`, `cursor`) 지원 — 구현 완료
3. Evidence 없는 관계는 패널에서 "근거 없음"으로 명시 — 구현 완료

## 6. 수용 기준
1. Compound edge 클릭 시 Contributor Panel에 Atomic 근거가 표시된다.
2. Grouping 전환(`targetCompound`/`relationType`)이 즉시 반영된다.
3. Evidence 항목에서 파일 경로/라인/excerpt를 확인할 수 있다.
4. `SUBTREE`/`GLOBAL` 전환 시 결과 범위가 달라짐을 확인할 수 있다. (Phase B)
