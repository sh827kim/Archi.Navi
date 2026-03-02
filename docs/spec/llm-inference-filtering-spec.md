# Archi.Navi — LLM 추론 후보 필터링

작성일: 2026-02-22
문서 버전: v1.0

---

## 1. 설계 목적

추론 엔진(Phase 1 Regex, Config 파싱, DB 스키마)이 생성한 **relation_candidates**를
LLM을 활용하여 **자동 검증 및 필터링**하는 후처리 레이어를 구현한다.

### 1.1 해결하려는 문제

| 문제 | 현재 상태 | LLM 필터링 후 |
|------|----------|-------------|
| 후보 수 과다 | 수십~수백 개 PENDING → 전부 사람이 검토 | LLM이 사전 분류하여 검토 부담 감소 |
| False Positive | Regex 기반 70~80% 정확도 → 노이즈 존재 | LLM이 컨텍스트 기반으로 FP 감지 |
| 검토 근거 부족 | confidence 숫자만 표시 | LLM이 자연어 설명 생성 |
| 우선순위 없음 | 모든 후보가 동일 순위 | LLM verdict 기반 정렬/그룹핑 |

### 1.2 설계 원칙

1. **파이프라인 독립성**: 기존 추론 엔진 코드를 수정하지 않음 (후처리 레이어)
2. **AST Phase 2 비충돌**: AST는 `packages/inference/src/code/ast/` 신호 추출 계층, LLM 필터는 `packages/inference/src/llm/` 후처리 계층 — 완전히 다른 레이어
3. **승인 원칙 유지**: LLM 결과도 `candidate.metadata`에 기록할 뿐, 자동 승인/반려하지 않음 (기본 모드)
4. **LLM 비의존**: LLM 없이도 기존 승인 워크플로우 정상 동작 (선택적 기능)
5. **DI 기반 테스트 용이성**: LLM 호출을 추상화하여 단위 테스트에서 mock 가능

---

## 2. 아키텍처

### 2.1 파이프라인 내 위치

```
Signal Collectors (Code/Config/DB)
      ↓
Inference Engine (기존)
      ↓
relation_candidates (PENDING)        ← 기존 산출물
      ↓
┌─────────────────────────────────┐
│   LLM Inference Filter (신규)    │  ← 이 문서의 범위
│                                  │
│   1. 후보 배치 로딩              │
│   2. Evidence 컨텍스트 조립       │
│   3. LLM 구조화 응답 요청        │
│   4. 평가 결과를 metadata에 기록  │
└─────────────────────────────────┘
      ↓
relation_candidates (PENDING + LLM 메타데이터 enriched)
      ↓
승인 워크플로우 (UI) — LLM 평가 결과 표시
```

### 2.2 모듈 구조

```
packages/inference/src/llm/
├── types.ts              # 입출력 계약 타입
├── prompts.ts            # 구조화 프롬프트 템플릿
├── candidateFilter.ts    # 핵심 필터링 로직 (DI 기반)
├── batchProcessor.ts     # 배치 그룹핑 + 병렬 처리
└── index.ts              # 공개 API export

apps/web/src/app/api/inference/llm-filter/
└── route.ts              # POST API 엔드포인트 (Vercel AI SDK 연결)
```

### 2.3 AST Phase 2와의 관계

| 계층 | AST Phase 2 (v2.1) | LLM 필터링 (본 문서) |
|------|--------------------|--------------------|
| 위치 | Signal Collector 계층 | 후처리 계층 |
| 디렉토리 | `src/code/ast/` | `src/llm/` |
| 입력 | 소스코드 파일 | relation_candidates + evidences |
| 출력 | code_artifacts, code_call_edges | candidate.metadata.llmAssessment |
| 상호작용 | 없음 (독립) | AST가 생성한 후보도 동일하게 필터링 |

**핵심**: AST는 "더 정확한 신호 추출"을 목표로 하고, LLM 필터는 "추출된 후보의 사후 검증"을 목표로 한다.
두 기능은 파이프라인의 서로 다른 단계에서 동작하므로 충돌이 없다.

---

## 3. 타입 설계

### 3.1 LLM 평가 결과 (`LlmAssessment`)

