import type { DbClient } from '@archi-navi/db';
import {
  extractCodeSignals,
  type CodeSignalOptions,
  type CodeSignalResult,
} from './codeSignalExtractor';
import { extractAstCodeSignals } from './ast/extractAstCodeSignals';
import { extractHybridCodeSignals } from './hybridCodeSignalExtractor';

export type CodeSignalEngine = 'ast' | 'regex' | 'hybrid';
export type CodeSignalEngineUsed = 'ast' | 'regex' | 'hybrid';

/** 엔진 모드별 운영 정책 */
export const ENGINE_POLICY: Record<CodeSignalEngine, { description: string; recommended: string }> = {
  hybrid: {
    description: 'AST + Regex 병합 — 두 엔진 결과를 confidence 기준으로 병합',
    recommended: '기본값. 대부분의 프로젝트에 권장',
  },
  ast: {
    description: 'AST 우선 — 파싱 실패 파일만 Regex fallback',
    recommended: 'tree-sitter 지원 언어(Java/Kotlin/TS/Python)만 사용하는 프로젝트',
  },
  regex: {
    description: 'Regex 전용 — Phase 1 패턴 매칭만 사용',
    recommended: 'WASM 로딩 불가 환경 또는 MyBatis XML 위주 프로젝트',
  },
};

export interface CodeSignalEngineOptions extends CodeSignalOptions {
  codeEngine?: CodeSignalEngine | 'auto' | string | null;
}

/** 언어별 처리 지표 */
export interface LanguageMetrics {
  fileCount: number;
  signalCount: number;
  errorCount: number;
  errorFilePaths: string[];
}

/** Fallback 관측 지표 */
export interface CodeSignalMetrics {
  /** 엔진별 소요 시간(ms) */
  timings: {
    primary: number;
    fallback?: number;
    total: number;
  };
  /** 언어별 처리 지표 (AST 또는 Hybrid에서만 수집) */
  byLanguage?: Record<string, LanguageMetrics>;
  /** Fallback 발생 파일 수 / 전체 처리 파일 수 */
  fallbackRate: number;
  /** fallback 대상 파일 수 */
  fallbackFileCount: number;
}

export interface CodeSignalEngineResult extends CodeSignalResult {
  engineRequested: CodeSignalEngine;
  engineUsed: CodeSignalEngineUsed;
  fallbackUsed: boolean;
  warning?: string;
  /** 관측 지표 (운영 모니터링용) */
  metrics: CodeSignalMetrics;
}

function shouldProbeRegexFallback(astResult: CodeSignalResult): boolean {
  const processedFileCount = astResult.fileCount - astResult.skippedCount;
  if (processedFileCount <= 0) return false;
  // 일부 파일만 파싱 실패해도(부분 실패) 누락 파일 복구를 위해 fallback probe를 수행한다.
  return (astResult.scanErrorCount ?? 0) > 0;
}

function getFailedFilePaths(astResult: CodeSignalResult): string[] {
  const source = astResult.scanErrorFilePaths ?? [];
  return Array.from(new Set(source.filter((path) => typeof path === 'string' && path.length > 0)));
}

function mergeAstAndRegexRecovery(
  astResult: CodeSignalResult,
  regexResult: CodeSignalResult,
): CodeSignalResult {
  const merged: CodeSignalResult = {
    fileCount: astResult.fileCount,
    artifactCount: astResult.artifactCount + regexResult.artifactCount,
    signalCount: astResult.signalCount + regexResult.signalCount,
    skippedCount: astResult.skippedCount + regexResult.skippedCount,
  };
  if (typeof astResult.scanErrorCount === 'number') {
    merged.scanErrorCount = astResult.scanErrorCount;
  }
  if (astResult.scanErrorFilePaths) {
    merged.scanErrorFilePaths = astResult.scanErrorFilePaths;
  }
  if (astResult.scanFailures && astResult.scanFailures.length > 0) {
    merged.scanFailures = astResult.scanFailures;
  }
  return merged;
}

export function normalizeCodeSignalEngine(value: string | null | undefined): CodeSignalEngine {
  if (value === 'ast' || value === 'auto') return 'ast';
  if (value === 'regex') return 'regex';
  if (value === 'hybrid') return 'hybrid';
  return 'hybrid';
}

