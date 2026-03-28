# 21. Delta Rollup + 실시간 그래프 갱신 (SPEC) (Roadmap 4-5)

상태: Implemented
작성일: 2026-03-08
최종 정합화: 2026-03-28

## 1. 목적

관계 승인/추가/삭제와 endpoint 매핑 결과를 full rebuild 없이 증분 rollup에 반영하고, Mapping UI는 **SSE(EventSource) notification + 현재 뷰 refetch**로 최신 상태를 따라간다.

## 2. shipped contract

### 포함
- 관계 후보 승인, 수동 relation 추가, 승인된 base relation 삭제 시 `incrementalRebuild` 기반 delta rollup 적용
- `map-endpoints`가 여러 relation change event를 한 번에 모아 batch delta로 적용
- 서버는 `GET /api/rollup-events?workspaceId={id}` SSE 스트림으로 `rollup-change` notification 발행
- 클라이언트는 `rollup-change`를 받으면 현재 workspace 뷰를 refetch
- `EventSource` 미지원, 생성 실패, SSE 연결 에러 시 polling fallback으로 자동 전환

### 제외
- WebSocket 연결 및 edge delta payload 직접 push
- 변경된 edge만으로 클라이언트 그래프를 부분 patch 하는 프로토콜
- 다중 사용자 충돌 해결, presence, collaborative editing

## 3. 서버 동작 계약

### 3.1 변경 이벤트 입력
`applyRollupChanges(db, workspaceId, events)`는 rollup 영향이 있는 mutation마다 `ChangeEvent[]`를 받아 처리한다.

- 관계 후보 승인: `RELATION_APPROVED`
- 수동 relation 추가: `RELATION_APPROVED`
- 승인된 base relation 삭제: `RELATION_DELETED`
- `expose` 변경: `EXPOSE_CHANGED`
- endpoint 다중 매핑: 여러 `RELATION_APPROVED` 이벤트를 하나의 배열로 전달

### 3.2 증분 처리
```
mutation 발생
→ createRelationChangeEvent(...) / 관련 change event 구성
→ applyRollupChanges(db, workspaceId, events)
→ incrementalRebuild(db, workspaceId, events)
→ publishRollupChangeNotification(workspaceId, events)
```

서버는 변경된 edge 본문을 push하지 않고, 아래 notification만 발행한다.

## 4. SSE 프로토콜

연결: `GET /api/rollup-events?workspaceId={id}`

| 이벤트 | 페이로드 |
|--------|---------|
| `connected` | `{ type: 'ROLLUP_EVENTS_CONNECTED', workspaceId, connectedAt }` |
| `rollup-change` | `{ type: 'ROLLUP_CHANGED', workspaceId, eventCount, events, emittedAt }` |

비고:
- `events`는 rollup 재계산의 원인이 된 change event 목록이다.
- 서버는 `ROLLUP_EDGE_UPDATED` 같은 edge delta payload를 보내지 않는다.

## 5. 클라이언트 동작 계약

### 5.1 기본 경로
- 브라우저가 `EventSource`를 지원하면 SSE에 연결한다.
- `rollup-change`를 받으면 현재 Mapping 뷰 데이터를 다시 fetch 한다.

### 5.2 fallback 경로
- `EventSource`가 없으면 polling으로만 동작한다.
- `EventSource` 생성 실패 시 polling으로 전환한다.
- SSE 연결 중 `error` 이벤트가 나면 즉시 1회 재조회 후 polling으로 전환한다.
- fallback polling 기본 주기: `5000ms`

## 6. 일괄 delta 처리

`POST /api/inference/candidates/:id/map-endpoints`는 여러 endpoint를 한 번에 승인/매핑할 수 있으며, 각 relation change event를 개별 생성한 뒤 `applyRollupChanges(..., events)`를 **1회만 호출**해 batch delta를 적용한다.

이 계약으로 endpoint 매핑은 다음을 만족한다.
- 여러 endpoint 승인 시 sequential rebuild 대신 batch rebuild로 처리
- relation type은 매핑된 atomic relation에도 그대로 유지
- 최종 응답은 `createdRelationCount`, `resolvedRelationCount`, `reusedRelationCount`로 정리

## 7. 수용 기준 및 검증

| ID | 기준 | 검증 근거 |
|----|------|-----------|
| T1 | 단일 승인/추가 mutation은 full rebuild 없이 delta rollup을 적용한다. | 후보 승인, 수동 relation 추가 route 테스트와 `applyRollupChanges` 경로 검증 |
| T2 | 승인된 base relation 삭제 시 weight/provenance/graph stats가 감소 또는 제거되며 full rebuild와 동일 상태를 유지한다. | `incrementalRebuild` parity 테스트(T18, T19) |
| T3 | 실시간 반영 계약은 WebSocket이 아니라 SSE notification + client refetch 이다. 서버는 `rollup-change`만 발행하고 클라이언트는 현재 뷰를 재조회한다. | `rollup-events`, `rollup-event-source`, `rollup-graph` 테스트 |
| T4 | 10건 batch delta는 기록된 측정 기준으로 sequential avg `0.694ms`, batch avg `0.138ms`, improvement `80.06%`를 만족하며, batch와 sequential 최종 상태 동일성을 함께 검증한다. | `measure-batch-vs-sequential.mts` 측정 기준 |
| T5 | approval/addition/delete parity와 endpoint batch mapping contract가 보강되어, 승인/삭제는 full rebuild parity를 확인하고 추가/매핑은 올바른 delta event 적용을 확인한다. | `incrementalRebuild` parity 테스트(T18~T21), 후보 승인/수동 추가/삭제 route 테스트, `map-endpoints` batch 테스트 |
| T6 | `EventSource` 미지원, 생성 실패, SSE 에러 시 polling fallback이 자동으로 이어진다. | `rollup-event-source`, `rollup-graph` fallback 테스트 |

## 8. 남은 리스크

- 실시간 갱신은 edge delta push가 아니라 refetch 기반이므로, 매우 큰 그래프에서는 재조회 비용이 다음 최적화 포인트다.
- polling fallback은 안전망이지만 SSE 대비 반영 지연이 있을 수 있다.
