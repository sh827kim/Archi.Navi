# 13. Code Signal 기반 Relation 후보 추론 (SPEC)

상태: Implemented

## 목표
- `mode=code`만 실행해도 `relation_candidates`가 생성되어야 한다.
- 설정 파일(`application.yml`, `docker-compose.yml`, K8s manifest)이 없거나 미정인 프로젝트에서도 후보 추론이 가능해야 한다.
- Code Signal 추출 결과(`code_artifacts`, `code_call_edges`, `evidences`)를 활용하여 실제 의존성 후보를 만든다.

## 배경
- (기존) `/api/inference/run`의 `relationCandidatesCreated`는 `config + db` 결과만 합산했고,
  `code` 모드는 신호(artifacts/edges/evidences)만 저장하여 config가 없는 리포에서 “후보 0개”가 빈번하게 발생했다.
- (현재) `code` 모드도 `relation_candidates` 생성에 참여하며, `relationCandidatesCreated = config + db + code`로 합산한다.

## 입력/출력
### 입력
- `workspaceId`: 대상 워크스페이스
- `repoRoot`: 코드 스캔 대상 루트 (로컬 경로)

### 출력
- 생성된 `relation_candidates` 수
- 생성된 topic Object 수(필요 시)

## 후보 생성 규칙
### 1) 후보 생성 대상 kind
- `call`: 서비스 → (가능하면 api_endpoint) 또는 서비스 후보 생성
- `produce`: 서비스 → topic/queue 후보 생성
- `consume`: 서비스 → topic/queue 후보 생성

제외:
- `expose`: 실제 의존성 흐름이 아니라 “노출”이므로 후보 생성에서 제외한다.
- 그 외 kind(`db_mapping`, `db_read`, `db_write` 등)는 본 SPEC 범위에서는 후보 생성 대상에서 제외한다(별도 SPEC으로 확장).

### 2) Caller(주체) 결정
- `code_call_edges.callerArtifactId -> code_artifacts.ownerObjectId`를 subject로 사용한다.
- `ownerObjectId`가 없으면 후보 생성에서 스킵한다.

### 3) Target(대상) 결정
#### call
- `evidences.metadata.kind === "call"` 인 edge만 처리한다.
- `calleeSymbol`에서 타겟 서비스 후보를 추출한다:
  - URL 형태(`http(s)://...`, `lb://...`)는 hostname을 사용한다.
  - FeignClient 등 서비스명 직접 표기(`payment-service`)는 심볼 자체를 후보로 사용한다.
- hostname 후보는 `.` 포함 시 첫 세그먼트(예: `svc.ns.svc` → `svc`)도 추가 후보로 고려한다.
- 타겟 서비스는 `objects(objectType='service')`의 `name`과
  - 대소문자 무시 exact match
  - `[-_]` 제거 정규화 match
  로 매칭한다.

스킵:
- `calleeSymbol`이 `/api/...` 같이 path-only 인 경우는 타겟 서비스를 식별할 수 없으므로 기본적으로 스킵한다.

endpoint 매핑:
- `calleeSymbol`이 URL(host+path) 형태이고, `expose` 신호로 생성/정규화된 endpoint 인덱스가 존재하면
  가능한 경우 `service -> api_endpoint` 후보를 생성한다.
- endpoint 매핑이 실패/모호하면 `service -> service` 후보로 fallback 한다.

#### produce/consume
- `calleeSymbol`을 topic name으로 사용한다.
- channel 타입은 evidence metadata(예: `channelType`)로 결정한다:
  - 기본: `topic`
  - RabbitMQ 등 queue 추출기에서 `queue`로 명시할 수 있다.
- 대상 Object가 없으면 생성한다:
  - topic: `objectType='topic'`
  - queue: `objectType='queue'`
  - 공통: `category='CHANNEL'`, `granularity='ATOMIC'`, `urn` 기반 upsert

### 4) confidence/metadata/evidence
- 후보 confidence는 `evidences.metadata.confidence`를 우선 사용한다(0~1 clamp).
- 없으면 기본값 `0.7`을 사용한다.
- 후보 metadata에는 최소 아래 필드를 포함한다:
  - `source: 'CODE'`
  - `kind`
  - `repoRoot`
  - `calleeSymbol` 또는 `topic`
- `relation_candidate_evidences`로 evidenceId를 연결한다.

## 중복/상태 처리(멱등성)
- 동일한 `(workspaceId, relationType, subjectObjectId, objectId)` 조합에 대해:
  - MANUAL 관계가 존재하면 후보 생성/업데이트를 하지 않는다.
  - APPROVED 후보가 존재하면 후보 생성/업데이트를 하지 않는다.
  - PENDING 후보가 존재하면:
    - 새 confidence가 더 높을 때만 candidate를 업데이트한다.
    - evidence 연결은 항상 추가한다(중복은 PK로 방지).

## API 반영
- `/api/inference/run` 및 오케스트레이션 실행 결과에 `code.candidateCount`를 포함한다.
- `summary.relationCandidatesCreated`는 `config + db + code`의 합으로 계산한다.

## 비고/향후 과제
- path-only 호출(`/api/...`)의 타겟 서비스 식별은, 향후 `expose`/OpenAPI/게이트웨이 라우팅 정보와 결합하여 확장한다.
- `db_table`(read/write) 후보 생성 및 database 연결은 `docs/spec/16-db-table-code-signal-spec.md`로 확장한다.
