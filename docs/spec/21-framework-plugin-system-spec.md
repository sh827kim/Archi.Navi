# 21. 프레임워크 플러그인 시스템 (SPEC) (Roadmap 4-4)

상태: Draft
작성일: 2026-03-08

## 1. 목적

하드코딩된 프레임워크 패턴을 **플러그인 아키텍처**로 전환하여 core 코드 수정 없이 새 프레임워크 지원 추가.

## 2. 범위

### 포함
- FrameworkPlugin 인터페이스, PluginRegistry
- 기존 패턴의 빌트인 플러그인 마이그레이션
- 프로젝트 자동 감지 (detector)

### 제외: 외부 npm 플러그인 로딩, 마켓플레이스

## 3. 플러그인 인터페이스

```typescript
interface FrameworkPlugin {
  id: string;                          // "spring-boot", "nestjs"
  displayName: string;
  version: string;
  languages: Language[];
  detector: { filePatterns?: string[]; packageJsonDeps?: string[] };
  regexPatterns: SignalPattern[];
  astExtractor?: (tree: SyntaxTree, filePath: string) => ExtractedSignal[];
  configParsers?: { filePatterns: string[]; parse: (content: string, filePath: string) => ConfigSignal[] }[];
  confidenceRules?: { signalKind: SignalKind; condition: (s: ExtractedSignal) => boolean; adjustment: number }[];
}
```

## 4. 마이그레이션 계획

| 기존 모듈 | 분리 대상 | 패턴 수 |
|-----------|----------|---------|
| `scanners/javaKotlin.ts` | `spring-boot` + `java-common` | ~20 |
| `scanners/typeScript.ts` | `express` + `nestjs` | ~10 |
| `scanners/python.ts` | `fastapi` + `flask` | ~8 |

## 5. 확장 가능 프레임워크

gRPC, GraphQL, tRPC, Quarkus, Ktor, Django, RabbitMQ

## 6. 수용 기준

| ID | 기준 |
|----|------|
| T1 | 기존 패턴이 플러그인으로 이동 후 동일 결과 생성 |
| T2 | detectPlugins()가 pom.xml/package.json 기반으로 플러그인 선택 |
| T3 | 미감지 시 범용 플러그인 fallback |
| T4 | 새 플러그인 추가 시 기존 코드 수정 불필요 |
| T5 | 마이그레이션 후 기존 테스트 통과 |
