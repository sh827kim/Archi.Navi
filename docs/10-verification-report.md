# 10. 종합 검증 보고서 (Phase 1-1 ~ 2-5)

> 작성일: 2026-02-24
> 대상: Archi.Navi v2.0 (P1) ~ v2.1 (P2) 구현 전체
> 검증 방법: 코드 리뷰 + 빌드 + 테스트 실행

---

## 1. 빌드 / 테스트 결과 요약

| 항목 | 결과 | 비고 |
|------|------|------|
| inference 단위 테스트 | **231/231 통과** | 20개 테스트 스위트 전체 통과 |
| core 단위 테스트 | **47/47 통과** | evidence-assembler, answer-composer, domainSummary |
| CLI 빌드 (tsc) | **통과** | tree-sitter 네이티브 설치 후 통과 |
| Web 빌드 (Next.js Turbopack) | **실패** | LLM 모듈 `.js` 확장자 resolve 오류 |

### 빌드 실패 상세

**Web 빌드 — LLM 모듈 import 오류**

```
Module not found: Can't resolve './batchProcessor.js'
Module not found: Can't resolve './candidateFilter.js'
Module not found: Can't resolve './prompts.js'
Module not found: Can't resolve './types.js'
```

- 원인: `packages/inference/src/llm/index.ts`에서 프로젝트 내 유일하게 `.js` 확장자로 임포트
- 영향: `llm-filter` API route와 `domain-candidates/[id]` API route 빌드 불가
- 수정: `.js` 확장자를 제거하여 다른 모듈과 동일한 패턴으로 통일 필요

---

## 2. CRITICAL 이슈 (5건)

### [BUILD-C1] tree-sitter 네이티브 패키지 미설치 → WASM 전환 필요

- **파일**: `packages/inference/package.json`
- **증상**: `tree-sitter` 네이티브 바이너리가 `pnpm install`에서 누락되어 AST 관련 4개 테스트 스위트 + CLI 빌드 실패
- **근본 원인**: `tree-sitter` 0.22.4는 네이티브(C++) 바인딩으로, `node-gyp-build`를 통한 컴파일이 필요함. CI/CD 환경이나 일부 플랫폼에서 빌드 도구 누락 시 무조건 실패함
- **결정 사항**: **WASM 기반으로 전환** (아래 §5 참조)

### [BUILD-C2] LLM 모듈 `.js` 확장자로 Web 빌드 실패

- **파일**: `packages/inference/src/llm/index.ts` 및 하위 모듈 전체
- **증상**: Next.js Turbopack이 `.js` 확장자를 `.ts` 파일로 resolve하지 못함
- **수정**: 모든 `from './xxx.js'`를 `from './xxx'`로 변경 (5개 파일)

### [1-5-C1] Discovery run이 시작부터 `status: 'DONE'`으로 저장

- **파일**: `packages/inference/src/domain/discovery.ts:120-135`
- **증상**: `domainDiscoveryRuns` INSERT 시 `status: 'DONE'`을 시작 시점에 기록. 도중 예외 발생 시 실패한 run이 DONE으로 남음
- **부가 문제**: 빈 그래프 조기 반환(라인 228-231) 시 `finishedAt`이 null인 채로 DONE 상태
- **수정**: `status: 'RUNNING'`으로 시작 → 정상 완료 시 `DONE`, 예외 시 `FAILED`로 업데이트

### [2-1-C1] Kotlin 파일을 Java parser로 파싱

- **파일**: `packages/inference/src/code/ast/astJavaKotlin.ts:450,452`
- **증상**: `.kt` 파일도 `tree-sitter-java` grammar으로 파싱. Kotlin AST 구조가 완전히 달라 대부분의 패턴 감지 실패
- **영향**: Kotlin 코드베이스에서 AST 기반 추론이 사실상 동작하지 않음
- **수정**: WASM 전환 시 `tree-sitter-kotlin` WASM grammar 추가, 또는 Kotlin은 Phase 1(Regex) 폴백 처리

### [INT-C1] DOMAIN_SUMMARY에서 불필요한 graph 빌드

