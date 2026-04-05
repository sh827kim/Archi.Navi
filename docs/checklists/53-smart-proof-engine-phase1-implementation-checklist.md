# Smart Proof Engine Phase 1 구현 체크리스트

> 상위 SPEC: [53-smart-proof-engine-escalation-spec.md](../spec/53-smart-proof-engine-escalation-spec.md)
> 관련 SPEC: [48-intent-centric-proof-engine-spec.md](../spec/48-intent-centric-proof-engine-spec.md), [50-intent-centric-proof-engine-resolution-pipeline-spec.md](../spec/50-intent-centric-proof-engine-resolution-pipeline-spec.md)

상태: Completed

구현 메모:
- 원래 실행 계획은 PR 1~4였지만, 실제 구현에서는 `resolver 골격`과 `web generator 주입`을 분리하는 편이 안전해서 PR 5까지로 쪼개서 진행했다.
- 아래 체크는 현재 작업 트리 기준으로 실제 코드/테스트 반영 여부를 다시 대조해서 갱신했다.
- DB 통합 테스트는 sandbox shared memory 제약 때문에 샌드박스 밖에서 파일 단위로 개별 실행해 최종 통과를 확인했다.

---

## 1. 목표

Phase 1의 목표는 Smart Proof Engine의 공통 인프라를 먼저 닫는 것이다.

이 단계에서는 아직 모든 LLM 해소 로직을 다 구현하지 않는다.
우선 아래 기반을 먼저 갖춘다.

- `smartProof` 실행 계약
- `smart_agent` patch source kind
- Smart audit log 저장
- Smart summary 메트릭
- Category B 1차 resolver를 붙일 수 있는 오케스트레이션 골격

---

## 2. API 계약

- [x] `POST /api/inference/run` 요청 타입에 `smartProof?: boolean | SmartProofConfig` 추가
- [x] `smartProof: true`일 때 default config가 주입되도록 구현
- [x] `smartProof: false | undefined`일 때 기존 static 동작 유지
- [x] `POST /api/inference/smart`가 내부적으로 동일 계약을 사용하도록 정리
- [x] `analysisMode` 같은 legacy Smart 입력은 비지원 계약으로 고정
- [x] run detail 응답에 Smart 메트릭 블록이 포함되도록 정리

---

## 3. 타입/모듈 구조

- [x] `packages/inference/src/agent/smartProofTypes.ts` 신규 생성
- [x] `SmartProofConfig` 타입 정의
- [x] `SmartBudgetTracker` 타입 및 인터페이스 정의
- [x] `SmartFrontierResolution` 타입 정의
- [x] `SmartModeSummary` 타입 정의
- [x] `packages/inference/src/orchestration/index.ts` export 정리

---

## 4. DB 스키마

- [x] `proof_patches.source_kind`에 `smart_agent` 허용
- [x] `smart_proof_llm_calls` 테이블 스키마 추가
- [x] `workspace_id`, `run_id`, `proof_state_id` 인덱스 추가
- [x] `call_category` check 제약 추가
- [x] `domain_inference_profiles.smart_proof_config` 추가 여부 결정 및 스키마 반영
- [x] migration 파일 추가

---

## 5. 오케스트레이션

- [x] `executeInferenceRun()`에서 Smart on/off 분기 추가
- [x] deterministic proof engine 이후에만 Smart가 실행되도록 순서 고정
- [x] deterministic frontier agent와 Smart escalation 역할 분리
- [x] run 단위 budget tracker 생성
- [x] proof 또는 intent 단위 call cap 적용
- [x] accepted patch만 proof re-run 하도록 연결
- [x] validator 실패 patch는 audit만 남기고 proof 상태를 보존

---

## 6. Smart Summary 메트릭

- [x] `ProofEngineSummary`에 Smart 메트릭 블록 추가
- [x] `buildEmptyProofEngineSummary()`에 Smart 기본값 추가
- [x] `buildProofEngineSummaryForRun()`에서 Smart 집계 추가
- [x] llm call 수, token 수, cost, accepted/review/skipped 수 집계
- [x] frontier reason별 resolution breakdown 집계

---

## 7. Category B 1차 골격

- [x] `packages/inference/src/agent/smartFrontierResolver.ts` 신규 생성
- [x] frontier reason별 dispatcher 구현
- [x] 최소 지원 reason 4개 상수 정의
- [x] context assembler 함수 분리
- [x] structured output schema adapter 레이어 정의
- [x] LLM 출력 -> `ProofPatch` 변환 adapter 구현
- [x] `sourceKind='smart_agent'`로 patch 저장되도록 연결

---

## 8. Confidence / Acceptance 정책

- [x] `autoAcceptConfidence`, `reviewConfidence`, `skipConfidence` 기본값 정의
- [x] `confidence >= autoAcceptConfidence`면 `ACCEPTED`
- [x] `reviewConfidence <= confidence < autoAcceptConfidence`면 `PENDING_REVIEW`
- [x] `confidence < reviewConfidence`면 `SKIPPED`
- [x] `PENDING_REVIEW` patch의 저장/노출 규칙 정리
- [x] `SKIPPED` patch의 저장 여부와 audit 규칙 정리

---

## 9. 테스트

### 단위 테스트

- [x] Smart config parsing 테스트
- [x] budget tracker 테스트
- [x] `smart_agent` patch validation 테스트
- [x] Smart summary 기본값 테스트
- [x] structured output -> patch adapter 테스트

### 통합 테스트

- [x] Smart off일 때 기존 run 결과 parity 확인
- [x] Smart on + accepted patch일 때 proof re-run 확인
- [x] Smart on + validator reject일 때 frontier 유지 확인
- [x] Smart on + budget exhausted일 때 조기 종료 확인
- [x] Smart summary 메트릭 기록 확인

---

## 10. 검증 명령

- [x] `pnpm --filter @archi-navi/inference exec vitest run src/__tests__/orchestration/inferenceRuns.test.ts`
- [x] `pnpm --filter @archi-navi/inference exec vitest run src/__tests__/orchestration/intentProofEngine.test.ts`
- [x] `pnpm --filter @archi-navi/inference exec vitest run src/__tests__/agent/frontierAgent.test.ts`
- [x] 신규 Smart resolver 테스트 명령 추가

---

## 11. 완료 기준

- [x] Static run 결과가 Smart 미사용 시 기존과 동일하다
- [x] Smart 실행 여부와 예산 사용량을 run summary에서 확인할 수 있다
- [x] `smart_agent` patch와 LLM 호출 이력을 proof/run 단위로 추적할 수 있다
- [x] Category B 1차 resolver를 붙일 수 있는 확장 지점이 코드에 고정된다
- [x] 이후 Phase 2 구현이 문서 없이도 바로 착수 가능할 정도로 공통 기반이 닫힌다
