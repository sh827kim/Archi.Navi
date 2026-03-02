# Archi.Navi — 추론 엔진

작성일: 2026-02-22
문서 버전: v3.0

---

## 1. 설계 목적

추론 엔진은 소스코드, DB 스키마, 설정 파일, 메시지 설정 등에서 **구조 신호(Signal)**를 추출하고,
이를 기반으로 **Relation 후보**와 **Domain 소속**을 자동으로 생성한다.

**목표: 전체 Relation의 70% 이상을 자동 추론하여 수동 등록 부담을 최소화한다.**

모든 추론 결과는 **승인 전 반영 금지** 원칙을 따른다.

### 1.1 추론 엔진 전체 아키텍처

```
┌─────────────────────────────────────────────────────────┐
│                    Signal Collectors                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐  │
│  │ Code     │  │ Config   │  │ DB Schema│  │ Message│  │
│  │ Signals  │  │ Signals  │  │ Signals  │  │ Signals│  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───┬────┘  │
│       │              │              │             │      │
│       ▼              ▼              ▼             ▼      │
│  ┌──────────────────────────────────────────────────┐   │
│  │          Signal Store (evidences 테이블)          │   │
│  └─────────────────────┬────────────────────────────┘   │
│                        │                                │
│       ┌────────────────┼────────────────┐               │
│       ▼                ▼                ▼               │
│  ┌─────────┐   ┌──────────────┐  ┌──────────────┐      │
│  │Relation │   │Domain Track A│  │Domain Track B│      │
│  │Inference│   │(Seed-based)  │  │(Discovery)   │      │
│  └────┬────┘   └──────┬───────┘  └──────┬───────┘      │
│       │               │                 │               │
│       ▼               ▼                 ▼               │
│  relation_     domain_          domain_discovery_       │
│  candidates    candidates       memberships             │
│  (PENDING)     (PENDING)        (스냅샷)                │
│       │               │                 │               │
│       └───────────────┼─────────────────┘               │
│                       ▼                                 │
│              승인 워크플로우 (UI)                        │
│                       │                                 │
│       ┌───────────────┼───────────────┐                 │
│       ▼               ▼               ▼                 │
│  object_       object_domain_   Named Domain            │
│  relations     affinities       승격                    │
│  (확정)        (확정)           (선택)                   │
└─────────────────────────────────────────────────────────┘
```

---

## 1.2 구현 디렉토리 매핑 (2026-03-01)

`packages/inference/src`의 실제 실행 모듈은 아래와 같다.

- `relation/`: Config 기반 관계 후보 생성, 후보 승인/거부 처리
- `domain/`: Track A/B 도메인 추론, 도메인 후보 승인
- `code/`: Regex 기반 코드 신호 추출 + `code/ast/` AST 파서
- `db/`: DB 스키마 신호(FK/implicit FK) 추출
- `llm/`: 후보 LLM 필터링/배치 처리

참고:
- `src/signals/`, `src/ast/`는 현재 placeholder 디렉토리이며 실행 파일은 없다.

---

## 2. Relation 추론

### 2.1 추론 파이프라인 — 전체 흐름

```
CLI/Web: 프로젝트 스캔으로 service Object + scanPath 등록
  - CLI: anavi scan --workspace <id> [--path|--workspace-dir|--github-repo|--github-org]
  - Web: POST /api/scan
      ↓
Signal Collector 실행 (소스별)
      ↓
evidences 테이블에 근거 저장
      ↓
code_call_edges / code_import_edges에 구조 데이터 저장
      ↓
Web API: POST /api/inference/run
  - modes: config | code | db
  - repoRoots 또는 service.metadata.scanPath 기반 실행
      ↓
Relation Inference Engine 실행
  - Signal Store 조회
  - 추론 규칙 적용
  - Confidence 산정
      ↓
relation_candidates (PENDING) + evidence 연결
      ↓
UI: 승인 페이지에서 검토
      ↓
승인 → object_relations (확정) + rollup rebuild 트리거
반려 → status='REJECTED'
```

### 2.2 Signal Collector — 수집 단계

Signal Collector는 **원본 데이터를 분석하여 구조화된 신호로 변환**하는 모듈이다.
각 Collector는 독립적으로 실행 가능하며, 결과를 공유 테이블에 저장한다.

#### 수집 모드별 CLI 호출

