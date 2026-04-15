# SPEC 문서 목록

`docs/spec`는 기능 단위 구현 계약을 관리한다. 2026-04-15 기준으로 파생 PR 문서들은 가능한 한 canonical SPEC으로 통합했고, 이 README도 구현 축 기준으로만 그룹화한다.

## 규칙
1. 기능 SPEC 문서명은 `*-spec.md`를 사용한다.
2. 체크리스트/인덱스 문서는 `docs/spec` 밖의 별도 디렉토리에 둔다.
3. Design 설명은 중복 작성하지 않고 `docs/design` 링크로 연결한다.
4. 작은 파생 PR 문서는 장기적으로 상위 canonical SPEC에 흡수한다.
5. 현재 제품 계약에서 대체된 문서는 `docs/spec/deprecated/`로 이동한다.

## 번호 정책
- 번호는 한 번 발급하면 재사용하지 않는다.
- deprecated 문서로 이동한 번호는 비워 두고 유지한다.
- canonical SPEC에 흡수된 파생 문서 번호도 retired 상태로 남기고 재사용하지 않는다.
- 따라서 현재 `docs/spec`에서 번호 공백이 보여도 정상이다.

## Current

### Platform / Visualization
- [01-db-inference-index-unique-spec.md](./01-db-inference-index-unique-spec.md)
- [02-object-mapping-3d-renderer-spec.md](./02-object-mapping-3d-renderer-spec.md)
- [03-compound-view-implementation-spec.md](./03-compound-view-implementation-spec.md)
- [05-incremental-rollup-rebuild-spec.md](./05-incremental-rollup-rebuild-spec.md)
- [06-hub-node-management-spec.md](./06-hub-node-management-spec.md)
- [07-progressive-rendering-spec.md](./07-progressive-rendering-spec.md)
- [08-domain-first-navigation-spec.md](./08-domain-first-navigation-spec.md)
- [21-realtime-rollup-spec.md](./21-realtime-rollup-spec.md)
- [54-object-detail-layer-assignment-spec.md](./54-object-detail-layer-assignment-spec.md)
- [55-light-theme-tone-refresh-spec.md](./55-light-theme-tone-refresh-spec.md)

### Standard Inference / Candidate Flow
- [04-llm-inference-filtering-spec.md](./04-llm-inference-filtering-spec.md)
- [09-incremental-inference-spec.md](./09-incremental-inference-spec.md)
- [10-ast-default-code-signal-spec.md](./10-ast-default-code-signal-spec.md)
- [11-ast-regex-hybrid-code-signal-spec.md](./11-ast-regex-hybrid-code-signal-spec.md)
- [12-inference-run-orchestration-spec.md](./12-inference-run-orchestration-spec.md)
- [13-code-based-relation-candidate-spec.md](./13-code-based-relation-candidate-spec.md)
- [14-compound-to-atomic-inference-spec.md](./14-compound-to-atomic-inference-spec.md)
- [15-rabbitmq-queue-code-signal-spec.md](./15-rabbitmq-queue-code-signal-spec.md)
- [16-db-table-code-signal-spec.md](./16-db-table-code-signal-spec.md)
- [18-cross-signal-validation-spec.md](./18-cross-signal-validation-spec.md)
- [20-framework-plugin-system-spec.md](./20-framework-plugin-system-spec.md)
- [22-inference-feedback-loop-spec.md](./22-inference-feedback-loop-spec.md)
- [28-approval-mapping-ui-consistency-spec.md](./28-approval-mapping-ui-consistency-spec.md)
- [36-relation-feedback-key-specialization-spec.md](./36-relation-feedback-key-specialization-spec.md)
- [91-db-scan-toggle-spec.md](./91-db-scan-toggle-spec.md)
- [93-common-http-signal-extraction-coverage-spec.md](./93-common-http-signal-extraction-coverage-spec.md)
- [99-dual-inference-pipeline-selector-spec.md](./99-dual-inference-pipeline-selector-spec.md)
- [100-spring-request-mapping-atomic-composition-spec.md](./100-spring-request-mapping-atomic-composition-spec.md)

### Proof / Frontier
- [48-intent-centric-proof-engine-spec.md](./48-intent-centric-proof-engine-spec.md)
- [49-intent-centric-proof-engine-state-model-spec.md](./49-intent-centric-proof-engine-state-model-spec.md)
- [50-intent-centric-proof-engine-resolution-pipeline-spec.md](./50-intent-centric-proof-engine-resolution-pipeline-spec.md)
- [53-smart-proof-engine-escalation-spec.md](./53-smart-proof-engine-escalation-spec.md)
- [101-frontier-review-promotion-spec.md](./101-frontier-review-promotion-spec.md)

### UX / Operations
- [38-s1-phase2-ux-foundation-spec.md](./38-s1-phase2-ux-foundation-spec.md)
- [39-workspace-folder-picker-spec.md](./39-workspace-folder-picker-spec.md)
- [40-inference-scan-smart-async-spec.md](./40-inference-scan-smart-async-spec.md)
- [41-db-recovery-migration-spec.md](./41-db-recovery-migration-spec.md)
- [43-inference-run-ops-ux-spec.md](./43-inference-run-ops-ux-spec.md)
- [44-query-engine-humanized-results-spec.md](./44-query-engine-humanized-results-spec.md)
- [45-query-engine-input-usability-spec.md](./45-query-engine-input-usability-spec.md)
- [46-ai-architecture-assistant-scope-expansion-spec.md](./46-ai-architecture-assistant-scope-expansion-spec.md)
- [52-embedded-postgres-runtime-migration-spec.md](./52-embedded-postgres-runtime-migration-spec.md)

## Transition

### Adoption / Cutover Reference
- [51-intent-centric-proof-engine-adoption-plan-spec.md](./51-intent-centric-proof-engine-adoption-plan-spec.md)

## Proposed

### Backlog / Future Exploration
- [17-inter-procedural-ast-spec.md](./17-inter-procedural-ast-spec.md)
- [23-change-impact-preview-spec.md](./23-change-impact-preview-spec.md)
- [24-architecture-drift-detection-spec.md](./24-architecture-drift-detection-spec.md)
- [25-personal-architecture-journal-spec.md](./25-personal-architecture-journal-spec.md)
- [26-api-contract-diff-spec.md](./26-api-contract-diff-spec.md)
- [27-architecture-health-score-spec.md](./27-architecture-health-score-spec.md)
- [92-compound-scan-ownership-design-spec.md](./92-compound-scan-ownership-design-spec.md)

## Deprecated
- [deprecated/README.md](./deprecated/README.md)

## 이번 정리에서 반영한 사항
- `18`은 cross-signal validation의 단일 canonical SPEC으로 정리했고 `30/32/33/34`를 흡수했다.
- `93`은 signal coverage rollout의 단일 canonical SPEC으로 정리했고 `94~98`을 흡수했다.
- `101`은 현재 구현 상태를 반영해 `Current (Partial Rollout)` 기준으로 업데이트했다.
- `102`는 `101`에 흡수했다.

## 참고
- 구현 체크리스트: [docs/checklists/README.md](../checklists/README.md)
- 설계 기준: [docs/design/README.md](../design/README.md)
