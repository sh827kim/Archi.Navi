# Archi.Navi — Query Engine + AI Assistant

작성일: 2026-02-22
최종 갱신: 2026-03-31
문서 버전: v3.0

---

## 1. 설계 원칙

Archi.Navi의 구조 질의는 **결정론 엔진 우선** 원칙을 따른다.
LLM은 query 결과를 대체하지 않고, 자연어 진입점과 응답 표현을 보강한다.

| 원칙 | 설명 |
|------|------|
| **Deterministic First** | 동일 입력은 동일한 query 결과를 돌려준다. |
| **Generation Consistency** | query는 active generation 또는 명시한 generation 기준으로 실행된다. |
| **Evidence Traceability** | rollup edge에서 base relation과 evidence까지 추적 가능해야 한다. |
| **Two Entry Points** | 운영자는 `/query`, 일반 탐색은 `/chat`을 사용한다. |
| **LLM is a Formatter or Router** | LLM은 intent 분류, 문장화, 설명 보강에 참여한다. |

---

## 2. 지원 질의 타입

`packages/shared` 기준 query type은 아래 4개다.

| 타입 | 설명 | 기본 데이터 경로 |
|------|------|------------------|
| `IMPACT_ANALYSIS` | 특정 object 변경 영향 범위 분석 | rollup graph |
| `PATH_DISCOVERY` | 두 object 간 경로 탐색 | rollup graph |
| `USAGE_DISCOVERY` | 특정 object 사용 주체 추적 | rollup graph + relation lookup |
| `DOMAIN_SUMMARY` | 도메인 구조 요약 | DB 집계 + optional AI formatting |

query page는 이 4개를 직접 노출하고 있다.

---

## 3. 실행 구조

## 3.1 요청 계약

공용 계약은 `packages/shared/src/types/index.ts`의 `QueryRequest`, `QueryResponse`를 따른다.

```ts
interface QueryRequest {
  workspaceId: string;
  generationVersion?: number;
  queryType: QueryType;
  scope: {
    level: RollupLevel;
    relationTypes?: RelationType[];
    visibility: 'VISIBLE_ONLY' | 'INCLUDE_HIDDEN';
    tagIds?: string[];
    objectTypes?: ObjectType[];
  };
  params: {
    fromObjectId?: string;
    toObjectId?: string;
    targetObjectId?: string;
    objectId?: string;
    domainId?: string;
    direction?: 'UPSTREAM' | 'DOWNSTREAM' | 'BOTH';
    maxHops?: number;
    maxDepth?: number;
    topK?: number;
  };
}
```

## 3.2 실행 준비

`packages/core/src/query-engine/executor.ts` 기준 실행 흐름은 아래와 같다.

```text
request 수신
  ↓
generationVersion 확정
  ↓
query type이 rollup graph 필요 여부 판정
  ↓
필요 시 graph-index에서 generation별 graph 확보
  ↓
query type별 알고리즘 실행
  ↓
result + meta 반환
```

### rollup graph를 사용하는 질의

- `PATH_DISCOVERY`
- `IMPACT_ANALYSIS`
- `USAGE_DISCOVERY`

### rollup graph 없이 실행하는 질의

- `DOMAIN_SUMMARY`

---

## 4. 알고리즘 레이어

## 4.1 Path Discovery

- 구현: `pathDiscovery.ts`
- 방식:
  - bounded BFS
  - shortest-path 우선
  - 경로 score 정렬

기본값:

- `maxHops = 6`
- `topK = 3`
- `maxVisited = 20_000`

## 4.2 Impact Analysis

- 구현: `impactAnalysis.ts`
- 방식:
  - downstream / upstream / both
  - bounded traversal + depth 기반 정렬

query UI는 `targetObjectId`, `direction`, `maxDepth`를 계약에 맞춰 전송한다.

## 4.3 Usage Discovery

- 구현: `usageDiscovery.ts`
- 방식:
  - 상위 레벨은 rollup graph 우선
  - 상세 추적은 relation lookup 병행

## 4.4 Domain Summary

- 구현: `domainSummary.ts`
- 방식:
  - 도메인 구성/멤버/외부 연결/통계 집계
  - chat에서는 optional formatting을 추가 적용

---

## 5. Query UI 의 역할

`/query`는 엔진 디버깅 화면이 아니라 **운영자가 직접 구조 질의를 실행하는 화면**이다.

