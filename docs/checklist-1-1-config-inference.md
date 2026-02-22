# 개발 체크리스트: 1-1 Config 기반 Relation 추론

> 로드맵 참조: `docs/08-roadmap.md` §P1 1-1
> 설계 참조: `docs/03-inference-engine.md` §7 Config 파싱 전략, §2.3.3 Config 기반 추론
> 브랜치: `feature/inference-engine`
> 작성일: 2026-02-22

---

## 목표

`packages/inference/src/relation/configBased.ts` stub 구현을 완성하여,
설정 파일에서 자동으로 Relation 후보를 추론하고 `relation_candidates` 테이블에 PENDING 상태로 저장한다.

**기대 효과:** 전체 Relation의 30~40% 자동 발견 (서비스↔DB, 서비스↔Broker)

---

## 구현 범위

### 지원 설정 파일

| 파일 패턴 | 파싱 대상 | 추론 결과 |
|----------|----------|----------|
| `**/application*.yml` | `spring.datasource.url` | database Object 생성 + `read`/`write` relation |
| `**/application*.yml` | `spring.kafka.bootstrap-servers` | message_broker Object 생성 |
| `**/application*.yml` | `spring.kafka.consumer` + topics | `consume` relation |
| `**/application*.yml` | `spring.kafka.producer.*` | `produce` relation |
| `**/docker-compose*.yml` | `depends_on` | service간 `depend_on` relation |
| `**/docker-compose*.yml` | DB 이미지 (mysql/postgres/mariadb) | database Object 생성 |
| `**/docker-compose*.yml` | Broker 이미지 (kafka/rabbitmq) | message_broker Object 생성 |
| `**/k8s/**/*.yml`, `**/deployment*.yml` | 환경변수 DB_URL, KAFKA_BROKERS | Object 생성 + relation |

### Confidence 기준 (설계 문서 §2.3.3)

| 설정 | Confidence |
|------|-----------|
| `spring.datasource.url` → `read`/`write` | 0.9 |
| `spring.kafka.bootstrap-servers` → broker | 0.9 |
| `spring.kafka.consumer` → `consume` | 0.85 |
| `spring.kafka.producer` → `produce` | 0.85 |
| `docker-compose` `depends_on` → `depend_on` | 0.6 |
| `docker-compose` DB 이미지 → database Object | 0.8 |
| K8s env `DB_URL` → `read`/`write` | 0.7 |
| K8s env `KAFKA_BROKERS` → broker + relation | 0.7 |

---

## 구현 파일 목록

```
packages/inference/src/relation/
  ├── configBased.ts                     [수정] stub → 전면 구현
  ├── parsers/
  │   ├── applicationYml.ts              [신규] application.yml 파서
  │   ├── dockerCompose.ts               [신규] docker-compose.yml 파서
  │   └── k8sManifest.ts                 [신규] K8s manifest 파서
  └── index.ts                           [유지] 변경 없음

packages/inference/src/__tests__/
  └── relation/
      ├── parsers/
      │   ├── applicationYml.test.ts     [신규] 파서 단위 테스트
      │   ├── dockerCompose.test.ts      [신규] 파서 단위 테스트
      │   └── k8sManifest.test.ts        [신규] 파서 단위 테스트
      └── configBased.test.ts            [신규] 통합 테스트 (PGlite)
```

---

## 체크리스트

### Phase 1: 의존성 및 환경 설정

- [ ] **js-yaml 패키지 설치**
  - `packages/inference/package.json`에 `js-yaml`, `@types/js-yaml` 추가
  - `pnpm install` 실행 후 설치 확인

### Phase 2: 파서 모듈 구현

- [ ] **`parsers/applicationYml.ts` 구현**
  - [ ] `js-yaml`로 YAML 파싱
  - [ ] `spring.application.name` 추출 → 서비스명 매칭에 사용
  - [ ] `spring.datasource.url` 추출 → JDBC URL 파싱 (host, port, dbName, dbType)
  - [ ] `spring.kafka.bootstrap-servers` 추출 → Broker 주소
  - [ ] `spring.kafka.consumer.group-id` + topics 추출
  - [ ] `spring.kafka.producer.*` 존재 여부 확인
  - [ ] `server.port`, `server.servlet.context-path` 추출
  - [ ] 잘못된 YAML → 빈 결과 반환 (예외 던지지 않음)

- [ ] **`parsers/dockerCompose.ts` 구현**
  - [ ] `services.*` 전체 순회
  - [ ] 각 서비스의 `depends_on` 추출 (배열/객체 형식 모두 지원)
  - [ ] 각 서비스의 `image` 확인 → DB/Broker 분류
    - DB 이미지: `mysql`, `postgres`, `mariadb`, `mongo`
    - Broker 이미지: `kafka`, `rabbitmq`, `redpanda`
  - [ ] `environment.MYSQL_DATABASE`, `POSTGRES_DB` 추출 → DB 이름
  - [ ] 잘못된 YAML → 빈 결과 반환

- [ ] **`parsers/k8sManifest.ts` 구현**
  - [ ] `kind: Deployment` 확인
  - [ ] `metadata.name` → 서비스명
  - [ ] `spec.template.spec.containers[].env[]` 순회
  - [ ] `DB_URL`, `DATABASE_URL`, `JDBC_URL` → JDBC/DB URL 파싱
  - [ ] `KAFKA_BROKERS`, `KAFKA_BOOTSTRAP_SERVERS` → Broker 주소
  - [ ] 잘못된 YAML → 빈 결과 반환