- **파일**: `packages/core/src/query-engine/executor.ts:27-32,51`
- **증상**: 모든 쿼리 타입에 대해 `getOrBuildGraph()` 호출 → DOMAIN_SUMMARY는 graph를 사용하지 않음
- **영향**: 불필요한 성능 비용 + graph 빌드 실패 시 DOMAIN_SUMMARY까지 장애 확산
- **수정**: DOMAIN_SUMMARY 분기 전에 graph 빌드를 조건부로 실행

---

## 3. WARNING 이슈 (28건)

### Phase 1-1: Config-based Relation Inference

| ID | 파일 | 설명 |
|----|------|------|
| W-1.1 | `scanners/javaKotlin.ts:31-36` | `@RequestMapping`이 `value="/path"`, `path="/path"` 속성 형태를 놓침 |
| W-1.2 | `scanners/javaKotlin.ts:21-29` | `@GetMapping` 등도 `value=`, `path=`, 다중 경로 미지원 |
| W-1.3 | `configBased.ts:713-740` | K8s `KAFKA_BROKERS`에서 `produce`만 생성, `consume` 누락 |
| W-1.4 | `parsers/applicationYml.ts:53-78` | JDBC URL에서 DB명이 빈 문자열이 되면 의미 없는 URN 생성 |
| W-1.5 | `configBased.ts:89-97` | 프로필별 yaml에서 동일 datasource의 중복 candidate 생성 |

### Phase 1-2: Regex Code Signal Extraction

| ID | 파일 | 설명 |
|----|------|------|
| W-2.1 | `scanners/javaKotlin.ts:83-88` | `@KafkaListener(topics = {"t1", "t2"})` 다중 토픽 중 첫 번째만 캡처 |
| W-2.2 | `scanners/typeScript.ts:43-49` | `.get("url")` 패턴이 `map.get()`, `cache.delete()` 등에 false positive |
| W-2.3 | `scanners/javaKotlin.ts:113-138` | 한 줄에 첫 매칭만 캡처, 이후 패턴 무시 |
| W-2.4 | `scanners/javaKotlin.ts:208-263` | MyBatis XML 미종료 태그 시 `sqlBuffer` 무한 누적 |

### Phase 1-3: DB Signal Extraction

| ID | 파일 | 설명 |
|----|------|------|
| W-3.1 | `dbSchemaSignal.ts:329-336` | `dbScore` 정규화 없이 raw count 반환 → 다른 score와 스케일 불일치 |
| W-3.2 | `dbSchemaSignal.ts:82-87` | `matchDomainByPrefix` 양방향 partial match에서 짧은 prefix 오탐 |

### Phase 1-4: Domain Approval API + UI

| ID | 파일 | 설명 |
|----|------|------|
| W-4.1 | `approveDomainCandidate.ts:42-86` | 트랜잭션 미사용 → status 업데이트와 affinity insert 간 부분 실패 가능 |
| W-4.2 | `domain-approval-list.tsx:63-68` | PATCH fetch 응답의 `res.ok` 미검증 → 실패해도 성공 UI 표시 |
| W-4.3 | `domain-candidates/route.ts:25` | GET API status 파라미터 검증 없이 unsafe 캐스팅 |
| W-4.4 | `approveDomainCandidate.ts:39,83` | JS `new Date()`와 SQL `now()` 혼재 사용 |

### Phase 1-5: Discovery Multi-layer

| ID | 파일 | 설명 |
|----|------|------|
| W-5.1 | `discovery.ts:265-297` | 도메인/멤버십 생성에 트랜잭션 미사용 → 부분 실패 시 불일치 |
| W-5.2 | `discovery.ts:258-263` | 클러스터별 멤버 이름 조회 N+1 쿼리 |
| W-5.3 | `discovery.ts:228-231` | 빈 그래프 조기 반환 시 `finishedAt` 미설정 |

### Phase 1-6: Cluster Label Auto-extraction

| ID | 파일 | 설명 |
|----|------|------|
| W-6.1 | `labelExtractor.ts:40-44` | 순수 숫자 토큰(`"12"`) 미필터링 |

### Phase 2-1: AST Plugin (Tree-sitter)