```typescript
/** LLM이 후보에 대해 내린 평가 */
interface LlmAssessment {
  /** 판정: 유효/불확실/거짓양성 */
  verdict: 'LIKELY_VALID' | 'UNCERTAIN' | 'LIKELY_FALSE_POSITIVE';

  /** LLM이 산정한 신뢰도 조정값 (-0.3 ~ +0.2) */
  confidenceAdjustment: number;

  /** 판정 근거 (자연어, 한국어) */
  reasoning: string;

  /** 검토 우선순위 제안 */
  reviewPriority: 'HIGH' | 'MEDIUM' | 'LOW';

  /** LLM 모델 식별자 */
  model: string;

  /** 평가 시각 (ISO 8601) */
  assessedAt: string;
}
```

### 3.2 필터 요청/응답

```typescript
/** 필터 실행 요청 */
interface LlmFilterRequest {
  workspaceId: string;
  /** 필터링 대상 후보 ID 목록 (비어있으면 전체 PENDING) */
  candidateIds?: string[];
  /** 배치 크기 (기본 10) */
  batchSize?: number;
}

/** 필터 실행 결과 */
interface LlmFilterResult {
  /** 처리된 후보 수 */
  processedCount: number;
  /** verdict별 통계 */
  stats: {
    likelyValid: number;
    uncertain: number;
    likelyFalsePositive: number;
  };
  /** 처리 시간 (ms) */
  durationMs: number;
}
```

### 3.3 LLM 생성 함수 추상화 (DI 계약)

```typescript
/** LLM 호출 추상화 — 테스트에서 mock 가능 */
type GenerateAssessmentFn = (
  prompt: string,
  context: CandidateContext,
) => Promise<LlmAssessment>;

/** 후보 + Evidence 컨텍스트 */
interface CandidateContext {
  candidateId: string;
  subjectName: string;
  objectName: string;
  relationType: string;
  confidence: number;
  evidences: Array<{
    filePath: string | null;
    lineStart: number | null;
    lineEnd: number | null;
    excerpt: string | null;
    evidenceType: string;
  }>;
  metadata: Record<string, unknown>;
}
```

---

## 4. 프롬프트 설계

### 4.1 Relation 후보 검증 프롬프트

```
당신은 마이크로서비스 아키텍처 분석 전문가입니다.
아래 추론된 서비스 관계 후보가 유효한지 검증해주세요.

## 후보 정보
- Subject: {subjectName}
- Relation: {relationType}
- Object: {objectName}
- Confidence: {confidence}

## Evidence (근거)
{evidences.map(e => `
- [${e.evidenceType}] ${e.filePath}:${e.lineStart}-${e.lineEnd}
  "${e.excerpt}"
`)}

## 검증 기준
1. 관계 타입이 evidence와 일치하는가?
2. subject와 object가 실제 서비스 간 관계로 보이는가?
3. 테스트 코드, mock, 주석에서 추출된 false positive는 아닌가?
4. URL 패턴이나 설정이 실제 서비스 연결을 나타내는가?

## 응답 형식 (JSON)
{
  "verdict": "LIKELY_VALID" | "UNCERTAIN" | "LIKELY_FALSE_POSITIVE",
  "confidenceAdjustment": <-0.3 ~ +0.2>,
  "reasoning": "<판정 근거를 한국어로 1~2문장>",
  "reviewPriority": "HIGH" | "MEDIUM" | "LOW"
}
```

### 4.2 응답 파싱

- Vercel AI SDK의 `generateObject` + Zod 스키마로 구조화 응답 강제
- API 라우트에서만 SDK 사용, inference 패키지는 파싱된 결과만 수신

---

## 5. 배치 처리 전략

### 5.1 그룹핑 규칙

```
PENDING 후보 로딩
      ↓
같은 (subjectObjectId, objectId) 쌍으로 그룹핑
      ↓
그룹별 Evidence 조인
      ↓
batchSize(기본 10)개씩 LLM 호출
      ↓
결과를 candidate.metadata.llmAssessment에 저장
```

### 5.2 Rate Limiting

- 동시 LLM 호출: 최대 3건 (p-limit 또는 수동 세마포어)
- 호출 간 최소 간격: 200ms
- 타임아웃: 후보당 30초

