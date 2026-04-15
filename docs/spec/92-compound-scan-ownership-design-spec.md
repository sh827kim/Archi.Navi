# 92. Compound Scan Ownership Design SPEC

상태: Backlog Proposed
작성일: 2026-04-06

현행 메모:
- 이 문서는 아직 구현에 착수하지 않은 backlog 설계다.
- 현재 스캔/ownership 제품 계약의 기준 문서가 아니며, 실제 착수 전까지는 active SPEC처럼 해석하지 않는다.

## 1. 문제

현재 스캔 경로는 코드에서 DB/Kafka 관련 신호를 보면 암묵적으로 compound를 만들 가능성이 있다.
이 방식은 다음 문제가 있다.

- 모듈 단위로 `database` compound가 난립한다.
- 사용자가 의도한 실제 인프라 경계와 스캔 결과 귀속 대상이 분리된다.
- DB/Kafka를 먼저 모델링하고 그 아래로 스캔 결과를 귀속시키는 UX가 없다.

## 2. 목표

- 마법사에서 `database`, `message_broker`(Kafka 포함) compound를 명시적으로 생성할 수 있어야 한다.
- 코드 스캔은 새 compound를 임의 생성하는 대신, 사용자가 선택한 compound에 atomic 결과를 귀속시켜야 한다.
- 귀속 대상이 없으면 기본 동작은 “생성하지 않음 + 후보/경고만 남김”이어야 한다.

## 3. 제안 UX

### 3.1 마법사
- 코드 스캔 단계 앞 또는 내부에 `인프라 컴파운드` 섹션을 추가한다.
- 사용자는 아래를 직접 추가할 수 있다.
  - Database compound
  - Kafka/Broker compound
- 각 항목은 최소 아래 필드를 가진다.
  - 이름
  - 타입 (`database` / `message_broker`)
  - 식별 힌트
    - DB: datasource key, JDBC host/schema, 서비스 매핑
    - Kafka: bootstrap server alias, topic prefix, cluster name

### 3.2 스캔 매핑
- 스캔 실행 전 귀속 규칙을 계산한다.
  - DB signal -> database compound
  - produce/consume signal -> broker compound
- 단일 매칭이면 자동 귀속한다.
- 다중 후보면 스캔 결과를 pending mapping으로 남기고 사용자 확인을 요구한다.

## 4. 데이터 모델 방향

### 4.1 compound metadata
- `objects.metadata`에 compound 식별 힌트를 저장한다.
- 예시:
  - `database`: `datasourceKeys`, `jdbcHosts`, `schemas`
  - `message_broker`: `bootstrapServers`, `topicPrefixes`, `clusterKey`

### 4.2 스캔 설정
- workspace default profile에는 귀속 정책을 저장한다.
- 예시:
  - `scanConfig.enableDbScan`
  - `scanConfig.enableMessageScan`
  - `scanConfig.compoundBindings`

### 4.3 pending mapping
- 자동 귀속 실패 케이스를 위해 audit/run metadata 또는 별도 pending table이 필요하다.
- 1차 구현에서는 inference run / scan result metadata에 누적하고, 필요 시 별도 테이블로 승격한다.

## 5. 단계별 구현안

### Phase 1
- DB 스캔 토글 옵션화
- Kafka/DB compound 자동 생성 중단 준비

### Phase 2
- 마법사에서 DB/Kafka compound 명시 생성
- metadata에 식별 힌트 저장

### Phase 3
- 스캔 결과를 기존 compound에 귀속
- 다중 후보 / 미매칭 시 pending mapping 기록

### Phase 4
- 설정 화면에서 compound binding 수정
- pending mapping 승인 UX 제공

## 6. 오픈 이슈

- DB 하나에 여러 서비스가 연결될 때 기본 귀속 전략을 어떻게 둘지
- Kafka topic이 cluster를 넘나드는 경우 topic prefix만으로 충분한지
- pending mapping 저장소를 audit metadata로 둘지 별도 테이블로 둘지
