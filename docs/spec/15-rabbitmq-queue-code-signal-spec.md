# 15. RabbitMQ Queue Code Signal 추출 및 후보 생성 (SPEC)

상태: Implemented

## 목표
- Java/Kotlin(Spring AMQP) 코드에서 RabbitMQ queue 사용을 추출한다.
- `mode=code`만으로 `queue` Atomic object 및 `produce/consume` 관계 후보(`relation_candidates`)를 생성한다.

## 비목표
- RabbitMQ exchange/routing-key 정밀 추론(초기에는 큐 이름 중심으로 추론)
- 동적 큐 이름(변수/설정 바인딩) 완전 추적(Phase 2에서 AST 기반으로 확장)

## 입력/출력
### 입력
- `workspaceId`
- `repoRoot`

### 출력
- `queue` Atomic object upsert 결과(신규 생성 수)
- `relation_candidates` 생성 수

## Signal 추출 규칙 (Phase 1)
### consume
- `@RabbitListener(queues = "queueName")`
- `@RabbitListener(queues = {"q1","q2"})` (다중 큐)

### produce
- `rabbitTemplate.convertAndSend("queueName", ...)`
- `rabbitTemplate.send("queueName", ...)`

### Signal 형식
- `ExtractedSignal.kind`:
  - consume → `consume`
  - produce → `produce`
- `symbol`: queueName
- `metadata`:
  - `broker: 'rabbitmq'`
  - `channelType: 'queue'`
  - `client` 또는 `annotation` (근거용)

## Object upsert
- objectType: `queue`
- category: `CHANNEL`
- granularity: `ATOMIC`
- urn: `buildUrn(workspaceId, 'channel', 'queue', queueName)`

옵션(추가 고도화):
- message_broker(`rabbitmq`) Compound를 워크스페이스 단위로 생성하고,
  queue를 해당 broker의 child로 연결한다.

## 후보 생성
- subject: `code_artifacts.ownerObjectId` (service)
- object: `queue` object id
- relationType:
  - produce → `produce`
  - consume → `consume`
- expose는 후보 생성 대상이 아니다.

## 멱등성
- queue object는 urn 기반으로 upsert한다.
- candidate 생성은 기존 규칙을 따른다(MANUAL/APPROVED 우선, PENDING confidence 업데이트, evidence 연결).

## 테스트(수용 기준)
- `@RabbitListener`로 consume 후보가 생성된다.
- `RabbitTemplate.convertAndSend`로 produce 후보가 생성된다.
- 동일 입력을 반복 실행해도 후보/오브젝트가 중복 생성되지 않는다.
