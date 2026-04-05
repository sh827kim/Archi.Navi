import { describe, expect, it } from 'vitest';
import {
  SMART_FRONTIER_REASONS,
  SMART_FRONTIER_REASONS_SUPPORTED,
  buildDefaultSmartProofConfig,
  buildEmptySmartModeSummary,
  normalizeSmartProofConfig,
  resolveSmartProofDecision,
} from '@/agent/smartProofTypes';

describe('smartProofTypes', () => {
  it('smart config parsing은 boolean true를 기본 설정으로 확장해야 한다', () => {
    expect(normalizeSmartProofConfig(true)).toEqual(buildDefaultSmartProofConfig());
  });

  it('smart config parsing은 partial object를 기본값과 병합해야 한다', () => {
    expect(normalizeSmartProofConfig({
      enabled: true,
      budget: {
        maxLlmCallsPerRun: 3,
        maxLlmCallsPerIntent: 1,
        maxInputTokensPerCall: 200,
        maxTotalTokensPerRun: 500,
      },
      thresholds: {
        autoAcceptConfidence: 0.9,
        reviewConfidence: 0.6,
        skipConfidence: 0.4,
      },
      categories: {
        frontierResolution: true,
        ambiguityResolution: true,
        preResolutionEnhancement: false,
        crossProofCorrelation: false,
        contradictionDetection: false,
      },
    })).toMatchObject({
      enabled: true,
      budget: {
        maxLlmCallsPerRun: 3,
        maxLlmCallsPerIntent: 1,
        maxInputTokensPerCall: 200,
        maxTotalTokensPerRun: 500,
      },
      thresholds: {
        autoAcceptConfidence: 0.9,
        reviewConfidence: 0.6,
        skipConfidence: 0.4,
      },
      categories: {
        frontierResolution: true,
        ambiguityResolution: true,
      },
    });
  });

  it('smart summary 기본값은 disabled 상태와 0 집계를 제공해야 한다', () => {
    expect(buildEmptySmartModeSummary()).toEqual({
      enabled: false,
      llmCallCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      estimatedCostUsd: 0,
      frontierResolvedByLlm: 0,
      summaryEnhancedByLlm: 0,
      contradictionsChallenged: 0,
      autoAcceptedCount: 0,
      pendingReviewCount: 0,
      skippedCount: 0,
      resolutionByCategory: {},
      resolutionByFrontierReason: {},
    });
  });

  it('confidence 정책 경계는 잘 정규화되어 review는 auto보다 작거나 같아야 한다', () => {
    const normalized = normalizeSmartProofConfig({
      enabled: true,
      thresholds: {
        autoAcceptConfidence: 0.5,
        reviewConfidence: 0.9,
        skipConfidence: 0.2,
      },
      budget: {
        maxLlmCallsPerRun: 1,
        maxLlmCallsPerIntent: 1,
        maxInputTokensPerCall: 1,
        maxTotalTokensPerRun: 1,
      },
      categories: {
        preResolutionEnhancement: true,
        frontierResolution: true,
        ambiguityResolution: true,
        crossProofCorrelation: true,
        contradictionDetection: true,
      },
    });

    expect(normalized.thresholds.reviewConfidence).toBe(0.5);
    expect(normalized.thresholds.skipConfidence).toBe(0.2);
  });

  it('partial threshold 입력에서도 skip 기본값은 review 기본값으로 덮어쓰지 않아야 한다', () => {
    const normalized = normalizeSmartProofConfig({
      enabled: true,
      thresholds: {
        autoAcceptConfidence: 0.9,
      },
      budget: {
        maxLlmCallsPerRun: 1,
        maxLlmCallsPerIntent: 1,
        maxInputTokensPerCall: 1,
        maxTotalTokensPerRun: 1,
      },
      categories: {
        preResolutionEnhancement: false,
        frontierResolution: true,
        ambiguityResolution: false,
        crossProofCorrelation: false,
        contradictionDetection: false,
      },
    });

    expect(normalized.thresholds).toEqual({
      autoAcceptConfidence: 0.9,
      reviewConfidence: 0.5,
      skipConfidence: 0.3,
    });
  });

  it('ACCEPTED/PENDING_REVIEW/SKIPPED 판정은 정책 임계값을 정확히 따른다', () => {
    const config = normalizeSmartProofConfig({
      enabled: true,
      thresholds: {
        autoAcceptConfidence: 0.8,
        reviewConfidence: 0.5,
        skipConfidence: 0.3,
      },
      budget: {
        maxLlmCallsPerRun: 1,
        maxLlmCallsPerIntent: 1,
        maxInputTokensPerCall: 1,
        maxTotalTokensPerRun: 1,
      },
      categories: {
        preResolutionEnhancement: false,
        frontierResolution: true,
        ambiguityResolution: false,
        crossProofCorrelation: false,
        contradictionDetection: false,
      },
    });

    expect(resolveSmartProofDecision(config, 0.81)).toBe('ACCEPTED');
    expect(resolveSmartProofDecision(config, 0.8)).toBe('ACCEPTED');
    expect(resolveSmartProofDecision(config, 0.5)).toBe('PENDING_REVIEW');
    expect(resolveSmartProofDecision(config, 0.51)).toBe('PENDING_REVIEW');
    expect(resolveSmartProofDecision(config, 0.49)).toBe('SKIPPED');
  });

  it('SMART_FRONTIER_REASONS가 공개 지원 reason 집합과 일치해야 한다', () => {
    expect(SMART_FRONTIER_REASONS).toEqual(SMART_FRONTIER_REASONS_SUPPORTED);
    expect(SMART_FRONTIER_REASONS).toContain('METHOD_UNKNOWN');
    expect(SMART_FRONTIER_REASONS).not.toContain('PROVIDER_SERVICE_AMBIGUOUS');
  });
});
