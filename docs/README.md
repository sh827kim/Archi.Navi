# Docs 구조 가이드

문서는 목적이 겹치지 않도록 `Design`, `SPEC`, `Checklist`, `Guide/Ops`로 분리한다. 2026-04-15 기준으로 상세 파일 목록은 각 하위 README가 canonical source다.

## 분류 기준

| 구분 | 위치 | 포함 내용 | 제외 내용 |
|------|------|-----------|-----------|
| Design | `docs/design` | 아키텍처, 데이터 모델, 알고리즘, 데이터 흐름 | 기능별 수용 기준 |
| SPEC | `docs/spec` | 기능 요구사항, API/입출력 계약, 수용 기준 | 제품 전체 아키텍처 설명 |
| Checklist | `docs/checklists` | 구현 진행 체크, 검증 체크, 이행 확인 | 기능 요구사항 원문 |
| Guide/Ops | `docs` 루트 | 개요, 개발/검증/배포 가이드, 구현 현황, 로드맵 | 기능 상세 계약 |

## 작성 규칙

1. 신규 기능은 먼저 `docs/spec/*-spec.md`로 요구사항과 수용 기준을 정의한다.
2. 구조/알고리즘 변경이 있으면 `docs/design/*.md`에 반영한다.
3. SPEC 구현 진행 체크는 `docs/checklists/*-checklist.md` 형식으로 작성한다.
4. 루트 문서에는 기능 계약을 중복 작성하지 않고 하위 README를 우선 링크한다.
5. 작은 파생 SPEC은 상위 canonical SPEC으로 통합하고, 중복 인덱스는 남기지 않는다.

## 읽는 순서

1. [00-overview.md](./00-overview.md)
2. [01-development-guide.md](./01-development-guide.md)
3. [02-implementation-status.md](./02-implementation-status.md)
4. [03-roadmap.md](./03-roadmap.md)
5. [04-verification-guide.md](./04-verification-guide.md)
6. [05-npm-distribution.md](./05-npm-distribution.md)

## 문서 인덱스

### Design
- [docs/design/README.md](./design/README.md)

핵심 흐름:
- [01-architecture.md](./design/01-architecture.md)
- [02-data-model.md](./design/02-data-model.md)
- [03-inference-engine.md](./design/03-inference-engine.md)
- [09-intent-centric-proof-engine-overview.md](./design/09-intent-centric-proof-engine-overview.md)
- [14-signal-coverage-design-public-edition.md](./design/14-signal-coverage-design-public-edition.md)

### SPEC
- [docs/spec/README.md](./spec/README.md)

현재 구현 축의 대표 canonical SPEC:
- [18-cross-signal-validation-spec.md](./spec/18-cross-signal-validation-spec.md)
- [48-intent-centric-proof-engine-spec.md](./spec/48-intent-centric-proof-engine-spec.md)
- [50-intent-centric-proof-engine-resolution-pipeline-spec.md](./spec/50-intent-centric-proof-engine-resolution-pipeline-spec.md)
- [93-common-http-signal-extraction-coverage-spec.md](./spec/93-common-http-signal-extraction-coverage-spec.md)
- [99-dual-inference-pipeline-selector-spec.md](./spec/99-dual-inference-pipeline-selector-spec.md)
- [101-frontier-review-promotion-spec.md](./spec/101-frontier-review-promotion-spec.md)

### Checklist
- [docs/checklists/README.md](./checklists/README.md)

### Guide / Ops
- [00-overview.md](./00-overview.md)
- [01-development-guide.md](./01-development-guide.md)
- [02-implementation-status.md](./02-implementation-status.md)
- [03-roadmap.md](./03-roadmap.md)
- [04-verification-guide.md](./04-verification-guide.md)
- [05-npm-distribution.md](./05-npm-distribution.md)

## 이번 정리에서 반영한 사항

- 루트 README의 낡은 파일 나열을 없애고 하위 canonical README 중심으로 단순화했다.
- cross-signal validation과 signal coverage는 각각 단일 canonical SPEC 중심으로 재정리했다.
- frontier review는 구현 상태를 반영하는 canonical SPEC 하나로 정리했다.
