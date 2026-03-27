/**
 * AST Plugin 모듈 (Phase 2)
 * tree-sitter 기반 정밀 코드 신호 추출
 *
 * 설계 참조: docs/03-inference-engine.md §6.2 Phase 2
 */
export { extractAstCodeSignals } from './extractAstCodeSignals';
export {
  buildProjectSymbolTable,
  getImplementationsForInterface,
  getSingleImplementationForInterface,
  getTypeSymbol,
} from './symbolTable';
export { scanJavaKotlinAst } from './astJavaKotlin';
export { scanTypeScriptAst } from './astTypeScript';
export { scanPythonAst } from './astPython';