```bash
# 1) 서비스 등록(스캔)
anavi scan --workspace <workspaceId> --path /path/to/repo

# 2) 관계 추론 실행 (API)
curl -X POST http://localhost:3000/api/inference/run \
  -H 'Content-Type: application/json' \
  -d '{"workspaceId":"<workspaceId>","modes":["config","db"],"useServiceMetadataPaths":true}'

# 3) (선택) 코드 신호 포함 실행
curl -X POST http://localhost:3000/api/inference/run \
  -H 'Content-Type: application/json' \
  -d '{"workspaceId":"<workspaceId>","modes":["config","code","db"],"repoRoots":["/abs/repo/path"]}'
```

#### 수집 결과 저장 위치

| Collector | 저장 테이블 | 설명 |
|-----------|------------|------|
| Code Signal | `code_artifacts` | 파일/모듈 메타 (언어, 경로, SHA256) |
| Code Signal | `code_call_edges` | 호출 관계 (caller → callee symbol) |
| Code Signal | `code_import_edges` | Import 그래프 |
| Code Signal | `evidences` | 근거 원본 (파일 경로, 행 번호, 발췌) |
| Config Signal | `evidences` | 설정 파일 근거 |
| Config Signal | `objects` (생성) | 발견된 DB/Broker/Topic Object 자동 생성 |
| DB Signal | `evidences` | FK 제약조건, 테이블 스키마 근거 |

### 2.3 Relation 추론 규칙

#### 2.3.1 Code 기반 추론

| 신호 패턴 | 추론 결과 | Confidence | 비고 |
|-----------|----------|------------|------|
| HTTP Client 호출 (`RestTemplate`, `WebClient`, `FeignClient`) | `call` relation | Phase 1: 0.7 / Phase 2: 0.9 | URL path → api_endpoint 매칭 필요 |
| API Controller 선언 (`@GetMapping`, `@PostMapping`) | `expose` relation | Phase 1: 0.8 / Phase 2: 0.95 | path → api_endpoint Object 자동 생성 |
| Message Producer (`kafkaTemplate.send`, `@SendTo`) | `produce` relation | Phase 1: 0.7 / Phase 2: 0.9 | topic 문자열 추출 |
| Message Consumer (`@KafkaListener`, `@RabbitListener`) | `consume` relation | Phase 1: 0.8 / Phase 2: 0.95 | topics 파라미터 추출 |
| MyBatis XML (`<select>`, `<insert>`, `<update>`, `<delete>`) | `read`/`write` | Phase 1: 0.8 | SQL 내 테이블명 추출 |
| JPA Mapping (`@Entity`, `@Table`, `@ManyToOne`) | `read`/`write` | Phase 1: 0.7 / Phase 2: 0.9 | 엔티티-테이블 매핑 |

#### 2.3.2 URL Path → API Endpoint 매칭 알고리즘

Code에서 HTTP 호출을 감지하면 URL path를 추출하는데, 이를 **어떤 서비스의 어떤 API에 매핑**할지가 핵심이다.

```
[매칭 우선순위]
1. 정확 매칭: url_path == api_endpoint.name (또는 metadata.path)
   → confidence += 0.3

2. 프리픽스 매칭: url_path.startsWith(service.metadata.contextPath)
   → 해당 서비스의 api_endpoint 중 가장 유사한 것 선택
   → confidence += 0.2

3. 서비스명 힌트: FeignClient의 name/url 속성 → 서비스 매칭
   → confidence += 0.2

4. 매칭 실패 시: subject_service → "unknown" endpoint로 기록
   → confidence = 0.3, status=PENDING으로 사용자 검토 유도
```

#### 2.3.3 Config 기반 추론

| 설정 파일 | 파싱 대상 | 추론 결과 | Confidence |
|-----------|----------|----------|------------|
| `application.yml` | `spring.datasource.url` | database Object 생성 + `read`/`write` relation | 0.9 |
| `application.yml` | `spring.kafka.bootstrap-servers` | message_broker Object 생성 | 0.9 |
| `application.yml` | `spring.kafka.consumer.group-id` + topics | `consume` relation | 0.85 |
| `docker-compose.yml` | `depends_on` | service간 `depend_on` relation | 0.6 |
| `docker-compose.yml` | DB 서비스 (mysql, postgres 이미지) | database Object 생성 | 0.8 |
| K8s `deployment.yml` | 환경변수의 DB_URL, KAFKA_BROKERS | Object 생성 + relation | 0.7 |
| API Gateway config | 라우팅 규칙 (path → service) | `call` relation | 0.8 |

