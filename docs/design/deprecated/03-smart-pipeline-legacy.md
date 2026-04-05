# [Deprecated] Smart 추론 파이프라인 (Pair-first)

> **상태: Deprecated (2026-04-05)**
> 이 문서는 `03-inference-engine.md`에서 분리된 레거시 Smart 파이프라인 설계다.
> Intent-Centric Proof Engine(09-12) 도입 이후, Smart는 proof engine 위의 escalation 레이어로 재설계되었다.
> 현행 Smart 설계는 [13-smart-proof-engine-escalation.md](../13-smart-proof-engine-escalation.md)를 참조한다.
> 관련 SPEC: [53-smart-proof-engine-escalation-spec.md](../../spec/53-smart-proof-engine-escalation-spec.md)

---

## 대체 사유

- pair-first 접근(service pair → endpoint)이 intent-first 접근(intent → proof → candidate)으로 교체됨
- `fallbackReason`(NO_ENDPOINT_OBJECTS 등)이 proof engine의 `frontierReason` 체계로 대체됨
- `analysisMode = pair_pack | agent_assisted | full_agent` 메타데이터가 더 이상 유효하지 않음
- LLM의 역할이 "pair-scoped atomic inference"에서 "frontier-local structured patch proposer"로 변경됨

---

## (아래는 원본 내용)

## Smart 추론 파이프라인

shipped Smart 설계는 "서비스 후보 요약"이 아니라
**service pair 단위 atomic inference**를 중심으로 한다.

### 단계

```text
Phase 1   OpenAPI import
Phase 1.5 Code expose 기반 endpoint bootstrap
Phase 2   Config → LLM → candidate service pairs
Phase 2.5 Pair-scoped evidence pack assembly
Phase 3   Pair → LLM → atomic relation inference
Phase 3.5 Optional deep inspection
```

### Phase별 역할

| 단계 | 역할 |
|------|------|
| `Phase 1` | provider endpoint를 OpenAPI에서 확보 |
| `Phase 1.5` | OpenAPI가 부족한 서비스에 code expose 기반 endpoint bootstrap 적용 |
| `Phase 2` | config 파일로 서비스 쌍과 힌트를 추출 |
| `Phase 2.5` | consumer/provider 양쪽 파일과 endpoint 정보를 pair pack으로 구성 |
| `Phase 3` | pair 단위로 `service -> api_endpoint` 후보를 생성 |
| `Phase 3.5` | 낮은 confidence 또는 부족한 맥락에 대해서만 deep inspection 수행 |

### Smart 후보 metadata의 의미

Smart 후보는 일반 후보와 달리 아래 정보를 함께 가진다.

- `signalKind = smart_pair_atomic`
- `targetType = api_endpoint | service`
- `targetServiceId`
- `analysisMode = pair_pack | agent_assisted | full_agent`
- `fallbackReason?`
- `fallbackContext?`

#### fallback reason

- `NO_ENDPOINT_OBJECTS`
- `PATH_NOT_MATCHED`
- `METHOD_NOT_MATCHED`
- `INSUFFICIENT_CONTEXT`

즉, Smart가 service-level fallback을 만들더라도
"왜 atomic으로 승격되지 못했는지"를 운영자가 추적할 수 있어야 한다.

---

## 관련 레거시 SPEC

- [37-smart-pipeline-atomic-redesign-spec.md](../../spec/deprecated/37-smart-pipeline-atomic-redesign-spec.md)
- [42-agent-assisted-smart-atomic-spec.md](../../spec/deprecated/42-agent-assisted-smart-atomic-spec.md)
- [47-zuul-route-aware-smart-atomic-spec.md](../../spec/deprecated/47-zuul-route-aware-smart-atomic-spec.md)
