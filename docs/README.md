# Docs 구조 가이드

문서는 목적이 겹치지 않도록 `Design`과 `SPEC`을 분리하고, 운영 문서는 루트에 둔다.

## 분류 기준

| 구분 | 위치 | 포함 내용 | 제외 내용 |
|------|------|-----------|-----------|
| Design | `docs/design` | 아키텍처, 데이터 모델, 알고리즘, 데이터 흐름 | 기능별 수용 기준(acceptance criteria) |
| SPEC | `docs/spec` | 기능 요구사항, API/입출력 계약, 수용 기준 | 제품 전체 아키텍처 설명 |
| Guide/Ops | `docs` 루트 | 개요, 개발/검증/배포 가이드, 구현 현황, 로드맵 | 기능 상세 계약 |

## 작성 규칙

1. 신규 기능은 먼저 `docs/spec/*-spec.md`로 요구사항과 수용 기준을 정의한다.
2. 구조/알고리즘 변경이 있으면 `docs/design/*.md`에 반영한다.
3. SPEC 구현 진행 체크는 `docs/spec/*-spec-checklist.md` 형식으로 작성한다.
4. 루트 문서에는 기능 계약을 중복 작성하지 않고 링크만 제공한다.

## 현재 구성

### Design (`docs/design`)
- [README.md](./design/README.md)
- [01-architecture.md](./design/01-architecture.md)
- [02-data-model.md](./design/02-data-model.md)
- [03-inference-engine.md](./design/03-inference-engine.md)
- [04-query-engine.md](./design/04-query-engine.md)
- [05-rollup-and-graph.md](./design/05-rollup-and-graph.md)
- [06-compound-view.md](./design/06-compound-view.md)
- [07-inference-engine-advanced.md](./design/07-inference-engine-advanced.md)
- [08-developer-productivity.md](./design/08-developer-productivity.md)

### SPEC (`docs/spec`)
- [README.md](./spec/README.md)
- [01-db-inference-index-unique-spec.md](./spec/01-db-inference-index-unique-spec.md)
- [02-object-mapping-3d-renderer-spec.md](./spec/02-object-mapping-3d-renderer-spec.md)
- [03-compound-view-implementation-spec.md](./spec/03-compound-view-implementation-spec.md)
- [04-llm-inference-filtering-spec.md](./spec/04-llm-inference-filtering-spec.md)
- [05-llm-inference-filtering-spec-checklist.md](./spec/05-llm-inference-filtering-spec-checklist.md)
- [06-incremental-rollup-rebuild-spec.md](./spec/06-incremental-rollup-rebuild-spec.md)
- [07-hub-node-management-spec.md](./spec/07-hub-node-management-spec.md)
- [08-progressive-rendering-spec.md](./spec/08-progressive-rendering-spec.md)
- [09-domain-first-navigation-spec.md](./spec/09-domain-first-navigation-spec.md)
- [10-incremental-inference-spec.md](./spec/10-incremental-inference-spec.md)
- [11-ast-default-code-signal-spec.md](./spec/11-ast-default-code-signal-spec.md)
- [12-ast-regex-hybrid-code-signal-spec.md](./spec/12-ast-regex-hybrid-code-signal-spec.md)
- [13-inference-run-orchestration-spec.md](./spec/13-inference-run-orchestration-spec.md)
- [14-code-based-relation-candidate-spec.md](./spec/14-code-based-relation-candidate-spec.md)
- [15-compound-to-atomic-inference-spec.md](./spec/15-compound-to-atomic-inference-spec.md)
- [16-rabbitmq-queue-code-signal-spec.md](./spec/16-rabbitmq-queue-code-signal-spec.md)
- [17-db-table-code-signal-spec.md](./spec/17-db-table-code-signal-spec.md)
- [18-inter-procedural-ast-spec.md](./spec/18-inter-procedural-ast-spec.md)
- [19-cross-signal-validation-spec.md](./spec/19-cross-signal-validation-spec.md)
- [20-llm-inference-boost-spec.md](./spec/20-llm-inference-boost-spec.md)
- [21-framework-plugin-system-spec.md](./spec/21-framework-plugin-system-spec.md)
- [22-realtime-rollup-spec.md](./spec/22-realtime-rollup-spec.md)
- [23-inference-feedback-loop-spec.md](./spec/23-inference-feedback-loop-spec.md)
- [24-change-impact-preview-spec.md](./spec/24-change-impact-preview-spec.md)
- [25-architecture-drift-detection-spec.md](./spec/25-architecture-drift-detection-spec.md)
- [26-personal-architecture-journal-spec.md](./spec/26-personal-architecture-journal-spec.md)
- [27-api-contract-diff-spec.md](./spec/27-api-contract-diff-spec.md)
- [28-architecture-health-score-spec.md](./spec/28-architecture-health-score-spec.md)
- [29-approval-mapping-ui-consistency-spec.md](./spec/29-approval-mapping-ui-consistency-spec.md)
- [30-cross-signal-validation-phase1-spec.md](./spec/30-cross-signal-validation-phase1-spec.md)
- [31-cross-signal-validation-stale-config-phase2a-spec.md](./spec/31-cross-signal-validation-stale-config-phase2a-spec.md)
- [32-cross-signal-validation-common-contract-spec.md](./spec/32-cross-signal-validation-common-contract-spec.md)
- [33-cross-signal-validation-phantom-call-spec.md](./spec/33-cross-signal-validation-phantom-call-spec.md)
- [34-cross-signal-validation-dead-topic-spec.md](./spec/34-cross-signal-validation-dead-topic-spec.md)
- [35-cross-signal-validation-orphan-fk-spec.md](./spec/35-cross-signal-validation-orphan-fk-spec.md)
- [36-cross-signal-validation-finalization-spec.md](./spec/36-cross-signal-validation-finalization-spec.md)

### Guide/Ops (`docs` 루트)
- [00-overview.md](./00-overview.md)
- [01-development-guide.md](./01-development-guide.md)
- [02-implementation-status.md](./02-implementation-status.md)
- [03-roadmap.md](./03-roadmap.md)
- [04-verification-guide.md](./04-verification-guide.md)
- [05-npm-distribution.md](./05-npm-distribution.md)
