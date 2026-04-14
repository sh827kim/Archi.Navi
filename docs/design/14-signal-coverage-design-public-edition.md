# Signal Coverage Design (Public Edition)

작성일: 2026-04-14
상태: Public Shareable Implementation Guide
구현 상태: Current Reference

---

## 1. 목적

이 문서는 signal coverage 보완을 외부 공개 가능한 수준으로 일반화한 구현 가이드다.

이 문서만 읽은 에이전트나 개발자도 아래 작업을 수행할 수 있어야 한다.

1. 공통 HTTP signal 추출 인프라 확장
2. framework-specific code scanner 추가
3. framework-specific config parser hook 추가
4. config-code binding 추가
5. 멀티모듈 서비스 경계 보정
6. bootstrap 실행 정책 정리

이 문서는 특정 서비스명, 로컬 경로, 내부 저장소 구조, 조직 고유 설정값을 포함하지 않는다.

---

## 2. 배경

멀티서비스 코드베이스에서 signal이 잘 잡히지 않는 가장 흔한 이유는 다음이다.

- HTTP 호출이 문자열 리터럴이 아니라 변수, getter, URI builder, lambda builder 기반으로 조합된다.
- 일부 프레임워크는 Spring-style scanner로는 포착할 수 없는 고유 호출 규칙을 가진다.
- 설정 파일이 YAML 외의 형식(JSON 등)을 사용하거나, 코드가 중첩 config 접근을 사용한다.
- 프로젝트가 멀티모듈 구조라서 코드 발견과 서비스 경계가 어긋난다.
- bootstrap 경로가 regex 위주로 동작해 AST/hybrid의 장점을 충분히 살리지 못한다.

핵심 판단은 다음 한 문장으로 요약된다.

> signal coverage 문제는 주로 추론 철학의 문제가 아니라, 입력 추출 범위와 binding completeness의 문제다.

---

## 3. 목표와 비목표

## 3.1 목표

1. raw signal이 비어 있는 대표 케이스를 줄인다.
2. partial evidence를 버리지 않고 proof 가능한 입력으로 보존한다.
3. 공통 인프라와 framework-specific 로직의 책임을 분리한다.
4. 특정 프레임워크 지원을 추가해도 core를 과도하게 오염시키지 않는다.
5. config-derived URL/topic/host 정보를 실제 proof input까지 연결한다.

## 3.2 비목표

- pair-first 추론 구조로 회귀
- service-level fallback candidate 재도입
- 1차 구현에서 모든 dynamic config 패턴 완전 해석
- 모든 하위 모듈을 자동으로 서비스로 승격
- plugin만으로 config parsing/binding까지 해결한다고 가정

---

## 4. 최종 구조 판단

## 4.1 Core에 속하는 것

- 공통 HTTP call extraction
- alias/config enrichment
- 멀티모듈 서비스 경계 보정
- bootstrap 실행 정책
- framework-dispatched config parser hook
- config-code binding orchestrator

## 4.2 Built-in plugin에 속하는 것

- framework-specific code scanner
- framework-specific expose/call/produce/consume 패턴
- framework-specific confidence adjustment

## 4.3 왜 혼합 구조가 필요한가

framework별 코드는 plugin으로 분리하는 것이 맞지만, config inference와 intent extraction은 대개 core 파이프라인에 붙어 있다. 따라서 아래 구조가 가장 안정적이다.

1. core가 code extraction과 config extraction의 공통 lifecycle을 갖는다.
2. built-in plugin은 framework-specific code scanner를 제공한다.
3. core는 필요 시 framework-specific config parser를 dispatch한다.
4. core는 code signal과 config signal을 binding해서 intent/proof input을 만든다.

---

## 5. 최소 데이터 계약

이 섹션은 구체 구현이 달라도 유지되어야 하는 최소 계약이다.

## 5.1 Code Signal

