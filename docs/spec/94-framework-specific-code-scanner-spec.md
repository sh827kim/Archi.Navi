# 94. Framework-Specific Code Scanner Extension (SPEC)

상태: Proposed
우선순위: P0
상위 문서:
- [20-framework-plugin-system-spec.md](./20-framework-plugin-system-spec.md)
- [93-common-http-signal-extraction-coverage-spec.md](./93-common-http-signal-extraction-coverage-spec.md)
관련 설계 문서:
- [14-signal-coverage-design-public-edition.md](../design/14-signal-coverage-design-public-edition.md)
작성일: 2026-04-14

---

## 1. 목적

Spring-style scanner가 놓치는 framework 고유 호출 규칙을 built-in plugin으로 확장하여 signal recall을 개선한다.

---

## 2. 범위

### 2.1 포함
- framework HTTP client 패턴 추출
- framework router expose 패턴 추출
- framework event bus/message 패턴 추출
- framework confidence rule 보정

### 2.2 제외
- config discovery 독자 구현
- proof projection 규칙 변경

---

## 3. Plugin 계약

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
1. plugin output은 공통 signal contract(`ExtractedSignal`)를 따라야 한다.
2. plugin은 code signal만 생산하고 config lifecycle은 core로 위임한다.
3. plugin에서 산출한 partial signal도 드롭하지 않는다.

---

## 4. 최소 패턴 카탈로그

- 3-arg HTTP client call
- `requestAbs`
- `getAbs/postAbs`
- `eventBus.send/request`
- framework router methods
- framework message factory methods

---

## 5. 실행 순서 계약

1. core scanner 실행
2. framework plugin scan 실행
3. signal merge + dedupe
4. confidence 규칙 적용
5. downstream(intent/proof) 전달

---

## 6. 테스트 요구사항

단위:
- `requestAbs`, `getAbs/postAbs`
- event bus send/request
- router expose 패턴

통합:
- plugin 활성 시 regex-only 대비 signal 수 증가 검증

---

## 7. 수용 기준

1. framework-specific 샘플에서 적어도 하나의 signal 생성.
2. plugin 활성 시 기존 공통 scanner 결과와 충돌/중복 폭증 없음.
3. plugin 비활성 시 기존 동작 유지.
