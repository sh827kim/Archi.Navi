# Archi.Navi — Roll-up 전략 및 그래프 성능

작성일: 2026-02-22
문서 버전: v2.0

---

## 1. 설계 목표

Roll-up은 원자 관계(`object_relations`)를 기반으로 **상위 레벨 의존성을 Materialized 형태로 계산**하여 고속 그래프 탐색을 가능하게 한다.

| 목표 | 설명 |
|------|------|
| 전량 조회 | 1레벨 관계는 원칙적으로 전부 조회 가능 |
| UI 무병목 | 병목 없이 동작하는 렌더링 |
| 허브 사용자 제어 | 숨기지 않고 사용자가 제어 |
| 결정론 유지 | Query Engine과 일관된 결정론적 결과 |
| Local-first 호환 | PGlite 환경에서 현실적 성능 |

---

## 2. Roll-up Level 정의

| Level | 소스 | 파생 |
|-------|------|------|
| **SERVICE_TO_SERVICE** | `call` + `expose` at endpoint level | A→endpoint→B expose ⟹ A→B call |
| **SERVICE_TO_DATABASE** | `read`/`write` at table level | S→table T (parent=DB) ⟹ S→DB |
| **SERVICE_TO_BROKER** | `produce`/`consume` at topic level | S→topic T (parent=Broker) ⟹ S→Broker |
| **DOMAIN_TO_DOMAIN** | SERVICE_TO_SERVICE + domain affinities | 도메인 간 가중 누적 |

---

## 3. 계산 규칙

### 3.1 SERVICE_TO_SERVICE

```
Base:
  A --call--> endpoint E
  B --expose--> endpoint E

Roll-up:
  A --call--> B
  edge_weight = A가 B의 endpoint를 call하는 base relation 수
  confidence = avg(base.confidence)
```

### 3.2 SERVICE_TO_DATABASE

```
Base:
  Service S --read/write--> Table T
  T.parent = Database DB

Roll-up:
  S --read/write--> DB
  edge_weight = S가 DB의 table을 접근하는 base relation 수
  confidence = avg(base.confidence)
```

### 3.3 SERVICE_TO_BROKER

```
Base:
  Service S --produce/consume--> Topic T
  T.parent = Broker M

Roll-up:
  S --produce/consume--> M
  edge_weight = S가 M의 topic을 접근하는 base relation 수
  confidence = avg(base.confidence)
```

### 3.4 DOMAIN_TO_DOMAIN

**입력:**
- SERVICE_TO_SERVICE rollup
- `object_domain_affinities`

**계산 공식 (결정론):**

서비스 edge: A → B, weight = w_ab, confidence = c_ab
A의 도메인 분포: a[X], B의 도메인 분포: b[Y]

```
// 도메인 edge 가중치 누적
edge_weight[X,Y] += w_ab × a[X] × b[Y]

// 도메인 edge confidence (가중 평균)
confidence[X,Y] =
  sum(c_ab × w_ab × a[X] × b[Y]) /
  sum(w_ab × a[X] × b[Y])
```

**Threshold:** `min_membership_threshold = 0.2` (이하 affinity는 무시)

**Provenance:**
- `domain_rollup_provenances`에 어떤 서비스 edge가 기여했는지 저장
- AI evidence 추적을 위해 필수

---

## 4. 집계 전략

| 항목 | 계산 방식 |
|------|----------|
| **edge_weight** | 동일 Rollup edge를 구성하는 base relation 수 |
| **confidence** | avg(base.confidence) |

---

## 5. Generation 관리

### 5.1 Generation 개념

Rollup은 `generation_version` 단위로 관리한다.
모든 질의는 **ACTIVE generation** 기준으로 수행하여 일관성을 보장한다.

### 5.2 Generation 상태

| 상태 | 설명 |
|------|------|
| `BUILDING` | Rollup 빌드 진행 중 |
| `ACTIVE` | 현재 활성 (workspace당 1개) |
| `ARCHIVED` | 이전 버전 (보존) |

