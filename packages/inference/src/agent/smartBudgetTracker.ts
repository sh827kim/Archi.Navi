import type { SmartBudgetTrackerSnapshot } from './smartProofTypes';

export interface RecordSmartBudgetCallInput {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd?: number;
}

export function createSmartBudgetTracker(input: {
  maxCalls: number;
  maxTokens: number;
}): SmartBudgetTrackerSnapshot {
  return {
    maxCalls: Math.max(0, Math.floor(input.maxCalls)),
    maxTokens: Math.max(0, Math.floor(input.maxTokens)),
    callsUsed: 0,
    tokensUsed: 0,
    estimatedCostUsd: 0,
  };
}

export function recordSmartBudgetCall(
  tracker: SmartBudgetTrackerSnapshot,
  input: RecordSmartBudgetCallInput,
): SmartBudgetTrackerSnapshot {
  const nextInputTokens = Math.max(0, Math.floor(input.inputTokens));
  const nextOutputTokens = Math.max(0, Math.floor(input.outputTokens));

  return {
    ...tracker,
    callsUsed: tracker.callsUsed + 1,
    tokensUsed: tracker.tokensUsed + nextInputTokens + nextOutputTokens,
    estimatedCostUsd: tracker.estimatedCostUsd + Math.max(0, input.estimatedCostUsd ?? 0),
  };
}

export function isSmartBudgetExhausted(tracker: SmartBudgetTrackerSnapshot): boolean {
  return tracker.callsUsed >= tracker.maxCalls || tracker.tokensUsed >= tracker.maxTokens;
}

export function canAffordSmartBudgetCall(
  tracker: SmartBudgetTrackerSnapshot,
  estimatedInputTokens: number,
): boolean {
  const normalizedEstimatedInputTokens = Math.max(0, Math.floor(estimatedInputTokens));
  if (tracker.callsUsed >= tracker.maxCalls) return false;
  return tracker.tokensUsed + normalizedEstimatedInputTokens <= tracker.maxTokens;
}