#### 2.3.4 DB 스키마 기반 추론

| 신호 | 추론 결과 | Confidence |
|------|----------|------------|
| FK 제약조건 | `db_table` → `db_table` 참조 관계 (Evidence로 저장) | 0.95 |
| SELECT 쿼리 (MyBatis/JPA) | service → db_table `read` | 0.8 |
| INSERT/UPDATE/DELETE 쿼리 | service → db_table `write` | 0.8 |
| 컬럼 참조 패턴 (`*_id` suffix) | db_table 간 implicit FK | 0.5 |

### 2.4 Confidence 산정 기준

| 수준 | confidence | 조건 |
|------|-----------|------|
| 높음 | 0.9~1.0 | AST 기반 정확한 추출 + Evidence 명확 |
| 중간 | 0.6~0.8 | Regex 패턴 매칭 기반 (Phase 1) |
| 낮음 | 0.3~0.5 | 휴리스틱 기반 (이름 유사도, 디렉토리 구조) |

Phase 2(AST) 적용 시 같은 신호라도 confidence가 0.1~0.2 상향된다.

### 2.5 중복 후보 처리

같은 `(subject, object, relationType)` 조합의 후보가 이미 존재할 때:

- **기존 PENDING**: 새 confidence가 더 높으면 갱신, evidence 추가
- **기존 APPROVED**: 무시 (이미 확정됨)
- **기존 REJECTED**: 새 evidence가 있으면 별도 후보 생성, 없으면 무시
- **수동 MANUAL 관계 존재**: 무시 (수동 오버라이드 우선)

---

## 3. Domain 추론 — Track A: Seed 기반 Named Domain

### 3.1 핵심 개념: Affinity 분포

서비스는 하나의 도메인에 깔끔히 속하지 않을 수 있다.
따라서 도메인 소속은 **단일 라벨**이 아닌 **분포(Distribution)**로 표현한다.

```
affinity = { domainId → score }  // 합이 1.0이 되도록 정규화

primary   = argmax(affinity)     // 가장 높은 소속
secondary = affinity[d] >= 0.25  // threshold 이상 (primary 제외)
purity    = max(affinity)        // 단일 도메인 순수도
```

**Purity 해석:**
- 0.90+: 거의 단일 도메인
- 0.60: 어느 정도 혼재
- 0.40-: 강한 혼재 (통합/게이트웨이/레거시 성격)

### 3.2 입력

- **Seed Domain 목록**: 사용자가 정의 (예: order, payment, user, inventory)
- **Seed 추천**: 서비스 이름/디렉토리/테이블 prefix 빈도 기반 자동 추천 가능

### 3.3 신호(Signal) 설계

#### Code Signals

**(A) Heuristic 기반 (약한 신호)**
- 파일 경로, 패키지명, 클래스/함수명에서 도메인 키워드 매칭
- 점수 상한: domain당 최대 0.30 (오탐 방지)

**(B) Code Structure 기반 (중간 신호)** — Phase 1
- `code_import_edges`: 어떤 도메인 모듈을 참조하는지 (import 빈도 집계)
- `code_call_edges`: 어떤 도메인 소유 Object를 호출하는지 (call 빈도 집계)

**(C) AST 기반 (강한 신호)** — Phase 2
- Import graph: 정확한 모듈 의존 관계
- Symbol ownership: 심볼이 어느 도메인에 정의되었는지
- Call edges: 실제 호출 관계의 정밀 분석

#### DB Signals (강한 신호)

- 테이블 prefix 매칭 (예: `order_*` → order 도메인)
- FK 네이밍 패턴 (FK가 같은 도메인 테이블을 참조하는지)
- FK 커뮤니티 (FK로 연결된 테이블 응집도)

#### Message Signals (중간 신호)

- Topic 네이밍 패턴 (예: `order.created` → order 도메인)
- Producer/Consumer 응집도 (같은 도메인 서비스끼리 연결되는지)

### 3.4 점수 합성 (결정론)

```
v = Wcode × v_code + Wdb × v_db + Wmsg × v_msg (+ Wmanual)
affinity = normalize(v)   // 합이 1.0이 되도록
```

**권장 가중치:**

