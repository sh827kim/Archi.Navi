# AST Default Code Signal SPEC (Roadmap 2-1 Phase 1)

- 작성일: 2026-03-02
- 상태: Active
- 대상: `apps/web/src/app/api/inference/run/route.ts`, `packages/inference/src/code/*`
- 연계 문서: `../design/03-inference-engine.md`, `../03-roadmap.md`

## 1. 목적
`codeEngine=ast` 모드를 AST 우선 + Regex fallback 동작으로 정의해, 정밀 추출 우선 전략과 운영 안정성을 동시에 확보한다.

## 2. 범위
1. `/api/inference/run`에서 코드 추출 엔진 선택 지원
2. 엔진 모드: `hybrid | ast | regex` (`auto`는 ast 별칭으로 호환)
3. `ast` 모드의 AST 우선 실행 + Regex fallback
4. 실행 결과 메타(요청 엔진/실사용 엔진/fallback 여부) 노출

## 3. API 계약
### 3.1 요청
```json
{
  "workspaceId": "...",
  "modes": ["code"],
  "repoRoots": ["/path/to/repo"],
  "codeEngine": "ast"
}
```

### 3.2 응답(`results.code`)
```json
{
  "repoCount": 1,
  "fileCount": 100,
  "artifactCount": 80,
  "signalCount": 210,
  "skippedCount": 20,
  "engineRequested": "ast",
  "enginesUsed": ["ast"],
  "fallbackCount": 0,
  "fallbackRepoRoots": []
}
```

## 4. 엔진 선택 규칙
1. `codeEngine=ast`: AST 우선 시도, 실패 시 Regex fallback
2. `codeEngine=regex`: Regex만 사용
3. `codeEngine=hybrid`(기본): AST+Regex 병합 엔진 사용 (상세는 SPEC 12)
4. `codeEngine=auto`: `ast`로 정규화되어 동작

## 5. 오류/예외
1. `ast`에서 AST 실패 + Regex 실패: code 모드 실패로 처리
2. `regex` 모드 실패: 실패

## 6. 테스트 수용 기준
1. `ast` 모드에서 AST 성공 시 Regex가 호출되지 않는다.
2. `ast` 모드에서 AST 실패 시 Regex fallback이 동작한다.
3. `ast` 모드에서 양쪽 실패 시 명시적 에러를 반환한다.
4. `regex`, `ast` 고정 모드가 의도대로 동작한다.
