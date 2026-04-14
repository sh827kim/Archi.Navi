# 93. Common HTTP Signal Extraction Coverage (SPEC)

상태: Proposed
우선순위: P0
상위 문서:
- [11-ast-regex-hybrid-code-signal-spec.md](./11-ast-regex-hybrid-code-signal-spec.md)
- [20-framework-plugin-system-spec.md](./20-framework-plugin-system-spec.md)
관련 설계 문서:
- [14-signal-coverage-design-public-edition.md](../design/14-signal-coverage-design-public-edition.md)
작성일: 2026-04-14

---

## 1. 목적

멀티서비스 코드베이스에서 non-literal HTTP 호출로 인해 `call` signal이 비어지는 문제를 줄이기 위해,
framework 공통으로 재사용 가능한 HTTP extraction 계약을 정의한다.

핵심 목표:

> resolved URL이 없어도 `hostHint`, `pathHint`, `configKeys` 기반 partial signal을 유지한다.

---

## 2. 범위

### 2.1 포함
- call-site → URI origin 추적의 2단계 추출 모델
- regex/AST/hybrid 입력 병합 규칙
- variable/property/builder 기반 URL 조합 처리
- signal 드롭 최소화 규칙

### 2.2 제외
- framework 전용 API 문법 파싱(별도 plugin spec에서 정의)
- config 파일 파싱/바인딩 로직(별도 spec)

---

## 3. 제품 계약

## 3.1 지원 패턴 (최소)
1. literal URI
2. `baseUrl + '/path'`
3. `getter() + '/path'`
4. URI builder 조합
5. `uri(baseUrl, uriBuilder -> ...)`
6. `uri` 변수 사전 생성 후 `.uri(uri)` 전달
7. multiline fluent chain

## 3.2 최소 metadata

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

## 3.3 signal 보존/드롭 규칙
- 아래 중 하나라도 존재하면 signal 유지:
  - resolved URL
  - `hostHint`
  - `pathHint`
  - `configKeys`
- 위 네 항목이 모두 비어 있을 때만 드롭.

---

## 4. 구현 요구사항

1. regex 결과만으로 종료하지 않고 AST/hybrid 결과와 병합한다.
2. call-site 탐색과 URI origin 추적을 분리된 단계로 유지한다.
3. origin 추적 실패 시에도 partial metadata를 최대한 보존한다.
4. 동일 call-site 중복 신호는 normalize + dedupe 규칙으로 정리한다.

---

## 5. 관측/메트릭

필수 집계:
- `http_call_detected_total`
- `http_call_partial_total`
- `http_call_dropped_total`
- `http_call_resolved_via_{literal|variable|property|builder|binding}`

---

## 6. 테스트 요구사항

### 단위
- multiline chain
- builder lambda
- variable-backed uri
- getter/property 기반 조합

### 통합
- hybrid 엔진 실행 시 partial call signal이 intent 입력으로 전달되는지 검증

---

## 7. 수용 기준

1. 대표 dynamic 호출 샘플에서 `call` signal non-empty.
2. partial metadata 기반 signal이 드롭되지 않고 downstream으로 전달.
3. 기존 literal URL 추출 케이스 회귀 없음.
