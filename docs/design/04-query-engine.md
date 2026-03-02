# Archi.Navi — Deterministic Query Engine + AI Reasoning

작성일: 2026-02-22
문서 버전: v2.0

---

## 1. 설계 원칙

Archi.Navi의 구조 질의는 **LLM 없이도 결정론적으로 계산**한다.
LLM은 결과를 **설명/요약하는 표현 레이어**로만 사용한다.

| 원칙 | 설명 |
|------|------|
| **재현 가능성** | 동일 입력 → 동일 출력 (결정론) |
| **Evidence 중심** | 모든 edge/node는 근거 추적 가능 |
| **Roll-up 기본** | 기본은 Rollup 그래프, 필요 시 Drill-down |
| **역할 분리** | 엔진 = 계산/랭킹/추적, LLM = 표현/문장화 |
| **스냅샷 기반** | `workspace_id` 격리 + `generation_version` 기준 조회 |

---

## 2. 데이터 소스

### 2.1 빠른 그래프 (기본)

- `object_rollups` (현재 ACTIVE generation_version)
- `object_graph_stats` (degree 정보)

### 2.2 상세/근거 (Drill-down)

- `object_relations` (원자 관계)
- `relation_evidences` → `evidences` (근거 체인)
- `relation_candidates` (선택 — 미승인 후보 포함 조회)

---

## 3. Query Type Enum

| 타입 | 설명 | 알고리즘 |
|------|------|---------|
| `IMPACT_ANALYSIS` | 변경 영향도 (Upstream/Downstream) | bounded BFS/DFS |
| `PATH_DISCOVERY` | A→B 경로 탐색 (최단 + Top-K) | BFS + 랭킹 |
| `USAGE_DISCOVERY` | 특정 객체 사용 주체 추적 | 직접 조회 + Rollup 조회 |
| `DOMAIN_SUMMARY` | 도메인 요약 (결정론 집계 + LLM 문장화) | 집계 + LLM |

### 확장 예정

- `DEPENDENCY_OVERVIEW`: 전체 의존성 개요
- `DRIFT_CHECK`: 설계 의도와 실제 구조 차이 탐지

---

## 4. Query DSL

### 4.1 QueryRequest

```typescript
interface QueryRequest {
  workspaceId: string;              // UUID
  generationVersion?: number;       // 미지정 시 ACTIVE 사용
  queryType: QueryType;
  scope: QueryScope;
  params: QueryParams;
}

interface QueryScope {
  level: RollupLevel;               // SERVICE_TO_SERVICE, DOMAIN_TO_DOMAIN, ...
  relationTypes?: string[];         // 관계 타입 필터
  visibility: 'VISIBLE_ONLY' | 'INCLUDE_HIDDEN';
  tagIds?: string[];                // 태그 필터 (선택)
  objectTypes?: string[];           // 노드 타입 제한 (선택)
}

interface QueryParams {
  // PATH_DISCOVERY
  fromObjectId?: string;
  toObjectId?: string;
  maxHops?: number;                 // 기본 6
  topK?: number;                    // 기본 3

  // IMPACT_ANALYSIS
  targetObjectId?: string;
  direction?: 'UPSTREAM' | 'DOWNSTREAM' | 'BOTH';
  maxDepth?: number;                // 기본 6

  // USAGE_DISCOVERY
  objectId?: string;

  // DOMAIN_SUMMARY
  domainId?: string;
}
```

### 4.2 QueryResponse