| ID | 파일 | 설명 |
|----|------|------|
| W-7.1 | `astJavaKotlin.ts:177` | `ann.text.split('\n')[0]`이 빈 문자열일 때 `??`가 통과 (`||` 필요) |
| W-7.2 | `astScanner.ts:16-23` | `findNodes` 재귀 + spread → 대형 파일에서 스택 오버플로우 가능 |
| W-7.3 | `astScanner.ts:49-70` | Python triple-quote 문자열 처리 오류 (앞뒤 1문자만 제거) |
| W-7.4 | `astJavaKotlin.ts:343,364` | WebClient 체인 감지에서 `objectNode.text.split('.')[0]` 부정확 |

### Phase 2-3: Answer Composer / Chat

| ID | 파일 | 설명 |
|----|------|------|
| W-8.1 | `floating-chat.tsx:80-98` | DOMAIN_SUMMARY 응답이 `parseAnswerText`에서 인식 불가 → AnswerCard 미렌더링 |
| W-8.2 | `api/chat/route.ts:41,50` | `process.env` 동적 덮어쓰기 → 동시 요청 시 API 키 race condition |
| W-8.3 | `api/chat/route.ts:273-278` | DOMAIN_SUMMARY 쿼리에 특정 `domainId` 미전달 → 항상 전체 목록만 반환 |

### Phase 2-4: DOMAIN_SUMMARY Query

| ID | 파일 | 설명 |
|----|------|------|
| W-9.1 | `domainSummary.ts:268,279` | `objectType`, `relationType` unsafe `as` 캐스팅 |
| W-9.2 | `domainSummary.ts:286` / `domain-summary-formatter.ts:43,47` | `as unknown as` 이중 캐스팅으로 타입 안전성 우회 |

### Phase 2-5: Message Signal Extraction

| ID | 파일 | 설명 |
|----|------|------|
| W-10.1 | `dbSchemaSignal.ts:179` | `fk_reference`가 `RELATION_TYPES`에 없는 타입으로 저장 |

---

## 4. INFO 이슈 (주요 항목)

| ID | 파일 | 설명 |
|----|------|------|
| I-1 | `dbSchemaSignal.ts:101-102` | 복수형 추정이 단순 `s` 추가만 지원 (`categories` 등 불규칙 미처리) |
| I-2 | `dbSchemaSignal.ts:176-187` | FK/implicit FK 개별 INSERT의 N+1 쿼리 패턴 |
| I-3 | `domain-approval-list.tsx:157` | UUID domainId 직접 표시 (도메인 이름 매핑 미제공) |
| I-4 | `evidence-assembler.ts:320-321` | confidence가 절대값/퍼센트로 두 번 표시 (LLM 토큰 낭비) |
| I-5 | `domainSummary.ts:221-222` | 관계 밀도 공식에서 self-loop 미배제 |
| I-6 | `api/chat/route.ts:219-278` | 쿼리 타입 자동 감지 키워드 겹침 시 순서 의존적 |
| I-7 | `labelExtractor.ts:36-37` | 2글자 불용어(`to`, `is` 등) STOP_WORDS 미포함 |
| I-8 | `astScanner.ts:28` | `findNodesByTypes` 함수 export되었으나 사용처 없음 (dead code) |

---

## 5. AST 기술셋 전환: tree-sitter 네이티브 → WASM

### 배경

현재 Phase 2-1 AST 플러그인은 `tree-sitter` 네이티브(C++) 바인딩을 사용하고 있으나, 프로젝트 초기 기술 결정에서 **WASM 기반**으로 합의한 바 있음. 현재 구현이 네이티브로 되어 있어 기술셋이 틀어진 상태.

### 네이티브 바인딩의 문제점

1. **설치 불안정**: `node-gyp-build` 의존으로 C++ 컴파일러, Python 등 네이티브 빌드 도구 필요. CI/CD나 다양한 OS에서 설치 실패 빈번
2. **Node.js 버전 의존**: 네이티브 바인딩은 Node.js 버전 업그레이드 시 리빌드 필요. 현재 Node.js 24 환경에서도 호환성 이슈 가능
3. **Next.js 번들링 충돌**: Turbopack/Webpack이 `.node` 네이티브 모듈을 처리하지 못해 Web 빌드에서 별도 처리 필요
4. **타입 선언 부재**: `tree-sitter` 0.22.4에 `@types/tree-sitter`가 별도로 없어 AST 파일 전체에서 `Parameter implicitly has 'any' type` 오류 35건 발생