### Phase 3: configBased.ts 전면 구현

- [ ] **인터페이스 변경**
  - [ ] `ConfigInferenceOptions.configFilePath` → `repoRoot`로 변경
  - [ ] 파일 시스템 탐색 로직 추가 (glob 패턴)

- [ ] **파일 탐색 로직**
  - [ ] `**/application*.yml` 탐색
  - [ ] `**/docker-compose*.yml` 탐색
  - [ ] `**/k8s/**/*.yml`, `**/deployment*.yml` 탐색

- [ ] **Object 생성/조회 로직**
  - [ ] URN 기반 중복 방지 (upsert)
    - database: `urn:{ws}:storage:database:{host}:{dbName}`
    - message_broker: `urn:{ws}:channel:message_broker:{host}`
    - topic: `urn:{ws}:channel:topic:{topicName}`
  - [ ] 기존 Object 있으면 재사용, 없으면 신규 생성

- [ ] **Service 매칭 로직**
  - [ ] `spring.application.name` → workspaceId의 service objects에서 이름 매칭
  - [ ] docker-compose 서비스명 → workspaceId의 service objects에서 이름 매칭
  - [ ] K8s `metadata.name` → 서비스 이름 매칭
  - [ ] 매칭 실패 시 해당 relation_candidate 건너뜀

- [ ] **relation_candidates 저장 (중복 처리 포함)**
  - [ ] 동일 `(workspaceId, relationType, subjectObjectId, objectId)` PENDING 후보 조회
  - [ ] PENDING 있고 새 confidence가 더 높으면 업데이트 + evidence 추가
  - [ ] APPROVED 있으면 건너뜀 (수동 오버라이드 우선)
  - [ ] 없으면 신규 생성 (status='PENDING')

- [ ] **evidences 저장**
  - [ ] evidenceType='CONFIG'
  - [ ] filePath, excerpt (설정 키=값) 포함
  - [ ] relation_candidate_evidences에 연결

- [ ] **결과 반환**
  - [ ] `{ candidateCount }` 반환 (새로 생성된 후보 수)

### Phase 4: 단위 테스트

- [ ] **`parsers/applicationYml.test.ts`**
  - [ ] 기본 application.yml 파싱 (datasource + kafka 모두 있음)
  - [ ] datasource만 있는 경우
  - [ ] kafka만 있는 경우
  - [ ] profiles 분기 (active profile 무시 — 단순 파싱)
  - [ ] 빈 YAML 처리
  - [ ] 잘못된 YAML 처리

- [ ] **`parsers/dockerCompose.test.ts`**
  - [ ] 기본 docker-compose 파싱 (depends_on + DB + Broker)
  - [ ] depends_on 배열 형식
  - [ ] depends_on 객체 형식 (`service: {condition: service_healthy}`)
  - [ ] DB 이미지 분류 (mysql, postgres, mariadb)
  - [ ] Broker 이미지 분류 (kafka, rabbitmq)
  - [ ] 빈 YAML 처리

- [ ] **`parsers/k8sManifest.test.ts`**
  - [ ] 기본 K8s Deployment 파싱 (env DB_URL, KAFKA_BROKERS)
  - [ ] kind != Deployment인 경우 (Service, ConfigMap 등) → 무시
  - [ ] env 없는 경우
  - [ ] 빈 YAML 처리

- [ ] **`configBased.test.ts` (통합 테스트)**
  - [ ] 실제 파일 탐색 + 파싱 + DB 저장 통합 테스트
  - [ ] service 매칭 성공 → relation_candidate 생성 확인
  - [ ] service 매칭 실패 → 건너뜀 확인
  - [ ] 중복 호출 → PENDING 업데이트 확인

### Phase 5: 컴파일 및 테스트 실행

- [ ] **TypeScript 컴파일 오류 없음**
  - [ ] `pnpm --filter @archi-navi/inference lint` 성공

- [ ] **단위 테스트 전체 통과**
  - [ ] `pnpm --filter @archi-navi/inference test:unit` 전체 GREEN

---

## 설계 결정 사항

### Object URN 전략
```
database:       urn:{workspaceId}:storage:database:{host}:{dbName}
message_broker: urn:{workspaceId}:channel:message_broker:{host}
topic:          urn:{workspaceId}:channel:topic:{topicName}
```

### Service 매칭 실패 시 처리
설정 파일에서 발견된 서비스명이 DB의 service Object와 매칭되지 않으면:
- relation_candidate는 생성하지 않음 (매칭된 subject 없이 저장 불가)
- evidence만 저장하여 추후 수동 연결 가능하게 함 (현재는 생략, 추후 확장)

### 중복 후보 처리 규칙 (설계 문서 §2.5)
```
MANUAL 관계 존재 → 무시
APPROVED 후보/관계 존재 → 무시
PENDING 후보 존재 → 더 높은 confidence면 업데이트 + evidence 추가
REJECTED 후보만 존재 → 새 후보 생성
없음 → 신규 생성
```

---

## 관련 문서

- `docs/08-roadmap.md` — P1 1-1 Config 기반 Relation 추론
- `docs/03-inference-engine.md` — §7 Config 파싱 전략, §2.3.3
- `packages/db/src/schema/core.ts` — `objects`, `relation_candidates`
- `packages/db/src/schema/evidence.ts` — `evidences`, `relation_candidate_evidences`
