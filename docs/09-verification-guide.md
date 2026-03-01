# Archi.Navi — 기능 검증 가이드 (1-1 ~ 2-5)

> 작성일: 2026-02-23
> 대상: 로드맵 `docs/08-roadmap.md` 의 P1(1-1~1-6) + P2 일부(2-1~2-5)
> 전제: `pnpm dev` 로 웹 서버 실행 중 (`http://localhost:3000`)

---

## 사전 준비

### 환경 변수 (.env.local)

```bash
# apps/web/.env.local
AI_PROVIDER=anthropic           # openai | anthropic | google
ANTHROPIC_API_KEY=sk-ant-...    # 또는 UI 설정 화면에서 입력 가능
```

> UI 오른쪽 상단 설정(⚙) 버튼 → API 키 / 제공자 / 모델 직접 입력 가능

### 편의 변수

```bash
WS="00000000-0000-0000-0000-000000000001"
BASE="http://localhost:3000"
```

---

## 데이터 초기화 및 주입

### ① DB 초기화 (처음부터 시작할 때)

```bash
curl -s -X POST "$BASE/api/dev/reset" \
  -H "Content-Type: application/json" \
  -d "{\"workspaceId\":\"$WS\"}" | jq
# → { "ok": true }
```

### ② 샘플 데이터 주입

```bash
curl -s -X POST "$BASE/api/dev/seed" \
  -H "Content-Type: application/json" \
  -d "{\"workspaceId\":\"$WS\"}" | jq
```

**주입되는 데이터 (쇼핑몰 마이크로서비스):**

| 항목 | 수량 | 내용 |
|------|------|------|
| 레이어 | 4개 | Presentation / Application / Domain / Infrastructure |
| 서비스 | 8개 | api-gateway, user/order/payment/notification/product/review-service, web-frontend |
| DB | 3개 | user-db, order-db, product-db |
| 메시지 브로커 | 1개 | kafka |
| Kafka 토픽 | 3개 | order.events, payment.events, notification.events |
| API 엔드포인트 | 21개 | 각 서비스별 ATOMIC 오브젝트 |
| DB 테이블 | 6개 | users, sessions, orders, order_items, products, product_stock |
| COMPOUND 관계 | 17개 | 서비스 간 call/write/read/produce/consume |
| ATOMIC 관계 | 34개 | 엔드포인트 ↔ 테이블/토픽 세부 관계 |

### ③ 도메인 Seed 등록 (추론 실행 전 필수)

Track A(Seed 기반 추론)는 도메인 오브젝트가 있어야 동작합니다.

```bash
for domain in order payment user product; do
  echo "도메인 등록: $domain"
  curl -s -X POST "$BASE/api/objects" \
    -H "Content-Type: application/json" \
    -d "{
      \"workspaceId\": \"$WS\",
      \"objectType\": \"domain\",
      \"granularity\": \"COMPOUND\",
      \"name\": \"$domain\",
      \"path\": \"/$domain\",
      \"depth\": 0,
      \"metadata\": {}
    }" | jq -r '.name + ": " + .id'
done
```

---

## 1-1: Config 기반 Relation 추론

**구현 파일:** `packages/inference/src/relation/configBased.ts`
**동작:** application.yml / docker-compose.yml / K8s manifest 파싱 → relation_candidates 생성

> **참고:** seed 데이터는 이미 완성된 관계(APPROVED)가 있으므로, Config 추론은 실제 레포 스캔 시 동작합니다.
> CLI로 실제 프로젝트 디렉토리를 스캔하면 확인 가능합니다.

```bash
# 실제 레포 디렉토리 스캔 (예시)
pnpm --filter @archi-navi/cli exec ts-node bin/anavi.ts scan \
  --workspace "$WS" \
  --path /path/to/your/spring-boot-project

# relation_candidates 확인
curl -s "$BASE/api/inference/candidates?workspaceId=$WS&status=PENDING" | jq '.[0:5]'
```

**기대 결과:** `spring.datasource.url` → `read`/`write` 후보, `spring.kafka.*` → `produce`/`consume` 후보 생성

---

## 1-2: Regex 기반 Code Signal 추출

**구현 파일:** `packages/inference/src/code/codeSignalExtractor.ts`, `src/code/scanners/`
**동작:** Java/Kotlin/TypeScript/Python 파일에서 @GetMapping, kafkaTemplate.send, RestTemplate 등 패턴 추출

```bash
# 실제 소스 디렉토리에서 코드 신호 추출 (CLI 필요)
pnpm --filter @archi-navi/cli exec ts-node bin/anavi.ts scan \
  --workspace "$WS" \
  --path /path/to/your/project \
  --lang java
```

**유닛 테스트로 검증 (소스 없이):**

```bash
pnpm --filter @archi-navi/inference test:unit -- \
  --reporter=verbose \
  --testPathPattern="codeSignalExtractor|javaKotlin|typeScript|python"
```

**기대 결과:** `code_artifacts`, `code_call_edges`, `evidences` 테이블에 신호 저장 (52개+ 테스트 통과)

---

## 1-3: DB 시그널 추출 (dbScore)