### 전환 대상

| 현재 (네이티브) | 전환 후 (WASM) |
|----------------|---------------|
| `tree-sitter` 0.22.4 | `web-tree-sitter` |
| `tree-sitter-java` | `tree-sitter-java.wasm` |
| `tree-sitter-typescript` | `tree-sitter-typescript.wasm` |
| `tree-sitter-python` | `tree-sitter-python.wasm` |
| (미지원) | `tree-sitter-kotlin.wasm` (Kotlin 지원 추가) |

### 전환 시 변경 범위

1. **패키지 교체**: `packages/inference/package.json`에서 네이티브 패키지 제거, `web-tree-sitter` + WASM grammar 파일 추가
2. **초기화 코드 변경**: 동기 `require()` → 비동기 `Parser.init()` + `Language.load(wasmPath)` 패턴
3. **파서 팩토리 수정**: `getParser()` 함수를 async로 변경, WASM 언어별 파서 인스턴스 관리
4. **SyntaxNode API 호환**: `web-tree-sitter`의 SyntaxNode API는 네이티브와 대부분 호환되나 일부 프로퍼티명 차이 확인 필요
5. **테스트 업데이트**: 4개 AST 테스트 스위트의 파서 초기화 부분을 async로 변경
6. **Kotlin 추가**: `tree-sitter-kotlin.wasm` grammar 로드 + `astJavaKotlin.ts`에서 Kotlin용 분기 추가

### 전환 우선순위

이 전환은 Phase 2-1의 모든 WARNING 이슈(W-7.1~W-7.4)와 CRITICAL 이슈(2-1-C1 Kotlin 파싱)를 함께 해결하는 기회이므로, AST 관련 개별 버그 수정보다 WASM 전환을 먼저 진행하는 것이 효율적.

---

## 6. 수정 우선순위

### 1순위: 동작 불가 / 데이터 손상 (즉시)

| 순번 | 이슈 ID | 설명 | 예상 난이도 |
|------|---------|------|------------|
| 1 | BUILD-C2 | LLM 모듈 `.js` → 확장자 제거 (Web 빌드 차단) | 낮음 |
| 2 | 1-5-C1 | Discovery run status `RUNNING` → `DONE` 패턴 적용 | 낮음 |
| 3 | W-4.1 | approveDomainCandidate 트랜잭션 래핑 | 낮음 |
| 4 | W-5.1 | discovery 도메인/멤버십 생성 트랜잭션 래핑 | 낮음 |

### 2순위: 기능 결함 (이번 스프린트)

| 순번 | 이슈 ID | 설명 | 예상 난이도 |
|------|---------|------|------------|
| 5 | BUILD-C1 | tree-sitter 네이티브 → WASM 전환 (§5 참조) | 높음 |
| 6 | 2-1-C1 | Kotlin 지원 (WASM 전환과 함께) | 높음 |
| 7 | INT-C1 | DOMAIN_SUMMARY에서 graph 빌드 조건부 실행 | 낮음 |
| 8 | W-8.1 | parseAnswerText가 DOMAIN_SUMMARY 형식도 인식하도록 확장 | 낮음 |
| 9 | W-8.2 | process.env 대신 SDK 인스턴스에 직접 API 키 전달 | 중간 |
| 10 | W-8.3 | 메시지에서 도메인명 추출 → domainId 파라미터 전달 | 중간 |

### 3순위: 정확도 / 품질 개선 (점진적)

