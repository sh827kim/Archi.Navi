# 개발 체크리스트: 1-2 Regex 기반 Code Signal 추출 (Phase 1)

> 로드맵 참조: `docs/08-roadmap.md` §P1 1-2
> 설계 참조: `docs/03-inference-engine.md` §6.1 Phase 1 Regex 기반 패턴 매칭
> 브랜치: `feature/inference-engine`
> 작성일: 2026-02-22

---

## 목표

소스코드 파일(Java/Kotlin, TypeScript/JS, Python, MyBatis XML)에서 정규식 기반 패턴 매칭으로
구조 신호(Signal)를 추출하여 `code_artifacts` + `code_call_edges` + `evidences` 테이블에 저장한다.

**기대 효과:** 서비스↔서비스 call, expose, produce/consume 관계 자동 발견 (30~40%)

---

## 구현 범위

### 지원 언어 및 파일

| 파일 확장자 | 언어 | 스캐너 |
|------------|------|--------|
| `.java`, `.kt` | Java/Kotlin | `scanners/javaKotlin.ts` |
| `.xml` (MyBatis mapper) | Java (MyBatis XML) | `scanners/javaKotlin.ts` (내장) |
| `.ts`, `.tsx`, `.js`, `.jsx` | TypeScript/JavaScript | `scanners/typeScript.ts` |
| `.py` | Python | `scanners/python.ts` |

### 추출 대상 신호 및 Confidence (설계 §2.3.1)

| 언어 | 패턴 | 신호 종류 | Confidence |
|------|------|-----------|------------|
| Java/Kotlin | `@(Get\|Post\|Put\|Delete\|Patch)Mapping("path")` | `expose` | 0.8 |
| Java/Kotlin | `@RequestMapping("path")` | `expose` | 0.8 |
| Java/Kotlin | `restTemplate.\w+("url")` | `call` | 0.7 |
| Java/Kotlin | `webClient.\w+().uri("url")` | `call` | 0.7 |
| Java/Kotlin | `@FeignClient(name = "service")` | `call` | 0.7 |
| Java/Kotlin | `kafkaTemplate.send("topic", ...)` | `produce` | 0.7 |
| Java/Kotlin | `@KafkaListener(topics = "topic")` | `consume` | 0.8 |
| Java/Kotlin | `@Table(name = "table")` | `db_mapping` | 0.7 |
| MyBatis XML | `<select>` SQL → FROM table | `db_read` | 0.8 |
| MyBatis XML | `<insert\|update\|delete>` SQL → table | `db_write` | 0.8 |
| TypeScript/JS | `(app\|router).(get\|post\|...)(path)` | `expose` | 0.8 |
| TypeScript/JS | `fetch("url")` | `call` | 0.7 |
| TypeScript/JS | `axios.\w+("url")` | `call` | 0.7 |
| TypeScript/JS | `.(get\|post\|...)("url")` | `call` | 0.6 (http-chain) |
| Python | `@(app\|router).(get\|post\|...)("path")` | `expose` | 0.8 |
| Python | `requests.\w+("url")` | `call` | 0.7 |
| Python | `KafkaProducer.send("topic")` | `produce` | 0.7 |
| Python | `@kafka_consumer(topic="topic")` | `consume` | 0.8 |

### 저장 위치

| 테이블 | 내용 |
|--------|------|
| `code_artifacts` | 파일 메타 (언어, 경로, SHA256, ownerObjectId) |
| `code_call_edges` | 추출된 신호 (calleeSymbol = URL/path/topic/table, evidenceId) |
| `evidences` | 근거 원본 (evidenceType='FILE', filePath, lineStart, lineEnd, excerpt, metadata.kind) |

### 증분 스캔 (SHA256 기반)

- 파일 SHA256 해시 비교 → 변경된 파일만 재처리
- 미변경 파일: `code_artifacts` sha256 동일 → 스킵
- 변경된 파일: 기존 `code_call_edges` 삭제 → 재추출 → 재삽입

---

## 구현 파일 목록

```
packages/inference/src/code/
  ├── index.ts                          [신규] 공개 API export
  ├── codeSignalExtractor.ts            [신규] 메인 추출기 (파일 탐색 + DB 저장)
  └── scanners/
      ├── javaKotlin.ts                 [신규] Java/Kotlin + MyBatis XML 스캐너
      ├── typeScript.ts                 [신규] TypeScript/JS 스캐너
      └── python.ts                     [신규] Python 스캐너

packages/inference/src/__tests__/code/
  ├── scanners/
  │   ├── javaKotlin.test.ts            [신규] 단위 테스트 (15개)
  │   ├── typeScript.test.ts            [신규] 단위 테스트 (10개)
  │   └── python.test.ts                [신규] 단위 테스트 (9개)
  └── codeSignalExtractor.test.ts       [신규] 통합 테스트 (8개)

packages/inference/src/index.ts         [수정] code 모듈 export 추가
```

