import type { DbClient } from '@archi-navi/db';
import { extractAliasBindingsFromCodeSignals, extractAliasBindingsFromConfig } from '@/extraction/aliasBindings';
import { extractFunctionSummariesFromCodeSignals } from '@/extraction/functionSummary';
import { extractInteractionIntentsFromCodeSignals } from '@/extraction/intents';
import { extractRouteTransformsFromConfig } from '@/extraction/routeTransforms';

export interface RunProofExtractionOptions {
  workspaceId: string;
  repoRoot: string;
  runId?: string | null | undefined;
}

export interface ProofExtractionSnapshot {
  aliasBindingCount: number;
  functionSummaryCount: number;
  interactionIntentCount: number;
  routeTransformCount: number;
}

export function createProofExtractionStore(db: DbClient) {
  return {
    async extractAll(options: RunProofExtractionOptions): Promise<ProofExtractionSnapshot> {
      const [aliasFromCode, aliasFromConfig, summaries, intents, routeTransforms] = await Promise.all([
        extractAliasBindingsFromCodeSignals(db, options),
        extractAliasBindingsFromConfig(db, options),
        extractFunctionSummariesFromCodeSignals(db, options),
        extractInteractionIntentsFromCodeSignals(db, options),
        extractRouteTransformsFromConfig(db, options),
      ]);

      return {
        aliasBindingCount: aliasFromCode.bindingCount + aliasFromConfig.bindingCount,
        functionSummaryCount: summaries.summaryCount,
        interactionIntentCount: intents.intentCount,
        routeTransformCount: routeTransforms.routeTransformCount,
      };
    },
  };
}