| 파라미터 | 기본값 | 설명 |
|---------|--------|------|
| `w_code` | 0.5 | 코드 신호 가중치 |
| `w_db` | 0.3 | DB 신호 가중치 |
| `w_msg` | 0.2 | 메시지 신호 가중치 |
| `heuristic_domain_cap` | 0.3 | 휴리스틱 점수 상한 |
| `secondary_threshold` | 0.25 | Secondary 도메인 포함 기준 |

가중치는 `domain_inference_profiles` 테이블에 저장하여 워크스페이스별 튜닝 가능.

### 3.5 승인 워크플로우

```
신호 추출 + 점수 합성
      ↓
domain_candidates (PENDING)
  - affinity_map: {"orderDomain": 0.62, "paymentDomain": 0.38}
  - purity: 0.62
  - signals: {code: [...], db: [...], msg: [...]}
      ↓
사용자 검토 (분포 전체를 승인)
      ↓
object_domain_affinities (확정)
  + objects.metadata.domain 캐시 갱신
```

**분포를 승인하는 이유:**
단일 primary만 승인하면 현실의 혼재를 지워버려, "실제 구조 보기" 목적에 반한다.

---

## 4. Domain 추론 — Track B: Seed-less Discovery

### 4.1 목적

레거시 환경에서는 도메인 seed 자체가 없다.
구조 그래프에서 **커뮤니티(군집)를 자동 탐지**해 "도메인 후보"를 생성한다.

핵심: "도메인은 이름이 아니라 **강하게 연결된 묶음**"

### 4.2 멀티 레이어 가중 그래프 구성

#### 노드

- `service` (필수)
- `db_table` (가능하면)
- `topic` (가능하면)
- `api_endpoint`, `function` (선택)

#### 엣지 가중치

| 타입 | 기본 가중치 | 프로필 키 | 설명 |
|------|------------|----------|------|
| service→service call (rollup) | 1.0 | `edge_w_call` | 가장 강한 구조 결합 |
| service→table read/write | 0.8 | `edge_w_rw` | DB 접근 |
| service→topic produce/consume | 0.6 | `edge_w_msg` | 메시지 기반 결합 |
| table↔table FK | 0.4 | `edge_w_fk` | 스키마 레벨 참조 |
| code import/call | 0.7 | `edge_w_code` | 코드 레벨 참조 |

가중치는 `domain_inference_profiles`에서 워크스페이스별 조정 가능.
`enabled_layers` 필드로 사용할 레이어를 선택 가능 (기본: `["call","db","msg","code"]`).

### 4.3 커뮤니티 탐지 알고리즘

- **권장**: Louvain 또는 Leiden (응집도 기반 군집 탐지)
- **라이브러리**: graphology + graphology-communities-louvain
- **파라미터**: resolution (세밀도 조절), min_cluster_size (최소 클러스터 크기)

```typescript
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';

// 가중 그래프 구성 후 커뮤니티 탐지
const communities = louvain(graph, {
  resolution: profile.resolution ?? 1.0,
});
```

### 4.4 Discovery Domain 생성

탐지된 커뮤니티마다 `objects`에 Domain Object를 생성한다.

```json
{
  "object_type": "domain",
  "name": "discovered:cluster-7",
  "display_name": "Cluster 7",
  "metadata": {
    "kind": "DISCOVERED",
    "cluster_id": "c-007",
    "algo": "louvain",
    "algo_version": "1.0",
    "input_layers": ["call", "db", "msg"],
    "parameters": { "min_cluster_size": 3 },
    "label_candidates": [
      { "text": "billing", "score": 0.82 },
      { "text": "invoice", "score": 0.61 }
    ]
  }
}
```

### 4.5 Label Suggestion (자동 라벨 후보)

클러스터 내부에서 자주 등장하는 키워드로 라벨 후보를 생성한다.

**토큰 추출 소스:**
- 서비스 이름 토큰 빈도 (예: `order-service` → `order`)
- 테이블 prefix 빈도 (예: `order_items`, `order_payments` → `order`)
- Topic prefix 빈도 (예: `order.created`, `order.cancelled` → `order`)
- 패키지 top-level 토큰

**라벨 점수 산정:**
```
label_score = Σ (token 출현 빈도 / 클러스터 내 총 토큰 수)
```

상위 3개 후보를 `metadata.label_candidates`에 저장하여 사용자가 이름을 선택/수정할 수 있게 한다.

