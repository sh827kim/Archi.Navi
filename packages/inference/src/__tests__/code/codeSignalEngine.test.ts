import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractCodeSignalsWithEngine,
  normalizeCodeSignalEngine,
  ENGINE_POLICY,
} from '@/code/codeSignalEngine';
import type { CodeSignalMetrics } from '@/code/codeSignalEngine';
import { extractCodeSignals } from '@/code/codeSignalExtractor';
import { extractAstCodeSignals } from '@/code/ast/extractAstCodeSignals';
import { extractHybridCodeSignals } from '@/code/hybridCodeSignalExtractor';

vi.mock('@/code/codeSignalExtractor', () => ({
  extractCodeSignals: vi.fn(),
}));

vi.mock('@/code/ast/extractAstCodeSignals', () => ({
  extractAstCodeSignals: vi.fn(),
}));

vi.mock('@/code/hybridCodeSignalExtractor', () => ({
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

  it('forceRescan=true이면 regex 모드에서 extractCodeSignals로 전달해야 한다', async () => {
    vi.mocked(extractCodeSignals).mockResolvedValue(BASE_RESULT);

    await extractCodeSignalsWithEngine(db, {
      ...options,
      codeEngine: 'regex',
      forceRescan: true,
    });

    expect(extractCodeSignals).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ ...options, forceRescan: true }),
    );
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

  it('forceRescan=true이면 ast 모드에서 extractAstCodeSignals로 전달해야 한다', async () => {
    vi.mocked(extractAstCodeSignals).mockResolvedValue(BASE_RESULT);

    await extractCodeSignalsWithEngine(db, {
      ...options,
      codeEngine: 'ast',
      forceRescan: true,
    });

    expect(extractAstCodeSignals).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ ...options, forceRescan: true }),
    );
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

  it('forceRescan=true이면 hybrid 모드에서 extractHybridCodeSignals로 전달해야 한다', async () => {
    vi.mocked(extractHybridCodeSignals).mockResolvedValue(BASE_RESULT);

    await extractCodeSignalsWithEngine(db, {
      ...options,
      codeEngine: 'hybrid',
      forceRescan: true,
    });

    expect(extractHybridCodeSignals).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ ...options, forceRescan: true }),
    );
  });

  it('ast 모드에서 AST 실패 시 Regex fallback을 사용해야 한다', async () => {
    vi.mocked(extractAstCodeSignals).mockRejectedValue(new Error('AST parser init failed'));
    vi.mocked(extractCodeSignals).mockResolvedValue(BASE_RESULT);

    const result = await extractCodeSignalsWithEngine(db, { ...options, codeEngine: 'ast' });

    expect(extractAstCodeSignals).toHaveBeenCalledTimes(1);
    expect(extractCodeSignals).toHaveBeenCalledTimes(1);
    expect(extractCodeSignals).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ ...options, forceRescan: true }),
    );
    expect(result.engineRequested).toBe('ast');
    expect(result.engineUsed).toBe('regex');
    expect(result.fallbackUsed).toBe(true);
    expect(result.warning).toContain('AST 추출 실패');
  });

  it('ast 모드에서 AST 무신호(침묵 실패) 시 Regex probe 결과를 fallback으로 채택해야 한다', async () => {
    vi.mocked(extractAstCodeSignals).mockResolvedValue({
      fileCount: 5,
      artifactCount: 0,
      signalCount: 0,
      skippedCount: 0,
      scanErrorCount: 2,
      scanErrorFilePaths: ['/tmp/repo/src/A.java', '/tmp/repo/src/B.java'],
    });
    vi.mocked(extractCodeSignals).mockResolvedValue(BASE_RESULT);

    const result = await extractCodeSignalsWithEngine(db, { ...options, codeEngine: 'ast' });

    expect(extractAstCodeSignals).toHaveBeenCalledTimes(1);
    expect(extractCodeSignals).toHaveBeenCalledTimes(1);
    expect(extractCodeSignals).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        ...options,
        forceRescan: true,
        targetFilePaths: ['/tmp/repo/src/A.java', '/tmp/repo/src/B.java'],
      }),
    );
    expect(result.engineRequested).toBe('ast');
    expect(result.engineUsed).toBe('regex');
    expect(result.fallbackUsed).toBe(true);
    expect(result.warning).toContain('파싱 오류');
  });

  it('AST 무신호 probe에서 Regex 신호가 동일/낮아도 regex 결과를 활성 엔진으로 반환해야 한다', async () => {
    vi.mocked(extractAstCodeSignals).mockResolvedValue({
      fileCount: 5,
      artifactCount: 0,
      signalCount: 0,
      skippedCount: 0,
      scanErrorCount: 1,
      scanErrorFilePaths: ['/tmp/repo/src/A.java'],
    });
    vi.mocked(extractCodeSignals).mockResolvedValue({
      fileCount: 5,
      artifactCount: 2,
      signalCount: 0,
      skippedCount: 0,
    });

    const result = await extractCodeSignalsWithEngine(db, { ...options, codeEngine: 'ast' });

    expect(extractAstCodeSignals).toHaveBeenCalledTimes(1);
    expect(extractCodeSignals).toHaveBeenCalledTimes(1);
    expect(result.engineUsed).toBe('regex');
    expect(result.fallbackUsed).toBe(true);
  });

  it('ast 모드에서 일부 파일만 파싱 실패한 경우(signal>0 + scanError>0)에도 Regex probe를 수행해야 한다', async () => {
    vi.mocked(extractAstCodeSignals).mockResolvedValue({
      fileCount: 5,
      artifactCount: 2,
      signalCount: 3,
      skippedCount: 0,
      scanErrorCount: 1,
      scanErrorFilePaths: ['/tmp/repo/src/Failed.ts'],
    });
    vi.mocked(extractCodeSignals).mockResolvedValue({
      fileCount: 1,
      artifactCount: 1,
      signalCount: 2,
      skippedCount: 0,
    });

    const result = await extractCodeSignalsWithEngine(db, { ...options, codeEngine: 'ast' });

    expect(extractAstCodeSignals).toHaveBeenCalledTimes(1);
    expect(extractCodeSignals).toHaveBeenCalledTimes(1);
    expect(extractCodeSignals).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        ...options,
        forceRescan: true,
        targetFilePaths: ['/tmp/repo/src/Failed.ts'],
      }),
    );
    expect(result.engineUsed).toBe('ast');
    expect(result.fallbackUsed).toBe(true);
    expect(result.signalCount).toBe(5);
    expect(result.warning).toContain('파싱 오류');
  });

  it('ast 모드에서 scanErrorCount>0 이지만 실패 파일 목록이 없고 AST 신호가 있으면 fallback을 건너뛰어야 한다', async () => {
    vi.mocked(extractAstCodeSignals).mockResolvedValue({
      fileCount: 4,
      artifactCount: 1,
      signalCount: 2,
      skippedCount: 0,
      scanErrorCount: 1,
    });

    const result = await extractCodeSignalsWithEngine(db, { ...options, codeEngine: 'ast' });

    expect(extractAstCodeSignals).toHaveBeenCalledTimes(1);
    expect(extractCodeSignals).not.toHaveBeenCalled();
    expect(result.engineUsed).toBe('ast');
    expect(result.fallbackUsed).toBe(false);
    expect(result.warning).toContain('건너뛰었습니다');
  });

  it('ast 모드에서 모두 skipped인 0 signal 결과는 Regex probe를 수행하지 않아야 한다', async () => {
    vi.mocked(extractAstCodeSignals).mockResolvedValue({
      fileCount: 4,
      artifactCount: 0,
      signalCount: 0,
      skippedCount: 4,
      scanErrorCount: 1,
    });

    const result = await extractCodeSignalsWithEngine(db, { ...options, codeEngine: 'ast' });

    expect(extractAstCodeSignals).toHaveBeenCalledTimes(1);
    expect(extractCodeSignals).not.toHaveBeenCalled();
    expect(result.engineUsed).toBe('ast');
    expect(result.fallbackUsed).toBe(false);
  });

  it('ast 모드에서 0 signal이어도 AST 오류 신호가 없으면 Regex probe를 수행하지 않아야 한다', async () => {
    vi.mocked(extractAstCodeSignals).mockResolvedValue({
      fileCount: 3,
      artifactCount: 0,
      signalCount: 0,
      skippedCount: 0,
      scanErrorCount: 0,
    });

    const result = await extractCodeSignalsWithEngine(db, { ...options, codeEngine: 'ast' });

    expect(extractAstCodeSignals).toHaveBeenCalledTimes(1);
    expect(extractCodeSignals).not.toHaveBeenCalled();
    expect(result.engineUsed).toBe('ast');
    expect(result.fallbackUsed).toBe(false);
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

  // ─── 관측 지표(metrics) 테스트 ─────────────────────────────────────────────

  describe('metrics', () => {
    it('모든 모드에서 metrics 객체가 반환되어야 한다', async () => {
      vi.mocked(extractCodeSignals).mockResolvedValue(BASE_RESULT);
      vi.mocked(extractAstCodeSignals).mockResolvedValue(BASE_RESULT);
      vi.mocked(extractHybridCodeSignals).mockResolvedValue(BASE_RESULT);

      const regexResult = await extractCodeSignalsWithEngine(db, { ...options, codeEngine: 'regex' });
      expect(regexResult.metrics).toBeDefined();
      expect(regexResult.metrics.timings.primary).toBeGreaterThanOrEqual(0);
      expect(regexResult.metrics.timings.total).toBeGreaterThanOrEqual(0);
      expect(regexResult.metrics.fallbackRate).toBe(0);
      expect(regexResult.metrics.fallbackFileCount).toBe(0);

      const astResult = await extractCodeSignalsWithEngine(db, { ...options, codeEngine: 'ast' });
      expect(astResult.metrics).toBeDefined();

      const hybridResult = await extractCodeSignalsWithEngine(db, { ...options, codeEngine: 'hybrid' });
      expect(hybridResult.metrics).toBeDefined();
    });

    it('AST 부분 실패 fallback 시 fallbackRate/fallbackFileCount가 정확해야 한다', async () => {
      vi.mocked(extractAstCodeSignals).mockResolvedValue({
        fileCount: 10,
        artifactCount: 6,
        signalCount: 15,
        skippedCount: 0,
        scanErrorCount: 3,
        scanErrorFilePaths: ['/a/A.java', '/a/B.kt', '/a/C.ts'],
      });
      vi.mocked(extractCodeSignals).mockResolvedValue({
        fileCount: 3,
        artifactCount: 2,
        signalCount: 5,
        skippedCount: 0,
      });

      const result = await extractCodeSignalsWithEngine(db, { ...options, codeEngine: 'ast' });

      expect(result.metrics.fallbackUsed ?? result.fallbackUsed).toBeTruthy();
      expect(result.metrics.fallbackFileCount).toBe(3);
      expect(result.metrics.fallbackRate).toBeCloseTo(0.3, 1); // 3/10
      expect(result.metrics.timings.fallback).toBeGreaterThanOrEqual(0);
    });

    it('AST 전체 실패 시 fallbackRate=1 이어야 한다', async () => {
      vi.mocked(extractAstCodeSignals).mockRejectedValue(new Error('WASM init failed'));
      vi.mocked(extractCodeSignals).mockResolvedValue(BASE_RESULT);

      const result = await extractCodeSignalsWithEngine(db, { ...options, codeEngine: 'ast' });

      expect(result.metrics.fallbackRate).toBe(1);
      expect(result.metrics.timings.primary).toBe(0);
      expect(result.metrics.timings.fallback).toBeGreaterThanOrEqual(0);
    });

    it('언어별 에러 지표(byLanguage)가 올바르게 분류되어야 한다', async () => {
      vi.mocked(extractAstCodeSignals).mockResolvedValue({
        fileCount: 10,
        artifactCount: 5,
        signalCount: 12,
        skippedCount: 0,
        scanErrorCount: 3,
        scanErrorFilePaths: ['/src/A.java', '/src/B.kt', '/src/C.ts'],
      });
      vi.mocked(extractCodeSignals).mockResolvedValue({
        fileCount: 3, artifactCount: 2, signalCount: 5, skippedCount: 0,
      });

      const result = await extractCodeSignalsWithEngine(db, { ...options, codeEngine: 'ast' });
      const byLang = result.metrics.byLanguage;

      expect(byLang).toBeDefined();
      expect(byLang?.java?.errorCount).toBe(1);
      expect(byLang?.kotlin?.errorCount).toBe(1);
      expect(byLang?.typescript?.errorCount).toBe(1);
    });
  });

  // ─── scanFailures 테스트 ─────────────────────────────────────────────────

  describe('scanFailures', () => {
    it('AST 부분 실패 시 scanFailures가 병합 결과에 포함되어야 한다', async () => {
      vi.mocked(extractAstCodeSignals).mockResolvedValue({
        fileCount: 5,
        artifactCount: 2,
        signalCount: 3,
        skippedCount: 0,
        scanErrorCount: 1,
        scanErrorFilePaths: ['/tmp/repo/src/Bad.java'],
        scanFailures: [
          { filePath: '/tmp/repo/src/Bad.java', reason: 'unexpected token', language: 'java' },
        ],
      });
      vi.mocked(extractCodeSignals).mockResolvedValue({
        fileCount: 1,
        artifactCount: 1,
        signalCount: 2,
        skippedCount: 0,
      });

      const result = await extractCodeSignalsWithEngine(db, { ...options, codeEngine: 'ast' });

      expect(result.scanFailures).toBeDefined();
      expect(result.scanFailures).toHaveLength(1);
      expect(result.scanFailures![0]!.filePath).toBe('/tmp/repo/src/Bad.java');
      expect(result.scanFailures![0]!.reason).toBe('unexpected token');
      expect(result.scanFailures![0]!.language).toBe('java');
    });

    it('fallback 시에도 AST의 scanFailures가 보존되어야 한다', async () => {
      vi.mocked(extractAstCodeSignals).mockResolvedValue({
        fileCount: 3,
        artifactCount: 0,
        signalCount: 0,
        skippedCount: 0,
        scanErrorCount: 2,
        scanErrorFilePaths: ['/tmp/repo/A.ts', '/tmp/repo/B.ts'],
        scanFailures: [
          { filePath: '/tmp/repo/A.ts', reason: 'syntax error', language: 'typescript' },
          { filePath: '/tmp/repo/B.ts', reason: 'parse timeout', language: 'typescript' },
        ],
      });
      vi.mocked(extractCodeSignals).mockResolvedValue({
        fileCount: 2,
        artifactCount: 2,
        signalCount: 4,
        skippedCount: 0,
      });

      const result = await extractCodeSignalsWithEngine(db, { ...options, codeEngine: 'ast' });

      expect(result.fallbackUsed).toBe(true);
      expect(result.engineUsed).toBe('regex');
      expect(result.scanFailures).toHaveLength(2);
      expect(result.scanFailures?.map((item) => item.filePath)).toEqual([
        '/tmp/repo/A.ts',
        '/tmp/repo/B.ts',
      ]);
      expect(result.scanErrorCount).toBe(2);
      expect(result.scanErrorFilePaths).toEqual(['/tmp/repo/A.ts', '/tmp/repo/B.ts']);
    });

    it('regex 모드에서는 scanFailures가 없어야 한다', async () => {
      vi.mocked(extractCodeSignals).mockResolvedValue(BASE_RESULT);

      const result = await extractCodeSignalsWithEngine(db, { ...options, codeEngine: 'regex' });

      expect(result.scanFailures).toBeUndefined();
    });

    it('hybrid 모드에서는 scanFailures가 없어야 한다', async () => {
      vi.mocked(extractHybridCodeSignals).mockResolvedValue(BASE_RESULT);

      const result = await extractCodeSignalsWithEngine(db, { ...options, codeEngine: 'hybrid' });

      expect(result.scanFailures).toBeUndefined();
    });
  });

  // ─── 엔진 운영 정책 테스트 ─────────────────────────────────────────────────

  describe('ENGINE_POLICY', () => {
    it('3개 모드 모두 정책이 정의되어야 한다', () => {
      expect(ENGINE_POLICY.hybrid).toBeDefined();
      expect(ENGINE_POLICY.ast).toBeDefined();
      expect(ENGINE_POLICY.regex).toBeDefined();
    });

    it('각 정책에 description과 recommended가 있어야 한다', () => {
      for (const mode of ['hybrid', 'ast', 'regex'] as const) {
        expect(ENGINE_POLICY[mode].description).toBeTruthy();
        expect(ENGINE_POLICY[mode].recommended).toBeTruthy();
      }
    });
  });
});
