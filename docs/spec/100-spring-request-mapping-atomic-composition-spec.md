# Spring RequestMapping + Method Mapping Atomic 조합 설계

- 작성일: 2026-04-15
- 대상 워크스페이스: `/Users/spark/testbed/Archi.Navi`
- 작성 목적: Spring Boot 기준 클래스 레벨 `@RequestMapping`과 메서드 레벨 `@GetMapping`/`@PostMapping`/`@RequestMapping` 등을 조합한 최종 endpoint 형태로 `api_endpoint` Atomic을 저장하도록 개선하는 구체 설계를 정리한다.

## 1. 요약

현재 Java/Kotlin Spring expose 추출은 annotation 단위로 평평하게 signal을 생성한다. 이 때문에 아래처럼 controller prefix와 method mapping이 함께 있는 전형적인 Spring 코드에서:

```java
@RestController
@RequestMapping("/api/orders")
class OrderController {
  @GetMapping("/{id}")
  Order getOrder() {}
}
```

실제 Atomic bootstrap은 `GET /api/orders/{id}`가 아니라, 분리된 expose signal에 기반해 아래처럼 저장될 수 있다.

- `ANY /api/orders`
- `GET /{id}`

권장 방향은 bootstrap 단계 후처리 조합이 아니라, **추출 단계에서 declaration-aware한 최종 expose signal을 생성**하는 것이다.

핵심 설계:

- Java/Kotlin AST 추출기에 Spring controller 전용 declaration-aware extractor 추가
- 클래스 레벨 mapping + 메서드 레벨 mapping 조합으로 최종 `(HTTP method, full path)` expose signal 생성
- hybrid 모드에서 AST Spring expose가 있으면 regex flat Spring expose 제거
- bootstrap/upsert는 기존처럼 expose signal을 그대로 올리되, 입력 신호를 조합형으로 개선
- 기존 오염 endpoint는 별도 refresh/backfill로 정리

## 2. 현재 구현 분석

### 2.1 AST 추출은 annotation 단위 평면 추출

- 파일: `packages/inference/src/code/ast/astJavaKotlin.ts`
- 현재 `processSpringMappingAnnotations()`는 전체 AST annotation 노드를 순회하며 annotation 하나당 expose signal을 생성한다.

핵심 문제:

- annotation이 어떤 클래스/메서드 선언에 붙었는지 문맥을 보지 않음
- 클래스 레벨 `@RequestMapping("/prefix")`와 메서드 레벨 `@GetMapping("/path")`를 합치지 않음

### 2.2 Regex 추출도 분리형

- 파일: `packages/inference/src/code/scanners/javaKotlin.ts`
- `@GetMapping`, `@RequestMapping`을 독립 패턴으로 추출

### 2.3 bootstrap 저장 단계는 signal을 그대로 저장

- 파일: `packages/inference/src/relation/codeBased.ts`
- `bootstrapApiEndpointsFromCodeSignals()`는 `metadata.method` + `metadata.path`(또는 `calleeSymbol`)를 그대로 `upsertApiEndpoint()`에 전달

### 2.4 기본 경로(hybrid) 특성상 AST만 고치면 부족

- hybrid는 AST/regex를 파일 단위로 합치지만 semantic 조합은 하지 않음
- AST가 조합 endpoint를 만들더라도 regex flat endpoint가 남을 수 있음

### 2.5 FeignClient는 이미 declaration-aware

- 인터페이스 레벨 + 메서드 레벨 매핑을 결합해서 최종 call signal 생성
- Spring controller expose도 동일 패턴으로 맞추는 것이 자연스러움

## 3. 목표

- Spring controller provider endpoint Atomic이 런타임 route에 가깝게 저장되어야 함
- 클래스 prefix + 메서드 mapping 조합 시 항상 조합된 최종 path 사용
- hybrid 기본 모드에서도 flat expose가 남지 않음
- FeignClient/HttpInterface/Kafka/DB 추출 동작 불변
- bootstrap/upsert 단순 계약 유지, 조합 책임은 추출 레이어에 배치

## 4. 비목표

- Spring MVC 고급 조건(params/headers/consumes/produces) 완전 모델링 제외
- 동적 property placeholder 해석 제외
- WebFlux functional routing DSL 제외
- stale endpoint 자동 정리 완전 자동화 제외
- bootstrap 후처리 재조합 방식 채택 안 함

## 5. 설계 원칙

1. 조합 책임은 추출 단계에 둔다.
2. Java/Kotlin Spring expose는 declaration-aware AST를 source of truth로 삼는다.
3. 최종 Atomic 키(`serviceName:method:path`)는 유지한다.

## 6. 상세 설계

### 6.1 중간 모델

```ts
interface SpringRequestMappingInfo {
  paths: string[];
  methods: string[] | null;
  annotation: string;
}
```

### 6.2 타입 레벨 추출 규칙

- 대상: `class_declaration`, `interface_declaration`
- controller 선언: `@RestController` 또는 `@Controller`
- 단, controller annotation이 없어도 메서드 레벨 Spring mapping이 있으면 provider로 간주
- `@RequestMapping(path|value, method)`에서 path/method 배열 모두 펼침

### 6.3 메서드 레벨 추출 규칙