/** 시간 측정 헬퍼 */
function elapsed(start: number): number {
  return Math.round(performance.now() - start);
}

/** 기본 메트릭 생성 */
function buildMetrics(overrides: {
  timings?: CodeSignalMetrics['timings'];
  fallbackRate?: number;
  fallbackFileCount?: number;
  byLanguage?: Record<string, LanguageMetrics>;
} = {}): CodeSignalMetrics {
  const base: CodeSignalMetrics = {
    timings: overrides.timings ?? { primary: 0, total: 0 },
    fallbackRate: overrides.fallbackRate ?? 0,
    fallbackFileCount: overrides.fallbackFileCount ?? 0,
  };
  if (overrides.byLanguage) {
    base.byLanguage = overrides.byLanguage;
  }
  return base;
}

/** buildMetrics에 byLanguage를 조건부로 spread하기 위한 헬퍼 */
function langMetricsOf(result: CodeSignalResult): { byLanguage: Record<string, LanguageMetrics> } | Record<string, never> {
  const metrics = buildLanguageMetricsFromErrors(result);
  return metrics ? { byLanguage: metrics } : {};
}

/** scanErrorFilePaths에서 언어별 에러 카운트 추출 */
function buildLanguageMetricsFromErrors(result: CodeSignalResult): Record<string, LanguageMetrics> | undefined {
  const errorPaths = result.scanErrorFilePaths ?? [];
  if (errorPaths.length === 0 && (result.scanErrorCount ?? 0) === 0) return undefined;

  const langMap: Record<string, LanguageMetrics> = {};
  for (const filePath of errorPaths) {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    let lang: string;
    if (ext === 'java') lang = 'java';
    else if (ext === 'kt' || ext === 'kts') lang = 'kotlin';
    else if (['ts', 'tsx', 'js', 'jsx'].includes(ext)) lang = 'typescript';
    else if (ext === 'py') lang = 'python';
    else lang = 'unknown';

    if (!langMap[lang]) {
      langMap[lang] = { fileCount: 0, signalCount: 0, errorCount: 0, errorFilePaths: [] };
    }
    const entry = langMap[lang]!;
    entry.errorCount++;
    entry.errorFilePaths.push(filePath);
  }
  return langMap;
}

