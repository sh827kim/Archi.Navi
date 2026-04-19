# Archi.Navi — 기능 검증 가이드 (1-1 ~ 2-5 핵심 기능)

> 작성일: 2026-02-23
> 대상: 로드맵 `docs/03-roadmap.md` 의 P1(1-1~1-6) + P2 핵심 기능(2-1~2-5)
> 전제: `pnpm dev` 로 웹 서버 실행 중 (`http://localhost:3000`)
> 주의: 기본 워크스페이스는 더 이상 자동 생성되지 않음

---

## 사전 준비

### 환경 변수 (.env.local)

```bash
# apps/web/.env.local
AI_PROVIDER=anthropic           # openai | anthropic | google
ANTHROPIC_API_KEY=sk-ant-...    # 또는 UI 설정 화면에서 입력 가능
```

> UI 오른쪽 상단 설정(⚙) 버튼 → API 키 / 제공자 / 모델 직접 입력 가능

### 편의 변수 + 워크스페이스 생성

```bash
BASE="http://localhost:3000"
WS_NAME="verification-$(date +%Y%m%d-%H%M%S)"

# 검증 전용 워크스페이스 생성
WS=$(curl -s -X POST "$BASE/api/workspaces" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$WS_NAME\"}" \
  | jq -r '.id')

echo "workspaceId=$WS"
```

> `WS`가 비어 있거나 `null`이면 서버 로그를 확인한 뒤 `POST /api/workspaces` 호출부터 다시 실행하세요.

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

### ③ 도메인 Seed 등록 (선택 — 검증용)

> 새 도메인 발견 엔진은 seed 도메인이 없어도 동작한다 (`POST /api/domains/discover`).
> 아래 단계는 기존 도메인이 미리 존재할 때의 동작을 확인하고 싶을 때만 실행한다.

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
# 실제 레포 디렉토리를 워크스페이스에 등록
pnpm --filter @archi-navi/cli exec tsx src/index.ts scan \
  --workspace "$WS" \
  --path /path/to/your/spring-boot-project

# config 추론 실행
curl -s -X POST "$BASE/api/inference/run" \
  -H "Content-Type: application/json" \
  -d "{\"workspaceId\":\"$WS\",\"modes\":[\"config\"],\"useServiceMetadataPaths\":true}" | jq

# relation_candidates 확인
curl -s "$BASE/api/inference/candidates?workspaceId=$WS&status=PENDING" | jq '.[0:5]'
```

**기대 결과:** `spring.datasource.url` → `read`/`write` 후보, `spring.kafka.*` → `produce`/`consume` 후보 생성

---

## 1-2: Regex 기반 Code Signal 추출

**구현 파일:** `packages/inference/src/code/codeSignalExtractor.ts`, `src/code/scanners/`
**동작:** Java/Kotlin/TypeScript/Python 파일에서 @GetMapping, kafkaTemplate.send, RestTemplate 등 패턴 추출

```bash
# 실제 소스 디렉토리를 워크스페이스에 등록
pnpm --filter @archi-navi/cli exec tsx src/index.ts scan \
  --workspace "$WS" \
  --path /path/to/your/project

# code 추론 실행
curl -s -X POST "$BASE/api/inference/run" \
  -H "Content-Type: application/json" \
  -d "{\"workspaceId\":\"$WS\",\"modes\":[\"code\"],\"useServiceMetadataPaths\":true,\"codeEngine\":\"hybrid\"}" | jq
```

**유닛 테스트로 검증 (소스 없이):**

```bash
pnpm --filter @archi-navi/inference exec vitest run \
  src/__tests__/code/codeSignalExtractor.test.ts \
  src/__tests__/code/hybridCodeSignalExtractor.test.ts \
  src/__tests__/code/ast/extractAstCodeSignals.test.ts \
  src/__tests__/code/scanners/javaKotlin.test.ts \
  src/__tests__/code/scanners/typeScript.test.ts \
  src/__tests__/code/scanners/python.test.ts