UX 방향:

- query type별 목적 중심 입력 문구 제공
- object picker를 독립 상태로 유지
- 결과를 raw JSON이 아니라 사람이 읽기 쉬운 카드/리스트/stepper로 변환

humanized 결과 예시는 아래와 같다.

| 질의 | UI 표현 |
|------|---------|
| `IMPACT_ANALYSIS` | 직접 영향 / 간접 영향 / 총 노드 수 카드 |
| `PATH_DISCOVERY` | 단계형 경로(stepper/timeline) |
| `USAGE_DISCOVERY` | “누가 사용 중인지” 우선 목록 |
| `DOMAIN_SUMMARY` | 멤버/외부 연결/핵심 통계 카드 |

즉, `/query`는 deterministic contract를 그대로 유지하되,
출력은 사람이 빠르게 이해할 수 있도록 번역한다.

---

## 6. AI Assistant (`/chat`)와의 관계

chat은 query engine의 대체물이 아니라 **자연어 진입 레이어**다.

## 6.1 intent 범주

`/api/chat`은 아래 intent를 지원한다.

- `SERVICE_ENDPOINTS`
- `SERVICE_OVERVIEW`
- `IMPACT_ANALYSIS`
- `PATH_DISCOVERY`
- `USAGE_DISCOVERY`
- `DOMAIN_SUMMARY`
- `GENERAL`

## 6.2 라우팅 구조

```text
사용자 질문
  ↓
intent router
  - LLM classify 우선
  - 실패 시 keyword fallback
  ↓
분기
  - query-engine 경로
  - service overview / endpoints 직접 조회 경로
  - general answer 경로
  ↓
evidence/context assembly
  ↓
LLM formatting (streaming)
```

### query-engine 경로

- 영향 분석
- 경로 탐색
- 사용 주체 추적
- 도메인 요약

### direct retrieval 경로

- 서비스 개요
- 서비스 API 목록

즉, chat은 “모든 질문을 query type으로 강제”하지 않는다.
서비스 설명형 질문은 object/objectRelations/object children 조회를 직접 사용할 수 있다.

---

## 7. Evidence 체인

query와 chat 모두 동일한 explainability 원칙을 따른다.

```text
Query Result / Chat Answer
  ↓
Rollup edge
  ↓
object_rollup_provenances
  ↓
object_relations
  ↓
relation_evidences
  ↓
evidences
```

LLM이 응답을 정리하더라도, 기반 데이터는 반드시 이 체인을 통해 역추적 가능해야 한다.

---

## 8. AI 응답 레이어

`packages/core/src/ai`와 `/api/chat`이 함께 담당하는 역할은 아래와 같다.

| 구성 | 역할 |
|------|------|
| `evidence-assembler` | 관련 evidence chain을 수집하고 정리 |
| `answer-composer` | 답변 골격과 system prompt를 구성 |
| `domain-summary-formatter` | 도메인 요약 응답 보강 |
| `/api/chat` | provider/model 선택, intent routing, streaming response |

provider 전략:

- OpenAI
- Anthropic
- Google

헤더 기반으로 provider/model/API key를 오버라이드할 수 있다.

---

## 9. 설계 방향

## 9.1 유지하는 방향

- `/query`는 계약 중심의 운영 도구로 유지한다.
- `/chat`은 자연어 해석과 설명형 응답을 담당하되, 계산은 가능한 한 query engine을 재사용한다.
- query type을 무리하게 늘리기보다, direct retrieval 경로와 조합해 assistant 범위를 확장한다.
- evidence pool과 confidence threshold를 두어 chat 응답도 근거 기반으로 유지한다.

## 9.2 아직 하지 않는 것

- 완전한 자연어 planner/agent
- 멀티턴 장기 메모리 저장
- query export 중심의 별도 분석 워크벤치
- LLM이 rollup graph를 직접 계산하는 경로

---

## 10. 관련 문서

- [05-rollup-and-graph.md](./05-rollup-and-graph.md)
- [../spec/44-query-engine-humanized-results-spec.md](../spec/44-query-engine-humanized-results-spec.md)
- [../spec/45-query-engine-input-usability-spec.md](../spec/45-query-engine-input-usability-spec.md)
- [../spec/46-ai-architecture-assistant-scope-expansion-spec.md](../spec/46-ai-architecture-assistant-scope-expansion-spec.md)