---

## 체크리스트

### Phase 1: 의존성 확인

- [x] **crypto 모듈** — Node.js 내장, 별도 설치 불필요
  - SHA256 계산: `import { createHash } from 'crypto'`
- [x] **기존 패키지 활용 확인**
  - `@archi-navi/db`: `codeArtifacts`, `codeCallEdges`, `evidences` import 가능 확인
  - `@archi-navi/shared`: `generateId`, `buildUrn` 활용

### Phase 2: 공유 타입 및 스캐너 모듈 구현

- [x] **공유 타입 정의** (`codeSignalExtractor.ts` 상단)
  - `SignalKind`: `'expose' | 'call' | 'produce' | 'consume' | 'db_read' | 'db_write' | 'db_mapping'`
  - `ExtractedSignal`: `{ kind, symbol, lineStart, lineEnd, excerpt, confidence, metadata }`
  - `FileScanResult`: `{ language, sha256, packageName?, signals }`

- [x] **`scanners/javaKotlin.ts` 구현**
  - [x] `scanJavaKotlin(filePath, content)` — `.java`, `.kt` 파일 스캔
    - [x] 라인별 순회로 단일 라인 패턴 매칭
    - [x] `@(Get|Post|Put|Delete|Patch)Mapping("path")` → `expose` (confidence: 0.8)
    - [x] `@RequestMapping("path")` → `expose` (confidence: 0.8)
    - [x] `restTemplate.\w+("url")` → `call` (confidence: 0.7)
    - [x] `webClient.\w+().uri("url")` → `call` (confidence: 0.7)
    - [x] `@FeignClient(name = "service")` → `call` (confidence: 0.7)
    - [x] `kafkaTemplate.send("topic", ...)` → `produce` (confidence: 0.7)
    - [x] `@KafkaListener(topics = "topic")` → `consume` (confidence: 0.8)
    - [x] `@Table(name = "table")` → `db_mapping` (confidence: 0.7)
    - [x] SHA256 계산 포함
    - [x] Java `package` 선언에서 `packageName` 추출
  - [x] `scanMyBatisXml(filePath, content)` — `.xml` MyBatis mapper 파일 스캔
    - [x] `<mapper namespace="...">` → packageName
    - [x] `<select ...>` 블록 내 `FROM table`, `JOIN table` → `db_read` (confidence: 0.8)
    - [x] `<insert ...>` 블록 내 `INSERT INTO table` → `db_write` (confidence: 0.8)
    - [x] `<update ...>` 블록 내 `UPDATE table` → `db_write` (confidence: 0.8)
    - [x] `<delete ...>` 블록 내 `DELETE FROM table` → `db_write` (confidence: 0.8)
    - [x] 잘못된 XML → 빈 결과 반환 (예외 던지지 않음)

- [x] **`scanners/typeScript.ts` 구현**
  - [x] `scanTypeScript(filePath, content)` — `.ts`, `.tsx`, `.js`, `.jsx` 파일 스캔
    - [x] `(app|router).(get|post|put|delete|patch)("path", ...)` → `expose` (confidence: 0.8)
    - [x] `fetch("url")` → `call` (confidence: 0.7)
    - [x] `axios.\w+("url")` → `call` (confidence: 0.7)
    - [x] `.(get|post|...)("url")` → `call` (confidence: 0.6, http-chain, expose와 중복 방지)
    - [x] SHA256 계산 포함

- [x] **`scanners/python.ts` 구현**
  - [x] `scanPython(filePath, content)` — `.py` 파일 스캔
    - [x] `@(app|router).(get|post|put|delete|patch)("path")` → `expose` (confidence: 0.8)
    - [x] `requests.\w+("url")` → `call` (confidence: 0.7)
    - [x] `KafkaProducer.*\.send("topic")` → `produce` (confidence: 0.7)
    - [x] `@kafka_consumer(topic="topic")` → `consume` (confidence: 0.8)
    - [x] SHA256 계산 포함

### Phase 3: codeSignalExtractor.ts 메인 추출기 구현