```

**기대 결과:** `code_artifacts`, `code_call_edges`, `evidences` 테이블에 신호 저장 (52개+ 테스트 통과)

---

## 1-3: DB 시그널 추출 (dbScore)

**구현 파일:** `packages/inference/src/db/dbSchemaSignal.ts`
**동작:** code_call_edges 의 DB 접근 신호(db_read/write/mapping) 에서 테이블 prefix
신호를 추출. 새 도메인 엔진(아래 1-4)의 path/route/topic 신호와 함께 활용된다.

```bash
pnpm --filter @archi-navi/inference exec vitest run \
  src/__tests__/db/dbSchemaSignal.test.ts
```

**기대 결과:** 테이블 prefix → 도메인 매칭 점수가 fixture 기준으로 일치한다.

---

## 1-4: 도메인 발견 (Phase 1) — 결정적 클러스터링 + LLM 검토

> 2026-04-19 이후 Track A/B Seed/Louvain 엔진은 모두 폐기되었다.
> 새 흐름은 **결정적 신호 4종 + 관계 응집도** 로 후보를 산출하고,
> **저비용 LLM 호출 1회** 로 일관성/이름을 검수한 뒤 사용자가 즉시 승인하는
> in-memory 후보 패턴이다 (`domain_candidates` 테이블 없음).

**구현 파일:**
- `packages/inference/src/domain/discovery/structuralClustering.ts`
- `packages/inference/src/domain/discovery/relationCohesion.ts`
- `packages/inference/src/domain/discovery/llmReviewer.ts`
- `packages/inference/src/domain/discovery/runDomainDiscovery.ts`

**API:**
- `POST /api/domains/discover` — workspaceId 만 받아 후보 목록 반환 (서버 무상태)
- `POST /api/domains/approve` — 후보 1건을 받아 `objects` 행 + `object_domain_affinities` upsert

**UI:**
1. `/domains` 진입 → 승인된 도메인 카드 그리드 + [도메인 발견] 버튼
2. [도메인 발견] 클릭 → 후보 미리보기 카드 (이름 인라인 편집, coherent 칩, 강한 신호 칩 3개)
3. 카드별 [승인]/[거부] 또는 상단 [coherent 인 후보 전체 승인]

**API로 확인:**

```bash
# 발견
curl -s -X POST "$BASE/api/domains/discover" \
  -H "Content-Type: application/json" \
  -d "{\"workspaceId\":\"$WS\"}" | jq

# 응답 구조: { candidates: [{ id, name, coherent, members, strongSignals, ... }] }

# 승인 (응답에서 받은 candidate 본문을 그대로 전송)
curl -s -X POST "$BASE/api/domains/approve" \
  -H "Content-Type: application/json" \
  -d "{\"workspaceId\":\"$WS\",\"candidate\":{...}}" | jq
```

**기대 결과:** 승인 시 `objects(object_type='domain')` 1행 + 멤버별
`object_domain_affinities(source='APPROVED_INFERENCE')` 행 생성.

---

## 1-5: 도메인 의미 추출 (Phase 2)

**구현 파일:**
- `packages/inference/src/domain/semantic/semanticSignalCollector.ts`
- `packages/inference/src/domain/semantic/scenarioExtractor.ts`
- `packages/inference/src/domain/semantic/semanticComposer.ts`
- `packages/inference/src/llm/semanticPrompt.ts`

**API:**
- `POST /api/domains/[id]/extract-semantic` — Phase 2 실행 + `domain_semantic_profiles` upsert
- `GET  /api/domains/[id]/semantic` — 저장된 프로파일 조회
- `GET  /api/domains/[id]/semantic/export?format=json` — JSON 다운로드

**UI:** `/domains/[id]` 상세 페이지에서 [의미 추출 실행] / [JSON 내보내기].

**검증 단계:**

```bash
# 추출
curl -s -X POST "$BASE/api/domains/$DOMAIN_ID/extract-semantic" \
  -H "Content-Type: application/json" \
  -d "{\"workspaceId\":\"$WS\"}" | jq

# 조회
curl -s "$BASE/api/domains/$DOMAIN_ID/semantic?workspaceId=$WS" | jq
```

**기대 결과:** 응답에 `schemaVersion: '1.0'` + 6개 섹션 (책임 / state / actions /
invariants+events / collaborators / scenarios) 모두 채워지고, 각 항목의
`evidenceIds[]` 가 `evidence[]` 배열을 정확히 가리킨다.

---

## 1-6: CLI 의미 프로파일 export

```bash
pnpm anavi export \
  --workspace "$WS" \
  --domain "$DOMAIN_ID" \
  --format domain-semantic \
  --output ./domain.semantic.json
