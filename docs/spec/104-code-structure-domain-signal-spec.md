# 104. Code Structure Domain Signal SPEC

- 상태: Implemented
- 작성일: 2026-04-26
- 대상: `packages/inference/src/domain/discovery`, `packages/inference/src/code`
- 관련: `10-ast-default-code-signal-spec.md`, `11-ast-regex-hybrid-code-signal-spec.md`, `17-inter-procedural-ast-spec.md`

## 1. 목적

도메인 발견이 단순 이름/table prefix에 과하게 끌리지 않도록, 기존 `codeArtifacts`,
`codeCallEdges`, `evidences`, `objects`, `interaction_intents`에서 얻은 구조 신호를
가중치 기반 affinity 계산에 반영한다.

참고한 외부 패턴은 `code-review-graph`의 AST 원문 저장이 아니라, Tree-sitter 결과를
파일/함수/호출/테스트 같은 안정적인 구조 그래프로 낮춰 저장한 뒤 질의하는 방식이다.

## 2. 범위

- 기존 `web-tree-sitter` AST 및 hybrid/regex 엔진은 유지한다.
- 도메인 발견의 구조 클러스터링은 `path`, `route`, `topic`, `name`, `code`, `table`
  신호를 동일 평균으로 계산하지 않고 가중치로 계산한다.
- route/topic/code 신호가 table 신호보다 우선되도록 기본 가중치를 둔다.
- `db_table`은 도메인 멤버 후보가 될 수 있지만, service implements 비율 계산에는
  포함하지 않는다. implements 계산은 기존 102 SPEC의 `function/api_endpoint` 기준을 따른다.

## 3. Affinity 규칙

기본 가중치:

| 신호 | weight |
|---|---:|
| route prefix | 0.30 |
| topic prefix | 0.20 |
| code family(class/file/package) | 0.20 |
| name token | 0.15 |
| path prefix | 0.10 |
| table family | 0.05 |

객체가 `db_table` 계열이면 table weight를 0.20으로 올리고 code/topic/path weight를 낮춘다.
이 경우에도 table prefix 단독 신호가 route/function 신호보다 service 도메인을 더 강하게
밀지 않도록 한다.

## 4. 수용 기준

- route 또는 function/code family가 일치하는 객체는 table prefix만 일치하는 객체보다 높은
  affinity를 갖는다.
- 기존 `CandidateMemberScore` 출력 필드는 유지한다.
- service는 signal-only 객체로 남을 수 있으나 최종 members에는 들어가지 않는다.
- 기존 domain physical/logical separation 계약과 충돌하지 않는다.