| 순번 | 이슈 ID | 설명 | 예상 난이도 |
|------|---------|------|------------|
| 11 | W-1.1/W-1.2 | Spring annotation 패턴 확장 | 중간 |
| 12 | W-2.1 | KafkaListener 다중 토픽 지원 | 낮음 |
| 13 | W-2.2 | TS scanner false positive 감소 | 낮음 |
| 14 | W-3.1 | dbScore 정규화 | 낮음 |
| 15 | W-4.2 | PATCH fetch 응답 검증 추가 | 낮음 |
| 16 | W-9.1/W-9.2 | unsafe 타입 캐스팅 정리 | 중간 |
| 17 | W-10.1 | fk_reference를 RELATION_TYPES에 추가 | 낮음 |

---

## 8. 1순위 수정 완료 기록

> 수정일: 2026-02-24

### 수정 결과

| 항목 | 수정 전 | 수정 후 |
|------|---------|---------|
| Web 빌드 | **실패** | **성공** |
| CLI 빌드 | **실패** (tree-sitter 미설치) | **성공** |
| inference 테스트 | 231/231 통과 | 231/231 통과 (변동 없음) |
| core 테스트 | 47/47 통과 | 47/47 통과 (변동 없음) |

### 수정 상세

| 이슈 ID | 수정 파일 | 수정 내용 |
|---------|----------|----------|
| BUILD-C2 | `packages/inference/src/llm/index.ts`, `prompts.ts`, `batchProcessor.ts`, `candidateFilter.ts` | 모든 `.js` 확장자를 제거하여 Turbopack 호환 |
| BUILD-C1 (부분) | `packages/inference/src/code/index.ts` | AST export를 메인 index에서 분리하여 tree-sitter native 번들링 충돌 해소. WASM 전환 완료 후 재통합 예정 |
| 1-5-C1 | `packages/inference/src/domain/discovery.ts` | run status를 `RUNNING`으로 시작 → 성공 시 `DONE`, 예외 시 `FAILED`로 전환. 빈 그래프 조기 반환 시에도 `finishedAt` 및 `graphStats` 설정 |
| W-4.1 | `packages/inference/src/domain/approveDomainCandidate.ts` | 승인 처리(status 업데이트 + affinity upsert)를 `db.transaction()` 래핑 |
| W-5.1 | `packages/inference/src/domain/discovery.ts` | 도메인 생성 + 멤버십 저장 + run 완료를 `db.transaction()` 래핑 |
| (추가) | `apps/web/src/app/api/inference/llm-filter/route.ts` | `exactOptionalPropertyTypes` 타입 호환 수정 (spread 패턴 적용) |

---

## 9. 2순위 수정 완료 기록

> 수정일: 2026-02-23

### 수정 요약