### 4.6 Discovery Affinity

클러스터 멤버십을 `object_domain_affinities`에 반영한다.

- **단순**: 멤버 = affinity 1.0
- **고급**: 경계가 흐린 서비스는 분포로 반영 (예: 0.6/0.4)

### 4.7 실행 스냅샷 관리

```
Discovery 실행
      ↓
domain_discovery_runs (실행 메타 기록)
      ↓
domain_discovery_memberships (클러스터별 멤버십 저장)
      ↓
사용자 검토
      ↓
"적용" → object_domain_affinities (source=DISCOVERY)
또는
"이름 변경/병합" → Named Domain으로 승격
```

**왜 run별 스냅샷이 필요한가?**
- 레거시 분석은 결과 재현이 핵심
- 파라미터 튜닝/비교를 위해 히스토리 보존 필요

---

## 5. DB 스키마 신호 추출

### 5.1 Domain 추론용 신호 (Track A dbScore)

| 소스 | 추론 방식 | Confidence |
|------|----------|------------|
| **테이블 prefix** | `order_*` 테이블 → order 도메인 | 0.6 |
| **FK 커뮤니티** | FK로 연결된 테이블 그룹 → 같은 도메인 | 0.7 |
| **FK 네이밍 패턴** | FK가 가리키는 테이블의 도메인 → 참조 관계 | 0.5 |

### 5.2 Relation 추론용 신호

| 소스 | 추론 방식 | 추론 결과 | Confidence |
|------|----------|----------|------------|
| **FK 제약조건** | 직접 추출 | `db_table` → `db_table` 참조 Evidence | 0.95 |
| **Unique 제약 / Unique 인덱스** | `*_id`, `*_no` 컬럼 + unique 패턴 | 식별 관계 힌트 Evidence | 0.85 |
| **복합 인덱스** | 인덱스 구성 컬럼(`columns >= 2`)의 FK 유사 컬럼 추론 | 조인 관계 힌트 Evidence | 0.7 |
| **컬럼명 패턴** | `*_id`, `*_no` 접미사 → 대상 테이블 추정 | implicit FK Evidence | 0.5 |

**제외 패턴** (false positive 방지):
`created_by`, `updated_by`, `deleted_by`, `created_at`, `updated_at`

> **참고**: MyBatis XML 파싱, JPA Mapping 파싱은 Section 6(Code Signal Extraction)에서 처리한다.
> DB 스키마 신호 추출은 **코드 없이 스키마만으로 추출 가능한 신호**에 집중한다.

---

## 6. Code Signal Extraction — 2단계 전략

### 6.1 Phase 1: Regex 기반 패턴 매칭 (우선 구현)

AST 없이도 **정규식 기반 패턴 매칭으로 70~80% 정확도**를 달성할 수 있다.
Phase 1은 빠르게 구현하여 추론 파이프라인 전체를 동작시키는 데 집중한다.

#### 6.1.1 추출 대상 패턴 (Java/Kotlin)

| 카테고리 | 패턴 | 추출 정보 |
|---------|------|----------|
| **API 노출** | `@(Get\|Post\|Put\|Delete\|Patch)Mapping\("(.+)"\)` | `expose` + path |
| **API 노출** | `@RequestMapping\("(.+)"\)` | `expose` + path (method는 별도 추출) |
| **HTTP 호출** | `restTemplate\.\w+\("([^"]+)"` | `call` + URL |
| **HTTP 호출** | `webClient\.\w+\(\)\.uri\("([^"]+)"` | `call` + URL |
| **HTTP 호출** | `@FeignClient\(.*name\s*=\s*"([^"]+)"` | `call` + 대상 서비스 name |
| **Kafka 발행** | `kafkaTemplate\.send\("([^"]+)"` | `produce` + topic |
| **Kafka 수신** | `@KafkaListener\(.*topics\s*=\s*\{?"([^"]+)"` | `consume` + topic |
| **DB 접근 (MyBatis)** | `<select\|insert\|update\|delete[^>]*>` 내 테이블명 | `read`/`write` + table |
| **DB 접근 (JPA)** | `@Table\(.*name\s*=\s*"([^"]+)"` | 엔티티-테이블 매핑 |
| **DB 접근 (JPA)** | `@(ManyToOne\|OneToMany\|ManyToMany)` | 테이블 간 관계 힌트 |

