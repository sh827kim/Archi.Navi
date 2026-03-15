# Archi.Navi — 추론 엔진 고도화

작성일: 2026-03-08
문서 버전: v1.0

> 기존 추론 엔진(`docs/design/03-inference-engine.md` v3.0)의 확장 설계.
> 본 문서는 추론 정밀도·품질을 구조적으로 끌어올리기 위한 5가지 핵심 개선을 다룬다.

---

## 1. 설계 목표

| 목표 | 현재 | 개선 후 |
|------|------|---------|
| 코드 시그널 정밀도 | 파일 단위 AST (변수 추적 제한) | Inter-procedural 분석 + 프로퍼티 전파 |
| 시그널 간 정합성 | 독립 수집 → 독립 후보 | 교차 검증으로 신뢰도 동적 조정 |
| LLM 활용 범위 | 후보 필터링(post-filter)만 | 추론 부스터 + 관계 설명 + 도메인 라벨 정제 |
| 프레임워크 확장성 | 패턴 하드코딩 | 플러그인 아키텍처로 커뮤니티 확장 |
| 학습 능력 | 없음 | 승인/거절 패턴 기반 신뢰도 자동 보정 |

**최종 목표: 전체 Relation의 90~95% 자동 추론 + 노이즈 50% 이상 감소**

---

## 2. Inter-procedural AST 분석 (기존 2-1 확장)

### 2.1 현재 한계

현재 AST 분석은 **파일 단위(intra-file)** 분석에 그친다.

| 한계 | 예시 | 영향 |
|------|------|------|
| 메서드 호출 체인 미추적 | `service.callPayment()` → `callPayment() { restTemplate.get(url) }` | call 관계 누락 |
| Spring 프로퍼티 미연결 | `@Value("${payment.url}")` → application.yml 값 | URL 미확정 |
| 인터페이스 구현체 미매핑 | `FeignClient` 인터페이스 → 실제 호출 대상 | 대상 서비스 미식별 |
| 추상 클래스 상속 미추적 | `AbstractApiClient.call()` → 하위 구현 | 호출 패턴 누락 |

### 2.2 아키텍처

```
Phase 1 (현재)                     Phase 2 (확장)
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

현재 config, code, db 시그널 수집기가 독립적으로 후보를 생성한다.
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

## 4. LLM 추론 부스터 (기존 LLM 필터 확장)

### 4.1 기존 vs 확장

| 구분 | 기존 (후보 필터링) | 확장 (추론 부스터) |
|------|-------------------|-------------------|
| 실행 시점 | 후보 생성 후 | 후보 생성 전/후 모두 |
| 역할 | 후보 타당성 판정 | 의도 분석 + 설명 생성 + 라벨 정제 |
| 입력 | 후보 + evidence | 코드 컨텍스트 + 후보 + 프로젝트 구조 |
| 출력 | accept/reject | 관계 설명, 도메인 라벨, 보완 후보 |

### 4.2 LLM 부스터 기능 3가지

#### 4.2.1 코드 의도 분석 (Pre-inference LLM)

Regex/AST로 잡기 어려운 패턴을 LLM이 보완한다.

**대상 패턴:**
- 동적 URL 구성: `baseUrl + "/" + serviceName + "/api/orders"`
- 리플렉션 기반 호출
- 커스텀 HTTP 클라이언트 래퍼

**실행 방식:**
```
1. AST 분석에서 "미확정" 시그널 수집 (confidence < 0.5)
       ↓
2. 해당 파일의 관련 코드 컨텍스트 추출 (±30 lines)
       ↓
3. LLM 호출 → 보완 후보 생성
   - confidence: 0.5~0.7 (LLM 기반이므로 중간 수준)
   - metadata.source: "LLM_BOOST"
