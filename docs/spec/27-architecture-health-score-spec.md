# 27. Architecture Health Score (SPEC) (Roadmap 5-5)

상태: Backlog Draft
작성일: 2026-03-08

현행 메모:
- 일부 계산 재료는 현재 모델에서 얻을 수 있다.
- 다만 건강도 점수, 추천 메시지, API/UI/CLI 계약은 아직 shipped 범위가 아니므로 backlog SPEC으로만 유지한다.

## 1. 목적

서비스별/워크스페이스별 **구조적 건강도 점수** 산출 → 아키텍처 품질 수치화.

## 2. 범위

### 포함
- 6개 지표 계산 + 종합 점수 + 등급 판정
- 개선 추천 메시지
- Web UI 위젯, CLI: `anavi health --workspace <id>`

### 제외: 시계열 추적, 알림, 커스텀 지표

## 3. 건강도 지표

| 지표 | 계산 | 가중치 | 방향 |
|------|------|--------|------|
| 결합도 | (outDegree + inDegree) / totalServices | 0.25 | 낮을수록 |
| 도메인 순수도 | max(affinity) | 0.20 | 높을수록 |
| 순환 의존 | 참여 cycle 수 | 0.20 | 0 이상적 |
| Hub 집중도 | max(inDegree) / avg(inDegree) | 0.15 | 낮을수록 |
| Evidence 커버리지 | with_evidence / total | 0.10 | 높을수록 |
| Approval 비율 | approved / (approved + pending) | 0.10 | 높을수록 |

## 4. 등급

```
90+ : Excellent | 70-89: Good | 50-69: Needs Attention | <50: Critical
```

## 5. API

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/health?workspaceId=` | 워크스페이스 건강도 |
| GET | `/api/health/:objectId` | 서비스별 건강도 |

## 6. 수용 기준

| ID | 기준 |
|----|------|
| T1 | 6개 지표 모두 0-100 정규화 |
| T2 | 종합 점수 = 가중 평균 |
| T3 | 등급 올바르게 판정 |
| T4 | 순환 의존 서비스의 Cycles 점수 ≈ 0 |
| T5 | 가장 낮은 지표 기반 추천 메시지 |
| T6 | CLI 명령어 동작 |
