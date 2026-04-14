# SPEC 문서 목록

`docs/spec`는 기능 단위 구현 계약을 관리한다. 현재 기준은 단순 번호순 나열이 아니라 `Current / Proposed / Deprecated` 상태로 읽는다.

## 규칙
1. 기능 SPEC 문서명은 `*-spec.md`를 사용한다.
2. 체크리스트/인덱스 문서는 `docs/spec` 밖의 별도 디렉토리에 둔다.
3. Design 설명은 중복 작성하지 않고 `docs/design` 링크로 연결한다.
4. 현재 제품 계약에서 대체된 문서는 `docs/spec/deprecated/`로 이동한다.

## Current

### Core Inference / Mapping
- [01-db-inference-index-unique-spec.md](./01-db-inference-index-unique-spec.md)
- [02-object-mapping-3d-renderer-spec.md](./02-object-mapping-3d-renderer-spec.md)
- [03-compound-view-implementation-spec.md](./03-compound-view-implementation-spec.md)
- [04-llm-inference-filtering-spec.md](./04-llm-inference-filtering-spec.md)
- [05-incremental-rollup-rebuild-spec.md](./05-incremental-rollup-rebuild-spec.md)
- [06-hub-node-management-spec.md](./06-hub-node-management-spec.md)
- [07-progressive-rendering-spec.md](./07-progressive-rendering-spec.md)
- [08-domain-first-navigation-spec.md](./08-domain-first-navigation-spec.md)
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
- [21-realtime-rollup-spec.md](./21-realtime-rollup-spec.md)
- [22-inference-feedback-loop-spec.md](./22-inference-feedback-loop-spec.md)
- [28-approval-mapping-ui-consistency-spec.md](./28-approval-mapping-ui-consistency-spec.md)
- [30-cross-signal-validation-stale-config-phase2a-spec.md](./30-cross-signal-validation-stale-config-phase2a-spec.md)
- [32-cross-signal-validation-phantom-call-spec.md](./32-cross-signal-validation-phantom-call-spec.md)
- [33-cross-signal-validation-dead-topic-spec.md](./33-cross-signal-validation-dead-topic-spec.md)
- [34-cross-signal-validation-orphan-fk-spec.md](./34-cross-signal-validation-orphan-fk-spec.md)
- [36-relation-feedback-key-specialization-spec.md](./36-relation-feedback-key-specialization-spec.md)

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
- [54-object-detail-layer-assignment-spec.md](./54-object-detail-layer-assignment-spec.md)
- [55-light-theme-tone-refresh-spec.md](./55-light-theme-tone-refresh-spec.md)

### Current Architecture Direction
- [53-smart-proof-engine-escalation-spec.md](./53-smart-proof-engine-escalation-spec.md)

## Proposed

### Active Architecture Direction
- [48-intent-centric-proof-engine-spec.md](./48-intent-centric-proof-engine-spec.md)
- [49-intent-centric-proof-engine-state-model-spec.md](./49-intent-centric-proof-engine-state-model-spec.md)
- [50-intent-centric-proof-engine-resolution-pipeline-spec.md](./50-intent-centric-proof-engine-resolution-pipeline-spec.md)
- [51-intent-centric-proof-engine-adoption-plan-spec.md](./51-intent-centric-proof-engine-adoption-plan-spec.md)

### Backlog / Productivity
- [17-inter-procedural-ast-spec.md](./17-inter-procedural-ast-spec.md)
- [23-change-impact-preview-spec.md](./23-change-impact-preview-spec.md)
- [24-architecture-drift-detection-spec.md](./24-architecture-drift-detection-spec.md)
- [25-personal-architecture-journal-spec.md](./25-personal-architecture-journal-spec.md)
- [26-api-contract-diff-spec.md](./26-api-contract-diff-spec.md)
- [27-architecture-health-score-spec.md](./27-architecture-health-score-spec.md)

### Signal Coverage Program (Proposed)
- [93-common-http-signal-extraction-coverage-spec.md](./93-common-http-signal-extraction-coverage-spec.md)
- [94-framework-specific-code-scanner-spec.md](./94-framework-specific-code-scanner-spec.md)
- [95-framework-config-parser-hook-spec.md](./95-framework-config-parser-hook-spec.md)
- [96-config-code-binding-completeness-spec.md](./96-config-code-binding-completeness-spec.md)
- [97-multi-module-service-boundary-calibration-spec.md](./97-multi-module-service-boundary-calibration-spec.md)
- [98-bootstrap-engine-policy-alignment-spec.md](./98-bootstrap-engine-policy-alignment-spec.md)

## Deprecated
- [deprecated/19-llm-inference-boost-spec.md](./deprecated/19-llm-inference-boost-spec.md)
- [deprecated/29-cross-signal-validation-phase1-spec.md](./deprecated/29-cross-signal-validation-phase1-spec.md)
- [deprecated/31-cross-signal-validation-common-contract-spec.md](./deprecated/31-cross-signal-validation-common-contract-spec.md)
- [deprecated/35-cross-signal-validation-finalization-spec.md](./deprecated/35-cross-signal-validation-finalization-spec.md)
- [deprecated/37-smart-pipeline-atomic-redesign-spec.md](./deprecated/37-smart-pipeline-atomic-redesign-spec.md)
- [deprecated/42-agent-assisted-smart-atomic-spec.md](./deprecated/42-agent-assisted-smart-atomic-spec.md)
- [deprecated/47-zuul-route-aware-smart-atomic-spec.md](./deprecated/47-zuul-route-aware-smart-atomic-spec.md)
- [deprecated/README.md](./deprecated/README.md)

## 참고
- 구현 체크리스트: [docs/checklists/README.md](../checklists/README.md)
- 설계 기준: [docs/design/README.md](../design/README.md)
