# Archi.Navi — 추론 엔진 고도화

작성일: 2026-03-08
최종 갱신: 2026-03-31
문서 버전: v1.1
상태: Extension / Partially Shipped / Partially Deprecated

> 기존 추론 엔진(`docs/design/03-inference-engine.md` v4.0)의 확장 설계.
> 본 문서는 추론 정밀도·품질을 구조적으로 끌어올리기 위한 5가지 핵심 개선을 다룬다.
>
> **Note (2026-04-05)**: 섹션 4(LLM 추론 부스터)와 섹션 7(전체 파이프라인 통합 뷰)은 Intent-Centric Proof Engine + Smart Proof Engine으로 대체되어 deprecated 처리되었다. 섹션 2(Inter-procedural AST), 3(Cross-Signal Validation), 5(프레임워크 플러그인), 6(피드백 루프)은 여전히 유효하다.

---

## 1. 설계 목표

| 목표 | 기준 상태 | 개선 후 |
|------|------|---------|
| 코드 시그널 정밀도 | 파일 단위 AST (변수 추적 제한) | Inter-procedural 분석 + 프로퍼티 전파 |
| 시그널 간 정합성 | 독립 수집 → 독립 후보 | 교차 검증으로 신뢰도 동적 조정 |
| LLM 활용 범위 | 후보 필터링(post-filter)만 | 추론 부스터 + 관계 설명 + 도메인 라벨 정제 |
| 프레임워크 확장성 | 패턴 하드코딩 | 플러그인 아키텍처로 커뮤니티 확장 |
| 학습 능력 | 없음 | 승인/거절 패턴 기반 신뢰도 자동 보정 |

**최종 목표: 전체 Relation의 90~95% 자동 추론 + 노이즈 50% 이상 감소**

---

## 2. Inter-procedural AST 분석 (기존 2-1 확장)

### 2.1 한계

AST 분석은 **파일 단위(intra-file)** 분석에 그친다.

| 한계 | 예시 | 영향 |
|------|------|------|
| 메서드 호출 체인 미추적 | `service.callPayment()` → `callPayment() { restTemplate.get(url) }` | call 관계 누락 |
| Spring 프로퍼티 미연결 | `@Value("${payment.url}")` → application.yml 값 | URL 미확정 |
| 인터페이스 구현체 미매핑 | `FeignClient` 인터페이스 → 실제 호출 대상 | 대상 서비스 미식별 |
| 추상 클래스 상속 미추적 | `AbstractApiClient.call()` → 하위 구현 | 호출 패턴 누락 |

### 2.2 아키텍처

```
Phase 1 (기본)                     Phase 2 (확장)
┌────────────────┐                ┌────────────────────────────┐
│ 파일 단위 AST  │                │ Multi-file Symbol Table    │
│ - 어노테이션   │                │ - 클래스/인터페이스 계보   │
│ - 변수 추적    │                │ - 메서드 시그니처 맵       │
│ - import 그래프 │               │ - 프로퍼티 바인딩 맵       │
└───────┬────────┘                └──────────┬─────────────────┘
        │                                    │
        ▼                                    ▼
   code_artifacts                  ┌─────────────────────┐
   code_call_edges                 │ Call Chain Resolver  │
   evidences                       │ - 메서드 호출 체인   │
                                   │ - 프로퍼티 전파      │
                                   │ - 인터페이스 매핑    │
                                   └──────────┬──────────┘
                                              │
                                              ▼
                                   code_call_edges (확장)
                                   + cross_file_evidences
```

### 2.3 Multi-file Symbol Table

```typescript
interface SymbolTable {
  classes: Map<string, ClassSymbol>;        // FQCN → 클래스 정보
  interfaces: Map<string, InterfaceSymbol>; // FQCN → 인터페이스 정보
  methods: Map<string, MethodSymbol>;       // FQCN.method → 메서드 시그니처
  properties: Map<string, string>;          // property key → resolved value
  implementations: Map<string, string[]>;   // interface FQCN → impl FQCN[]
}

interface ClassSymbol {
  fqcn: string;
  filePath: string;
  superClass?: string;
  interfaces: string[];
  annotations: AnnotationInfo[];
  fields: FieldInfo[];
  methods: MethodSymbol[];
}

interface MethodSymbol {
  name: string;
  ownerFqcn: string;
  parameters: ParameterInfo[];
  returnType: string;
  callSites: CallSiteInfo[];    // 이 메서드가 호출하는 다른 메서드들
  annotations: AnnotationInfo[];
}
```