```

#### 4.2.2 관계 설명 자동 생성

각 relation_candidate에 "왜 이 관계가 존재하는가"를 자연어로 생성.

```
입력: subject, object, relationType, evidences
LLM 출력: "order-service는 주문 결제 시 payment-service의 charge API를 호출합니다."
저장: relation_candidates.metadata.llmExplanation
```

#### 4.2.3 도메인 라벨 정제

Track B Discovery의 label_candidates를 자연스러운 이름으로 변환.

```
입력: cluster members + label_candidates + table/topic prefixes
LLM 출력: { "suggestedName": "주문 관리", "suggestedEnglishName": "Order Management" }
저장: domain_discovery_memberships.metadata.llmLabel
```

### 4.3 배치 최적화

```
기존: 후보 1건씩 개별 LLM 호출
개선: 같은 subject 서비스의 후보들을 그룹화 → 맥락 포함 배치 호출
배치 크기: 5~10 후보/호출 (토큰 제한 고려)
```

### 4.4 비용 제어

| 파라미터 | 기본값 | 설명 |
|---------|--------|------|
| `llm_boost_enabled` | false | LLM 부스터 활성화 여부 |
| `llm_boost_threshold` | 0.5 | 이 confidence 미만 시그널만 LLM 분석 |
| `llm_explanation_enabled` | true | 관계 설명 생성 여부 |
| `llm_label_enabled` | true | 도메인 라벨 정제 여부 |
| `llm_max_calls_per_run` | 50 | 추론 1회당 최대 LLM 호출 수 |

---

## 5. 프레임워크 플러그인 시스템

### 5.1 현재 문제

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

사용자가 후보를 승인/거절할 때마다, **같은 유형의 시그널에 대한 기본 신뢰도를 자동 조정**.

### 6.2 피드백 수집

```
승인/거절 이벤트
      ↓
key = (signalKind, relationType, framework, language)
value = { approved, rejected, total, approvalRate }
      ↓
domain_inference_profiles.feedbackAdjustments에 저장
```

### 6.3 신뢰도 자동 보정

```typescript
function adjustedConfidence(base: number, feedback: FeedbackStats): number {
  if (feedback.total < 10) return base;  // 최소 10건 이상
  const adjustment = (feedback.approvalRate - 0.5) * 0.15; // MAX_ADJUSTMENT = 0.15
  return clamp(base + adjustment, 0.1, 0.99);
}
```

**예시:**
- `call:code:spring-boot:java` 승인율 90% → +0.06
- `depend_on:config:docker-compose` 승인율 30% → -0.03

---

## 7. 전체 파이프라인 통합 뷰

```
┌─────────────────────────────────────────────────────────────┐
│                    Enhanced Pipeline                         │
│                                                             │
│  ① Signal Collection (기존 + 확장)                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐   │
│  │ Code     │ │ Config   │ │ DB Schema│ │ LLM Boost    │   │
│  │ (Inter-  │ │ Signals  │ │ Signals  │ │ (미확정 시그널│   │
│  │ procedural)│          │ │          │ │  보완)       │   │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └──────┬───────┘   │
│       │             │            │               │          │
│       ▼             ▼            ▼               ▼          │
│  ② Cross-Signal Validation                                  │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ 동일 관계 그룹화 → 지지/모순 판정 → 신뢰도 재계산    │   │
│  └───────────────────────┬──────────────────────────────┘   │
│                          │                                  │
│                          ▼                                  │
│  ③ Candidate Generation + LLM Explanation                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ relation_candidates + 자연어 설명 + 교차 검증 정보    │   │
│  └───────────────────────┬──────────────────────────────┘   │
│                          │                                  │
│                          ▼                                  │
│  ④ LLM Candidate Filter (기존)                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ 배치 그룹화 → 맥락 포함 평가 → accept/reject         │   │
│  └───────────────────────┬──────────────────────────────┘   │
│                          │                                  │
│                          ▼                                  │
│  ⑤ Approval + Feedback Loop                                 │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ 승인 UI → 확정 → rollup rebuild                       │   │
│  │       → 피드백 집계 → 신뢰도 자동 보정                │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## 참고 문서

| 문서 | 설명 |
|------|------|
| [03-inference-engine.md](./03-inference-engine.md) | 기존 추론 엔진 설계 v3.0 |
| [04-query-engine.md](./04-query-engine.md) | 쿼리 엔진 (추론 결과 활용) |
| [spec/18-inter-procedural-ast-spec.md](../spec/18-inter-procedural-ast-spec.md) | Inter-procedural AST SPEC |
| [spec/19-cross-signal-validation-spec.md](../spec/19-cross-signal-validation-spec.md) | Cross-Signal Validation SPEC |
| [spec/20-llm-inference-boost-spec.md](../spec/20-llm-inference-boost-spec.md) | LLM 추론 부스터 SPEC |
| [spec/21-framework-plugin-system-spec.md](../spec/21-framework-plugin-system-spec.md) | 프레임워크 플러그인 SPEC |
| [spec/23-inference-feedback-loop-spec.md](../spec/23-inference-feedback-loop-spec.md) | 피드백 루프 SPEC |
