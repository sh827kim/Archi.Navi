import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const parserMockState = vi.hoisted(() => {
  const initMock = vi.fn(async () => undefined);
  const loadMock = vi.fn(async (wasmPath: string) => ({ wasmPath }));
  const setLanguageMock = vi.fn();
  const deleteMock = vi.fn();

  const ParserMock = vi.fn(function MockParser(this: { setLanguage: typeof setLanguageMock; delete: typeof deleteMock }) {
    this.setLanguage = setLanguageMock;
    this.delete = deleteMock;
  });
  (ParserMock as unknown as { init: typeof initMock }).init = initMock;
  (
    ParserMock as unknown as {
      Language: { load: typeof loadMock };
    }
  ).Language = { load: loadMock };

  return {
    ParserMock,
    initMock,
    loadMock,
    setLanguageMock,
    deleteMock,
  };
});

vi.mock('web-tree-sitter', () => ({
  default: parserMockState.ParserMock,
}));

import { getWasmParser, detectLanguage, resetParsers } from '../../../code/ast/wasmParser';

describe('wasmParser', () => {
  beforeEach(() => {
    delete process.env['TREE_SITTER_WASM_DIR'];
    vi.clearAllMocks();
    resetParsers();
  });

  afterEach(() => {
    delete process.env['TREE_SITTER_WASM_DIR'];
    resetParsers();
  });

  it('환경변수 wasm 경로를 사용하고 동일 언어 파서를 캐시해야 한다', async () => {
    process.env['TREE_SITTER_WASM_DIR'] = '/tmp/custom-wasm';

    const parserA = await getWasmParser('java');
    const parserB = await getWasmParser('java');

    expect(parserA).toBe(parserB);
    expect(parserMockState.initMock).toHaveBeenCalledTimes(1);
    expect(parserMockState.loadMock).toHaveBeenCalledTimes(1);
    expect(parserMockState.loadMock).toHaveBeenCalledWith(
      '/tmp/custom-wasm/tree-sitter-java.wasm',
    );
    expect(parserMockState.ParserMock).toHaveBeenCalledTimes(1);
    expect(parserMockState.setLanguageMock).toHaveBeenCalledTimes(1);
  });

  it('resetParsers 후에는 delete 호출 및 재초기화되어야 한다', async () => {
    await getWasmParser('java');
    await getWasmParser('python');
    expect(parserMockState.ParserMock).toHaveBeenCalledTimes(2);

    resetParsers();
    expect(parserMockState.deleteMock).toHaveBeenCalledTimes(2);

    await getWasmParser('java');
    expect(parserMockState.initMock).toHaveBeenCalledTimes(2);
    expect(parserMockState.ParserMock).toHaveBeenCalledTimes(3);
  });

  it('확장자별 언어 감지를 수행해야 한다', () => {
    expect(detectLanguage('/a/b/Main.java')).toBe('java');
    expect(detectLanguage('/a/b/app.kt')).toBe('kotlin');
    expect(detectLanguage('/a/b/app.kts')).toBe('kotlin');
    expect(detectLanguage('/a/b/view.ts')).toBe('typescript');
    expect(detectLanguage('/a/b/view.tsx')).toBe('typescript');
    expect(detectLanguage('/a/b/view.js')).toBe('typescript');
    expect(detectLanguage('/a/b/view.jsx')).toBe('typescript');
    expect(detectLanguage('/a/b/run.py')).toBe('python');
    expect(detectLanguage('/a/b/README.md')).toBeNull();
  });
});