### 2.4 Call Chain Resolution 알고리즘

```
입력: code_call_edges (파일 단위 결과) + SymbolTable (전체 프로젝트)

1. 직접 호출 확인:
   callerMethod.callSites.forEach(site => {
     resolved = symbolTable.methods.get(site.targetFqcn + "." + site.methodName)
     if (resolved) → 직접 연결
   })

2. 인터페이스 → 구현체 해소:
   if (site.targetType is interface) {
     impls = symbolTable.implementations.get(site.targetType)
     impls.forEach(impl => 간접 호출 엣지 생성, confidence -= 0.1)
   }

3. 프로퍼티 전파:
   if (site.argument matches "${property.key}") {
     value = symbolTable.properties.get(key)
     site.resolvedUrl = value
   }

4. 호출 체인 전파 (최대 깊이 3):
   if (resolved.method has HTTP call) {
     propagate relation to original caller
     confidence = base × (0.9 ^ depth)
   }
```

### 2.5 프로퍼티 전파 규칙

| 소스 | 우선순위 | 예시 |
|------|---------|------|
| application.yml | 1 (최고) | `payment.service.url: http://payment:8080` |
| application-{profile}.yml | 2 | 프로파일별 오버라이드 |
| .env | 3 | `PAYMENT_URL=http://payment:8080` |
| 코드 내 기본값 | 4 (최저) | `@Value("${payment.url:http://localhost:8080}")` |

### 2.6 신뢰도 조정

| 분석 유형 | 기존 Confidence | 개선 Confidence |
|-----------|----------------|----------------|
| 직접 호출 (파일 내) | 0.8-0.9 | 0.9-0.95 |
| 프로퍼티 전파 URL | 0.5 (미확정) | 0.85 (확정) |
| 인터페이스 → 단일 구현체 | 0.7 | 0.9 |
| 인터페이스 → 다중 구현체 | 0.7 | 0.75 (ambiguity) |
| 호출 체인 (depth 1) | 미감지 | 0.8 |
| 호출 체인 (depth 2) | 미감지 | 0.72 |
| 호출 체인 (depth 3) | 미감지 | 0.65 |

---

## 3. Cross-Signal Validation (교차 검증)

### 3.1 핵심 아이디어

config, code, db 시그널 수집기는 독립적으로 후보를 생성한다.
**같은 관계를 여러 시그널이 지지하면 신뢰도를 올리고, 모순되면 내린다.**

### 3.2 Validation Matrix

```
                    Config에서   Code에서   DB에서
                    발견됨       발견됨     발견됨
service→database
  - config only     0.9          -          -        → 0.9 (유지)
  - config+code     0.9          0.8        -        → 0.95 (부스트)
  - config+code+db  0.9          0.8        0.95     → 0.98 (강한 부스트)
  - config only     0.9          미발견     -        → 0.75 (stale config 의심)
  - code only       -            0.8        -        → 0.8 (유지)

service→service (call)
  - feign+gateway   0.8(gw)      0.8(feign) -        → 0.92 (부스트)
  - code only       -            0.7        -        → 0.7 (유지)
```

### 3.3 Bayesian 신뢰도 업데이트 모델

```
P(relation | signal₁, signal₂, ..., signalₙ)

prior = max(individual_confidences)

// 지지 시그널 수에 따른 부스트
support_count = count(signals supporting this relation)
boost = 1 - (1 - BOOST_FACTOR) ^ (support_count - 1)
// BOOST_FACTOR = 0.3

// 모순 시그널에 따른 페널티
contradiction_count = count(signals contradicting this relation)
penalty = PENALTY_FACTOR ^ contradiction_count
// PENALTY_FACTOR = 0.85

final_confidence = clamp(prior + boost - (1 - penalty), 0.1, 0.99)
```