**구현 파일:** `packages/inference/src/db/dbSchemaSignal.ts`
**동작:** code_call_edges의 DB 접근 신호(db_read/write/mapping)에서 테이블 prefix → 도메인 매칭 점수 계산

### 추론 실행

```bash
pnpm --filter @archi-navi/cli exec ts-node bin/anavi.ts infer \
  --workspace "$WS" \
  --track a
```

### 결과 확인

```bash
# domain_candidates 전체 조회
curl -s "$BASE/api/inference/domain-candidates?workspaceId=$WS&status=PENDING" \
  | jq '[.[] | {service: .objectId, purity: .purity, db: .signals.db}]'
```

**기대 결과:** `signals.db`에 테이블 prefix 매칭 점수 포함
- `order-service` → order 도메인 점수 높음 (order_* 테이블 접근)
- `product-service` → product 도메인 점수 높음

---

## 1-4: Domain Candidates 승인 API + UI

**구현 파일:** `packages/inference/src/domain/approveDomainCandidate.ts`
**API:** `GET/PATCH /api/inference/domain-candidates`

### UI로 확인

1. 브라우저에서 `http://localhost:3000/architecture` 접속
2. 좌측 메뉴 **승인 대기** 클릭
3. **Domains 탭** 선택
4. 후보 목록에서 affinity 분포 확인 후 승인/거부

### API로 확인

```bash
# 후보 목록 조회
curl -s "$BASE/api/inference/domain-candidates?workspaceId=$WS&status=PENDING" | jq '.'

# 첫 번째 후보 ID 추출
FIRST_ID=$(curl -s "$BASE/api/inference/domain-candidates?workspaceId=$WS&status=PENDING" \
  | jq -r '.[0].id')

# 승인
curl -s -X PATCH "$BASE/api/inference/domain-candidates/$FIRST_ID" \
  -H "Content-Type: application/json" \
  -d '{"status":"APPROVED"}' | jq

# 거부
curl -s -X PATCH "$BASE/api/inference/domain-candidates/$FIRST_ID" \
  -H "Content-Type: application/json" \
  -d '{"status":"REJECTED"}' | jq
```

**기대 결과:** APPROVED 시 `object_domain_affinities` 테이블에 분포 저장

---

## 1-5: Discovery 다중 레이어 통합

**구현 파일:** `packages/inference/src/domain/discovery.ts`
**동작:** 서비스 간 call/db/msg 관계를 가중 그래프로 구성 → Louvain 커뮤니티 탐지

```bash
pnpm --filter @archi-navi/cli exec ts-node bin/anavi.ts infer \
  --workspace "$WS" \
  --track b \
  --min-cluster-size 2 \
  --resolution 0.8
```

**결과 확인:**

```bash
# Discovery run 기록 확인
curl -s "$BASE/api/inference/domain-candidates?workspaceId=$WS" \
  | jq '[.[] | select(.signals != null) | {id, purity, primary: .primaryDomainId}]'

# 생성된 discovered 도메인 오브젝트 확인
curl -s "$BASE/api/objects?workspaceId=$WS&objectType=domain" \
  | jq '[.[] | select(.name | startswith("discovered:"))]'
```

**기대 결과:** 서비스들이 `order-service + order-db + order.events` 그룹 등으로 클러스터링됨

---

## 1-6: 클러스터 Label 자동 추출

**구현 파일:** `packages/inference/src/domain/labelExtractor.ts`
**동작:** 클러스터 멤버 이름 토큰 빈도 분석 → 상위 3개 라벨 후보 생성

1-5 실행 후 자동으로 동작합니다.

```bash
# discovered 도메인의 labelCandidates 확인
curl -s "$BASE/api/objects?workspaceId=$WS&objectType=domain" \
  | jq '[.[] | select(.name | startswith("discovered:")) | {
      name,
      labels: .metadata.labelCandidates
    }]'
```

**기대 결과:**
```json
[{
  "name": "discovered:cluster-0",
  "labels": [
    { "text": "order", "score": 0.82 },
    { "text": "service", "score": 0.61 }
  ]
}]
```

---

## 2-1: AST Plugin (Tree-sitter)

**구현 파일:** `packages/inference/src/code/ast/`
**상태:** 구현 완료, tree-sitter native 빌드 필요

```bash
# tree-sitter 빌드 (최초 1회)
cd packages/inference && pnpm rebuild

# AST 기반 스캔 실행 (Regex보다 정밀)
pnpm --filter @archi-navi/cli exec ts-node bin/anavi.ts scan \
  --workspace "$WS" \
  --path /path/to/your/project
```

---

## 2-2 + 2-3: Evidence Assembler + Answer Composer

**구현 파일:** `packages/core/src/ai/evidence-assembler.ts`, `answer-composer.ts`
**동작:** 쿼리 결과 → 증거 체인 구조화 → 결론/신뢰도/증거목록 포맷

### UI로 확인

1. `http://localhost:3000/architecture` 접속
2. 우하단 채팅 버튼(💬) 클릭
3. 아래 질문 입력:

```
order-service가 의존하는 서비스는?
payment-service 수정 시 영향받는 서비스는?
user-service에서 DB까지 경로는?
```