```

**기대 결과:** Phase 2 산출물이 JSON 파일로 저장. LLM 키 누락 시 명확한 에러 출력.

---

## 2-1: AST Plugin (Tree-sitter)

**구현 파일:** `packages/inference/src/code/ast/`
**상태:** 구현 완료, tree-sitter native 빌드 필요

```bash
# tree-sitter 빌드 (최초 1회)
cd packages/inference && pnpm rebuild

# AST 기반 code 추론 실행 (Regex보다 정밀)
curl -s -X POST "$BASE/api/inference/run" \
  -H "Content-Type: application/json" \
  -d "{\"workspaceId\":\"$WS\",\"modes\":[\"code\"],\"useServiceMetadataPaths\":true,\"codeEngine\":\"ast\"}" | jq
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

## 2-5: Message 시그널 추출 (msgScore — 토픽 prefix 신호)

**구현 파일:** `packages/inference/src/domain/msgSignal.ts`
**동작:** 토픽 네이밍 패턴 + producer/consumer 결합도 → Phase 1 의 `topicPrefixMatch`
신호로 활용된다.

### 유닛 테스트로 확인

```bash
pnpm --filter @archi-navi/inference exec vitest run \
  src/__tests__/domain/msgSignal.test.ts
```

**기대 결과:** seed fixture 기준 `order.*` / `payment.*` 토픽이 후보 그룹에
강한 신호로 잡힌다.

---

## 전체 워크플로우 한눈에

```
[0] POST /api/workspaces                     → 검증용 워크스페이스 생성
[1] POST /api/dev/reset                      → DB 초기화
[2] POST /api/dev/seed                       → 샘플 데이터 주입 (52 objects, 51 relations)
[3] CLI: scan + 추론 실행                    → 1-1 Config + 1-2 Code + 1-3 DB 신호 추출
[4] UI: /domains → [도메인 발견]             → 1-4 Phase 1 후보 미리보기
[5] UI: 후보 카드 [승인]                     → POST /api/domains/approve 로 도메인 확정
[6] UI: /domains/[id] → [의미 추출 실행]     → 1-5 Phase 2 의미 프로파일 생성
[7] CLI: anavi export --format domain-semantic → 1-6 JSON 내보내기
[8] UI: 채팅 질문                            → 2-2 Evidence + 2-3 Answer Composer 확인
[9] POST /api/query DOMAIN_SUMMARY           → 2-4 집계 쿼리 확인
```

---

## 유닛 테스트로 개별 검증

코드 변경 없이 각 기능 로직을 독립적으로 검증하고 싶다면:

```bash
# 전체 테스트 (171개)
pnpm --filter @archi-navi/inference test:unit

# 기능별 테스트만 실행
pnpm --filter @archi-navi/inference exec vitest run \
  src/__tests__/db/dbSchemaSignal.test.ts                 # 1-3

pnpm --filter @archi-navi/inference exec vitest run \
  src/__tests__/domain/discovery                          # 1-4 Phase 1 (전 모듈)

pnpm --filter @archi-navi/inference exec vitest run \
  src/__tests__/domain/semantic                           # 1-5 Phase 2 (전 모듈)

pnpm --filter @archi-navi/inference exec vitest run \
  src/__tests__/domain/msgSignal.test.ts                  # 2-5
```

---

## 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| AI 채팅 에러: `Invalid prompt: messages do not match ModelMessage[] schema` | ~~UIMessage → ModelMessage 변환 누락~~ | 수정 완료 (`convertToModelMessages` 적용) |
| `infer` CLI 명령 없음 | CLI 빌드 안 됨 | `pnpm --filter @archi-navi/cli build` |
| `/api/domains/discover` 빈 후보 | 관계 데이터 부족 | seed 데이터 주입 + 코드 스캔 후 재실행 |
| Phase 2 의미 추출 5xx | LLM 키 누락 / quota 초과 | `OPENAI_API_KEY` 등 환경변수 확인 |
| tree-sitter 빌드 에러 | native addon 미빌드 | `cd packages/inference && pnpm rebuild` |
