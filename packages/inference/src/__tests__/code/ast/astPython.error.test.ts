import { describe, expect, it, vi } from 'vitest';

vi.mock('@/code/ast/wasmParser', () => ({
  getWasmParser: vi.fn(async () => ({
    parse: () => {
      throw new Error('parse failed');
    },
  })),
}));

import { scanPythonAst } from '@/code/ast/astPython';

describe('scanPythonAst parse error handling', () => {
  it('parser.parse 예외 발생 시 빈 signals를 반환해야 한다', async () => {
    const result = await scanPythonAst('/src/broken.py', 'def broken(:');
    expect(result.language).toBe('python');
    expect(result.signals).toEqual([]);
  });
});