```typescript
interface QueryResponse {
  queryType: QueryType;
  result: QueryResult;
  meta: QueryMeta;
}

interface QueryResult {
  nodes: QueryNode[];
  edges: QueryEdge[];
  paths?: QueryPath[];              // PATH_DISCOVERY 전용
  summary?: Record<string, unknown>; // DOMAIN_SUMMARY 전용
}

interface QueryNode {
  id: string;
  type: string;                     // object_type
  name: string;
  displayName?: string;
  depth?: number;                   // 탐색 깊이
  metadata?: Record<string, unknown>;
}

interface QueryEdge {
  subjectId: string;
  objectId: string;
  relationType: string;
  level: string;                    // rollup_level
  edgeWeight: number;
  confidence: number;
  provenance: {
    rollupId: string;
    baseRelationIds: string[];
  };
}

interface QueryPath {
  pathId: string;
  nodeIds: string[];
  score: number;
}

interface QueryMeta {
  generationVersion: number;
  computedAt: string;               // ISO-8601
  executionMs: number;
  truncated: boolean;               // 결과 제한으로 잘렸는지
}
```

---

## 5. 질의별 알고리즘 (결정론)

### 5.1 PATH_DISCOVERY

**그래프**: `object_rollups` adjacency list
**알고리즘**: BFS (최단 거리 경로 수집)
**Top-K**: 최단 경로 집합 내에서 score 기준 정렬

**Score 계산 (고정 룰):**

```
score = avg(edge.confidence) × log(1 + min(edgeWeight)) ÷ hops_penalty

hops_penalty = 1 + (hops - 1) × 0.1
```

**제한:**
- maxHops: 6 (기본)
- maxVisited: 20,000 노드
- timeout: 2초

### 5.2 IMPACT_ANALYSIS

**모드**: Downstream / Upstream / Both
**알고리즘**: bounded BFS/DFS + maxDepth
**랭킹**: depth 우선, 동일 depth면 confidence/edgeWeight 우선

```
// Downstream: subject_object_id 기준 outbound 탐색
// Upstream: object_id 기준 inbound 탐색
```

### 5.3 USAGE_DISCOVERY

**원자 객체** (topic/db_table/api_endpoint):
- `object_relations` 직접 조회가 정확

**상위 객체** (database/broker/service):
- `object_rollups` 우선 조회

### 5.4 DOMAIN_SUMMARY

**결정론 집계 생성:**
- 도메인 소속 서비스 수
- Object type별 카운트
- 핵심 관계/토픽/테이블 목록
- 평균 purity
- 주요 외부 의존 도메인

**LLM 문장화:**
- 집계 결과를 입력으로 자연어 요약 생성
- 근거 링크 포함

---

## 6. Evidence / Provenance 체인

Explainable 결과를 위해 아래 체인을 끊지 않는다.

```
Rollup Edge
    → rollup_provenance (domain_rollup_provenances)
        → Base Relations (object_relations)
            → relation_evidences
                → evidences (file/line/excerpt/uri)
```

**원칙**: 어떤 결론이든 Evidence까지 추적 가능해야 한다.

---

## 7. 성능 / 캐싱

### 7.1 Adjacency Cache

- `generation_version`별 인메모리 adjacency list 구성
- Generation 변경 시 캐시 무효화 + 재구성
- graphology 그래프 인스턴스로 관리

### 7.2 Query 결과 캐시

- LRU 캐시 (선택)
- 캐시 키: `(workspace_id, generation_version, visibility, tagIds, queryType, params)`
- Generation 변경 시 자동 무효화

### 7.3 성능 제한

| 제한 | 기본값 | 설명 |
|------|--------|------|
| maxDepth | 6 | 탐색 깊이 제한 |
| maxVisited | 20,000 | 방문 노드 수 제한 |
| timeout | 2초 | 질의 타임아웃 |

---

## 8. AI Reasoning 레이어

### 8.1 컴포넌트 구성

```
사용자 질문
      ↓
[Query Router]        → QueryRequest 생성
      ↓
[Deterministic Engine] → 그래프 계산
      ↓
[Evidence Assembler]   → 근거 묶음 구성
      ↓
[Answer Composer]      → 구조화된 답변 골격
      ↓
[LLM Formatter]        → 자연어 정리
      ↓
최종 응답 (evidence + confidence + deep-link)
```

### 8.2 Query Router

질문 유형을 분류한다.

- **1차**: Rule-based (키워드 매칭, 패턴 인식)
- **2차**: LLM 보조 (애매한 경우에만)

