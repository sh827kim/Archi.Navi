# 93. Signal Coverage Rollout (SPEC)

상태: Current
우선순위: P0
상위 문서:
- [11-ast-regex-hybrid-code-signal-spec.md](./11-ast-regex-hybrid-code-signal-spec.md)
- [12-inference-run-orchestration-spec.md](./12-inference-run-orchestration-spec.md)
- [20-framework-plugin-system-spec.md](./20-framework-plugin-system-spec.md)
관련 설계 문서:
- [14-signal-coverage-design-public-edition.md](../design/14-signal-coverage-design-public-edition.md)
작성일: 2026-04-14
최종 정리: 2026-04-15
상태 메모: 공통 HTTP extraction, framework plugin/code scanner, config parser hook, config-code binding, 멀티모듈 경계 보정, bootstrap 정책을 이 문서에 통합했다.

---

## 1. 목적

멀티서비스 코드베이스에서 raw signal 부족으로 intent/proof 입력이 비어지는 문제를 줄이기 위해,
signal coverage 보완에 필요한 구현 계약을 하나의 canonical SPEC으로 관리한다.

핵심 목표:

> resolved value가 완전히 닫히지 않아도 partial signal과 binding 힌트를 유지해 downstream proof까지 전달한다.

---

## 2. 범위

### 2.1 포함
- 공통 HTTP call extraction
- framework-specific code scanner / built-in plugin 확장
- framework config parser hook
- config-code binding completeness
- 멀티모듈 서비스 경계 보정
- bootstrap engine 기본 정책과 fallback 관측

### 2.2 제외
- proof projection 규칙 자체 변경
- pair-first 추론 구조 회귀
- 모든 프레임워크에 대한 완전 커버리지 보장

---

## 3. 현재 구조

### 3.1 Core 책임
- 공통 HTTP extraction
- config discovery와 parser dispatch
- config binding
- 멀티모듈 ownership calibration
- bootstrap engine 선택/관측

### 3.2 Built-in Plugin 책임
- framework-specific call/expose/message 패턴 추출
- framework detector
- framework confidence rule 보정

### 3.3 문서 통합 메모
- 기존 파생 SPEC `94`, `95`, `96`, `97`, `98`의 살아 있는 계약은 이 문서에 흡수되었다.

---

## 4. 계약

### 4.1 공통 HTTP extraction

지원 패턴(최소):
1. literal URI
2. `baseUrl + '/path'`
3. `getter() + '/path'`
4. URI builder 조합
5. `uri(baseUrl, uriBuilder -> ...)`
6. `uri` 변수 사전 생성 후 `.uri(uri)` 전달
7. multiline fluent chain

최소 metadata:

```ts
interface HttpCallMetadata {
  client?: string;
  method?: string;
  hostHint?: string;
  pathHint?: string;
  configKeys?: string[];
  dynamicHost?: boolean;
  dynamicPath?: boolean;
  resolvedVia?: 'literal' | 'variable' | 'property' | 'builder' | 'binding';
}
```

보존/드롭 규칙:
- `resolvedUrl`, `hostHint`, `pathHint`, `configKeys` 중 하나라도 있으면 signal을 유지한다.
- 위 네 항목이 모두 비어 있을 때만 드롭한다.

### 4.2 Framework plugin / code scanner

```ts
interface FrameworkPlugin {
  id: string;
  displayName: string;
  languages: string[];
  detector?: ProjectDetector;
  scanRegex?: (filePath: string, content: string) => FileScanResult;
  scanAst?: (filePath: string, content: string, context: ScanContext) => FileScanResult | Promise<FileScanResult>;
  confidenceRules?: ConfidenceRule[];
  fallback?: boolean;
}
```

필수 규칙:
1. plugin output은 공통 `ExtractedSignal` 계약을 따라야 한다.
2. plugin은 code signal만 생산하고 config lifecycle은 core에 위임한다.
3. plugin이 생성한 partial signal도 드롭하지 않는다.

최소 패턴 카탈로그:
- 3-arg HTTP client call
- `requestAbs`
- `getAbs/postAbs`
- `eventBus.send/request`
- framework router methods
- framework message factory methods

실행 순서:
1. core scanner 실행
2. framework plugin scan 실행
3. signal merge + dedupe
4. confidence 규칙 적용
5. downstream(intent/proof) 전달

### 4.3 Framework config parser hook

