# 46. AI Architecture Assistant Scope Expansion SPEC

상태: Implemented
우선순위: S1
로드맵 범위: AI 고도화

## 1. 문제 정의

현재 `/api/chat`은 관계/경로/도메인 질의 중심의 키워드 라우팅만 제공한다.
그래서 “author-service는 어떤 API가 있지?” 같은 기본적인 서비스 설명형 질문을 잘 처리하지 못한다.

## 2. 목표

1. AI 아키텍처 어시스턴트가 서비스/API 설명형 질문을 처리할 수 있게 한다.
2. query-engine 기반 질문과 object-retrieval 기반 질문을 분리 라우팅한다.
3. 서비스 개요, 제공 API, 주요 의존성 같은 기본 정보 질문을 안정적으로 답한다.

## 3. 범위

### 3.1 포함
- service overview intent
- service endpoints intent
- object resolution 개선(name + displayName)
- chat example 질문 갱신

### 3.2 제외
- 완전한 자연어 planner/agent
- 멀티턴 메모리 저장

## 4. 기능 요구사항

1. `/api/chat`는 최소 아래 범주를 처리해야 한다.
   - 영향 분석
   - 경로 탐색
   - 사용 주체 추적
   - 도메인 요약
   - 서비스 개요
   - 서비스 API 목록
2. 서비스/API 질의는 query engine이 아니라 object/objectRelations/object children 조회를 사용할 수 있다.
3. object resolution은 `name`, `displayName` 모두 활용한다.
4. 응답은 기존 Answer Composer 스타일을 유지하되 서비스/API 목록에도 맞는 섹션을 제공한다.

## 5. 수용 기준

| ID | 기준 |
|----|------|
| T1 | `author-service 는 어떤 api 가 있지?` 류 질문에서 api_endpoint 목록을 근거와 함께 답할 수 있다 |
| T2 | 서비스 개요형 질문이 service overview context를 사용한다 |
| T3 | displayName 기반 object 해석이 가능하다 |
| T4 | 채팅 예시 질문이 신규 범주를 반영한다 |

## 6. 검증 계획

- `src/__tests__/chat.route.test.ts`
- 필요 시 `floating-chat` smoke test 추가
