# 98. Bootstrap Engine Policy Alignment (SPEC)

상태: Proposed
우선순위: P1
상위 문서:
- [11-ast-regex-hybrid-code-signal-spec.md](./11-ast-regex-hybrid-code-signal-spec.md)
- [12-inference-run-orchestration-spec.md](./12-inference-run-orchestration-spec.md)
관련 설계 문서:
- [14-signal-coverage-design-public-edition.md](../design/14-signal-coverage-design-public-edition.md)
작성일: 2026-04-14

---

## 1. 목적

coverage 개선 목표에 맞게 bootstrap 엔진 기본값과 fallback 정책을 표준화한다.

---

## 2. 정책 계약

기본값:
- `hybrid`

제한 환경:
- `regex`

복구:
- parse 실패 시 `ast + regex fallback` 또는 `hybrid` 재시도

---

## 3. 실행 계약

1. requested engine 기록
2. 실제 사용 engine 기록
3. fallback 발생 시 원인/횟수 기록
4. run 결과에 신호 수/실패 수 첨부

---

## 4. 최소 관측치

- engine requested
- engine used
- fallback count
- parse failure count
- file count
- signal count

---

## 5. 테스트 요구사항

단위:
- engine 선택 분기
- fallback 트리거 및 복구

통합:
- 동일 입력에서 regex 대비 hybrid가 coverage 개선되는지 검증

---

## 6. 수용 기준

1. 기본 실행 경로가 hybrid로 고정된다.
2. 제한 환경에서 regex 강등이 명시적으로 작동한다.
3. fallback 관측치가 운영 대시보드/로그로 노출된다.