```typescript
// 예시 분류 규칙
"영향" | "변경" | "impact" → IMPACT_ANALYSIS
"경로" | "path" | "어떻게 연결" → PATH_DISCOVERY
"누가 사용" | "어디서 쓰" → USAGE_DISCOVERY
"도메인 요약" | "어떤 도메인" → DOMAIN_SUMMARY
```

### 8.3 Evidence Assembler

**최대 10개** evidence 선택, 우선순위:

1. confidence 높은 순
2. edge_weight 높은 순
3. hop 가까운 순
4. 최신 valid_from 우선

### 8.4 Answer Composer

**응답 형식 강제:**

```
1. 결론 (데이터 기반)
2. Confidence (수치)
3. Evidence 목록 (provenance 포함)
4. 경로/영향 요약
5. Deep-link (그래프 뷰 링크)
```

**예시:**

```
결론: 주문 서비스는 결제 서비스를 호출합니다.
Confidence: 0.91
Evidence:
  - Rollup edge (edge_weight=7)
  - Base relation: OrderController.java:120-145
Deep-link: /mapping?path=p1
```

### 8.5 LLM Formatter

LLM은 **주어진 데이터만 문장화**한다.

**금지 사항:**
- 새로운 사실 추가 금지
- confidence 변경 금지
- evidence 삭제 금지

**멀티 프로바이더 지원 (Vercel AI SDK):**

```typescript
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';

// 설정에 따라 프로바이더 선택
const provider = getConfiguredProvider(); // openai | anthropic | google

const { text } = await generateText({
  model: provider(modelId),
  system: FORMATTER_SYSTEM_PROMPT,
  prompt: composedAnswer,
});
```

### 8.6 부족 근거 처리

근거가 부족하면:

- "확정 불가" 명시
- 부족한 근거 유형 안내
- 필요한 데이터 제안

### 8.7 모드 설계

| 모드 | 설명 | v1 |
|------|------|-----|
| **Strict Mode** | Evidence 없는 결론 금지 | 기본 |
| **Explore Mode** | 가설 허용 (UI에 "Hypothesis" 라벨 표기) | 선택 |

---

## 9. 모듈 구조

```
packages/core/src/
├── graph-store/          # DB 접근 (Rollup/Relation/Evidence 조회)
│   ├── rollupStore.ts
│   ├── relationStore.ts
│   └── evidenceStore.ts
├── graph-index/          # Adjacency 캐시 빌더
│   ├── adjacencyBuilder.ts
│   └── cacheManager.ts
├── query-engine/         # BFS/DFS/Path/Ranking
│   ├── pathDiscovery.ts
│   ├── impactAnalysis.ts
│   ├── usageDiscovery.ts
│   └── domainSummary.ts
├── query-dsl/            # Request/Response 스키마
│   ├── schema.ts         # zod 스키마
│   └── types.ts          # TypeScript 타입
└── rollup/               # Rollup 계산 (별도 문서 참조)
```

---

## 10. v1 구현 우선순위

| 순서 | 항목 | 설명 |
|------|------|------|
| 1 | PATH_DISCOVERY | service-to-service call 경로 탐색 |
| 2 | IMPACT_ANALYSIS | downstream/upstream 영향도 |
| 3 | USAGE_DISCOVERY | topic/table 사용 주체 추적 |
| 4 | DOMAIN_SUMMARY | 결정론 집계 + LLM 문장화 |
| 5 | AI Chat 통합 | Strict Mode 먼저, Explore Mode 이후 |

---

## 관련 문서

| 문서 | 설명 |
|------|------|
| [02-data-model.md](./02-data-model.md) | Query Engine이 조회하는 테이블 구조 |
| [05-rollup-and-graph.md](./05-rollup-and-graph.md) | Rollup 데이터 생성 방식 |
| [03-inference-engine.md](./03-inference-engine.md) | 추론 결과가 Query 대상이 됨 |
