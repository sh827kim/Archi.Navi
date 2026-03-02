import type { ExtractedSignal } from './codeSignalExtractor';

export type HybridSignalSource = 'ast' | 'regex';

export interface HybridSignalInput {
  source: HybridSignalSource;
  signal: ExtractedSignal;
}

function signalKey(signal: ExtractedSignal): string {
  return `${signal.kind}\u0000${signal.symbol}\u0000${signal.lineStart}\u0000${signal.lineEnd}`;
}

function readSources(signal: ExtractedSignal): HybridSignalSource[] {
  const raw = (signal.metadata as Record<string, unknown>)['extractionSources'];
  if (!Array.isArray(raw)) return [];

  return raw.filter((value): value is HybridSignalSource => value === 'ast' || value === 'regex');
}

function withSource(signal: ExtractedSignal, source: HybridSignalSource): ExtractedSignal {
  return {
    ...signal,
    metadata: {
      ...signal.metadata,
      extractionSources: [source],
    },
  };
}

/**
 * AST/Regex 추출 결과를 키(kind/symbol/line 범위) 기준으로 병합한다.
 * 중복 신호는 confidence가 높은 쪽을 우선하고, source는 누적한다.
 */
export function mergeHybridSignals(inputs: HybridSignalInput[]): ExtractedSignal[] {
  const merged = new Map<string, ExtractedSignal>();

  for (const input of inputs) {
    const candidate = withSource(input.signal, input.source);
    const key = signalKey(candidate);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, candidate);
      continue;
    }

    const existingSources = readSources(existing);
    const candidateSources = readSources(candidate);
    const mergedSources = Array.from(new Set([...existingSources, ...candidateSources]));

    const candidateWins = candidate.confidence > existing.confidence;
    const preferred = candidateWins ? candidate : existing;
    const secondary = candidateWins ? existing : candidate;

    merged.set(key, {
      ...preferred,
      confidence: Math.max(existing.confidence, candidate.confidence),
      metadata: {
        ...secondary.metadata,
        ...preferred.metadata,
        extractionSources: mergedSources,
      },
    });
  }

  return Array.from(merged.values()).sort((a, b) => {
    if (a.lineStart !== b.lineStart) return a.lineStart - b.lineStart;
    if (a.lineEnd !== b.lineEnd) return a.lineEnd - b.lineEnd;
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.symbol.localeCompare(b.symbol);
  });
}
