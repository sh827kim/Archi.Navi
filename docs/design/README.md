# Design 문서 목록

`docs/design`은 Archi.Navi의 설계 기준과 확장 설계 방향을 관리하는 문서 모음이다.

최종 정리: 2026-03-31

## 범위
- 포함: 시스템 구조, 데이터 모델, 추론/쿼리/롤업/뷰 설계, 운영 원칙
- 제외: 기능별 API 계약, 상세 수용 기준, 테스트 체크리스트
  - 기능 단위 계약은 `docs/spec`에서 관리한다.

## 읽는 순서
1. [01-architecture.md](./01-architecture.md)
2. [02-data-model.md](./02-data-model.md)
3. [03-inference-engine.md](./03-inference-engine.md)
4. [04-query-engine.md](./04-query-engine.md)
5. [05-rollup-and-graph.md](./05-rollup-and-graph.md)
6. [06-compound-view.md](./06-compound-view.md)

## 문서 상태

| 문서 | 역할 | 상태 |
|------|------|--------|
| [01-architecture.md](./01-architecture.md) | 런타임/패키지 구조 기준 문서 | Current |
| [02-data-model.md](./02-data-model.md) | 스키마와 객체/관계 모델 기준 문서 | Current |
| [03-inference-engine.md](./03-inference-engine.md) | 표준 추론 + Smart 추론 + 운영 모델 기준 문서 | Current |
| [04-query-engine.md](./04-query-engine.md) | 결정론 쿼리 엔진과 AI assistant 결합 방식 기준 문서 | Current |
| [05-rollup-and-graph.md](./05-rollup-and-graph.md) | rollup generation, delta rebuild, 실시간 갱신 기준 문서 | Current |
| [06-compound-view.md](./06-compound-view.md) | mapping graph / contributor drill-down UI 기준 문서 | Current |
| [07-inference-engine-advanced.md](./07-inference-engine-advanced.md) | 추론 엔진 고도화/확장 설계 | Extension |
| [08-developer-productivity.md](./08-developer-productivity.md) | 생산성 기능 로드맵/확장 설계 | Extension |
| [09-intent-centric-proof-engine-overview.md](./09-intent-centric-proof-engine-overview.md) | intent-first proof engine 개요 | Proposed |
| [10-intent-centric-proof-engine-state-model.md](./10-intent-centric-proof-engine-state-model.md) | intent/proof 상태 모델과 추출 레이어 | Proposed |
| [11-intent-centric-proof-engine-resolution-pipeline.md](./11-intent-centric-proof-engine-resolution-pipeline.md) | fixed resolution pipeline, frontier, agent | Proposed |
| [12-intent-centric-proof-engine-adoption-plan.md](./12-intent-centric-proof-engine-adoption-plan.md) | 구현 교체, UI/운영, cutover 계획 | Proposed |

## 이번 현행화에서 반영한 방향
- 제품의 중심축을 `단발성 추론 도구`가 아니라 `워크스페이스 기반 운영형 아키텍처 지식 시스템`으로 재정의했다.
- 추론을 `표준 실행`, `비동기 run orchestration`, `Smart pair-scoped atomic inference`까지 포함한 구조로 정리했다.
- rollup을 full rebuild 중심 설명에서 `delta rebuild + SSE refetch` 기반 운영 모델로 맞췄다.
- query/chat을 분리해서, 결정론 엔진과 AI assistant가 각각 어떤 책임을 가지는지 명확히 했다.
- mapping graph를 3D 렌더러, contributor 패널, 실시간 동기화, domain-first 탐색을 포함한 UX 기준으로 갱신했다.