#### 6.1.2 추출 대상 패턴 (TypeScript/JavaScript)

| 카테고리 | 패턴 | 추출 정보 |
|---------|------|----------|
| **HTTP 호출** | `(fetch\|axios\.\w+)\(["']([^"']+)["']` | `call` + URL |
| **HTTP 호출** | `\.get\|\.post\|\.put\|\.delete\(["']([^"']+)["']` | `call` + URL |
| **API 노출** | `(app\|router)\.(get\|post\|put\|delete)\(["']([^"']+)["']` | `expose` + path |

#### 6.1.3 추출 대상 패턴 (Python)

| 카테고리 | 패턴 | 추출 정보 |
|---------|------|----------|
| **HTTP 호출** | `requests\.\w+\(["']([^"']+)["']` | `call` + URL |
| **API 노출** | `@(app\|router)\.(get\|post\|put\|delete)\(["']([^"']+)["']` | `expose` + path |
| **Kafka** | `KafkaProducer.*\.send\(["']([^"']+)["']` | `produce` + topic |
| **Kafka** | `@kafka_consumer\(.*topic=["']([^"']+)["']` | `consume` + topic |

#### 6.1.4 수집 흐름

```
POST /api/inference/run  (modes에 code 포함)
      ↓
1. 파일 탐색 (언어별 확장자 필터: .java, .kt, .ts, .js, .py)
      ↓
2. SHA256 해시 비교 → 변경된 파일만 처리 (증분 스캔)
      ↓
3. 파일별 정규식 매칭 → 신호 추출
      ↓
4. code_artifacts 저장 (파일 메타)
   code_call_edges 저장 (호출 관계)
   code_import_edges 저장 (Import 관계)
   evidences 저장 (근거: 파일 경로, 행 번호, 코드 발췌)
      ↓
5. 추출 완료 리포트 출력
   - 스캔 파일 수, 신규/변경/미변경 파일 수
   - 추출된 신호 유형별 개수
```

#### 6.1.5 Phase 1 한계

- **변수/상수로 지정된 URL**: `String url = "/api/orders"; restTemplate.get(url)` → 미감지
- **동적 URL**: `restTemplate.get("/api/" + serviceName + "/orders")` → 미감지
- **간접 호출**: 팩토리 패턴, 의존성 주입으로 분리된 호출 → 미감지
- **정확도**: 약 70~80% (Phase 2에서 90%+로 개선)

### 6.2 Phase 2: AST 기반 정밀 추출 (Next Step)

Phase 1의 한계를 보완하기 위해 **Tree-sitter 기반 AST 분석**을 도입한다.
Phase 1과 **동일한 출력 형식** (`code_artifacts`, `code_call_edges`, `code_import_edges`, `evidences`)을 사용하므로,
하위 추론 엔진은 수정 없이 정밀도만 향상된다.

#### 6.2.1 아키텍처

```
소스코드 파일
      ↓
Tree-sitter 파서 (언어별 문법)
      ↓
AST → 구조적 쿼리 (S-expression)
      ↓
code_artifacts + code_import_edges + code_call_edges + evidences
```

#### 6.2.2 AST가 해결하는 Phase 1 한계

| Phase 1 한계 | AST 해결 방식 |
|-------------|-------------|
| 변수/상수 URL | AST data-flow 분석으로 변수 추적 |
| 간접 호출 | 타입 추론 → 인터페이스 구현체 매핑 |
| 중첩 어노테이션 | AST 구조적 쿼리로 정확한 파라미터 추출 |
| 멀티라인 패턴 | AST는 문법 구조 기반이므로 줄바꿈 무관 |
| Confidence 향상 | 같은 패턴도 AST 검증 시 +0.1~0.2 |

#### 6.2.3 추출 산출물

| 산출물 | 테이블 | 설명 |
|--------|--------|------|
| 파일/모듈 메타 | `code_artifacts` | 언어, 경로, 패키지, 소유 Object |
| Import 관계 | `code_import_edges` | 어떤 모듈/패키지를 참조하는지 |
| Call 관계 | `code_call_edges` | 어떤 심볼을 호출하는지 |

#### 6.2.4 지원 언어

| 언어 | Tree-sitter 문법 | 주요 추출 대상 |
|------|-----------------|---------------|
| **Java/Kotlin** | tree-sitter-java, tree-sitter-kotlin | import, annotation, method call |
| **TypeScript/JS** | tree-sitter-typescript | import/require, decorator, function call |
| **Python** | tree-sitter-python | import, decorator, function call |

