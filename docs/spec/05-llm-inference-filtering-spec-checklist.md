# LLM 추론 후보 필터링 — 구현 체크리스트

> 설계안: `docs/spec/04-llm-inference-filtering-spec.md` v1.0
> AST Phase 2 충돌 검증 포함

---

## 1. AST Phase 2 비충돌 검증

- [x] LLM 필터 코드가 `src/llm/` 디렉토리에만 위치 (AST는 `src/code/ast/`)
- [x] 기존 추론 엔진 코드(`configBased.ts`, `codeSignalExtractor.ts`, `dbSchemaSignal.ts`) 수정 없음
- [x] DB 스키마 변경 없음 (기존 `metadata` jsonb 활용)
- [x] `relation_candidates` 테이블 구조 변경 없음
- [x] AST가 생성하는 `code_artifacts`, `code_call_edges` 테이블과 무관
- [x] index.ts export에 `llm/` 모듈 추가만 (기존 export 변경 없음)

## 2. 타입 정의 (`packages/inference/src/llm/types.ts`)

- [x] `LlmAssessment` 인터페이스 — verdict, confidenceAdjustment, reasoning, reviewPriority, model, assessedAt
- [x] `LlmFilterRequest` 인터페이스 — workspaceId, candidateIds?, batchSize?
- [x] `LlmFilterResult` 인터페이스 — processedCount, stats, durationMs
- [x] `CandidateContext` 인터페이스 — candidateId, subjectName, objectName, relationType, confidence, evidences, metadata
- [x] `GenerateAssessmentFn` 타입 — DI 계약 (prompt, context) → Promise<LlmAssessment>
- [x] verdict 값 검증: 'LIKELY_VALID' | 'UNCERTAIN' | 'LIKELY_FALSE_POSITIVE' 만 허용
- [x] confidenceAdjustment 범위 검증: -0.3 ~ +0.2

## 3. 프롬프트 템플릿 (`packages/inference/src/llm/prompts.ts`)

- [x] `buildRelationAssessmentPrompt(context: CandidateContext): string` 함수
- [x] 프롬프트에 subject, object, relationType, confidence 포함
- [x] 프롬프트에 evidence 목록 (filePath, lineStart-lineEnd, excerpt) 포함
- [x] evidence excerpt가 500자 초과 시 truncate
- [x] evidence가 없는 경우 "근거 없음" 표시
- [x] JSON 응답 형식 명시

## 4. 핵심 필터링 로직 (`packages/inference/src/llm/candidateFilter.ts`)

- [x] `filterCandidates(db, generateFn, request): Promise<LlmFilterResult>` 함수
- [x] PENDING 상태 후보만 로딩
- [x] candidateIds 지정 시 해당 후보만 필터링
- [x] 이미 `metadata.llmAssessment`가 있는 후보 skip
- [x] subject/object 이름 조회 (objects 테이블 조인)
- [x] evidence 조회 (relation_candidate_evidences + evidences 조인)
- [x] CandidateContext 조립
- [x] generateFn 호출 → LlmAssessment 수신
- [x] candidate.metadata에 llmAssessment 저장 (기존 metadata 병합)
- [x] 결과 stats 집계 (verdict별 카운트)

## 5. 배치 처리기 (`packages/inference/src/llm/batchProcessor.ts`)

- [x] `processBatch(candidates, generateFn, batchSize): Promise<BatchResult[]>` 함수
- [x] batchSize 기본값 10
- [x] 동시 처리 제한: 최대 3건 동시 호출
- [x] 개별 후보 처리 실패 시 해당 후보만 skip (나머지 계속)
- [x] 타임아웃 30초 per candidate
- [x] 처리 결과에 성공/실패 상태 포함

## 6. API 라우트 (`apps/web/src/app/api/inference/llm-filter/route.ts`)

- [x] `POST` 핸들러 구현
- [x] LLM 제공자 선택 (기존 getModel 패턴 재사용)
- [x] Vercel AI SDK `generateObject` + Zod 스키마로 구조화 응답
- [x] 요청 바디 파싱 (workspaceId, candidateIds, batchSize)
- [x] LLM 미설정 시 `LLM_NOT_CONFIGURED` 에러 반환
- [x] 성공 응답: `{ success: true, data: LlmFilterResult }`
- [x] 에러 응답: `{ success: false, error: { code, message } }`

## 7. 기존 API 확장

- [x] `GET /api/inference/candidates` — 응답에 `llmAssessment` 필드 추가 (metadata에서 추출)

## 8. 테스트 커버리지

### 단위 테스트 (`packages/inference/src/__tests__/llm/`)

- [x] T1: `buildRelationAssessmentPrompt` — 기본 컨텍스트로 프롬프트 생성 확인
- [x] T2: `buildRelationAssessmentPrompt` — evidence 없는 경우 처리
- [x] T3: `buildRelationAssessmentPrompt` — evidence excerpt 500자 truncate
- [x] T4: `filterCandidates` — mock LLM으로 LIKELY_VALID 판정 → metadata 저장 확인
- [x] T5: `filterCandidates` — mock LLM으로 LIKELY_FALSE_POSITIVE 판정 → metadata 저장 확인
- [x] T6: `filterCandidates` — 이미 llmAssessment가 있는 후보 skip
- [x] T7: `filterCandidates` — PENDING이 아닌 후보 제외 확인
- [x] T8: `filterCandidates` — 결과 stats 정확한 집계
- [x] T9: `filterCandidates` — candidateIds 지정 시 해당 후보만 처리
- [x] T10: `processBatch` — batchSize별 분할 처리 확인
- [x] T11: `processBatch` — 개별 실패 시 다른 후보 계속 처리
- [x] T12: `processBatch` — 빈 배열 입력 시 빈 결과 반환
- [x] T13: confidenceAdjustment가 범위를 벗어난 경우 clamp 처리

## 9. 품질 게이트

- [x] `pnpm --filter @archi-navi/inference test:unit` — 전체 테스트 통과 (153/153)
- [x] `pnpm --filter @archi-navi/inference lint` — TypeScript 컴파일 에러 없음
- [x] 기존 테스트 (configBased 11개, codeSignal 46개, dbSchema 20개 등) 전부 통과 확인

---

## 충족률 추적

| 영역 | 체크 항목 | 완료 | 충족률 |
|------|----------|------|--------|
| AST 비충돌 | 6 | 6 | 100% |
| 타입 정의 | 7 | 7 | 100% |
| 프롬프트 | 6 | 6 | 100% |
| 필터링 로직 | 10 | 10 | 100% |
| 배치 처리 | 6 | 6 | 100% |
| API 라우트 | 7 | 7 | 100% |
| 기존 API 확장 | 1 | 1 | 100% |
| 테스트 | 13 | 13 | 100% |
| 품질 게이트 | 3 | 3 | 100% |
| **합계** | **59** | **59** | **100%** |
