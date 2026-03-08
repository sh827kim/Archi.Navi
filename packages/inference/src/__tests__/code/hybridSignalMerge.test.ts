import { describe, expect, it } from 'vitest';
import type { ExtractedSignal } from '@/code/codeSignalExtractor';
import { mergeHybridSignals } from '@/code/hybridSignalMerge';

function buildSignal(overrides: Partial<ExtractedSignal> = {}): ExtractedSignal {
  return {
    kind: 'call',
    symbol: '/api/users',
    lineStart: 10,
    lineEnd: 10,
    excerpt: 'fetch("/api/users")',
    confidence: 0.7,
    metadata: { client: 'fetch' },
    ...overrides,
  };
}

describe('mergeHybridSignals', () => {
  it('중복 키 신호는 confidence가 높은 항목 기준으로 병합해야 한다', () => {
    const merged = mergeHybridSignals([
      {
        source: 'regex',
        signal: buildSignal({
          confidence: 0.7,
          metadata: { client: 'fetch', method: 'GET' },
        }),
      },
      {
        source: 'ast',
        signal: buildSignal({
          confidence: 0.9,
          metadata: { client: 'axios', method: 'GET', resolvedFrom: 'const url' },
        }),
      },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.confidence).toBe(0.9);
    expect(merged[0]?.metadata['client']).toBe('axios');
    expect(merged[0]?.metadata['resolvedFrom']).toBe('const url');
    expect(merged[0]?.metadata['extractionSources']).toEqual(['regex', 'ast']);
  });

  it('키가 다른 신호는 그대로 모두 유지해야 한다', () => {
    const merged = mergeHybridSignals([
      {
        source: 'regex',
        signal: buildSignal({
          kind: 'call',
          symbol: '/api/a',
          lineStart: 3,
          lineEnd: 3,
        }),
      },
      {
        source: 'ast',
        signal: buildSignal({
          kind: 'expose',
          symbol: '/api/b',
          lineStart: 20,
          lineEnd: 20,
        }),
      },
    ]);

    expect(merged).toHaveLength(2);
    expect(merged.map((signal) => signal.symbol)).toEqual(['/api/a', '/api/b']);
  });
});