- 대상: `@GetMapping`, `@PostMapping`, `@PutMapping`, `@DeleteMapping`, `@PatchMapping`, `@RequestMapping`
- shortcut annotation은 고정 method
- `@RequestMapping`은 `method=` 읽기
- path/value 배열 전개
- method가 비어 있으면 `ANY`
- 1차에서 `GET|POST|PUT|DELETE|PATCH` 외 method는 `ANY`로 degrade

### 6.4 최종 endpoint 조합

- `effectivePaths = cartesian(typePaths, methodPaths).map(joinAndNormalizePath)`
- `effectiveMethods = methodLevel.methods ?? typeLevel.methods ?? ['ANY']`
- 둘 다 method restriction이 있으면 교집합 계산
- 교집합이 비면 endpoint 생성 skip

### 6.5 expose signal 메타데이터

```ts
{
  kind: 'expose',
  symbol: fullPath,
  metadata: {
    method,
    path: fullPath,
    annotation,
    framework: 'spring',
    mappingSource: 'controller_composed',
    typeLevelPath,
    methodLevelPath,
    ownerTypeName,
  }
}
```

### 6.6 line/excerpt 규칙

- lineStart/lineEnd: method-level mapping annotation 라인 범위
- excerpt: 메서드 annotation 첫 줄 또는 method 선언 첫 줄

### 6.7 타입 레벨 standalone expose 규칙

- 타입에 method-level mapping이 하나라도 있으면 type-level standalone expose 생성 금지
- method-level mapping이 전혀 없고 타입만 매핑된 경우에만 standalone 허용

## 7. 코드 변경 설계

### 7.1 `packages/inference/src/code/ast/astJavaKotlin.ts`

- declaration-aware controller extractor 추가
- 기존 generic annotation sweep에서 Spring mapping expose 생성 제거

### 7.2 `packages/inference/src/code/scanners/javaKotlin.ts`

- regex 스캐너 구조 유지
- Spring expose metadata에 `framework='spring'`, `mappingSource='regex_annotation_flat'` 보강

### 7.3 `packages/inference/src/code/plugins/runtime.ts`

- hybrid에서 AST composed spring expose가 있으면 regex flat spring expose 제거 후 merge

### 7.4 `packages/inference/src/relation/codeBased.ts`

- 1차는 변경 최소화(현 계약 유지)

### 7.5 `packages/inference/src/code/hybridSignalMerge.ts`

- 1차는 변경 없이 runtime.ts에서 파일-로컬 suppression으로 대응

## 8. 데이터 계약

### 8.1 expose evidence metadata

권장 필드:

- `method`, `path`, `annotation`
- `framework='spring'`, `mappingSource='controller_composed'`
- `typeLevelPath`, `methodLevelPath`, `ownerTypeName`

### 8.2 api_endpoint object metadata

필수/권장:

- `method`, `path`, `repoRoot`, `source`
- 선택: `framework`, `mappingSource`

## 9. 마이그레이션/백필

### 9.1 문제

기존 잘못된 code-derived endpoint(`ANY /prefix`, `GET /child`)는 자동 정리되지 않음.

### 9.2 권장 단계

- Phase 1: 추출기/부트스트랩 수정
- Phase 2: repo-scoped refresh 도구로 live 집합 재계산 + stale marking

### 9.3 삭제 전략

- hard delete 즉시 수행 금지
- 1차는 stale mark/report-only 권장

## 10. 테스트 설계

### 10.1 AST 단위 테스트

`packages/inference/src/__tests__/code/ast/astJavaKotlin.test.ts`

- 클래스 prefix + 메서드 mapping 조합
- path/method 배열 cartesian
- method 교집합
- type-only standalone 허용
- method-level 존재 시 type-level standalone 미생성

### 10.2 Hybrid 단위 테스트

`packages/inference/src/__tests__/code/plugins/runtime.test.ts`

- AST composed 존재 시 regex flat spring expose 제거
- AST 실패 시 regex fallback 유지

### 10.3 통합 테스트

`packages/inference/src/__tests__/code/ast/extractAstCodeSignals.test.ts`

- calleeSymbol/path가 full path로 저장되는지
- ownerFunctionId가 메서드에 연결되는지

### 10.4 bootstrap/relation 테스트

`packages/inference/src/__tests__/relation/codeBased.test.ts`

- bootstrap 이후 최종 조합 endpoint만 생성되는지

## 11. 단계별 구현 계획

1. AST declaration-aware controller 조합
2. hybrid suppression
3. bootstrap 검증
4. refresh/backfill 도구 설계

## 12. 리스크와 대응

- path/method 배열 expansion으로 endpoint 수 증가 가능 → 명시 배열만 전개 + 테스트 보강
- AST/regex 중복 억제 과도 가능 → Java/Kotlin Spring expose에만 제한
- type-only 패턴 누락 가능 → method-level 유무 기반 분기
- HEAD/OPTIONS 범위 모호 → 1차 ANY degrade

## 13. 최종 권고

문제의 본질은 저장 단계가 아니라 **Spring expose 추출의 declaration-aware 부재**다.

따라서 다음을 권고한다.

> Spring controller endpoint는 AST 추출 단계에서 클래스+메서드 매핑을 조합한 최종 expose signal로 생성하고, hybrid에서는 regex flat Spring expose를 AST 결과로 대체한다.

이 접근은 기존 bootstrap/upsert 계약을 유지하면서 문제를 가장 직접적으로 해결한다.
