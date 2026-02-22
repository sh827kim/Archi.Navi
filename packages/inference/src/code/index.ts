/**
 * Code Signal 추출 모듈
 * Phase 1: Regex 기반 패턴 매칭
 * Phase 2: AST 기반 정밀 추출 (tree-sitter)
 */
export { extractCodeSignals } from './codeSignalExtractor';
export type {
    CodeSignalOptions,
    CodeSignalResult,
    ExtractedSignal,
    FileScanResult,
    SignalKind,
} from './codeSignalExtractor';

// Phase 2: AST Plugin
export { extractAstCodeSignals } from './ast/extractAstCodeSignals';
export { scanJavaKotlinAst } from './ast/astJavaKotlin';
export { scanTypeScriptAst } from './ast/astTypeScript';
export { scanPythonAst } from './ast/astPython';