### 3.4 모순 감지 규칙

| 모순 유형 | 조건 | 페널티 |
|-----------|------|--------|
| Stale Config | config에서 DB 연결 발견 + code에서 해당 DB 접근 코드 미발견 | -0.15 |
| Phantom Call | code에서 HTTP 호출 발견 + 대상 서비스에 해당 endpoint 미존재 | -0.1 |
| Orphan FK | DB FK 존재 + 어떤 서비스도 해당 테이블에 접근하지 않음 | -0.05 |
| Dead Topic | config에서 topic 설정 + code에서 produce/consume 미발견 | -0.15 |

### 3.5 처리 파이프라인

```
1. 각 시그널 수집기가 독립 실행 (기존과 동일)
       ↓
2. Cross-Signal Validator 실행
   - 동일 (subject, object, relationType) 그룹화
   - 시그널 소스 목록 수집
   - 지지/모순 판정
   - 신뢰도 재계산
       ↓
3. relation_candidates 업데이트
   - confidence 갱신
   - metadata.crossValidation 추가
       ↓
4. 승인 UI에서 교차 검증 정보 표시
```

### 3.6 데이터 모델 확장

```json
// relation_candidates.metadata에 추가
{
  "crossValidation": {
    "supportingSources": ["config", "code", "db"],
    "contradictions": [
      {
        "type": "STALE_CONFIG",
        "detail": "config에서 payment_db 연결 발견, code에서 미사용",
        "penalty": -0.15
      }
    ],
    "originalConfidence": 0.8,
    "adjustedConfidence": 0.92,
    "validatedAt": "2026-03-08T12:00:00Z"
  }
}
```

---

## 4. LLM 추론 부스터

> **Deprecated (2026-04-05)**: 이 섹션은 Smart Proof Engine의 Category A/B로 대체되었다.
> 레거시 원본: [deprecated/07-llm-boost-and-pipeline-view-legacy.md](./deprecated/07-llm-boost-and-pipeline-view-legacy.md)
> 현행 설계: [13-smart-proof-engine-escalation.md](./13-smart-proof-engine-escalation.md)

---

## 5. 프레임워크 플러그인 시스템

### 5.1 문제

새 프레임워크(gRPC, GraphQL, tRPC) 지원을 추가하려면 `packages/inference/src/code/scanners/` 하드코딩 수정 필요.

### 5.2 플러그인 인터페이스

```typescript
interface FrameworkPlugin {
  id: string;                         // "spring-boot", "nestjs"
  version: string;
  languages: Language[];
  regexPatterns: SignalPattern[];
  astExtractor?: AstExtractorFn;
  configParsers?: ConfigParser[];
  confidenceRules?: ConfidenceRule[];
  detector: ProjectDetector;          // 프로젝트별 자동 감지
}

interface SignalPattern {
  kind: SignalKind;
  pattern: RegExp;
  captureGroups: Record<string, number>;
  baseConfidence: number;
}
```

### 5.3 빌트인 → 플러그인 마이그레이션

| 기존 파일 | 변환 대상 플러그인 |
|-----------|-------------------|
| `scanners/javaKotlin.ts` | `spring-boot` + `java-common` |
| `scanners/typeScript.ts` | `express` + `nestjs` |
| `scanners/python.ts` | `fastapi` + `flask` |

### 5.4 확장 가능 프레임워크

| 프레임워크 | 언어 | 추가 시그널 |
|-----------|------|------------|
| gRPC | Java/Go/Python | `.proto` → `call` + `expose` |
| GraphQL | TypeScript/Java | schema → `expose` |
| tRPC | TypeScript | router → `expose` + `call` |
| Quarkus | Java | CDI → Spring 유사 패턴 |
| RabbitMQ | 다수 | exchange/queue → `produce`/`consume` |

---

## 6. 추론 피드백 루프

### 6.1 핵심 아이디어

피드백 루프는 relation과 domain을 같은 저장소/초기화 경로로 섞지 않는다. relation feedback 구현 축은 유지하되, 이번 closure에서는 **domain feedback를 Track A 전용 계약으로 분리**하고, 그 결과를 **다음 domain run부터만** 반영하도록 고정한다.

