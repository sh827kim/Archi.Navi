# 1-4 Domain Candidates 승인 API + UI 체크리스트

> 작성일: 2026-02-22
> 참조: `docs/03-inference-engine.md` §8.2 Domain 승인
> 브랜치: `feature/inference-engine`

---

## 목표

`domain_candidates` 테이블의 PENDING 후보를 조회·승인·거부하는 API와 UI를 구현한다.
승인 시 `object_domain_affinities`에 확정 소속 데이터를 upsert한다.

---

## 구현 체크리스트

### A. 비즈니스 로직 (`packages/inference`)

- [x] `packages/inference/src/domain/approveDomainCandidate.ts` 신규 생성
  - [x] `approveDomainCandidate(db, candidateId, action)` 함수 구현
  - [x] APPROVED: `domain_candidates.status` → APPROVED, `reviewedAt` 설정
  - [x] APPROVED: `affinityMap` 각 항목 → `object_domain_affinities` upsert
        (source: 'APPROVED_INFERENCE', confidence = candidate.purity)
  - [x] REJECTED: `domain_candidates.status` → REJECTED, `reviewedAt` 설정
  - [x] candidate not found → Error('candidate not found') throw
- [x] `packages/inference/src/domain/index.ts` export 추가
  - [x] `export { approveDomainCandidate } from './approveDomainCandidate'`
- [x] `packages/inference/src/index.ts` 확인 (domain/index.ts 이미 export됨)

### B. API 라우트 (`apps/web`)

- [x] `apps/web/src/app/api/inference/domain-candidates/route.ts` 신규 생성
  - [x] `GET /api/inference/domain-candidates?workspaceId=&status=PENDING`
  - [x] domain_candidates + objects JOIN → objectName, primaryDomainName 포함
  - [x] 응답: `{ id, objectId, objectName, primaryDomainId, primaryDomainName, purity, affinityMap, signals, status, createdAt }`
- [x] `apps/web/src/app/api/inference/domain-candidates/[id]/route.ts` 신규 생성
  - [x] `PATCH /api/inference/domain-candidates/:id`
  - [x] body: `{ status: 'APPROVED' | 'REJECTED' }`
  - [x] 유효성 검사: APPROVED/REJECTED 외 400 반환
  - [x] `approveDomainCandidate()` 호출
  - [x] candidate not found → 404 반환
  - [x] 성공 → `{ success: true, status, affinityCount }` 반환

### C. UI (`apps/web`)

- [x] `apps/web/src/components/approval/domain-approval-list.tsx` 신규 생성
  - [x] `DomainApprovalList` 클라이언트 컴포넌트
  - [x] PENDING 도메인 후보 목록 표시 (objectName, primaryDomainName, purity)
  - [x] affinity 분포 시각화 (최대 3개 도메인 + 비율)
  - [x] 승인/거부 버튼 + 거부 확인 다이얼로그
  - [x] 빈 상태 메시지
- [x] `apps/web/src/components/approval/approval-tabs.tsx` 신규 생성
  - [x] "관계 후보" / "도메인 후보" 탭 전환 클라이언트 컴포넌트
  - [x] `ApprovalList` + `DomainApprovalList` 통합
- [x] `apps/web/src/app/(dashboard)/approval/page.tsx` 수정
  - [x] `<ApprovalList />` → `<ApprovalTabs />` 로 교체

### D. 테스트 (`packages/inference`)

- [x] `packages/inference/src/__tests__/domain/approveDomainCandidate.test.ts` 신규 생성
  - [x] T1: candidate not found → Error throw
  - [x] T2: REJECTED → status 업데이트, affinities 생성 안함
  - [x] T3: APPROVED → status 업데이트, reviewedAt 설정
  - [x] T4: APPROVED → affinityMap 각 항목에 대해 object_domain_affinities 생성
  - [x] T5: APPROVED → confidence = candidate.purity, source = APPROVED_INFERENCE
  - [x] T6: APPROVED 중복 → upsert (기존 affinities 업데이트)

### E. 빌드 검증

- [x] `pnpm --filter @archi-navi/inference lint` 에러 없음
- [x] `pnpm --filter @archi-navi/inference test:unit` 전체 GREEN (~124개)
- [x] TypeScript 컴파일 에러 없음

---

## 신규/수정 파일 목록

| 파일 | 상태 |
|------|------|
| `docs/checklist-1-4-domain-approval.md` | 신규 |
| `packages/inference/src/domain/approveDomainCandidate.ts` | 신규 |
| `packages/inference/src/domain/index.ts` | 수정 |
| `packages/inference/src/__tests__/domain/approveDomainCandidate.test.ts` | 신규 |
| `apps/web/src/app/api/inference/domain-candidates/route.ts` | 신규 |
| `apps/web/src/app/api/inference/domain-candidates/[id]/route.ts` | 신규 |
| `apps/web/src/components/approval/domain-approval-list.tsx` | 신규 |
| `apps/web/src/components/approval/approval-tabs.tsx` | 신규 |
| `apps/web/src/app/(dashboard)/approval/page.tsx` | 수정 |