2순위 기능결함 6건(이슈 #5~#10) 전체 수정 완료.
추가로 WARNING 이슈 W-7.1~W-7.4도 WASM 전환 과정에서 함께 해결.

### 수정 상세

| 이슈 ID | 수정 파일 | 수정 내용 |
|---------|----------|----------|
| BUILD-C1 | `packages/inference/src/code/ast/wasmParser.ts` (신규), `astScanner.ts`, `astJavaKotlin.ts`, `astTypeScript.ts`, `astPython.ts`, `extractAstCodeSignals.ts`, `package.json` | tree-sitter 네이티브(C++) → web-tree-sitter (WASM) 전환 완료. 비동기 파서 팩토리(`getWasmParser`) 도입, 모든 스캐너 함수 async 전환. 네이티브 의존성(`tree-sitter`, `tree-sitter-java/python/typescript`) 제거, `web-tree-sitter` 단일 의존으로 교체. WASM grammar 다운로드 스크립트(`scripts/download-wasm-grammars.mjs`) 추가. |
| 2-1-C1 | `packages/inference/src/code/ast/astJavaKotlin.ts`, `wasmParser.ts` | Kotlin 파일(`.kt`, `.kts`)은 `tree-sitter-kotlin.wasm` grammar으로 파싱하도록 변경. 기존: Java grammar으로 오파싱되어 대부분의 패턴 감지 실패. `wasmParser.ts`의 `detectLanguage()`에서 `.kt`/`.kts` → `'kotlin'` 매핑 추가. |
| INT-C1 | `packages/core/src/query-engine/executor.ts` | `getOrBuildGraph()`를 switch 분기 안으로 이동하여 `DOMAIN_SUMMARY`에서는 호출하지 않도록 변경. PATH_DISCOVERY, IMPACT_ANALYSIS, USAGE_DISCOVERY에서만 graph 빌드 수행. |
| W-8.1 | `apps/web/src/components/chat/floating-chat.tsx` | `parseAnswerText`가 `**증거 목록:**` 외에 `**도메인 목록:**`, `**멤버 목록:**`도 인식하도록 확장. DOMAIN_SUMMARY 응답에서도 AnswerCard가 정상 렌더링됨. |
| W-8.2 | `apps/web/src/app/api/chat/route.ts`, `apps/web/src/app/api/inference/llm-filter/route.ts` | `process.env` 동적 덮어쓰기 제거. 헤더로 API 키가 전달된 경우 `createOpenAI({apiKey})` / `createAnthropic({apiKey})` / `createGoogleGenerativeAI({apiKey})` factory 함수로 요청별 SDK 인스턴스 생성. 동시 요청 시 API 키 race condition 해소. |
| W-8.3 | `apps/web/src/app/api/chat/route.ts` | `resolveDomainId()` 함수 추가 — 사용자 메시지에서 도메인명을 한국어/영어 패턴으로 추출 후 DB에서 `objectType='domain'`인 Object ID를 조회. DOMAIN_SUMMARY 쿼리에 `domainId` 파라미터로 전달하여 특정 도메인 상세 집계 가능. |

### 부수 수정 (WASM 전환 과정에서 함께 해결)

| 이슈 ID | 수정 파일 | 수정 내용 |
|---------|----------|----------|
| W-7.1 | `astJavaKotlin.ts`, `astTypeScript.ts`, `astPython.ts` | `ann.text.split('\n')[0] ?? ann.text`에서 `??` → `||`로 변경. 빈 문자열(`""`)은 nullish가 아니므로 `??`가 통과하던 버그 수정. |
| W-7.2 | `astScanner.ts` | `findNodes` 재귀 + spread 방식 → 스택 기반 반복(iterative) 순회로 전환. 대형 파일에서 스택 오버플로우 위험 해소. |
| W-7.3 | `astScanner.ts` | `extractStringValue`에서 Python triple-quote(`"""..."""`, `'''...'''`) 처리 시 `slice(3, -3)` 적용. 기존 `slice(1, -1)`은 앞뒤 1문자만 제거하여 따옴표가 남던 오류 수정. |
| W-7.4 | `astJavaKotlin.ts` | WebClient/RestClient 체인 감지에서 `objectNode.text.split('.')[0]` 대신 `/webClient/i.test(objectNode.text)` 패턴으로 변경. 깊은 체인(`webClient.get().uri(...)`)에서도 정확 감지. |

### 검증 방법

- **정적 코드 분석**: 모든 수정 파일에 대해 이슈별 코드 리뷰 수행
  - native `tree-sitter` import 완전 제거 확인
  - `.children` 직접 접근 → `getChildren()` 헬퍼 전환 확인
  - `process.env` 뮤테이션 완전 제거 확인
  - 모든 스캐너 함수 async 전환 및 테스트 async/await 적용 확인
- **테스트 실행**: 샌드박스 환경의 네트워크 제한으로 `pnpm install` 불가하여 런타임 테스트는 미수행. `web-tree-sitter` 설치 후 `pnpm download:wasm && pnpm test:unit` 실행 필요.

### 후속 작업

1. `pnpm install` 실행하여 `web-tree-sitter` 패키지 설치
2. `pnpm --filter @archi-navi/inference download:wasm` 실행하여 WASM grammar 파일 다운로드
3. `pnpm test:unit` 전체 테스트 실행하여 AST 스캐너 통과 확인
4. `packages/inference/src/code/index.ts`에서 AST export 재통합 (WASM 전환 완료했으므로 번들링 충돌 해소)

---

## 10. 검증 환경

- **Node.js**: v24.12.0
- **pnpm**: v10.26.2
- **Turbo**: v2.8.10
- **OS**: Darwin 25.3.0 (macOS)
- **테스트 프레임워크**: Vitest v4.0.18
- **빌드 도구**: TypeScript 5.9.3, Next.js 16.1.6 (Turbopack)