#### 6.2.5 설계 원칙

- AST는 "규범 검증"이 아니라 **정확한 관측치 추출 도구**
- 언어별 플러그인은 선택적 (Phase 1 Regex가 없어도 AST만으로 동작)
- 파일 해시(`sha256`)로 변경 감지 → 변경된 파일만 재분석
- Phase 1과 Phase 2는 **동일 출력 형식**을 공유 → 전환 비용 최소화

---

## 7. Config 파싱 전략

### 7.1 지원 설정 파일 목록

| 파일 | 파싱 라이브러리 | 추출 대상 |
|------|---------------|----------|
| `application.yml` / `application.properties` | `js-yaml` | DB URL, Kafka 설정, 서비스 포트, context-path |
| `bootstrap.yml` | `js-yaml` | 서비스 이름, Config Server 주소 |
| `docker-compose.yml` | `js-yaml` | 서비스 의존관계, DB/Broker 컨테이너, 포트 매핑 |
| K8s `deployment.yml` / `service.yml` | `js-yaml` | 환경변수 (DB_URL, KAFKA_BROKERS), 서비스 디스커버리 |
| `.env` | 텍스트 파싱 | 환경변수 → DB URL, API URL 추출 |

### 7.2 application.yml 파싱 규칙

```yaml
# 입력 예시
spring:
  application:
    name: order-service        # → service Object 이름 확인/매칭
  datasource:
    url: jdbc:mysql://db-host:3306/order_db  # → database Object 생성
  kafka:
    bootstrap-servers: kafka:9092             # → message_broker Object 생성
    consumer:
      group-id: order-group
    listener:
      topics: order.created, payment.completed  # → topic Object 생성 + consume relation
```

**추론 규칙:**

| YAML 경로 | 추출 | 추론 |
|-----------|------|------|
| `spring.application.name` | 서비스명 | 기존 service Object와 매칭 |
| `spring.datasource.url` | DB URL → host, port, dbName | database Object 생성 + service→database `read`/`write` |
| `spring.jpa.properties` 존재 | JPA 사용 확인 | `read`/`write` confidence 보정 |
| `spring.kafka.bootstrap-servers` | Broker 주소 | message_broker Object 생성 |
| `spring.kafka.consumer.group-id` + topics | Consumer 설정 | service→topic `consume` |
| `spring.kafka.producer.*` | Producer 설정 | service→broker `produce` (topic은 코드에서 추출) |
| `server.port` | 서비스 포트 | service metadata 보강 |
| `server.servlet.context-path` | Context path | URL 매칭 시 prefix로 활용 |

### 7.3 docker-compose.yml 파싱 규칙

```yaml
# 입력 예시
services:
  order-service:
    depends_on:
      - mysql-db
      - kafka
  mysql-db:
    image: mysql:8.0
    environment:
      MYSQL_DATABASE: order_db
  kafka:
    image: confluentinc/cp-kafka:7.0
```

**추론 규칙:**

| 항목 | 추론 |
|------|------|
| `depends_on` | service → service `depend_on` (confidence: 0.6) |
| DB 이미지 (`mysql`, `postgres`, `mariadb`) | database Object 생성 |
| Kafka/RabbitMQ 이미지 | message_broker Object 생성 |
| `MYSQL_DATABASE` 환경변수 | database 이름 매칭 |
| 서비스명이 기존 Object와 매칭 | 기존 service Object에 metadata 보강 |

### 7.4 수집 흐름

```
POST /api/inference/run  (modes에 config 포함)
      ↓
1. 설정 파일 탐색
   - **/application*.yml, **/application*.properties
   - **/bootstrap*.yml
   - **/docker-compose*.yml
   - **/k8s/**/*.yml, **/deployment*.yml
   - **/.env
      ↓
2. 파일별 파싱 + 규칙 적용
      ↓
3. Object 자동 생성 (database, message_broker, topic)
   - 이미 존재하면 metadata 보강
   - 새로 발견되면 PENDING 상태로 생성 가능 (설정에 따라)
      ↓
4. relation_candidates 생성 + evidences 연결
      ↓
5. 리포트 출력
   - 발견된 설정 파일 수
   - 생성/보강된 Object 수
   - 생성된 relation candidate 수
```