- [x] **인터페이스 정의**
  - [x] `CodeSignalOptions`: `{ workspaceId, repoRoot }`
  - [x] `CodeSignalResult`: `{ fileCount, artifactCount, signalCount, skippedCount }`

- [x] **파일 탐색 로직**
  - [x] Java/Kotlin: `.java`, `.kt` 확장자 재귀 탐색
  - [x] MyBatis XML: `.xml` 확장자 탐색 → 내용에 `<mapper` 포함 여부 필터링
  - [x] TypeScript/JS: `.ts`, `.tsx`, `.js`, `.jsx` 확장자 탐색
  - [x] Python: `.py` 확장자 탐색
  - [x] 공통 제외 디렉토리: `node_modules`, `.git`, `dist`, `build`, `.next`, `target`, `__pycache__`, `.gradle`, `out`, `coverage`

- [x] **ownerObjectId 추론 (서비스 매칭 휴리스틱)**
  - [x] 파일 경로의 디렉토리 세그먼트에서 서비스 이름 매칭 시도
  - [x] 정확 매칭 → 정규화 매칭 (하이픈/언더스코어 제거) 순서로 시도
  - [x] 매칭 실패 시 `null` (Phase 2에서 개선)

- [x] **SHA256 기반 증분 스캔**
  - [x] 기존 `code_artifact` 조회 (workspaceId + filePath)
  - [x] sha256 동일 → `skippedCount++`, 스킵
  - [x] sha256 다름 → 기존 `code_call_edges` 삭제 후 재추출
  - [x] 신규 파일 → 새로 생성

- [x] **code_artifacts 저장**
  - [x] 신규: insert (id, workspaceId, language, filePath, sha256, packageName, ownerObjectId, repoRoot)
  - [x] 기존 sha256 변경: update (sha256, updatedAt)

- [x] **code_call_edges + evidences 저장**
  - [x] 각 신호마다 `evidences` insert (evidenceType='FILE', filePath, lineStart, lineEnd, excerpt, metadata: { kind, confidence, language, ...패턴별 메타})
  - [x] 각 신호마다 `code_call_edges` insert (callerArtifactId, calleeSymbol, weight=1, evidenceId)

- [x] **결과 반환**
  - [x] `{ fileCount, artifactCount, signalCount, skippedCount }` 반환

### Phase 4: 단위 테스트

- [x] **`scanners/javaKotlin.test.ts`** (15개, 계획 12개 대비 +3)
  - [x] `@GetMapping` → expose 신호 추출 (path, confidence, lineStart 확인)
  - [x] `@PostMapping`, `@PutMapping`, `@DeleteMapping`, `@PatchMapping` → expose 추출
  - [x] `@RequestMapping` → expose 추출
  - [x] `restTemplate.getForObject("...")` → call 추출
  - [x] `webClient.get().uri("...")` → call 추출
  - [x] `@FeignClient(name = "service-name")` → call 추출
  - [x] `kafkaTemplate.send("topic", ...)` → produce 추출
  - [x] `@KafkaListener(topics = "topic")` → consume 추출
  - [x] `@Table(name = "table_name")` → db_mapping 추출
  - [x] 여러 신호가 있는 파일 → 모두 추출
  - [x] 빈 파일 → 빈 signals 배열
  - [x] Kotlin 언어 감지 (.kt 확장자)
  - [x] MyBatis XML SELECT → db_read 추출
  - [x] MyBatis XML INSERT → db_write 추출
  - [x] MyBatis XML SELECT + JOIN → 복수 테이블 db_read

- [x] **`scanners/typeScript.test.ts`** (10개, 계획 8개 대비 +2)
  - [x] `app.get("/api/orders", handler)` → expose 추출
  - [x] `router.post("/api/payment", handler)` → expose 추출
  - [x] `router.put/delete/patch` → expose 추출
  - [x] `fetch("http://service/api")` → call 추출
  - [x] `axios.get("http://service/api")` → call 추출
  - [x] `axios.post("http://service/api")` → call 추출
  - [x] 여러 신호가 있는 파일 (expose + call 혼합)
  - [x] 빈 파일 → 빈 결과
  - [x] `.js` 파일 → language: 'javascript'
  - [x] `.ts` 파일 → language: 'typescript'