### 5.3 빌드 파이프라인

```
1. Approved atomic relations 스냅샷 확정
2. new_generation = last_generation + 1 (status=BUILDING)
3. SERVICE_TO_SERVICE rollup 생성
4. SERVICE_TO_DATABASE rollup 생성
5. SERVICE_TO_BROKER rollup 생성
6. DOMAIN_TO_DOMAIN rollup 생성
7. object_graph_stats 계산
8. rollup_generations status → ACTIVE
9. 이전 generation → ARCHIVED
```

### 5.4 Rebuild 트리거

| 이벤트 | 처리 |
|--------|------|
| Relation 승인 | Rollup 재빌드 |
| Relation 삭제 | Rollup 재빌드 |
| Object parent 변경 | Rollup 재빌드 |
| expose 변경 | Rollup 재빌드 |
| Domain affinity 변경 | DOMAIN_TO_DOMAIN만 재빌드 |

---

## 6. Incremental Rebuild 전략

### 6.1 개념

Full rebuild가 아닌, 영향받는 노드만 부분 재계산한다.

### 6.2 전략

1. 변경된 relation의 subject/object를 식별
2. 해당 노드의 parent chain 추적
3. 영향받는 rollup edge만 삭제 + 재계산
4. 동일 generation_version 유지 (또는 minor version 증가)

### 6.3 CLI 지원

```bash
archi-navi rebuild-rollup              # 전체 재빌드
archi-navi rebuild-rollup --incremental # 변경분만 재빌드
```

---

## 7. 허브(Hub) 처리 전략

### 7.1 허브 정의

- `out_degree > threshold` (기본: 200)
- `in_degree > threshold` (기본: 200)
- threshold는 `domain_inference_profiles` 등 설정에서 관리

### 7.2 UI 처리 원칙

**허브는 숨기지 않는다.** 사용자 제어 기반으로 처리한다.

| 원칙 | 설명 |
|------|------|
| 기본 접힘 | inbound/outbound를 접은 상태로 시작 |
| 수치 표시 | "Outbound 482개 (접힘)" 형태로 명시 |
| 토글 제공 | 사용자가 펼침/접힘 전환 가능 |
| 필터 제공 | 펼칠 때 relation_type, confidence 필터 가능 |

### 7.3 object_graph_stats 활용

Rollup 빌드 시 함께 계산하여, UI가 허브 여부를 빠르게 판단한다.

```sql
-- 허브 판별 쿼리
SELECT object_id, out_degree, in_degree
FROM object_graph_stats
WHERE workspace_id = ? AND generation_version = ? AND rollup_level = ?
  AND (out_degree > 200 OR in_degree > 200);
```

---

## 8. Graph 조회 전략

### 8.1 Direction 기반 조회

Graph API는 반드시 direction을 포함한다.

```typescript
type GraphDirection = 'OUT' | 'IN' | 'BOTH';

interface GraphQuery {
  workspaceId: string;
  generationVersion?: number;
  rollupLevel: RollupLevel;
  objectId: string;
  direction: GraphDirection;
  relationTypes?: string[];
  limit?: number;
}
```

### 8.2 필수 인덱스

```sql
-- Outbound 탐색
create index ix_rollup_out
  on object_rollups(workspace_id, generation_version, rollup_level, subject_object_id);

-- Inbound 탐색
create index ix_rollup_in
  on object_rollups(workspace_id, generation_version, rollup_level, object_id);

-- 타입별 필터
create index ix_rollup_type
  on object_rollups(workspace_id, generation_version, rollup_level, relation_type);
```

---

## 9. 렌더링 성능 전략

### 9.1 점진적 렌더링

edge가 많을 경우 한번에 그리지 않는다.

```typescript
const BATCH_SIZE = 200;

function renderIncrementally(edges: Edge[]) {
  let index = 0;

  function renderBatch() {
    const batch = edges.slice(index, index + BATCH_SIZE);
    batch.forEach(edge => addEdgeToGraph(edge));
    index += BATCH_SIZE;

    if (index < edges.length) {
      requestAnimationFrame(renderBatch);
    }
  }

  requestAnimationFrame(renderBatch);
}
```

