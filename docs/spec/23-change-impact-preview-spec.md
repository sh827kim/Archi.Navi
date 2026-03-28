# 23. Change Impact Preview (SPEC) (Roadmap 5-1)

상태: Draft
작성일: 2026-03-08

## 1. 목적

`git diff` 기반 변경 파일 분석 → **영향받는 서비스/API/토픽 목록** 자동 생성. PR 리뷰 시 영향도 즉시 파악.

## 2. 범위

### 포함
- git diff 파싱 → 변경 파일 → code_artifacts 매핑 → 서비스 식별
- 시그널 변경 감지 + IMPACT_ANALYSIS 연동
- CLI: `anavi impact --workspace <id> --diff HEAD~1`
- Impact Report (JSON/Markdown/Table)

### 제외 (후속): GitHub Action PR 코멘트, Git Hook, Web UI 위젯

## 3. CLI

```bash
anavi impact --workspace <id> --diff HEAD~1
anavi impact --workspace <id> --diff main..feature/payment
anavi impact --workspace <id> --files src/OrderService.java
anavi impact --workspace <id> --diff HEAD~1 --format json|markdown|table
```

## 4. 처리 흐름

```
git diff 파싱 → 변경 파일 + 행 범위
      ↓
code_artifacts 매핑 → 소속 서비스
      ↓
변경된 시그널 식별 (evidences 조회)
      ↓
IMPACT_ANALYSIS 실행 (depth: 2)
      ↓
Impact Report 생성
```

## 5. 응답 모델

```typescript
interface ImpactReport {
  diff: { base: string; head: string };
  changedServices: string[];
  directImpact: ImpactItem[];      // 직접 영향
  indirectImpact: ImpactItem[];    // 2-hop 간접 영향
  changedSignals: { endpoints: SignalChange[]; topics: SignalChange[] };
  unmappedFiles: string[];
}
```

## 6. 수용 기준

| ID | 기준 |
|----|------|
| T1 | git diff 변경 파일 올바르게 파싱 |
| T2 | 변경 파일 → code_artifacts → 서비스 매핑 |
| T3 | 직접 영향(caller/callee) 조회 |
| T4 | 간접 영향(2-hop)에 `via` 필드 표시 |
| T5 | `--format markdown` 출력이 PR 코멘트 사용 가능 |
| T6 | 매핑 실패 파일은 unmappedFiles로 분류 + 경고 |
| T7 | 추론 미실행 워크스페이스에서 빈 결과 반환 |
