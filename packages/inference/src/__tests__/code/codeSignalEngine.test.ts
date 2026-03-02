import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractCodeSignalsWithEngine,
  normalizeCodeSignalEngine,
} from '../../code/codeSignalEngine';
import { extractCodeSignals } from '../../code/codeSignalExtractor';
import { extractAstCodeSignals } from '../../code/ast/extractAstCodeSignals';
import { extractHybridCodeSignals } from '../../code/hybridCodeSignalExtractor';

vi.mock('../../code/codeSignalExtractor', () => ({
  extractCodeSignals: vi.fn(),
}));

vi.mock('../../code/ast/extractAstCodeSignals', () => ({
  extractAstCodeSignals: vi.fn(),
}));

vi.mock('../../code/hybridCodeSignalExtractor', () => ({
  extractHybridCodeSignals: vi.fn(),
}));

const BASE_RESULT = {
  fileCount: 3,
  artifactCount: 2,
  signalCount: 8,
  skippedCount: 1,
};

describe('codeSignalEngine', () => {
  const db = {} as Parameters<typeof extractCodeSignalsWithEngine>[0];
  const options = { workspaceId: 'ws-1', repoRoot: '/tmp/repo' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('normalizeCodeSignalEngine는 미지정/잘못된 값에서 hybrid를 반환해야 한다', () => {
    expect(normalizeCodeSignalEngine(undefined)).toBe('hybrid');
    expect(normalizeCodeSignalEngine(null)).toBe('hybrid');
    expect(normalizeCodeSignalEngine('unknown')).toBe('hybrid');
    expect(normalizeCodeSignalEngine('ast')).toBe('ast');
    expect(normalizeCodeSignalEngine('auto')).toBe('ast');
    expect(normalizeCodeSignalEngine('regex')).toBe('regex');
    expect(normalizeCodeSignalEngine('hybrid')).toBe('hybrid');
  });

  it('regex 모드면 Regex 추출기만 사용해야 한다', async () => {
    vi.mocked(extractCodeSignals).mockResolvedValue(BASE_RESULT);

    const result = await extractCodeSignalsWithEngine(db, { ...options, codeEngine: 'regex' });

    expect(extractCodeSignals).toHaveBeenCalledTimes(1);
    expect(extractAstCodeSignals).not.toHaveBeenCalled();
    expect(result.engineRequested).toBe('regex');
    expect(result.engineUsed).toBe('regex');
    expect(result.fallbackUsed).toBe(false);
  });

  it('ast 모드에서 AST가 성공하면 fallback 없이 AST를 사용해야 한다', async () => {
    vi.mocked(extractAstCodeSignals).mockResolvedValue(BASE_RESULT);

    const result = await extractCodeSignalsWithEngine(db, { ...options, codeEngine: 'ast' });

    expect(extractAstCodeSignals).toHaveBeenCalledTimes(1);
    expect(extractCodeSignals).not.toHaveBeenCalled();
    expect(result.engineRequested).toBe('ast');
    expect(result.engineUsed).toBe('ast');
    expect(result.fallbackUsed).toBe(false);
  });

  it('hybrid 모드면 AST+Regex 병합 추출기만 사용해야 한다', async () => {
    vi.mocked(extractHybridCodeSignals).mockResolvedValue(BASE_RESULT);

    const result = await extractCodeSignalsWithEngine(db, { ...options, codeEngine: 'hybrid' });

    expect(extractHybridCodeSignals).toHaveBeenCalledTimes(1);
    expect(extractAstCodeSignals).not.toHaveBeenCalled();
    expect(extractCodeSignals).not.toHaveBeenCalled();
    expect(result.engineRequested).toBe('hybrid');
    expect(result.engineUsed).toBe('hybrid');
    expect(result.fallbackUsed).toBe(false);
  });

  it('ast 모드에서 AST 실패 시 Regex fallback을 사용해야 한다', async () => {
    vi.mocked(extractAstCodeSignals).mockRejectedValue(new Error('AST parser init failed'));
    vi.mocked(extractCodeSignals).mockResolvedValue(BASE_RESULT);

    const result = await extractCodeSignalsWithEngine(db, { ...options, codeEngine: 'ast' });

    expect(extractAstCodeSignals).toHaveBeenCalledTimes(1);
    expect(extractCodeSignals).toHaveBeenCalledTimes(1);
    expect(result.engineRequested).toBe('ast');
    expect(result.engineUsed).toBe('regex');
    expect(result.fallbackUsed).toBe(true);
    expect(result.warning).toContain('AST 추출 실패');
  });

  it('ast 모드에서 AST/Regex 모두 실패하면 에러를 던져야 한다', async () => {
    vi.mocked(extractAstCodeSignals).mockRejectedValue(new Error('ast failed'));
    vi.mocked(extractCodeSignals).mockRejectedValue(new Error('regex failed'));

    await expect(
      extractCodeSignalsWithEngine(db, { ...options, codeEngine: 'ast' }),
    ).rejects.toThrow('코드 신호 추출 실패(AST + Regex)');
  });

  it('auto 입력은 ast 별칭으로 동작해야 한다', async () => {
    vi.mocked(extractAstCodeSignals).mockResolvedValue(BASE_RESULT);

    const result = await extractCodeSignalsWithEngine(db, { ...options, codeEngine: 'auto' });

    expect(extractAstCodeSignals).toHaveBeenCalledTimes(1);
    expect(extractCodeSignals).not.toHaveBeenCalled();
    expect(result.engineRequested).toBe('ast');
    expect(result.engineUsed).toBe('ast');
  });
});
