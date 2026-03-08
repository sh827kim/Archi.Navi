import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

import {
  AstRuntimeError,
  getWasmParser,
  detectLanguage,
  resetParsers,
} from '@/code/ast/wasmParser';

describe('wasmParser', () => {
  beforeEach(() => {
    delete process.env['TREE_SITTER_WASM_DIR'];
    delete process.env['TREE_SITTER_RUNTIME_WASM_PATH'];
    vi.clearAllMocks();
    resetParsers();
  });

  afterEach(() => {
    delete process.env['TREE_SITTER_WASM_DIR'];
    delete process.env['TREE_SITTER_RUNTIME_WASM_PATH'];
    resetParsers();
  });

  it('환경변수 wasm 경로를 사용하고 동일 언어 파서를 캐시해야 한다', async () => {
    process.env['TREE_SITTER_WASM_DIR'] = '/tmp/custom-wasm';
    process.env['TREE_SITTER_RUNTIME_WASM_PATH'] = '/tmp/runtime/tree-sitter.wasm';

    const parserA = await getWasmParser('java');
    const parserB = await getWasmParser('java');

    expect(parserA).toBe(parserB);
    expect(parserMockState.initMock).toHaveBeenCalledTimes(1);
    expect(parserMockState.initMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        locateFile: expect.any(Function),
      }),
    );
    const locateFile = parserMockState.initMock.mock.calls[0]?.[0]?.locateFile as
      | ((path: string) => string)
      | undefined;
    expect(locateFile?.('tree-sitter.wasm')).toBe('/tmp/runtime/tree-sitter.wasm');
    expect(parserMockState.loadMock).toHaveBeenCalledTimes(1);
    expect(parserMockState.loadMock).toHaveBeenCalledWith(
      '/tmp/custom-wasm/tree-sitter-java.wasm',
    );
    expect(parserMockState.ParserMock).toHaveBeenCalledTimes(1);
    expect(parserMockState.setLanguageMock).toHaveBeenCalledTimes(1);
  });

  it('TREE_SITTER_RUNTIME_WASM_PATH가 없으면 wasm 디렉토리의 runtime wasm을 우선 사용해야 한다', async () => {
    const wasmDir = mkdtempSync(join(tmpdir(), 'archi-navi-wasm-'));
    writeFileSync(join(wasmDir, 'tree-sitter.wasm'), 'runtime');
    process.env['TREE_SITTER_WASM_DIR'] = wasmDir;

    await getWasmParser('java');

    const locateFile = parserMockState.initMock.mock.calls[0]?.[0]?.locateFile as
      | ((path: string) => string)
      | undefined;
    expect(locateFile?.('tree-sitter.wasm')).toBe(`${wasmDir}/tree-sitter.wasm`);
    expect(parserMockState.loadMock).toHaveBeenCalledWith(`${wasmDir}/tree-sitter-java.wasm`);
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

  it('grammar 로드 실패 시 AstRuntimeError를 던져야 한다', async () => {
    parserMockState.loadMock.mockRejectedValueOnce(new Error('missing grammar wasm'));

    await expect(getWasmParser('java')).rejects.toBeInstanceOf(AstRuntimeError);
  });
});
