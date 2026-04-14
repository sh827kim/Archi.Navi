# 96. Config-Code Binding Completeness (SPEC)

상태: Proposed
우선순위: P0
상위 문서:
- [93-common-http-signal-extraction-coverage-spec.md](./93-common-http-signal-extraction-coverage-spec.md)
- [95-framework-config-parser-hook-spec.md](./95-framework-config-parser-hook-spec.md)
관련 설계 문서:
- [14-signal-coverage-design-public-edition.md](../design/14-signal-coverage-design-public-edition.md)
작성일: 2026-04-14

---

## 1. 목적

code signal의 `configKeys`와 config parser output을 연결해,
URL/topic/queue/host/port 힌트를 proof 입력까지 전달하는 바인딩 계약을 정의한다.

---

## 2. 인터페이스 계약

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

## 3. 바인딩 알고리즘(최소)

1. config entries로 key registry 구축
2. signal의 `configKeys` 순회
3. 가장 구체적인 key 우선 매칭
4. resolved value 타입별 metadata 보강
5. 실패 key는 unresolved에 누적

보강 규칙:
- URL → `hostHint`, `pathHint`, `resolvedUrl`
- topic → `messageTopicHints`
- queue → `messageQueueHints`
- port → metadata 보강

---

## 4. 신호 보존 규칙

- 바인딩 성공: 기존 signal 대체 금지, 강화만 수행
- 바인딩 실패: signal 즉시 드롭 금지, unresolved 상태 유지

---

## 5. Alias/Config enrichment 연계

- URL property를 alias 후보로 포함
- key suffix, host, env placeholder를 alias 후보로 포함
- normalize + token overlap으로 서비스 후보 매칭

---

## 6. 테스트 요구사항

단위:
- nested config key binding
- URL/topic/queue/port 타입별 보강
- unresolved 누적

통합:
- binding 결과가 intent hints/proof input으로 유지되는지 검증

---

## 7. 수용 기준

1. `configKeys` 기반 resolve 비율이 baseline 대비 개선.
2. binding 이후 empty intent 비율 감소.
3. unresolved 기록이 감사 가능하게 남는다.