```ts
interface FrameworkConfigParser {
  id: string;
  fileMatchers: Array<(filePath: string) => boolean>;
  parse: (filePath: string, content: string) => ConfigParseResult;
}

interface ConfigParseResult {
  entries: ConfigEntry[];
  derivedSignals?: ExtractedSignal[];
  metadata?: Record<string, unknown>;
}
```

lifecycle:
1. core가 config file discovery 수행
2. file path 기준 parser 선택
3. `ConfigEntry[]` 생성
4. 필요 시 derived signal 생성
5. downstream 공통 파이프라인으로 전달

형식별 최소 요구사항:
- YAML: 기존 호환 유지
- JSON: flatten key/value, nested path(`a.b.c`) 보존, 배열 유지
- Properties: key-value 단순 파싱 + source 추적

### 4.4 Config-code binding

```ts
interface ConfigBinder {
  bind(params: {
    codeSignals: ExtractedSignal[];
    configEntries: ConfigEntry[];
  }): {
    codeSignals: ExtractedSignal[];
    bindings: ConfigBinding[];
    unresolved: Array<{ key: string; reason: string }>;
  };
}
```

최소 바인딩 알고리즘:
1. config entries로 key registry 구축
2. signal의 `configKeys` 순회
3. 가장 구체적인 key 우선 매칭
4. resolved value 타입별 metadata 보강
5. 실패 key는 unresolved에 누적

보강 규칙:
- URL -> `hostHint`, `pathHint`, `resolvedUrl`
- topic -> `messageTopicHints`
- queue -> `messageQueueHints`
- port -> metadata 보강

신호 보존 규칙:
- 바인딩 성공 시 기존 signal 대체 금지, 강화만 수행
- 바인딩 실패 시 signal 즉시 드롭 금지, unresolved 상태 유지

### 4.5 멀티모듈 서비스 경계 보정

알고리즘 계약:
1. settings/pom 기준 하위 모듈 목록 수집
2. 모듈별 실행 가능성 점수 계산
3. score threshold 이상만 서비스로 승격
4. 나머지는 parent ownership에 귀속

점수 예시:
- application config: +3
- main source set: +2
- executable entry/plugin: +3
- common/domain/library naming: -3
- runtime resource/entrypoint 없음: -3

최소 결과 필드:
- module path
- score
- classification(`service_candidate | library_candidate | inherited`)
- reasons[]

### 4.6 Bootstrap engine 정책

기본값:
- `hybrid`

제한 환경:
- `regex`

복구:
- parse 실패 시 `ast + regex fallback` 또는 `hybrid` 재시도

실행 계약:
1. requested engine 기록
2. 실제 사용 engine 기록
3. fallback 발생 시 원인/횟수 기록
4. run 결과에 신호 수/실패 수 첨부

---

## 5. 관측/메트릭

필수 집계:
- `http_call_detected_total`
- `http_call_partial_total`
- `http_call_dropped_total`
- `http_call_resolved_via_{literal|variable|property|builder|binding}`
- `config_files_discovered_total`
- `config_parser_selected_total`
- `config_entries_emitted_total`
- `config_derived_signals_total`
- `config_parse_failure_total`
- engine requested / used / fallback count / parse failure count / file count / signal count

---

## 6. 테스트 요구사항

단위:
- multiline chain
- builder lambda
- variable-backed uri
- getter/property 기반 조합
- `requestAbs`, `getAbs/postAbs`, event bus send/request, router expose
- JSON flatten / nested key 유지 / 배열 파싱
- URL/topic/queue/port 타입별 binding
- 실행 모듈/라이브러리 모듈 분류
- engine 선택 분기와 fallback

통합:
- hybrid 엔진 실행 시 partial call signal이 intent 입력으로 전달되는지 검증
- plugin 활성 시 regex-only 대비 signal 수 증가 검증
- parser 결과가 alias/config inference에서 실제 소비되는지 검증
- binding 결과가 proof 입력으로 유지되는지 검증

---

## 7. 수용 기준

1. 대표 dynamic HTTP 호출 샘플에서 `call` signal이 비어 있지 않다.
2. partial metadata 기반 signal이 드롭되지 않고 downstream으로 전달된다.
3. framework-specific 샘플에서 plugin 활성 시 signal recall이 증가한다.
4. JSON/properties parser 결과가 binding과 proof 입력에서 실제 사용된다.
5. 멀티모듈 샘플에서 루트 단일 ownership 집중이 완화된다.
6. 기본 실행 경로가 `hybrid`로 고정되고 fallback 관측치가 남는다.