- [x] **`scanners/python.test.ts`** (9개, 계획 7개 대비 +2)
  - [x] `requests.get("http://service/api")` → call 추출
  - [x] `requests.post("http://service/api")` → call 추출
  - [x] `@app.route("/api/orders")` → expose 추출
  - [x] `@router.get("/api/payment")` → expose 추출
  - [x] `@app.post/@router.delete` → 복수 expose 추출
  - [x] `producer.send("topic", ...)` → produce 추출 (KafkaProducer 패턴)
  - [x] `@kafka_consumer(topic="order.events")` → consume 추출
  - [x] 빈 파일 → 빈 결과
  - [x] lineStart 정확도 확인

- [x] **`codeSignalExtractor.test.ts`** (통합 테스트, 8개)
  - [x] Java 파일 스캔 → `code_artifacts` + `code_call_edges` + `evidences` 정상 저장
  - [x] TypeScript 파일 스캔 → 저장 확인
  - [x] Python 파일 스캔 → 저장 확인
  - [x] SHA256 미변경 → 파일 스킵 (skippedCount 반영)
  - [x] SHA256 변경 → 기존 `code_call_edges` 삭제 후 재생성
  - [x] `evidences.evidenceType === 'FILE'` 확인
  - [x] 서비스 이름 매칭 → `ownerObjectId` 설정 확인
  - [x] 빈 디렉토리 → 빈 결과 (`fileCount: 0`)

### Phase 5: export 및 컴파일/테스트 실행

- [x] **`code/index.ts` 작성**
  - [x] `extractCodeSignals` export
  - [x] 타입 export (`CodeSignalOptions`, `CodeSignalResult`, `ExtractedSignal`, `FileScanResult`, `SignalKind`)

- [x] **`inference/src/index.ts` 수정**
  - [x] `export * from './code/index'` 추가

- [x] **TypeScript 컴파일 오류 없음**
  - [x] `pnpm --filter @archi-navi/inference lint` 성공 (`tsc --noEmit` 출력 없음 = 오류 없음)

- [x] **단위 테스트 전체 통과**
  - [x] `pnpm --filter @archi-navi/inference test:unit` 전체 GREEN (52개 → 94개)
    - 기존: 52개 (1-1 Config 기반 추론)
    - 신규: 42개 (javaKotlin 15 + typeScript 10 + python 9 + codeSignalExtractor 8)

---

## 설계 결정 사항

### evidences.metadata 구조

```json
{
  "kind": "expose",
  "confidence": 0.8,
  "language": "java",
  "annotation": "@GetMapping"
}
```

### code_call_edges.calleeSymbol 값

| 신호 종류 | calleeSymbol 값 |
|----------|----------------|
| `expose` | API 경로 (예: `/api/orders`) |
| `call` | 호출 URL (예: `http://payment-service/pay`) |
| `produce` | 토픽명 (예: `order.created`) |
| `consume` | 토픽명 (예: `payment.completed`) |
| `db_read` | 테이블명 (예: `order_items`) |
| `db_write` | 테이블명 (예: `order_items`) |
| `db_mapping` | 테이블명 (예: `orders`) |

### MyBatis XML 판별 기준

`.xml` 파일에서 `<mapper namespace=` 패턴이 포함된 파일만 MyBatis mapper로 처리

### SHA256 증분 스캔 로직

```
기존 artifact 없음    → 신규 생성 + 신호 추출
기존 sha256 == 신규   → 스킵 (skippedCount++)
기존 sha256 != 신규   → sha256 업데이트 + 기존 code_call_edges 삭제 + 재추출
```

### 결과 반환 형식

```typescript
{ fileCount: number, artifactCount: number, signalCount: number, skippedCount: number }
// fileCount:    처리한 총 파일 수 (스킵 포함)
// artifactCount: 새로 생성된 code_artifacts 수
// signalCount:  추출된 신호 수 (code_call_edges 기준)
// skippedCount: sha256 미변경으로 스킵된 파일 수
```

### Phase 1 한계 및 Phase 2 예정 사항

- Phase 1은 단일 라인 패턴만 매칭 (멀티라인 어노테이션 미지원)
- 변수/상수로 지정된 URL 추적 불가 (data-flow 미지원)
- 간접 호출 감지 불가 (인터페이스 구현체 매핑)
- Phase 2 (AST, Tree-sitter)에서 위 한계 해결 예정

---

## 관련 문서

- `docs/08-roadmap.md` — P1 1-2 Regex 기반 Code Signal 추출
- `docs/03-inference-engine.md` — §6.1 Phase 1 Regex 기반 패턴 매칭
- `packages/db/src/schema/code.ts` — `code_artifacts`, `code_call_edges`, `code_import_edges`
- `packages/db/src/schema/evidence.ts` — `evidences`
