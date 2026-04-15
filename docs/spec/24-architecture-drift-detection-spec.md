# 24. Architecture Drift Detection (SPEC) (Roadmap 5-2)

상태: Backlog Draft
작성일: 2026-03-08

현행 메모:
- rollup generation, diff 계산에 필요한 일부 기반은 존재한다.
- 하지만 drift 판정 규칙과 CLI 계약은 아직 shipped 범위가 아니므로 backlog SPEC으로만 유지한다.

## 1. 목적

주기적 추론 실행 후 **이전 스냅샷과 비교**하여 아키텍처 변화(drift)를 자동 감지.

## 2. 범위

### 포함
- rollup generation 간 diff, Drift 유형 분류, 심각도 판정
- CLI: `anavi drift --workspace <id>`

### 제외 (후속): Webhook 알림, 자동 주기 실행, Web UI 대시보드

## 3. Drift 유형

| 유형 | 조건 | 심각도 |
|------|------|--------|
| NEW_DEPENDENCY | 이전에 없던 엣지 | INFO |
| REMOVED_DEPENDENCY | 이전 엣지 소멸 | WARNING |
| CONFIDENCE_SHIFT | 동일 엣지 confidence ≥ 0.2 변화 | INFO |
| DOMAIN_DRIFT | primary domain 변경 | WARNING |
| NEW_CIRCULAR_DEP | 새 순환 의존 | CRITICAL |
| HUB_CONCENTRATION | inDegree 평균 3배+ 증가 | WARNING |

## 4. CLI

```bash
anavi drift --workspace <id>
anavi drift --workspace <id> --compare-with <generation-id>
anavi drift --workspace <id> --min-severity warning
anavi drift --workspace <id> --format json|markdown|table
```

## 5. 수용 기준

| ID | 기준 |
|----|------|
| T1 | 새 엣지가 NEW_DEPENDENCY로 감지 |
| T2 | 삭제 엣지가 REMOVED_DEPENDENCY로 감지 |
| T3 | confidence 차이 ≥ 0.2가 CONFIDENCE_SHIFT로 감지 |
| T4 | 새 순환 의존이 CRITICAL로 감지 |
| T5 | 이전 generation 없을 때 비교 불가 경고 |
| T6 | `--min-severity` 필터링 동작 |