```ts
type SignalKind =
  | 'expose'
  | 'call'
  | 'produce'
  | 'consume'
  | 'db_read'
  | 'db_write'
  | 'db_mapping';

interface ExtractedSignal {
  kind: SignalKind;
  symbol: string;
  confidence: number;
  lineStart: number;
  lineEnd: number;
  excerpt?: string;
  metadata: Record<string, unknown>;
}
```

### 규칙

- `symbol`은 가능한 경우 resolved value를 사용한다.
- 완전 해석이 불가능하면 `symbol`은 best-effort value를 사용하고, 상세는 `metadata`에 남긴다.
- partial evidence는 버리지 않는다.

## 5.2 Config Entry

```ts
interface ConfigEntry {
  key: string;
  value: string;
  sourceType: 'yaml' | 'json' | 'properties' | 'other';
  filePath: string;
}
```

## 5.3 Config Binding Result

```ts
interface ConfigBinding {
  configKey: string;
  resolvedValue: string;
  valueType: 'url' | 'host' | 'topic' | 'queue' | 'port' | 'generic';
  sourceFilePath: string;
  sourceLine?: number;
}
```

## 5.4 Intent Input Hint

```ts
interface IntentHints {
  hostHint?: string | null;
  pathHint?: string | null;
  methodHint?: string | null;
  configKeys?: string[];
  messageTopicHints?: string[];
  messageQueueHints?: string[];
}
```

### 규칙

- signal이 완전히 닫히지 않아도 `hostHint`, `pathHint`, `configKeys`, `messageTopicHints` 중 하나 이상을 남기면 downstream에서 proof 시도가 가능해야 한다.
- `hint`가 있으면 살아남고, 완전히 비어 있으면 드롭되는 구조를 권장한다.

---

## 6. 필수 인터페이스

## 6.1 Framework Plugin

```ts
interface FrameworkPlugin {
  id: string;
  displayName: string;
  languages: string[];
  detector?: ProjectDetector;
  scanRegex?: (filePath: string, content: string) => FileScanResult;
  scanAst?: (filePath: string, content: string, context: ScanContext) => FileScanResult | Promise<FileScanResult>;
  configParsers?: FrameworkConfigParser[];
  confidenceRules?: ConfidenceRule[];
  fallback?: boolean;
}
```

## 6.2 Framework Config Parser Hook

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

### 중요

- 공개 구현 가이드 기준으로는 `configParsers`가 선언만 되어서는 부족하다.
- core orchestration이 실제로 이를 호출해야 한다.

## 6.3 Config Binder

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

---

## 7. 구현 상세

## 7.1 공통 HTTP extraction

공통 HTTP extraction은 framework 하나를 위한 scanner가 아니라, 여러 Java 계열 클라이언트가 공유할 수 있는 normalization layer여야 한다.

### 입력

- regex scan result
- AST scan result
- variable/property resolver output

### 출력

- `call` signal
- partial metadata

### 최소 감지 대상

1. 리터럴 URI
2. `baseUrl + "/path"`
3. `getter() + "/path"`
4. URI builder 기반 조합
5. `uri(baseUrl, uriBuilder -> ...)`
6. 미리 만든 `uri` 변수를 나중에 `.uri(uri)`에 넘기는 패턴
7. multiline fluent chain

### 최소 metadata

