# 1-6 클러스터 Label 자동 추출 체크리스트

> 작성일: 2026-02-22
> 참조: `docs/03-inference-engine.md` §4.5 Label Suggestion
> 브랜치: `feature/inference-engine`

---

## 목표

Discovery 실행 후 생성되는 Domain Object의 `metadata.labelCandidates`가
현재 `[]`로 하드코딩되어 있는 것을 실제 토큰 빈도 분석 결과로 채운다.

### 설계 기반 토큰 추출 소스

| 소스 | 예시 | 추출 토큰 |
|------|------|----------|
| 서비스명 | `order-service` | `order` |
| 테이블명 | `order_items` | `order`, `items` |
| 토픽명 | `order.created` | `order`, `created` |
| PascalCase | `OrderManagement` | `order`, `management` |

### 라벨 점수 산정
```
score(token) = token 출현 횟수 / 전체 토큰 출현 횟수 합계
```

상위 3개 후보를 `metadata.labelCandidates`에 `[{ text, score }]` 형태로 저장.

---

## 구현 체크리스트

### A. 라벨 추출 로직 (`packages/inference`)

- [x] `packages/inference/src/domain/labelExtractor.ts` 신규 생성
  - [x] `tokenize(name)` 내부 함수
    - [x] camelCase/PascalCase → 하이픈으로 분리 (`OrderService` → `order-service`)
    - [x] 구분자 `-`, `_`, `.`, `:`, ` ` 로 분리
    - [x] 소문자 변환, 길이 ≤ 1 토큰 제거
    - [x] STOP_WORDS 필터링 (`service`, `api`, `app`, `server`, `client` 등)
  - [x] `LabelCandidate` 타입 export
  - [x] `extractLabelCandidates(memberNames, topN=3)` 함수 export
    - [x] 빈 입력 → 빈 배열 반환
    - [x] 토큰 빈도 집계
    - [x] score = count / totalCount (소수점 2자리 반올림)
    - [x] 빈도 내림차순 정렬 → 상위 topN 반환
- [x] `packages/inference/src/domain/index.ts` export 추가
  - [x] `export { extractLabelCandidates } from './labelExtractor'`
  - [x] `export type { LabelCandidate } from './labelExtractor'`

### B. `discovery.ts` 수정 (`packages/inference`)

- [x] `inArray` import 추가 (drizzle-orm)
- [x] `extractLabelCandidates` import 추가
- [x] 클러스터별 멤버 이름 조회 (`objects.name`)
- [x] `extractLabelCandidates(memberNames)` 호출
- [x] `metadata.labelCandidates: []` → 실제 추출 결과로 교체

### C. 테스트 (`packages/inference`)

- [x] `packages/inference/src/__tests__/domain/labelExtractor.test.ts` 신규 생성
  - [x] T1: 빈 배열 → 빈 결과
  - [x] T2: 단일 이름 `order-service` → `order` 최우선 (service 필터됨)
  - [x] T3: 공통 prefix를 가진 여러 이름 → 공통 토큰 최우선
  - [x] T4: PascalCase `OrderManagement` → `order`, `management`
  - [x] T5: DB 테이블명 `order_items`, `order_payments` → `order` 최우선
  - [x] T6: 토픽명 `order.created`, `order.cancelled` → `order` 최우선
  - [x] T7: topN 제한 → 최대 3개 반환
  - [x] T8: score 정확성 → 총 토큰 대비 빈도 비율 검증
- [x] `packages/inference/src/__tests__/domain/discovery.test.ts` 추가 테스트
  - [x] T8: Discovery 후 domain 객체의 labelCandidates가 비어있지 않음

### D. 빌드 검증

- [x] `pnpm --filter @archi-navi/inference exec tsc --noEmit` 에러 없음
- [x] `pnpm --filter @archi-navi/inference test:unit` 전체 GREEN (~140개 이상)
- [x] 기존 테스트 regression 없음

---

## 신규/수정 파일 목록

| 파일 | 상태 |
|------|------|
| `docs/checklist-1-6-cluster-label.md` | 신규 |
| `packages/inference/src/domain/labelExtractor.ts` | 신규 |
| `packages/inference/src/domain/index.ts` | 수정 |
| `packages/inference/src/domain/discovery.ts` | 수정 |
| `packages/inference/src/__tests__/domain/labelExtractor.test.ts` | 신규 |
| `packages/inference/src/__tests__/domain/discovery.test.ts` | 수정 |
