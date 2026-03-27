# Incremental Inference SPEC (Roadmap 3-5)

- 작성일: 2026-03-02
- 상태: Implemented
- 대상: `packages/inference/src/relation/configBased.ts`, `packages/inference/src/db/dbSchemaSignal.ts`, `/api/inference/run`
- 연계 문서: `../design/03-inference-engine.md`

## 1. 목적
변경 없는 입력 파일/테이블을 재처리하지 않도록 하여 추론 실행 시간을 단축하고, 동일 입력에서 안정적인 결과를 유지한다.

## 2. 범위
1. Config 추론 증분 처리
2. DB 스키마 추론 증분 처리
3. API 옵션(`incremental`) 및 통계 응답 제공

## 3. 기능 요구사항
1. Config 증분
- 입력 파일 콘텐츠 SHA256 해시를 기준으로 변경 여부 판정
- 변경 없음: parse/infer skip
- 변경 있음: 해당 파일만 재처리 + 해시 갱신

2. DB 증분
- `db_table.metadata` 기반 해시를 기준으로 변경 테이블만 재처리
- 변경된 테이블의 기존 `PENDING fk_reference` 후보는 갱신 대상

3. API 계약
- 요청: `POST /api/inference/run` with `incremental: boolean`
- 응답 통계(최소):
  - `fileCount`
  - `processedFileCount`
  - `skippedFileCount`

## 4. 무결성 규칙
1. 증분 ON/OFF 결과의 의미적 결과가 동일해야 한다.
2. stale candidate가 남지 않도록 테이블 단위 갱신 시 기존 후보 정리를 수행한다.
3. 증분 키 산정 필드는 추론에 영향을 주는 메타데이터를 모두 포함해야 한다.

## 5. 비기능 요구사항
1. 대규모 workspace에서 full scan 대비 처리 시간이 단축되어야 한다.
2. 증분 모드에서도 회귀 없이 기존 테스트를 통과해야 한다.

## 6. 수용 기준
1. 변경 없는 config/db 입력은 skip 카운트가 증가한다.
2. 변경된 입력만 재처리된다.
3. API 응답 통계가 실제 처리 결과와 일치한다.
4. 증분 모드에서 후보 중복/유실이 발생하지 않는다.
