# Intent Proof Benchmark Gate

## 목적

`ARC-18` cutover gate 전에 현재 워크스페이스에서 intent proof 엔진의 핵심 분기들이 계속 살아 있는지 빠르게 확인한다.

## 실행 명령

```bash
pnpm --filter @archi-navi/inference test:benchmark-gate
```

## 현재 구성

- 진입점: `packages/inference/src/orchestration/intentProofBenchmarkGate.ts`
- 게이트 테스트: `packages/inference/src/__tests__/orchestration/intentProofBenchmarkGate.test.ts`
- 기준선: `packages/inference/src/__tests__/fixtures/intent-proof-benchmark-baseline.v1.json`

## 검증 범위

- HTTP intent의 `CLOSED_ATOMIC`, `FRONTIER`, `REJECTED` 분기
- DB intent의 read/write projection 및 schema ambiguity frontier
- Message publish projection
- Frontier 상태에서 허용된 patch 적용 후 `consume` candidate 회복
- 잘못된 patch 입력의 rejection 보존

## QA 메모

- 명령은 임시 embedded postgres 테스트 DB에 마이그레이션을 적용한 뒤 실행되므로 로컬 개발 DB 상태에 의존하지 않는다.
- 실패 시 Vitest 출력과 함께 scenario id 단위의 mismatch가 노출되므로 `ARC-18` handoff에 그대로 첨부하면 된다.

## Representative Cutover Corpus

- 실 repo 상태가 zero-signal일 때는 대표 코퍼스 기준으로 baseline/candidate contract를 먼저 검증한다.
- 코퍼스 경로: `packages/inference/src/__tests__/fixtures/intent-proof-cutover-representative`
- truth corpus: `packages/inference/src/__tests__/fixtures/intent-proof-cutover-representative.truth.v1.json`
- 실행 명령:

```bash
pnpm --filter @archi-navi/inference test:cutover-fixture
```

- 기대 최소 신호:
  - baseline(`config,db`)는 `service:/gateway -> database:order_db`의 `read`, `write` relation 2개를 생성한다.
  - candidate(`config,code,db`)는 위 2개 relation에 더해 `service:/gateway -> service:/orders`의 `call` relation을 추가해 총 3개 relation을 생성한다.
- 기본 threshold로 cutover report를 계산하면 `recall`은 개선되지만 `approvalCountDelta=1` 때문에 recommendation은 `NO_GO`가 된다. 목적은 pass/fail 샘플이 아니라 non-zero signal 재현이다.
- 이 fixture는 temp workspace + temp embedded postgres DB를 사용하므로 현재 Archi.Navi repo 자체의 scan 결과에 의존하지 않는다.

## Cutover Evidence API

- 실환경 baseline vs candidate artifact가 준비되면 `POST /api/inference/cutover-report`로 동일 snapshot 기준 비교 리포트를 생성할 수 있다.
- 인증은 다른 inference run API와 동일하게 `INFERENCE_RUNS_API_TOKEN` bearer/header 토큰을 사용한다.
- 요청 본문에는 `metadata(commitSha, corpusRef, commands, artifact paths)`, `truth.relations`, `baseline`, `candidate`, `thresholds`를 넣는다.
- 응답에는 precision/recall delta, frontier recoverability, approval workload delta, failedChecks, GO/NO_GO recommendation이 포함된다.
