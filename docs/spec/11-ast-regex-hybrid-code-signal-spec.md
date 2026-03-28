# AST + Regex Hybrid Code Signal SPEC

- 작성일: 2026-03-02
- 상태: Implemented
- 대상: `packages/inference/src/code/*`, `apps/web/src/app/api/inference/run/route.ts`
- 연계 문서: `./10-ast-default-code-signal-spec.md`, `../design/03-inference-engine.md`

## 1. 목적
`codeEngine=hybrid` 모드를 추가해 AST/Regex를 동시에 적용하고 결과를 병합하여 코드 신호 정확도를 높인다.

## 2. 범위
1. 엔진 모드: `hybrid | ast | regex` (`auto`는 ast 별칭으로 호환)
2. `hybrid` 모드에서 파일 단위 AST + Regex 신호 동시 추출
3. 동일 신호 중복 제거(키: `kind + symbol + lineStart + lineEnd`)
4. 중복 신호의 confidence 우선 병합 및 `metadata.extractionSources` 누적

## 3. API 계약
### 3.1 요청
```json
{
  "workspaceId": "...",
  "modes": ["code"],
  "repoRoots": ["/path/to/repo"],
  "codeEngine": "hybrid"
}
```

### 3.2 응답(`results.code`)
```json
{
  "engineRequested": "hybrid",
  "enginesUsed": ["hybrid"],
  "fallbackCount": 0
}
```

## 4. 동작 규칙
1. `hybrid`는 엔진 fallback이 아니라 병합 엔진이다.
2. Java/Kotlin, TypeScript/JavaScript, Python은 AST + Regex를 모두 수집한다.
3. MyBatis XML은 Regex만 사용한다.
4. 저장 시 evidence metadata에 `extractionMode: "hybrid"`를 기록한다.
5. `codeEngine` 미지정 시 `hybrid`를 기본값으로 사용한다.

## 5. 수용 기준
1. `normalizeCodeSignalEngine('hybrid') === 'hybrid'`.
2. `codeEngine=hybrid` 요청 시 hybrid 추출기만 실행된다.
3. 동일 키 신호는 1건으로 병합되고 confidence가 높은 값이 유지된다.
4. 병합 결과 metadata에는 두 엔진 source(`ast`, `regex`)가 누적된다.
