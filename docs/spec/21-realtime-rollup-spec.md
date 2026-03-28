# 21. Delta Rollup + 실시간 그래프 갱신 (SPEC) (Roadmap 4-5)

상태: Draft
작성일: 2026-03-08

## 1. 목적

관계 승인/삭제 시 해당 rollup 엣지만 **delta update** + **WebSocket push**로 실시간 그래프 갱신.

## 2. 범위

### 포함
- 단일/일괄 관계 승인 시 delta rollup update
- WebSocket 기반 실시간 그래프 변경 push
- 프론트엔드 실시간 반영

### 제외: 다중 사용자 동시 편집, 정합성 자동 검증

## 3. Delta Rollup 알고리즘

### 승인 시
```
관계의 rollup 레벨 판별 → 기존 엣지 조회
EXISTS → weight += 1, confidence 재계산
NOT EXISTS → 새 rollup 엣지 생성
graph_stats delta 업데이트 → WebSocket ROLLUP_EDGE_UPDATED
```

### 삭제 시
```
rollup 엣지의 baseRelationIds에서 제거
남은 관계 있음 → weight -= 1 / 없음 → 엣지 삭제
graph_stats 업데이트 → WebSocket ROLLUP_EDGE_REMOVED
```

## 4. WebSocket 프로토콜

연결: `ws://localhost:3000/ws/rollup?workspaceId={id}`

| 이벤트 | 페이로드 |
|--------|---------|
| `ROLLUP_EDGE_UPDATED` | `{ edge, delta }` |
| `ROLLUP_EDGE_REMOVED` | `{ edgeId }` |
| `ROLLUP_BATCH_UPDATED` | `{ edges[], removed[] }` |

## 5. 수용 기준

| ID | 기준 |
|----|------|
| T1 | 단일 승인 시 full rebuild 없이 rollup 엣지 업데이트 |
| T2 | 삭제 시 weight 감소, 0이 되면 엣지 삭제 |
| T3 | WebSocket 연결 시 실시간 그래프 변경 반영 |
| T4 | 일괄 승인(10건)이 개별 대비 50%+ 빠름 |
| T5 | delta 후 full rebuild와 동일 상태 보장 |
| T6 | WebSocket 미연결 시 기존 폴링 방식 동작 |