### 5.3 비용 최적화

- 같은 (subject, object, relationType) 그룹은 하나의 프롬프트로 묶음
- Evidence excerpt는 최대 500자로 truncate
- 이미 `llmAssessment`가 있는 후보는 skip (중복 방지)

---

## 6. 데이터 저장

### 6.1 candidate.metadata 확장

기존 `relation_candidates.metadata` JSON 필드에 `llmAssessment` 키 추가:

```json
{
  "source": "application_yml",
  "configKey": "spring.datasource.url",
  "llmAssessment": {
    "verdict": "LIKELY_VALID",
    "confidenceAdjustment": 0.1,
    "reasoning": "application.yml의 spring.datasource.url 설정에서 ...",
    "reviewPriority": "LOW",
    "model": "gpt-4o",
    "assessedAt": "2026-02-22T10:30:00Z"
  }
}
```

### 6.2 스키마 변경 없음

- `relation_candidates.metadata`는 이미 `jsonb` 타입
- 새 테이블/컬럼 추가 불필요 → 마이그레이션 불필요
- AST Phase 2의 스키마 변경과 충돌 없음

---

## 7. API 설계

### 7.1 POST `/api/inference/llm-filter`

**요청:**
```json
{
  "workspaceId": "00000000-0000-0000-0000-000000000001",
  "candidateIds": ["uuid-1", "uuid-2"],
  "batchSize": 10
}
```

**응답 (성공):**
```json
{
  "success": true,
  "data": {
    "processedCount": 15,
    "stats": {
      "likelyValid": 10,
      "uncertain": 3,
      "likelyFalsePositive": 2
    },
    "durationMs": 12340
  }
}
```

**응답 (LLM 미설정):**
```json
{
  "success": false,
  "error": {
    "code": "LLM_NOT_CONFIGURED",
    "message": "AI 제공자가 설정되지 않았습니다. 설정 > AI Settings에서 API 키를 입력해주세요."
  }
}
```

### 7.2 GET `/api/inference/candidates` 확장

기존 응답에 `llmAssessment` 필드 추가 (있는 경우):
```json
{
  "id": "uuid-1",
  "subjectName": "order-service",
  "relationType": "call",
  "objectName": "payment-service",
  "confidence": 0.7,
  "status": "PENDING",
  "llmAssessment": {
    "verdict": "LIKELY_VALID",
    "reasoning": "...",
    "reviewPriority": "LOW"
  }
}
```

---

## 8. 에러 처리

| 시나리오 | 처리 |
|---------|------|
| LLM API 키 미설정 | `LLM_NOT_CONFIGURED` 에러 반환 |
| LLM 호출 타임아웃 | 해당 후보 skip, 나머지 계속 처리 |
| LLM 응답 파싱 실패 | 해당 후보 skip, 에러 로그 기록 |
| 후보 없음 (전부 이미 평가됨) | `processedCount: 0` 정상 반환 |
| DB 오류 | 500 에러 + 에러 로그 |

---

## 9. 구현 로드맵

### Phase 1 (본 구현)
- [x] 타입 정의 (`types.ts`)
- [x] 프롬프트 템플릿 (`prompts.ts`)
- [x] 핵심 필터링 로직 (`candidateFilter.ts`) — DI 기반
- [x] 배치 처리기 (`batchProcessor.ts`)
- [x] API 라우트 (`route.ts`)
- [x] 기존 candidates GET API에 llmAssessment 포함

### Phase 2 (향후)
- [ ] 자동 승인/반려 모드 (설정 가능)
- [ ] Domain 후보 필터링 확장
- [ ] 필터링 이력 대시보드
- [ ] 비용 추적 (토큰 사용량)

---

## 관련 문서

| 문서 | 관계 |
|------|------|
| [03-inference-engine.md](./03-inference-engine.md) | 추론 엔진 전체 설계 (§2.5 중복 후보 처리) |
| [08-roadmap.md](./08-roadmap.md) | P2 AST + AI 고도화 로드맵 |
| [02-data-model.md](./02-data-model.md) | relation_candidates, evidences 스키마 |