export async function extractCodeSignalsWithEngine(
  db: DbClient,
  options: CodeSignalEngineOptions,
): Promise<CodeSignalEngineResult> {
  const totalStart = performance.now();
  const engineRequested = normalizeCodeSignalEngine(options.codeEngine ?? null);
  const baseOptions: CodeSignalOptions = {
    workspaceId: options.workspaceId,
    repoRoot: options.repoRoot,
    ...(options.forceRescan === true ? { forceRescan: true } : {}),
    ...(options.targetFilePaths ? { targetFilePaths: options.targetFilePaths } : {}),
  };

  if (engineRequested === 'regex') {
    const primaryStart = performance.now();
    const result = await extractCodeSignals(db, baseOptions);
    const primaryMs = elapsed(primaryStart);
    return {
      ...result,
      engineRequested,
      engineUsed: 'regex',
      fallbackUsed: false,
      metrics: buildMetrics({
        timings: { primary: primaryMs, total: elapsed(totalStart) },
      }),
    };
  }

  if (engineRequested === 'hybrid') {
    const primaryStart = performance.now();
    const result = await extractHybridCodeSignals(db, baseOptions);
    const primaryMs = elapsed(primaryStart);
    return {
      ...result,
      engineRequested,
      engineUsed: 'hybrid',
      fallbackUsed: false,
      metrics: buildMetrics({
        timings: { primary: primaryMs, total: elapsed(totalStart) },
      }),
    };
  }

  // AST 모드
  try {
    const primaryStart = performance.now();
    const astResult = await extractAstCodeSignals(db, baseOptions);
    const primaryMs = elapsed(primaryStart);
    let fallbackWarning: string | undefined;

    if (shouldProbeRegexFallback(astResult)) {
      const failedFilePaths = getFailedFilePaths(astResult);
      if (failedFilePaths.length === 0 && astResult.signalCount > 0) {
        return {
          ...astResult,
          engineRequested,
          engineUsed: 'ast',
          fallbackUsed: false,
          warning: `AST 파싱 오류(${astResult.scanErrorCount ?? 0}건)를 감지했지만 실패 파일 식별이 불가하여 Regex fallback을 건너뛰었습니다.`,
          metrics: buildMetrics({
            timings: { primary: primaryMs, total: elapsed(totalStart) },
            ...langMetricsOf(astResult),
            fallbackRate: 0,
            fallbackFileCount: 0,
          }),
        };
      }

      try {
        const fallbackStart = performance.now();
        const regexResult = await extractCodeSignals(db, {
          ...baseOptions,
          forceRescan: true,
          ...(failedFilePaths.length > 0 ? { targetFilePaths: failedFilePaths } : {}),
        });
        const fallbackMs = elapsed(fallbackStart);

        const processedFileCount = astResult.fileCount - astResult.skippedCount;
        const fallbackRate = processedFileCount > 0
          ? failedFilePaths.length / processedFileCount
          : 0;

        if (astResult.signalCount > 0) {
          return {
            ...mergeAstAndRegexRecovery(astResult, regexResult),
            engineRequested,
            engineUsed: 'ast',
            fallbackUsed: true,
            warning: `AST 파싱 오류(${astResult.scanErrorCount ?? 0}건) 파일에 한해 Regex fallback을 병행 적용했습니다.`,
            metrics: buildMetrics({
              timings: { primary: primaryMs, fallback: fallbackMs, total: elapsed(totalStart) },
              ...langMetricsOf(astResult),
              fallbackRate: Math.round(fallbackRate * 1000) / 1000,
              fallbackFileCount: failedFilePaths.length,
            }),
          };
        }

        return {
          ...regexResult,
          engineRequested,
          engineUsed: 'regex',
          fallbackUsed: true,
          warning: `AST 파싱 오류(${astResult.scanErrorCount ?? 0}건) 감지로 Regex fallback 결과를 사용했습니다.`,
          metrics: buildMetrics({
            timings: { primary: primaryMs, fallback: fallbackMs, total: elapsed(totalStart) },
            ...langMetricsOf(astResult),
            fallbackRate: 1,
            fallbackFileCount: failedFilePaths.length,
          }),
        };
      } catch (fallbackError) {
        const fallbackErrorMessage =
          fallbackError instanceof Error ? fallbackError.message : 'unknown regex fallback error';
        fallbackWarning = `AST 파싱 오류(${astResult.scanErrorCount ?? 0}건)를 감지했으나 Regex fallback에 실패했습니다: ${fallbackErrorMessage}`;
      }
    }

    return {
      ...astResult,
      engineRequested,
      engineUsed: 'ast',
      fallbackUsed: false,
      ...(fallbackWarning ? { warning: fallbackWarning } : {}),
      metrics: buildMetrics({
        timings: { primary: primaryMs, total: elapsed(totalStart) },
        ...langMetricsOf(astResult),
      }),
    };
  } catch (astError) {
    const astErrorMessage = astError instanceof Error ? astError.message : 'unknown AST error';
    try {
      const fallbackStart = performance.now();
      const result = await extractCodeSignals(db, {
        ...baseOptions,
        forceRescan: true,
      });
      const fallbackMs = elapsed(fallbackStart);
      return {
        ...result,
        engineRequested,
        engineUsed: 'regex',
        fallbackUsed: true,
        warning: `AST 추출 실패로 Regex fallback을 사용했습니다: ${astErrorMessage}`,
        metrics: buildMetrics({
          timings: { primary: 0, fallback: fallbackMs, total: elapsed(totalStart) },
          fallbackRate: 1,
          fallbackFileCount: result.fileCount,
        }),
      };
    } catch (regexError) {
      const regexErrorMessage = regexError instanceof Error ? regexError.message : 'unknown regex error';
      throw new Error(
        `코드 신호 추출 실패(AST + Regex): ast=${astErrorMessage}; regex=${regexErrorMessage}`,
      );
    }
  }
}
