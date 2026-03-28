# 14. Compound → Atomic 추론 고도화 (SPEC)

상태: Implemented

## 목표
- 코드 기반 추론만으로도(설정 파일 없이도) Atomic 객체(`api_endpoint`, `topic` 등) 생성 및 후보 관계 생성이 가능해야 한다.
- 기본 단위는 `service(Compound)`를 주체로 하고, `Atomic`을 대상으로 하는 관계를 만든다.

## 배경/문제
- 현재 후보(`relation_candidates`) 생성이 `config/db` 중심이면, config가 없는 리포에서는 “후보 0개”가 발생한다.
- `code_call_edges`에는 `expose`(endpoint 노출), `call`(호출), `produce/consume`(메시지) 신호가 저장되지만,
  이를 후보로 승격하는 단계가 없거나(기존), 서비스 단위로만 매핑되어 Atomic 수준이 부족했다.

## 범위
### 이번 단계(Phase 1)
- `api_endpoint` Atomic 생성: `expose` code signal 기반
- `call` 후보 생성:
  - URL(host+path) 형태면 `service -> api_endpoint`로 매핑 가능한 경우 endpoint로 후보 생성
  - endpoint 매핑 불가하면 `service -> service`로 fallback
- `produce/consume` 후보 생성: `service -> topic` (기존과 동일)

### 다음 단계(Phase 2)
- RabbitMQ queue Atomic 생성 및 후보 생성
  - expose와 무관하게 코드 시그널에서 queue 이름을 추출하여 `queue` Object를 upsert한다.
  - produce/consume 후보는 `service -> queue`로 생성한다.
- DB table Atomic 생성 및 후보 생성
  - 코드 시그널에서 `db_read/db_write/db_mapping`을 기반으로 `db_table` Object를 upsert한다.
  - read/write 후보는 `service -> db_table`로 생성한다.
  - `db_table`은 반드시 `database`에 소속되어야 한다(부모 연결 필수, `docs/spec/16-db-table-code-signal-spec.md` 참조).

### 제외(향후, Phase 3+)
- path-only 호출(`/api/...`)의 타겟 서비스 결정 (게이트웨이 라우팅/오픈API 결합 필요)
- queue/db_table에 대한 고급 정밀도(동적 이름, 변수 추적, 프레임워크별 추론) 보강

## 데이터 모델
- Atomic은 `objects`에 저장하며 `parentId`로 소속 서비스에 연결한다.
- `depth=1`, `granularity='ATOMIC'`

## 규칙
### api_endpoint 생성(expose)
- 주체 서비스: `code_artifacts.ownerObjectId`
- endpoint 식별: `method + path`
- 저장:
  - `objectType='api_endpoint'`, `category='COMPUTE'`
  - `urn = buildUrn(workspaceId, 'compute', 'api_endpoint', '{serviceName}:{method}:{path}')`
  - `name/displayName = '{METHOD} {path}'`
  - `metadata.method`, `metadata.path`, `metadata.repoRoot`

### call 후보 생성
- 타겟 서비스 식별:
  - `calleeSymbol`이 URL이면 hostname을 서비스명 매칭
  - 또는 `calleeSymbol`이 서비스명 자체인 경우 매칭
- endpoint 매핑:
  - `calleeSymbol` URL의 pathname이 타겟 서비스의 endpoint(path)와 유일하게 매칭되면
    `relationType='call'`, objectId는 endpoint로 사용
  - 매핑 실패/모호하면 service-level `call`로 fallback

### expose 처리
- `expose`는 “의존성”이 아니라 “노출/정의”이므로 `relation_candidates`로 직접 생성하지 않는다.
- 대신 endpoint 객체 생성 및 call 후보 매핑을 위한 인덱스로만 사용한다.

## 멱등성/중복
- URN 우선으로 upsert하고, URN이 없던 legacy 데이터는 `parentId + name`으로도 중복을 회피한다.
- 후보 생성은 기존 규칙을 따른다(MANUAL/APPROVED 우선, PENDING confidence 업데이트, evidence 연결).

## UI/진단
- `/api/inference/run` 결과에 `results.code.candidateCount`를 포함한다.
- endpoint 생성 수(`createdEndpointCount`)는 추후 필요 시 응답에 포함한다.