**기대 결과:** 결론 → 신뢰도 → 증거 목록(파일경로 + 발췌) → 요약 형식의 구조화된 답변

### API로 직접 테스트

```bash
curl -s -X POST "$BASE/api/chat" \
  -H "Content-Type: application/json" \
  -H "x-ai-provider: anthropic" \
  -H "x-ai-api-key: sk-ant-..." \
  -d "{
    \"workspaceId\": \"$WS\",
    \"messages\": [
      {
        \"role\": \"user\",
        \"parts\": [{\"type\": \"text\", \"text\": \"order-service 의존 서비스는?\"}]
      }
    ]
  }"
```

---

## 2-4: DOMAIN_SUMMARY 쿼리

**구현 파일:** `packages/core/src/query-engine/executor.ts`
**동작:** 도메인별 서비스 수, 관계 밀도, purity 통계 집계

```bash
curl -s -X POST "$BASE/api/query" \
  -H "Content-Type: application/json" \
  -d "{
    \"workspaceId\": \"$WS\",
    \"queryType\": \"DOMAIN_SUMMARY\",
    \"scope\": {
      \"level\": \"DOMAIN_TO_DOMAIN\",
      \"visibility\": \"VISIBLE_ONLY\"
    },
    \"params\": {}
  }" | jq
```

**기대 결과:**
```json
{
  "queryType": "DOMAIN_SUMMARY",
  "result": {
    "summary": {
      "order": {
        "serviceCount": 2,
        "relationDensity": 0.65,
        "avgPurity": 0.72
      }
    }
  }
}
```

---

## 2-5: Message 시그널 추출 (msgScore)

**구현 파일:** `packages/inference/src/domain/msgSignal.ts`
**동작:** 토픽 네이밍 패턴 분석 + producer/consumer 결합도 → 도메인 affinity 기여

seed 데이터에 Kafka 토픽과 produce/consume 관계가 포함되어 있으므로 바로 확인 가능합니다.

### 추론 실행 후 확인

```bash
# Track A 실행
pnpm --filter @archi-navi/cli exec ts-node bin/anavi.ts infer \
  --workspace "$WS" --track a

# msg 신호 확인
curl -s "$BASE/api/inference/domain-candidates?workspaceId=$WS&status=PENDING" \
  | jq '[.[] | {objectId, msgSignal: .signals.msg}] | map(select(.msgSignal != null))'
```

**기대 결과:**

| 서비스 | msgScore 기여 도메인 | 계산 근거 |
|--------|---------------------|----------|
| `order-service` | order: 2.5 | order.events produce×2 + 양방향 coupling +0.5 |
| `payment-service` | payment: 2.0 | payment.events produce×2 |
| `notification-service` | order: 1.0, payment: 1.0 | 각 토픽 consume×1 |

---

## 전체 워크플로우 한눈에

```
[1] POST /api/dev/reset          → DB 초기화
[2] POST /api/dev/seed           → 샘플 데이터 주입 (52 objects, 51 relations)
[3] POST /api/objects ×4         → 도메인 seed 등록 (order/payment/user/product)
[4] CLI: infer --track a         → 1-1 Config + 1-3 DB + 2-5 Msg 추론 한번에 실행
[5] CLI: infer --track b         → 1-5 Discovery + 1-6 Label 추출
[6] UI: 승인 대기 → Domains 탭  → 1-4 승인/거부 워크플로우
[7] UI: 채팅 질문               → 2-2 Evidence + 2-3 Answer Composer 확인
[8] POST /api/query DOMAIN_SUMMARY → 2-4 집계 쿼리 확인
```

---

## 유닛 테스트로 개별 검증

코드 변경 없이 각 기능 로직을 독립적으로 검증하고 싶다면:

```bash
# 전체 테스트 (171개)
pnpm --filter @archi-navi/inference test:unit

# 기능별 테스트만 실행
pnpm --filter @archi-navi/inference test:unit -- \
  --testPathPattern="dbSchemaSignal"     # 1-3

pnpm --filter @archi-navi/inference test:unit -- \
  --testPathPattern="approveDomainCandidate"  # 1-4

pnpm --filter @archi-navi/inference test:unit -- \
  --testPathPattern="discovery"           # 1-5, 1-6

pnpm --filter @archi-navi/inference test:unit -- \
  --testPathPattern="msgSignal"           # 2-5
```

---

## 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| AI 채팅 에러: `Invalid prompt: messages do not match ModelMessage[] schema` | ~~UIMessage → ModelMessage 변환 누락~~ | 수정 완료 (`convertToModelMessages` 적용) |
| `infer` CLI 명령 없음 | CLI 빌드 안 됨 | `pnpm --filter @archi-navi/cli build` |
| domain-candidates 빈 배열 | 도메인 seed 미등록 | ③번 도메인 seed 등록 단계 실행 |
| Discovery 클러스터 0개 | 관계 데이터 부족 | seed 데이터 주입 후 재실행 |
| tree-sitter 빌드 에러 | native addon 미빌드 | `cd packages/inference && pnpm rebuild` |