### 9.2 Layout 전략

| 모드 | 설명 | 용도 |
|------|------|------|
| **규칙 기반** (기본) | 계층별 고정 배치 | 빠른 초기 렌더링 |
| **Force Layout** (선택) | 물리 시뮬레이션 기반 | 구조 탐색용, 옵션 버튼 |

### 9.3 React Flow 구성

```typescript
// Architecture View의 React Flow 설정
const defaultOptions = {
  fitView: true,
  minZoom: 0.1,
  maxZoom: 2,
  nodesDraggable: true,
  elementsSelectable: true,
};
```

---

## 10. Navigation 전략

### 10.1 Domain-first Navigation

대규모 환경에서는 DOMAIN_TO_DOMAIN 그래프를 기본 네비게이션 레이어로 사용한다.

```
1차: DOMAIN_TO_DOMAIN 그래프 (전체 조감도)
      ↓ 도메인 클릭
2차: SERVICE_TO_SERVICE 드릴다운 (도메인 내 서비스 관계)
      ↓ 서비스 클릭
3차: Atomic 관계 드릴다운 (endpoint/table/topic 레벨)
```

### 10.2 View Preset

| 뷰 | 기본 레벨 | 설명 |
|-----|----------|------|
| **Architecture View** | SERVICE_TO_SERVICE | Roll-up 그래프 시각화 |
| **Domain View** | DOMAIN_TO_DOMAIN | 도메인 간 의존 시각화 |
| **Object Mapping** | Atomic | 타입 필터 + drill-down |

---

## 11. Fast Mode vs Exact Mode

### Fast Mode (기본)

- UI 중심 탐색
- 깊이 제한 (maxDepth: 6)
- 스트리밍 렌더링
- timeout: 2초

### Exact Mode (선택)

- 제한 완화 (maxDepth: 12, maxVisited: 50,000)
- timeout: 10초
- 시간 경고 표시: "정확한 탐색 중... (예상 n초)"

---

## 12. 핵심 API

```typescript
// Rollup 관련 API
rebuildRollups(workspaceId: string): Promise<GenerationVersion>
getRollupGraph(workspaceId: string, level: RollupLevel, options?: GraphQuery): Promise<RollupGraph>
getRollupProvenance(rollupId: string): Promise<Provenance[]>

// Graph Stats
getGraphStats(workspaceId: string, level: RollupLevel): Promise<GraphStats[]>
getHubs(workspaceId: string, level: RollupLevel, threshold?: number): Promise<HubNode[]>

// Generation 관리
getActiveGeneration(workspaceId: string): Promise<GenerationVersion>
listGenerations(workspaceId: string): Promise<Generation[]>
```

---

## 13. 구현 체크리스트

- [ ] rollup_generation 관리 구현
- [ ] SERVICE_TO_SERVICE rollup 계산
- [ ] SERVICE_TO_DATABASE rollup 계산
- [ ] SERVICE_TO_BROKER rollup 계산
- [ ] DOMAIN_TO_DOMAIN rollup 계산
- [ ] object_graph_stats 계산
- [ ] direction 기반 Graph API
- [ ] 허브 collapse/expand UI
- [ ] 점진적 렌더링 (requestAnimationFrame)
- [ ] React Flow 기반 Architecture View
- [ ] Domain-first navigation
- [ ] Fast Mode / Exact Mode 전환

---

## 관련 문서

| 문서 | 설명 |
|------|------|
| [02-data-model.md](./02-data-model.md) | Rollup 관련 테이블 스키마 |
| [04-query-engine.md](./04-query-engine.md) | Rollup 데이터를 활용하는 Query Engine |
| [03-inference-engine.md](./03-inference-engine.md) | 승인 후 Rollup 재빌드 트리거 |
| [07-compound-view.md](./07-compound-view.md) | Compound Dependency View 및 Contributor Drill-down 정의 |