---

## 8. 승인 워크플로우 통합

### 8.1 Relation 승인

#### API 경로

| Method | Path | 설명 |
|--------|------|------|
| `GET` | `/api/inference/candidates?workspaceId=&status=PENDING` | 후보 목록 조회 |
| `PATCH` | `/api/inference/candidates/:id` | 승인/거부 (body: `{ status }`) |

#### 승인 흐름

```
relation_candidates (PENDING)
      ↓
승인 UI:
  - 전체 선택
  - 부분 선택 해제
  - Evidence 링크 확인 (파일명, 행 번호, 코드 발췌)
  - 일괄 승인/반려
      ↓
승인 → object_relations (확정) + rollup rebuild 트리거
반려 → status='REJECTED'
```

### 8.2 Domain 승인

#### API 경로

| Method | Path | 설명 |
|--------|------|------|
| `GET` | `/api/inference/domain-candidates?workspaceId=&status=PENDING` | 도메인 후보 목록 조회 |
| `PATCH` | `/api/inference/domain-candidates/:id` | 승인/거부 (body: `{ status }`) |

#### 승인 흐름

```
domain_candidates (PENDING)
      ↓
승인 UI:
  - affinity 분포 확인 (primary/secondary/purity)
  - 신호 근거 확인 (code/db/msg 각각의 기여도)
  - 일괄 승인/반려
      ↓
승인 → object_domain_affinities (확정) + DOMAIN_TO_DOMAIN rollup 트리거
반려 → status='REJECTED'
```

### 8.3 편집 우선순위

**수동 오버라이드 > 자동 추론**

- 수동으로 설정한 관계/도메인은 자동 추론으로 덮어쓰지 않음
- source 필드로 구분: `MANUAL` > `APPROVED_INFERENCE` > `DISCOVERY`

---

## 9. 구현 로드맵

### Phase 1 — 추론 파이프라인 MVP (2026-03-01 기준)

| 순서 | 작업 | 상태 |
|------|------|------|
| 1 | Config 기반 Relation 추론 (`configBased.ts`) | ✅ 구현 |
| 2 | Regex 기반 Code Signal 추출 | ✅ 구현 |
| 3 | DB Signal 구현 (`dbScore`, FK 후보) | ✅ 구현 |
| 4 | Domain Candidates 승인 API + UI | ✅ 구현 |
| 5 | Discovery 다중 레이어 통합 | ⚠️ 부분 구현 |
| 6 | 클러스터 Label 자동 추출 | ⚠️ 부분 구현 |

**Phase 1 완료 시 목표: 전체 Relation의 60~80% 자동 추론**

### Phase 2 — AST 기반 정밀 추출 (v2.1)

| 순서 | 작업 | 예상 효과 |
|------|------|----------|
| 1 | Tree-sitter Java/Kotlin 플러그인 | Spring Boot 프로젝트 정밀 분석 (confidence +0.1~0.2) |
| 2 | Tree-sitter TypeScript/JS 플러그인 | Node.js 프로젝트 정밀 분석 |
| 3 | Tree-sitter Python 플러그인 | Python 서비스 정밀 분석 |
| 4 | 변수 추적 (data-flow analysis) | Phase 1 미감지 패턴 커버 |

**Phase 2 완료 시 목표: 전체 Relation의 85~95% 자동 추론**

### Phase 3 — 고도화 (v2.2+)

| 작업 | 설명 |
|------|------|
| Message Signal 구현 (`seedBased.ts`의 `msgScore`) | 토픽 네이밍 패턴 기반 도메인 추론 |
| 증분 추론 | 변경된 파일/설정만 재분석, 기존 결과 유지 |
| Evidence Assembler 고도화 | AI Chat에서 추론 근거 체인 표시 |
| 인덱스/Unique 제약조건 분석 | DB 추론 확장 (세밀한 테이블 관계) |

---

## 관련 문서

| 문서 | 설명 |
|------|------|
| [02-data-model.md](./02-data-model.md) | 추론 관련 테이블 스키마 (21개 테이블) |
| [05-rollup-and-graph.md](./05-rollup-and-graph.md) | 승인 후 Roll-up 재빌드 |
| [04-query-engine.md](./04-query-engine.md) | 추론 결과 활용 (Query Engine) |
| [08-roadmap.md](./08-roadmap.md) | 전체 로드맵 |
