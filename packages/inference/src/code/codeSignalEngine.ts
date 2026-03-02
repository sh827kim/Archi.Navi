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
    const result = await extractAstCodeSignals(db, baseOptions);
    return {
      ...result,
      engineRequested,
      engineUsed: 'ast',
      fallbackUsed: false,
    };
  } catch (astError) {
    const astErrorMessage = astError instanceof Error ? astError.message : 'unknown AST error';
    try {
      const result = await extractCodeSignals(db, baseOptions);
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
