import { describe, expect, it } from 'vitest';
import {
  canAffordSmartBudgetCall,
  createSmartBudgetTracker,
  isSmartBudgetExhausted,
  recordSmartBudgetCall,
} from '@/agent/smartBudgetTracker';

describe('smartBudgetTracker', () => {
  it('호출과 토큰 사용량을 누적하고 예산 소진 여부를 계산해야 한다', () => {
    const tracker = createSmartBudgetTracker({
      maxCalls: 2,
      maxTokens: 100,
    });

    expect(tracker).toMatchObject({
      maxCalls: 2,
      maxTokens: 100,
      callsUsed: 0,
      tokensUsed: 0,
      estimatedCostUsd: 0,
    });
    expect(canAffordSmartBudgetCall(tracker, 80)).toBe(true);
    expect(isSmartBudgetExhausted(tracker)).toBe(false);

    const afterFirstCall = recordSmartBudgetCall(tracker, {
      inputTokens: 40,
      outputTokens: 20,
      estimatedCostUsd: 0.12,
    });

    expect(afterFirstCall).toMatchObject({
      callsUsed: 1,
      tokensUsed: 60,
      estimatedCostUsd: 0.12,
    });
    expect(canAffordSmartBudgetCall(afterFirstCall, 30)).toBe(true);
    expect(canAffordSmartBudgetCall(afterFirstCall, 50)).toBe(false);
    expect(isSmartBudgetExhausted(afterFirstCall)).toBe(false);

    const afterSecondCall = recordSmartBudgetCall(afterFirstCall, {
      inputTokens: 20,
      outputTokens: 10,
      estimatedCostUsd: 0.05,
    });

    expect(afterSecondCall).toMatchObject({
      callsUsed: 2,
      tokensUsed: 90,
    });
    expect(afterSecondCall.estimatedCostUsd).toBeCloseTo(0.17, 10);
    expect(isSmartBudgetExhausted(afterSecondCall)).toBe(true);
    expect(canAffordSmartBudgetCall(afterSecondCall, 1)).toBe(false);
  });
});
