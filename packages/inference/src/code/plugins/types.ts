import type { ExtractedSignal, FileScanResult, SignalKind } from '../codeSignalExtractor';
import type { AstPropertyMap } from '../ast/propertyResolver';
import type { AstProjectSymbolTable } from '../ast/symbolTable';

export type FrameworkLanguage = FileScanResult['language'];
export type FrameworkPluginLanguage = FrameworkLanguage;

export interface RegexSignalPattern {
  kind: SignalKind;
  regex: RegExp;
  confidence: number;
  extract: (match: RegExpMatchArray) => {
    symbol: string;
    metadata: Record<string, unknown>;
  };
}

export interface ProjectDetector {
  filePatterns?: string[];
  packageJsonDeps?: string[];
  manifestMatches?: Array<{
    fileName: string;
    pattern: RegExp;
  }>;
}
export type FrameworkPluginDetector = ProjectDetector;

export interface FrameworkAstScanContext {
  interProcedural?: {
    symbolTable: AstProjectSymbolTable;
    maxCallChainDepth: number;
  };
  propertyMap?: AstPropertyMap;
}

export interface FrameworkPlugin {
  id: string;
  displayName: string;
  version: string;
  languages: FrameworkLanguage[];
  detector?: ProjectDetector;
  regexPatterns?: RegexSignalPattern[];
  regexScanner?: (filePath: string, content: string) => FileScanResult;
  scanRegex?: (filePath: string, content: string) => FileScanResult;
  astExtractor?: (
    filePath: string,
    content: string,
    context: FrameworkAstScanContext,
  ) => FileScanResult | Promise<FileScanResult>;
  scanAst?: (
    filePath: string,
    content: string,
    context: FrameworkAstScanContext,
  ) => FileScanResult | Promise<FileScanResult>;
  configParsers?: Array<{
    filePatterns: string[];
    parse: (content: string, filePath: string) => unknown[];
  }>;
  confidenceRules?: Array<{
    signalKind: SignalKind;
    condition: (signal: ExtractedSignal) => boolean;
    adjustment: number;
  }>;
  fallback?: boolean;
}

export interface DetectPluginsOptions {
  repoRoot: string;
  filePaths: string[];
}
