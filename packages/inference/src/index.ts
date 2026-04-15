// Inference 엔진 전체 export
export * from './domain/index';
export * from './relation/index';
export * from './code/index';
export * from './db/index';
export * from './llm/index';
export * from './orchestration/index';
export type * from './agent/smartProofTypes';
export {
  buildDefaultSmartProofConfig,
  buildEmptySmartModeSummary,
  normalizeSmartProofConfig,
} from './agent/smartProofTypes';
export {
  canAffordSmartBudgetCall,
  createSmartBudgetTracker,
  isSmartBudgetExhausted,
  recordSmartBudgetCall,
} from './agent/smartBudgetTracker';
export {
  buildHostAliasResolutionPrompt,
  buildRouteTransformResolutionPrompt,
  buildSmartFrontierPrompt,
  buildSmartAliasBindingPatch,
  buildSmartPatchFromProposal,
  buildSmartRouteTransformPatch,
  isSupportedSmartFrontierReason,
  resolveSmartFrontier,
  SUPPORTED_SMART_FRONTIER_REASONS,
} from './agent/smartFrontierResolver';
export type {
  GenerateSmartResolutionFn,
  ResolveSmartFrontierInput,
  ResolveSmartFrontierResult,
  SmartAliasBindingProposal,
  SmartPatchProposal,
  SmartFrontierResolutionContext,
  SmartRouteTransformProposal,
  SupportedSmartFrontierReason,
} from './agent/smartFrontierResolver';
export {
  buildSmartSummaryEnhancementPrompt,
  isSmartSummaryEnhancementCandidate,
  loadSmartSummaryEnhancementCandidates,
  resolveSmartSummaryEnhancement,
} from './agent/smartSummaryEnhancer';
export type {
  ResolveSmartSummaryEnhancementInput,
  ResolveSmartSummaryEnhancementResult,
  SmartSummaryEnhancementCandidate,
  SmartSummaryEnhancementProposal,
} from './agent/smartSummaryEnhancer';
export {
  buildProviderServiceSelectionPrompt,
  buildSmartProviderServiceSelectionPatch,
  isSupportedSmartAmbiguityReason,
  loadSmartAmbiguityContext,
  resolveSmartAmbiguity,
  SUPPORTED_SMART_AMBIGUITY_REASONS,
} from './agent/smartAmbiguityResolver';
export type {
  ResolveSmartAmbiguityInput,
  ResolveSmartAmbiguityResult,
  SmartAmbiguityResolutionContext,
  SmartProviderServiceSelectionProposal,
  SupportedSmartAmbiguityReason,
} from './agent/smartAmbiguityResolver';
export {
  buildSmartContradictionPrompt,
  loadSmartContradictionCandidates,
  resolveSmartContradiction,
} from './agent/smartContradictionResolver';
export type {
  ResolveSmartContradictionInput,
  ResolveSmartContradictionResult,
  SmartContradictionCandidate,
  SmartContradictionChallengeProposal,
} from './agent/smartContradictionResolver';
