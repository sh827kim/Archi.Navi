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

export interface CodeSignalEngineOptions extends CodeSignalOptions {
  codeEngine?: CodeSignalEngine | 'auto' | string | null;
}

export interface CodeSignalEngineResult extends CodeSignalResult {
  engineRequested: CodeSignalEngine;
  engineUsed: CodeSignalEngineUsed;
  fallbackUsed: boolean;
  warning?: string;
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
  return merged;
}

export function normalizeCodeSignalEngine(value: string | null | undefined): CodeSignalEngine {
  if (value === 'ast' || value === 'auto') return 'ast';
  if (value === 'regex') return 'regex';
  if (value === 'hybrid') return 'hybrid';
  return 'hybrid';
}

export async function extractCodeSignalsWithEngine(
  db: DbClient,
  options: CodeSignalEngineOptions,
): Promise<CodeSignalEngineResult> {
  const engineRequested = normalizeCodeSignalEngine(options.codeEngine ?? null);
  const baseOptions: CodeSignalOptions = {
    workspaceId: options.workspaceId,
    repoRoot: options.repoRoot,
    ...(options.forceRescan === true ? { forceRescan: true } : {}),
    ...(options.targetFilePaths ? { targetFilePaths: options.targetFilePaths } : {}),
  };

  if (engineRequested === 'regex') {
    const result = await extractCodeSignals(db, baseOptions);
    return {
      ...result,
      engineRequested,
      engineUsed: 'regex',
      fallbackUsed: false,
    };
  }

  if (engineRequested === 'hybrid') {
    const result = await extractHybridCodeSignals(db, baseOptions);
    return {
      ...result,
      engineRequested,
      engineUsed: 'hybrid',
      fallbackUsed: false,
    };
  }

  try {
    const astResult = await extractAstCodeSignals(db, baseOptions);
    let fallbackWarning: string | undefined;

    if (shouldProbeRegexFallback(astResult)) {
      const failedFilePaths = getFailedFilePaths(astResult);
      if (failedFilePaths.length === 0 && astResult.signalCount > 0) {
        // 실패 파일 식별 정보가 없을 때 전체 regex fallback은 AST 성공 신호를 덮어쓸 수 있어 차단한다.
        return {
          ...astResult,
          engineRequested,
          engineUsed: 'ast',
          fallbackUsed: false,
          warning: `AST 파싱 오류(${astResult.scanErrorCount ?? 0}건)를 감지했지만 실패 파일 식별이 불가하여 Regex fallback을 건너뛰었습니다.`,
        };
      }

      try {
        const regexResult = await extractCodeSignals(db, {
          ...baseOptions,
          forceRescan: true,
          ...(failedFilePaths.length > 0 ? { targetFilePaths: failedFilePaths } : {}),
        });

        if (astResult.signalCount > 0) {
          return {
            ...mergeAstAndRegexRecovery(astResult, regexResult),
            engineRequested,
            engineUsed: 'ast',
            fallbackUsed: true,
            warning: `AST 파싱 오류(${astResult.scanErrorCount ?? 0}건) 파일에 한해 Regex fallback을 병행 적용했습니다.`,
          };
        }

        return {
          ...regexResult,
          engineRequested,
          engineUsed: 'regex',
          fallbackUsed: true,
          warning: `AST 파싱 오류(${astResult.scanErrorCount ?? 0}건) 감지로 Regex fallback 결과를 사용했습니다.`,
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
    };
  } catch (astError) {
    const astErrorMessage = astError instanceof Error ? astError.message : 'unknown AST error';
    try {
      const result = await extractCodeSignals(db, {
        ...baseOptions,
        forceRescan: true,
      });
      return {
        ...result,
        engineRequested,
        engineUsed: 'regex',
        fallbackUsed: true,
        warning: `AST 추출 실패로 Regex fallback을 사용했습니다: ${astErrorMessage}`,
      };
    } catch (regexError) {
      const regexErrorMessage = regexError instanceof Error ? regexError.message : 'unknown regex error';
      throw new Error(
        `코드 신호 추출 실패(AST + Regex): ast=${astErrorMessage}; regex=${regexErrorMessage}`,
      );
    }
  }
}
