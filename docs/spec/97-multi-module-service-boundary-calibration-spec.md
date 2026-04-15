# 97. Multi-Module Service Boundary Calibration (SPEC)

상태: Current
우선순위: P1
상위 문서:
- [12-inference-run-orchestration-spec.md](./12-inference-run-orchestration-spec.md)
관련 설계 문서:
- [14-signal-coverage-design-public-edition.md](../design/14-signal-coverage-design-public-edition.md)
작성일: 2026-04-14
상태 메모: Maven/Gradle 모듈 수집과 application config 가중치가 경계 보정에 반영된다.

---

## 1. 목적

멀티모듈 프로젝트에서 서비스 ownership이 루트로 과집중되는 문제를 줄이기 위해,
실행 모듈만 서비스로 승격하는 경계 보정 계약을 정의한다.

---

## 2. 문제 정의

- 재귀 탐색으로 코드/설정은 발견되지만 서비스 등록 단위가 루트로 고정됨
- 라이브러리 모듈까지 서비스로 과분해되기 쉬움

---

## 3. 알고리즘 계약

1. settings/pom 기준 하위 모듈 목록 수집
2. 모듈별 실행 가능성 점수 계산
3. score threshold 이상만 서비스로 승격
4. 나머지는 parent ownership에 귀속

점수 예시:
- application config: +3
- main source set: +2
- executable entry/plugin: +3
- common/domain/library naming: -3
- runtime resource/entrypoint 없음: -3

---

## 4. 데이터 계약

모듈 분류 결과에 최소 포함:
- module path
- score
- classification(`service_candidate | library_candidate | inherited`)
- reasons[]

---

## 5. 테스트 요구사항

단위:
- 실행 모듈/라이브러리 모듈 분류
- threshold 경계값 동작

통합:
- 멀티모듈 샘플에서 ownership 분산 확인

---

## 6. 수용 기준

1. 서비스 수가 무의미하게 폭증하지 않는다.
2. 루트 단일 ownership 집중이 완화된다.
3. 모듈 분류 근거(reasons)가 로그/메타데이터로 남는다.
