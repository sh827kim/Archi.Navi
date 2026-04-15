# 26. API Contract Diff (SPEC) (Roadmap 5-4)

상태: Backlog Draft
작성일: 2026-03-08

현행 메모:
- expose signal과 caller 조회에 필요한 일부 기반은 존재한다.
- 그러나 이 문서의 diff report/CLI 계약은 아직 제품 기능이 아니므로 backlog SPEC으로 유지한다.

## 1. 목적

`expose` 시그널 버전별 비교 → **API 계약 변경 + 영향받는 caller** 자동 감지.

## 2. 범위

### 포함
- expose 스냅샷 비교, 엔드포인트 추가/삭제/변경 감지
- 영향받는 caller 서비스 조회
- CLI: `anavi api-diff --workspace <id>`

### 제외: Request/Response 스키마 비교, OpenAPI 생성

## 3. Diff 유형

| 유형 | 심각도 |
|------|--------|
| ENDPOINT_ADDED | INFO |
| ENDPOINT_REMOVED + caller 존재 | CRITICAL |
| ENDPOINT_REMOVED + caller 없음 | INFO |
| PATH_CHANGED | WARNING |
| METHOD_CHANGED | WARNING |

## 4. 처리 흐름

```
현재 expose 시그널 수집 → 이전 스냅샷 비교
      ↓
Diff 계산 (symbol 기준)
      ↓
삭제/변경 endpoint의 caller 조회
      ↓
Contract Diff Report
```

## 5. 수용 기준

| ID | 기준 |
|----|------|
| T1 | 새 endpoint가 ENDPOINT_ADDED로 감지 |
| T2 | 삭제 endpoint + caller 존재 시 CRITICAL |
| T3 | 영향받는 caller에 파일/라인 정보 포함 |
| T4 | CLI 명령어 동작 |
