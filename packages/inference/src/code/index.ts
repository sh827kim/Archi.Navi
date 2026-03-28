/**
 * Code Signal 추출 모듈
 * Phase 1: Regex 기반 패턴 매칭
 *
 * Phase 2 (AST) 는 tree-sitter 네이티브 의존성이 필요하므로
 * 별도 진입점(./ast)에서 import해야 함.
 * → WASM 전환 완료 후 다시 통합 예정 (docs/10-verification-report.md §5)
 */
export { extractCodeSignals } from './codeSignalExtractor';
export { extractHybridCodeSignals } from './hybridCodeSignalExtractor';
export {
    extractCodeSignalsWithEngine,
    normalizeCodeSignalEngine,
} from './codeSignalEngine';
export { mergeHybridSignals } from './hybridSignalMerge';
export { builtInPlugins, getBuiltInPlugins } from './plugins/builtInPlugins';
export { PluginRegistry, pluginRegistry, detectPlugins } from './plugins/pluginRegistry';
export {
    detectLanguageFromFilePath,
    scanFileWithAstPlugins,
    scanFileWithRegexPlugins,
    scanFileWithHybridPlugins,
} from './plugins/runtime';
export type {
    CodeSignalOptions,
    CodeSignalResult,
    ExtractedSignal,
    FileScanResult,
    ScanFailureDetail,
    SignalKind,
} from './codeSignalExtractor';
export type {
    FrameworkPlugin,
    FrameworkPluginDetector,
    FrameworkPluginLanguage,
} from './plugins/types';
export type {
    CodeSignalEngine,
    CodeSignalEngineResult,
    CodeSignalEngineUsed,
    CodeSignalEngineOptions,
    CodeSignalMetrics,
    LanguageMetrics,
} from './codeSignalEngine';
export { ENGINE_POLICY } from './codeSignalEngine';
