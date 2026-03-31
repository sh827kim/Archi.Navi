# Archi.Navi — 개발자 생산성 기능

작성일: 2026-03-08
최종 갱신: 2026-03-31
문서 버전: v1.1
상태: Extension / Roadmap

> Archi.Navi의 핵심 비전인 "개인 업무 생산성 향상"을 확장하기 위한 문서다.
> 제품에 일부 기반 기능은 존재하지만, 본 문서는 shipped 기준 문서가 아니라
> 중장기 확장 방향을 정리하는 로드맵 성격의 설계다.

---

## 1. 설계 원칙

| 원칙 | 설명 |
|------|------|
| **일상 통합** | 특별한 액션 없이 평소 개발 흐름에서 자연스럽게 사용 |
| **증거 기반** | 모든 인사이트는 코드/설정/스키마 근거와 함께 제공 |
| **점진적 가치** | 사용할수록 데이터가 쌓여 더 정확한 분석 제공 |
| **개인 우선** | 개인의 암묵지를 체계화하되, 공유도 가능한 구조 |

---

## 2. Change Impact Preview (변경 영향도 미리보기)

### 2.1 핵심 가치

코드 변경 시 **영향을 미치는 서비스/API/토픽 목록**을 자동 생성.
PR 리뷰에서 "이 변경이 다른 서비스에 어떤 영향을 주는가?"를 즉시 파악.

### 2.2 아키텍처

```
git diff (또는 PR diff)
      ↓
① 변경 파일 목록 추출
      ↓
② code_artifacts 매핑 (파일 → 소속 서비스)
      ↓
③ 변경된 시그널 식별 (expose/call/produce/consume/read/write)
      ↓
④ Query Engine IMPACT_ANALYSIS 실행 (depth: 2)
      ↓
⑤ Impact Report 생성
```

### 2.3 통합 방식

| 방식 | 설명 |
|------|------|
| **CLI** | `anavi impact --diff HEAD~1` |
| **GitHub Action** | PR 코멘트에 영향도 맵 자동 첨부 |
| **Git Hook** | `pre-push`에서 경고 수준 영향도 감지 |
| **Web UI** | Dashboard에 "최근 변경 영향도" 위젯 |

### 2.4 구현 의존

- `code_artifacts` 파일 → 서비스 매핑 (기존 구현 완료)
- Query Engine `IMPACT_ANALYSIS` (기존 구현 완료)
- `git diff` 파싱 → 변경 파일 목록 추출 (신규)

---

## 3. Architecture Drift Detection (드리프트 감지)

### 3.1 핵심 가치

주기적 추론 실행으로 **이전 스냅샷과 비교**하여 아키텍처 변화를 자동 감지.

### 3.2 Drift 유형

| 유형 | 설명 | 심각도 |
|------|------|--------|
| **New Dependency** | 새로운 서비스 간 관계 발견 | INFO |
| **Removed Dependency** | 기존 관계의 evidence 소멸 | WARNING |
| **Confidence Shift** | 같은 관계의 신뢰도 ±0.2 이상 변화 | INFO |
| **Domain Drift** | 서비스의 primary 도메인 변경 | WARNING |
| **Circular Dependency** | 새로운 순환 의존 감지 | CRITICAL |
| **Hub Concentration** | 특정 서비스 inDegree 급증 | WARNING |

### 3.3 비교 알고리즘

기존 `rollup_generations` + `valid_from`/`valid_to` 활용.
ACTIVE vs 직전 ARCHIVED generation을 diff하여 변화를 산출.

---

## 4. Architecture Health Score (건강도)

### 4.1 Health 지표