### 6.2 피드백 수집

```
relation approval/rejection
      ↓
relation key = (relationType, sourceFamily, signalKind)
      ↓
relationFeedbackAdjustments

domain approval/rejection (Track A only)
      ↓
domain key = TRACK_A:{primaryDomainId}:{purityBucket}
      ↓
domainFeedbackAdjustments
```

- relation feedback와 domain feedback는 `domain_inference_profiles`에서 별도 필드로 저장한다.
- domain feedback 집계/적용 대상은 Track A domain candidate only 이다.
- Track B / domain discovery는 feedback 집계 소스도, 적용 대상도 아니다.
- 승인 직후 기존 결과를 다시 계산하지 않고, domain feedback는 다음 Track A domain run부터 누적 결과를 사용한다.
- Settings 필수 범위는 relation/domain summary 및 reset 분리다. hint/detail table 확장은 선택 범위다.

### 6.3 신뢰도 자동 보정

```typescript
function applyFeedbackAdjustment(base: number, feedback: FeedbackStats): number {
  if (feedback.total < 10) return base;  // 최소 10건 이상
  const adjustment = (feedback.approvalRate - 0.5) * 0.15; // MAX_ADJUSTMENT = 0.15
  return clamp(base + adjustment, 0.1, 0.99);
}
```

**예시:**
- relation key `CALL:code:call` 승인율 90% → +0.06
- domain key `TRACK_A:domain-order:HIGH` 승인율 30% → -0.03

### 6.4 적용 순서와 UI 범위

- relation 경로에서는 기존처럼 `base confidence → feedback adjustment → cross-validation` 순서를 유지할 수 있다.
- domain 경로에서는 Track A scoring 내부의 단일 단계에서만 domain feedback를 적용하고, 승인 직후 소급 반영은 금지한다.
- Settings 필수 범위는 `relation summary + relation reset`, `domain summary + domain reset` 분리다.
- Approval 필수 범위는 domain 후보 승인 경로에 feedback 집계를 연결하는 것까지다.
- domain hint/detail table, Track B feedback은 후속 범위다.
- code-origin relation feedback의 framework/language key 세분화는 `docs/spec/36-relation-feedback-key-specialization-spec.md`에서 후속 계약으로 분리되어 구현되었다.

---

## 7. 전체 파이프라인 통합 뷰

> **Deprecated (2026-04-05)**: 기존 Signal→Feedback→Cross-validation→Candidate→LLM Filter 흐름은 Intent-Centric Proof Engine의 intent→proof→candidate 흐름으로 대체되었다.
> 레거시 원본: [deprecated/07-llm-boost-and-pipeline-view-legacy.md](./deprecated/07-llm-boost-and-pipeline-view-legacy.md)
> 현행 실행 순서: [12-intent-centric-proof-engine-adoption-plan.md](./12-intent-centric-proof-engine-adoption-plan.md)

현행 파이프라인:

```
extraction → cache update → intent creation → proof resolution
  → frontier/projection → optional agent → optional Smart escalation
  → proof re-run → candidate projection → approval
```

---

## 참고 문서

| 문서 | 설명 |
|------|------|
| [03-inference-engine.md](./03-inference-engine.md) | 추론 엔진 기준 문서 v4.0 |
| [13-smart-proof-engine-escalation.md](./13-smart-proof-engine-escalation.md) | Smart Proof Engine 설계 (LLM 부스터 후속) |
| [../spec/17-inter-procedural-ast-spec.md](../spec/17-inter-procedural-ast-spec.md) | Inter-procedural AST SPEC |
| [../spec/18-cross-signal-validation-spec.md](../spec/18-cross-signal-validation-spec.md) | Cross-Signal Validation SPEC |
| [../spec/20-framework-plugin-system-spec.md](../spec/20-framework-plugin-system-spec.md) | 프레임워크 플러그인 SPEC |
| [../spec/22-inference-feedback-loop-spec.md](../spec/22-inference-feedback-loop-spec.md) | 피드백 루프 SPEC |
