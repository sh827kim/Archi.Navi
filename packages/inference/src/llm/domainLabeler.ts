import { and, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import { domainDiscoveryMemberships, objects } from '@archi-navi/db';
import { asRecord } from '../utils/metadata';

export interface DomainLabelSuggestion {
  ko: string;
  en: string;
}

export interface DomainLabelContext {
  domainId: string;
  domainName: string;
  memberNames: string[];
  labelCandidates: Array<{ text: string; score: number }>;
}

export interface DomainLabelRequest {
  workspaceId: string;
  runId: string;
}

export interface DomainLabelResult {
  processedCount: number;
  labeledCount: number;
  skippedCount: number;
  callCount: number;
  errorCount: number;
}

export type GenerateDomainLabelFn = (
  context: DomainLabelContext,
) => Promise<DomainLabelSuggestion | null>;

function asLabelCandidates(value: unknown): Array<{ text: string; score: number }> {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item) => {
    const record = asRecord(item);
    if (!record || typeof record.text !== 'string' || typeof record.score !== 'number') {
      return [];
    }
    return [{ text: record.text, score: record.score }];
  });
}

export async function generateDomainLabels(
  db: DbClient,
  generateFn: GenerateDomainLabelFn,
  request: DomainLabelRequest,
): Promise<DomainLabelResult> {
  const memberships = await db
    .select({
      domainId: domainDiscoveryMemberships.domainId,
      objectId: domainDiscoveryMemberships.objectId,
    })
    .from(domainDiscoveryMemberships)
    .where(
      and(
        eq(domainDiscoveryMemberships.workspaceId, request.workspaceId),
        eq(domainDiscoveryMemberships.runId, request.runId),
      ),
    );

  const domainIds = [...new Set(memberships.map((membership) => membership.domainId))];
  if (domainIds.length === 0) {
    return {
      processedCount: 0,
      labeledCount: 0,
      skippedCount: 0,
      callCount: 0,
      errorCount: 0,
    };
  }

  const rows = await db
    .select({
      id: objects.id,
      name: objects.name,
      displayName: objects.displayName,
      metadata: objects.metadata,
    })
    .from(objects)
    .where(and(eq(objects.workspaceId, request.workspaceId), inArray(objects.id, [
      ...domainIds,
      ...memberships.map((membership) => membership.objectId),
    ])));

  const objectMap = new Map(rows.map((row) => [row.id, row]));
  let labeledCount = 0;
  let skippedCount = 0;
  let callCount = 0;
  let errorCount = 0;

  for (const domainId of domainIds) {
    const domain = objectMap.get(domainId);
    if (!domain) {
      skippedCount += 1;
      continue;
    }

    const metadata = asRecord(domain.metadata) ?? {};
    if (asRecord(metadata.llmLabel)) {
      skippedCount += 1;
      continue;
    }

    const memberNames = memberships
      .filter((membership) => membership.domainId === domainId)
      .map((membership) => {
        const objectRow = objectMap.get(membership.objectId);
        return objectRow?.displayName ?? objectRow?.name ?? membership.objectId;
      })
      .filter((name) => name.trim().length > 0);

    const labelCandidates = asLabelCandidates(metadata.labelCandidates);
    try {
      callCount += 1;
      const suggestion = await generateFn({
        domainId,
        domainName: domain.displayName ?? domain.name,
        memberNames,
        labelCandidates,
      });
      if (!suggestion) {
        skippedCount += 1;
        continue;
      }

      await db
        .update(objects)
        .set({
          metadata: {
            ...metadata,
            llmLabel: {
              ko: suggestion.ko,
              en: suggestion.en,
              labeledAt: new Date().toISOString(),
            },
          },
        })
        .where(and(eq(objects.id, domainId), eq(objects.workspaceId, request.workspaceId)));
      labeledCount += 1;
    } catch {
      errorCount += 1;
    }
  }

  return {
    processedCount: domainIds.length,
    labeledCount,
    skippedCount,
    callCount,
    errorCount,
  };
}