| 지표 | 계산 방식 | 가중치 | 방향 |
|------|----------|--------|------|
| 결합도 (Coupling) | (outDegree + inDegree) / totalServices | 0.25 | 낮을수록 좋음 |
| 도메인 순수도 (Purity) | max(affinity) | 0.20 | 높을수록 좋음 |
| 순환 의존 (Cycles) | 참여 cycle 수 | 0.20 | 0이 이상적 |
| Hub 집중도 | max(inDegree) / avg(inDegree) | 0.15 | 낮을수록 좋음 |
| Evidence 커버리지 | with_evidence / total_relations | 0.10 | 높을수록 좋음 |
| Approval 비율 | approved / (approved + pending) | 0.10 | 높을수록 좋음 |

### 4.2 등급

```
90+ : 🟢 Excellent
70-89: 🟡 Good
50-69: 🟠 Needs Attention
<50  : 🔴 Critical
```

---

## 5. Personal Architecture Journal (개인 저널)

### 5.1 핵심 가치

서비스/관계에 **개인 메모/태그 연결** → 암묵지 체계화. 시간이 지나면 온보딩 자료가 됨.

### 5.2 데이터 모델

```sql
CREATE TABLE object_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  object_id UUID NOT NULL REFERENCES objects(id),
  relation_id UUID REFERENCES object_relations(id),
  content TEXT NOT NULL,
  category VARCHAR(50) NOT NULL DEFAULT 'context',
  pinned BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);
```

### 5.3 카테고리

| 카테고리 | 용도 |
|---------|------|
| `warning` | "이 서비스는 레거시", "순서 보장 안 됨" |
| `tip` | "디버깅 시 이 로그 먼저 확인" |
| `todo` | "리팩토링 필요", "deprecated 예정" |
| `context` | "2025년 결제 시스템 전환 시 추가됨" |
| `decision` | "이 구조는 의도적 (성능 이유)" |

---

## 6. API Contract Diff (API 계약 변경 감지)

### 6.1 핵심 가치

`expose` 시그널을 버전별 비교 → **API 계약 변경 + 영향받는 클라이언트** 자동 표시.

### 6.2 Diff 유형

| 유형 | 심각도 |
|------|--------|
| Endpoint 추가 | INFO |
| Endpoint 삭제 + caller 존재 | CRITICAL |
| Path/Method 변경 | WARNING |

---

## 7. 구조적 개선 사항

### 7.1 서비스 레이어 분리

```
기준 상태: API route에 비즈니스 로직 직접 포함
개선: packages/inference/src/orchestration/inferenceService.ts (비즈니스)
      apps/web/src/app/api/inference/run/route.ts (thin HTTP 어댑터)
      packages/cli/src/commands/infer.ts (thin CLI 어댑터)
```

### 7.2 추론 커버리지 리포트

추론 결과에 분석 성공/실패 비율 + 언어별 커버리지를 포함하여 결과 신뢰도를 직관 제공.

### 7.3 Workspace 공유 메커니즘

```bash
anavi snapshot save --workspace <id> --output snapshot.json
anavi snapshot restore --input snapshot.json --workspace <new-id>
anavi snapshot merge --input teammate.json --workspace <id> --conflict-strategy newer|manual
```

### 7.4 파일 시스템 Watcher

```bash
anavi watch --workspace <id> --path /path/to/repos
# chokidar 기반 파일 변경 감지 → 증분 추론 자동 실행
```

---

## 참고 문서

| 문서 | 설명 |
|------|------|
| [07-inference-engine-advanced.md](./07-inference-engine-advanced.md) | 추론 엔진 고도화 설계 |
| [../spec/23-change-impact-preview-spec.md](../spec/23-change-impact-preview-spec.md) | Change Impact SPEC |
| [../spec/24-architecture-drift-detection-spec.md](../spec/24-architecture-drift-detection-spec.md) | Drift Detection SPEC |
| [../spec/25-personal-architecture-journal-spec.md](../spec/25-personal-architecture-journal-spec.md) | Journal SPEC |
| [../spec/26-api-contract-diff-spec.md](../spec/26-api-contract-diff-spec.md) | API Contract Diff SPEC |
| [../spec/27-architecture-health-score-spec.md](../spec/27-architecture-health-score-spec.md) | Health Score SPEC |
