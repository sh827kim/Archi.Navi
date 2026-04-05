import { and, desc, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import { proofDependencies, proofFrontiers, proofPatches, proofStates } from '@archi-navi/db';

interface ProofDependencyLookup {
  aliasBindingKeys?: string[];
  functionSummaryFunctionIds?: string[];
  routeTransformOwnerServiceIds?: string[];
}

export function createProofStateStore(db: DbClient) {
  return {
    async getByIntentId(workspaceId: string, intentId: string) {
      const rows = await db
        .select()
        .from(proofStates)
        .where(and(eq(proofStates.workspaceId, workspaceId), eq(proofStates.intentId, intentId)));
      return rows.find((row) => row.parentProofStateId === null) ?? rows[0] ?? null;
    },

    async listFrontiers(workspaceId: string) {
      return db
        .select({
          proofState: proofStates,
          frontier: proofFrontiers,
        })
        .from(proofFrontiers)
        .innerJoin(proofStates, eq(proofFrontiers.proofStateId, proofStates.id))
        .where(eq(proofFrontiers.workspaceId, workspaceId))
        .orderBy(desc(proofFrontiers.priority), desc(proofFrontiers.updatedAt));
    },

    async listPatches(workspaceId: string, proofStateId: string) {
      return db
        .select()
        .from(proofPatches)
        .where(and(eq(proofPatches.workspaceId, workspaceId), eq(proofPatches.proofStateId, proofStateId)))
        .orderBy(desc(proofPatches.createdAt), desc(proofPatches.id));
    },

    async listDependencies(workspaceId: string, proofStateId: string) {
      return db
        .select()
        .from(proofDependencies)
        .where(and(eq(proofDependencies.workspaceId, workspaceId), eq(proofDependencies.proofStateId, proofStateId)))
        .orderBy(desc(proofDependencies.updatedAt), desc(proofDependencies.id));
    },

    async listImpactedIntentIds(workspaceId: string, lookup: ProofDependencyLookup) {
      const impactedIntentIds = new Set<string>();

      const collectIntentIds = async (dependencyKind: string, dependencyKeys: string[]) => {
        if (dependencyKeys.length === 0) return;

        const rows = await db
          .select({ intentId: proofStates.intentId })
          .from(proofDependencies)
          .innerJoin(proofStates, eq(proofDependencies.proofStateId, proofStates.id))
          .where(
            and(
              eq(proofDependencies.workspaceId, workspaceId),
              eq(proofDependencies.dependencyKind, dependencyKind),
              inArray(proofDependencies.dependencyKey, dependencyKeys),
            ),
          );

        for (const row of rows) {
          impactedIntentIds.add(row.intentId);
        }
      };

      await collectIntentIds('alias_binding', [...new Set(lookup.aliasBindingKeys ?? [])]);
      await collectIntentIds(
        'function_summary_function',
        [...new Set(lookup.functionSummaryFunctionIds ?? [])],
      );
      await collectIntentIds(
        'route_transform_owner_service',
        [...new Set(lookup.routeTransformOwnerServiceIds ?? [])],
      );

      return [...impactedIntentIds];
    },
  };
}
