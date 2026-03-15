# 18. Inter-procedural AST 분석 (SPEC) (Roadmap 4-1)

상태: Draft
작성일: 2026-03-08

## 1. 목적

파일 단위(intra-file) AST 분석을 **프로젝트 단위(inter-procedural)** 분석으로 확장.
메서드 호출 체인, Spring 프로퍼티 전파, 인터페이스 구현체 매핑으로 추론 정밀도 90%+ 달성.

> 기존 2-1(AST Plugin)의 확장. hybrid 엔진 위에 추가되는 분석 레이어.

## 2. 범위

### 포함
- Multi-file Symbol Table 구축
- Call Chain Resolution (최대 depth 3)
- Spring 프로퍼티 전파 (`@Value` → `application.yml` 연결)
- 인터페이스 → 구현체 매핑
- 신뢰도 재조정

### 제외 (후속)
- 런타임 동적 바인딩 (리플렉션) → LLM 부스터로 처리
- Generic/템플릿 타입 해석
- 다중 모듈(multi-module) 프로젝트 간 참조

## 3. 처리 규칙

### 3.1 Symbol Table 구축

```
파일별 AST 파싱 (기존)
      ↓
ClassSymbol / InterfaceSymbol 추출 (FQCN, 상속/구현 관계, 메서드)
      ↓
SymbolTable에 등록 (프로젝트 단위 인메모리)
      ↓
Implementation Map 구축 (interface FQCN → impl FQCN[])
```

처리 순서: import 그래프의 역순(leaf → root)으로 빌드.

### 3.2 Call Chain Resolution

| 단계 | 처리 | 출력 |
|------|------|------|
| 1. 직접 호출 해석 | SymbolTable에서 callee 확정 | resolved call edge |
| 2. 인터페이스 해석 | implementations map 조회 | resolved impl call (confidence -0.1) |
| 3. 프로퍼티 전파 | properties map 조회 | URL/host 확정 |
| 4. 체인 전파 | depth ≤ 3, confidence × 0.9^depth | propagated relation |

### 3.3 프로퍼티 전파

우선순위: `application.yml` > `application-{profile}.yml` > `.env` > 코드 내 기본값

### 3.4 인터페이스 매핑

- 단일 구현체: confidence 유지
- 다중 구현체: confidence -0.1, `ambiguous: true`
- 0개 구현체: unresolved 유지

## 4. 데이터 모델

### 4.1 code_call_edges.metadata 확장

```json
{
  "resolvedUrl": "http://payment:8080/api/charge",
  "resolvedVia": "property",
  "callChainDepth": 2,
  "intermediateMethod": "PaymentClient.charge()",
  "interfaceImpl": "PaymentClientImpl",
  "ambiguous": false
}
```

### 4.2 Symbol Table — 인메모리, 추론 실행 중에만 유지 (1000파일 ~50MB)

## 5. API 변경

### 5.1 POST /api/inference/run 확장

```json
{
  "codeOptions": {
    "interProcedural": true,
    "maxCallChainDepth": 3,
    "resolveProperties": true
  }
}
```

## 6. 수용 기준

| ID | 기준 |
|----|------|
| T1 | 메서드 호출 체인(depth 2)을 추적하여 HTTP 호출 관계를 발견한다 |
| T2 | `@Value("${property}")` → application.yml 값으로 URL 확정, confidence 0.85+ |
| T3 | FeignClient 인터페이스 → 단일 구현체 매핑 시 대상 서비스 식별 |
| T4 | 다중 구현체 시 `ambiguous: true` 마킹, confidence -0.1 |
| T5 | maxCallChainDepth 초과 시 추적 중단 |
| T6 | `interProcedural: false`일 때 기존 동작과 동일 (회귀 방지) |
| T7 | 1000 파일 프로젝트에서 Symbol Table 구축 30초 이내 |

## 7. 후속 범위

- 다중 모듈 프로젝트 간 Symbol Table 연결
- Generic 타입 파라미터 해석
- Symbol Table 디스크 캐싱 (대규모 프로젝트용)
