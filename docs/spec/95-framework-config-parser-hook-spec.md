# 95. Framework Config Parser Hook (SPEC)

상태: Proposed
우선순위: P0
상위 문서:
- [20-framework-plugin-system-spec.md](./20-framework-plugin-system-spec.md)
관련 설계 문서:
- [14-signal-coverage-design-public-edition.md](../design/14-signal-coverage-design-public-edition.md)
작성일: 2026-04-14

---

## 1. 목적

framework별 설정 파일 형식/규칙 차이를 수용하기 위해,
core orchestration에서 dispatch 가능한 config parser hook 계약을 정의한다.

---

## 2. 인터페이스 계약

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

핵심 규칙:
- 선언만 하지 않고 core가 실제로 parser를 호출해야 한다.
- parser output은 alias binding / intent extraction / config inference가 공통 소비한다.

---

## 3. lifecycle 계약

1. core가 config file discovery 수행
2. file path 기준 parser 선택
3. `ConfigEntry[]` 생성
4. 필요 시 derived signal 생성
5. downstream 공통 파이프라인으로 전달

---

## 4. 형식별 최소 요구사항

- YAML: 기존 호환 유지
- JSON:
  - flatten key/value 생성
  - nested path를 `a.b.c` 형태 key로 보존
  - 배열을 logical entry로 유지
  - topic/queue/host/port 후보를 보강 가능한 형태로 출력
- Properties: key-value 단순 파싱 + source 추적

---

## 5. 관측

- `config_files_discovered_total`
- `config_parser_selected_total`
- `config_entries_emitted_total`
- `config_derived_signals_total`
- `config_parse_failure_total`

---

## 6. 테스트 요구사항

단위:
- JSON flatten
- nested key 유지
- 배열 파싱

통합:
- parser 결과가 alias/config inference에서 실제 소비되는지 검증

---

## 7. 수용 기준

1. JSON 기반 설정에서 key/value가 유실 없이 entry로 생성된다.
2. parser hook 경유 derived signal이 downstream에서 확인된다.
3. 기존 YAML inference 회귀 없음.