```ts
{
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

### 알고리즘

1. line regex만으로 끝내지 않는다.
2. 먼저 call-site를 찾는다.
3. 다음으로 URI origin을 찾는다.
4. origin을 variable/property/config binding 결과와 합친다.
5. 완전한 URL이 없더라도 `hostHint`, `pathHint`, `configKeys`를 남긴다.

### 드롭 규칙

다음 중 하나라도 있으면 signal을 유지한다.

- resolved URL
- hostHint
- pathHint
- configKeys

전부 비어 있을 때만 드롭한다.

## 7.2 Framework-specific code scanner

framework-specific plugin은 아래만 책임진다.

- framework HTTP client 호출
- framework router expose
- framework event bus or message patterns
- framework producer/consumer factory

### 예시 범주

- 3-arg HTTP client call
- `requestAbs`
- `getAbs/postAbs`
- `eventBus.send/request`
- framework router methods
- framework message factory methods

### 금지 사항

- plugin이 config 파일 discovery를 독자적으로 수행해 core와 별도 저장 경로를 만들지 않는다.
- plugin이 proof projection 규칙을 직접 바꾸지 않는다.

## 7.3 Framework config parser hook

config parser hook은 아래 lifecycle을 따라야 한다.

1. core가 config file discovery 수행
2. file path에 따라 적합한 parser 선택
3. parser가 `ConfigEntry[]` 생성
4. parser가 필요하면 derived signal을 생성
5. 결과를 alias binding, intent extraction, config inference가 공통 소비

### 지원해야 하는 형식

- YAML
- JSON
- 필요 시 properties

### JSON parser 최소 요구사항

- flatten된 key/value 생성
- 배열을 문자열 목록 또는 여러 개의 logical entry로 변환
- topic/queue/host/port 후보를 추출 가능한 형태로 유지
- nested object path를 `a.b.c` 형태의 key로 보존

## 7.4 Config-code binding

config-code binding은 coverage 보완에서 가장 중요한 downstream 연결 단계다.

### 입력

- code signal metadata 안의 `configKeys`
- config parser가 만든 `ConfigEntry[]`

### 출력

- resolved signal
- binding record
- unresolved list

### 알고리즘

1. config entry를 key-based registry로 만든다.
2. code signal의 `configKeys`를 순회한다.
3. 가장 구체적인 key를 우선 매칭한다.
4. resolve된 값이 URL이면 `hostHint/pathHint`를 보강한다.
5. resolve된 값이 topic/queue면 message hint로 보강한다.
6. 중첩 JSON 접근은 path flatten 규칙으로 처리한다.
7. 해석 실패 키는 unresolved로 남긴다.

### 보강 규칙

- URL: `hostHint`, `pathHint`, `resolvedUrl`
- topic: `messageTopicHints`
- queue: `messageQueueHints`
- port: 별도 metadata

### 신호 보존 규칙

- binding 성공 시 기존 signal을 대체하지 말고 강화한다.
- binding 실패 시 signal을 바로 버리지 말고 unresolved state를 유지한다.

## 7.5 Alias/config enrichment

일반 URL property도 alias 후보로 다뤄야 한다.

### 최소 규칙

1. 값이 URL이면 host/basePath를 추출한다.
2. key suffix에서 service hint 후보를 만든다.
3. host, key, suffix, env placeholder 이름을 alias candidate로 본다.
4. 서비스명 매칭은 normalize + token overlap 기준으로 수행한다.

### 목적

- config key와 실제 서비스 간 연결 가능성 보강
- host literal이 없어도 provider 후보를 만들 수 있게 함

## 7.6 멀티모듈 서비스 경계 보정

### 문제

재귀 파일 탐색은 code/config를 찾을 수 있어도, 서비스 등록 단위가 프로젝트 루트 하나로 고정되면 ownership이 흐려진다.

### 목표

실행 모듈을 서비스로 분리하되, 라이브러리 모듈은 서비스로 과잉 분해하지 않는다.

### 권장 알고리즘

1. settings/pom 기반으로 하위 모듈 목록 수집
2. 각 모듈에 대해 실행 가능성 점수 계산
3. 점수가 높은 모듈만 서비스 후보로 승격

### 실행 가능성 점수 예시

- application config 존재: +3
- main source set 존재: +2
- executable plugin/application entry 존재: +3
- common/domain/library naming pattern: -3
- no runtime resource and no entrypoint: -3

### 결과 규칙

- score threshold 이상만 서비스로 등록
- 나머지는 parent module ownership 아래에 둔다

## 7.7 Bootstrap 실행 정책

coverage 개선이 목적이면 bootstrap 기본값이 지나치게 regex 편향적이면 안 된다.

### 권장 정책

- 기본값: `hybrid`
- 제한 환경: `regex`
- 파싱 실패 복구: `ast + regex fallback` 또는 `hybrid`

### 최소 관측치

- engine requested
- engine used
- fallback count
- parse failure count
- file count
- signal count

---

## 8. 단계별 실행 계획

## Phase 1. raw signal 확보

### 작업

1. framework-specific built-in plugin 추가
2. 공통 HTTP extraction 확장
3. JSON config parser hook 연결
4. bootstrap 기본 engine 상향

### 완료 조건

- 이전에 empty signal이던 대표 샘플에서 최소 하나 이상의 `call`, `produce`, `consume`, `expose`가 생성된다.
- framework-specific pattern이 regex-only path보다 더 많이 잡힌다.

## Phase 2. binding 연결

### 작업

1. config registry 구축
2. config-code binding 추가
3. alias enrichment 강화
4. intent input hint 보강

### 완료 조건

- code signal에서 나온 `configKeys`가 실제 URL/topic/queue로 resolve된다.
- partial signal이 intent/proof input으로 살아남는다.

## Phase 3. 경계 정교화

### 작업

1. 멀티모듈 서비스 분리 정책 추가
2. 실행 모듈 선별
3. ownership metadata 반영

### 완료 조건

- 서비스 수가 무의미하게 폭증하지 않는다.
- signal ownership이 루트 프로젝트 하나로만 뭉치지 않는다.

---

## 9. 테스트 요구사항

## 9.1 단위 테스트

최소 테스트 범주:

1. multiline HTTP chain
2. `uri(baseUrl, uriBuilder -> ...)`
3. `UriComponentsBuilder(...).toUriString()`
4. variable-backed URI
5. framework-specific `requestAbs`
6. framework-specific `getAbs/postAbs`
7. event bus send/request
8. JSON config flatten
9. nested config key binding
10. URL property alias enrichment
11. 멀티모듈 모듈 분류

## 9.2 통합 테스트

최소 시나리오:

1. code scan -> signal 생성
2. config parse -> config entry 생성
3. binding -> signal 강화
4. intent extraction -> hint 유지
5. proof input -> non-empty

## 9.3 회귀 테스트

기존에 동작하던 아래 패턴은 반드시 유지해야 한다.

- literal HTTP URL
- annotation-based expose
- literal Kafka/Rabbit signal
- 기존 YAML config inference

---

## 10. 수용 기준

구현 완료로 판단하려면 아래를 만족해야 한다.

1. 대표적인 dynamic HTTP 호출 샘플에서 `call` signal이 비어 있지 않다.
2. framework-specific HTTP/EventBus/message 패턴에서 적어도 하나의 signal이 생성된다.
3. JSON config 기반 topic/URL/port가 binding을 통해 proof input으로 전달된다.
4. empty signal 또는 empty intent 케이스가 이전보다 유의미하게 감소한다.
5. 멀티모듈 프로젝트에서 실행 모듈과 라이브러리 모듈이 구분된다.
6. 기존 literal/annotation 기반 추출은 회귀하지 않는다.

---

## 11. 구현 시 주의사항

1. partial evidence를 조기에 드롭하지 않는다.
2. non-literal URL을 이유로 signal 자체를 버리지 않는다.
3. plugin이 config lifecycle을 독자적으로 우회하지 않는다.
4. 모든 framework 지원을 하나의 giant scanner에 몰아넣지 않는다.
5. 멀티모듈 분리를 “모든 include 모듈 = 서비스”로 단순화하지 않는다.

---

## 12. 최종 권고

signal coverage 보완은 다음 문장으로 구현 판단을 고정하면 된다.

> 공통 추출/바인딩/서비스 경계는 core에서 강화하고, 프레임워크별 코드 패턴은 built-in plugin으로 분리하며, framework-specific config parsing과 config-code binding은 core가 제공하는 hook 위에서 연결한다.

공개 문맥에서는 이 문서를 구현 기준으로 사용하고, 특정 조직/워크스페이스의 관측 근거는 별도 비공개 문서로 관리하는 것을 권장한다.
