/**
 * WASM 기반 tree-sitter 파서 팩토리 (BUILD-C1 / 2-1-C1)
 *
 * 네이티브 tree-sitter → web-tree-sitter (WASM) 전환.
 * - 비동기 초기화 (Parser.init() + Language.load())
 * - 언어별 파서 인스턴스 캐싱 (싱글턴)
 * - Kotlin 지원 추가 (2-1-C1)
 *
 * 설계 참조: docs/10-verification-report.md §5
 */
import Parser from 'web-tree-sitter';
import { join } from 'path';

// ─── 타입 정의 ────────────────────────────────────────────────────────────────

export type SupportedLanguage = 'java' | 'kotlin' | 'typescript' | 'python';

/** web-tree-sitter의 SyntaxNode를 re-export */
export type { SyntaxNode } from 'web-tree-sitter';

// ─── WASM 파일 경로 해석 ───────────────────────────────────────────────────────

/**
 * WASM grammar 파일 경로 결정
 * 환경변수 TREE_SITTER_WASM_DIR가 설정되면 해당 경로 사용,
 * 아니면 packages/inference/wasm/ 디렉토리 기본 사용
 */
function getWasmDir(): string {
    if (process.env['TREE_SITTER_WASM_DIR']) {
        return process.env['TREE_SITTER_WASM_DIR'];
    }

    // src/code/ast 또는 dist/code/ast 기준으로 패키지 루트의 wasm/ 디렉토리까지 이동
    return join(__dirname, '..', '..', '..', 'wasm');
}

/** 언어별 WASM 파일명 매핑 */
const WASM_FILE_MAP: Record<SupportedLanguage, string> = {
    java: 'tree-sitter-java.wasm',
    kotlin: 'tree-sitter-kotlin.wasm',
    typescript: 'tree-sitter-typescript.wasm',
    python: 'tree-sitter-python.wasm',
};

// ─── 초기화 상태 관리 ──────────────────────────────────────────────────────────

let _initPromise: Promise<void> | null = null;
const _parsers = new Map<SupportedLanguage, Parser>();

/**
 * web-tree-sitter WASM 런타임 초기화 (최초 1회)
 * Parser.init()는 전역에서 한 번만 호출하면 된다.
 */
async function ensureInit(): Promise<void> {
    if (!_initPromise) {
        _initPromise = Parser.init();
    }
    await _initPromise;
}

// ─── 공개 API ──────────────────────────────────────────────────────────────────

/**
 * 지정 언어의 WASM 파서를 반환한다 (캐시 적용).
 *
 * @param language - 파싱 대상 언어
 * @returns 초기화된 Parser 인스턴스
 *
 * @example
 * const parser = await getWasmParser('java');
 * const tree = parser.parse(sourceCode);
 */
export async function getWasmParser(language: SupportedLanguage): Promise<Parser> {
    const cached = _parsers.get(language);
    if (cached) return cached;

    await ensureInit();

    const wasmDir = getWasmDir();
    const wasmFile = WASM_FILE_MAP[language];
    const wasmPath = join(wasmDir, wasmFile);

    const lang = await Parser.Language.load(wasmPath);
    const parser = new Parser();
    parser.setLanguage(lang);

    _parsers.set(language, parser);
    return parser;
}

/**
 * 파일 확장자로 적절한 언어를 결정한다.
 *
 * @param filePath - 파일 경로
 * @returns 지원 언어 또는 null (미지원 확장자)
 */
export function detectLanguage(filePath: string): SupportedLanguage | null {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    switch (ext) {
        case 'java':
            return 'java';
        case 'kt':
        case 'kts':
            return 'kotlin';
        case 'ts':
        case 'tsx':
            return 'typescript';
        case 'js':
        case 'jsx':
            return 'typescript'; // tree-sitter-typescript로 JS도 파싱
        case 'py':
            return 'python';
        default:
            return null;
    }
}

/**
 * 캐시된 파서 인스턴스 초기화 (테스트용)
 */
export function resetParsers(): void {
    for (const parser of _parsers.values()) {
        parser.delete();
    }
    _parsers.clear();
    _initPromise = null;
}
