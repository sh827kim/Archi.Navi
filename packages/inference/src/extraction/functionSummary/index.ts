import { and, eq } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import { codeArtifacts, codeCallEdges, evidences, functionSummaries, objects } from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import { preferredSignalOwnerId, resolveExistingSignalOwnerId } from '@/code/ownerResolution';
import {
  asNumber,
  asRecord,
  asString,
  detectDynamicPath,
  extractHttpHostHint,
  extractHttpPathHint,
  normalizeOptionalUuid,
  normalizeMethod,
  stableHash,
  uniqueSortedStrings,
} from '../shared';

type SummaryKind = 'http' | 'db' | 'message' | 'mixed';
type ExtractionStrategy = 'ast_primary' | 'mixed_signals' | 'legacy_edges_fallback';
type SummaryFlags = {
  truncated: boolean;
  dynamicPath: boolean;
  dynamicHost: boolean;
  unsupportedPattern: boolean;
  astBacked: boolean;
};

interface SourceContext {
  serviceId: string;
  functionId: string;
  artifactFilePath: string;
}

interface CodeSignalRow {
  ownerObjectId: string | null;
  filePath: string;
  calleeSymbol: string;
  calleeOwnerObjectId: string | null;
  evidenceId: string | null;
  evidenceMetadata: unknown;
}

interface SummarySignalEntry {
  row: CodeSignalRow;
  metadata: Record<string, unknown>;
  signalSource: string;
}

const FUNCTION_SUMMARY_SOURCE_HASH_VERSION = 'function-summary-v4';

function extractConfigKeysFromMetadata(metadata: Record<string, unknown>): string[] {
  return uniqueSortedStrings([
    asString(metadata['configKey']),
    ...(
      Array.isArray(metadata['configKeys'])
        ? metadata['configKeys'].map((entry) => asString(entry))
        : []
    ),
    asString(metadata['baseUrlConfigKey']),
    asString(metadata['hostConfigKey']),
    asString(metadata['propertyKey']),
  ]);
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function inferSignalSource(metadata: Record<string, unknown>): string {
  return (
    asString(metadata['signalSource'])
    ?? asString(metadata['extractionMode'])
    ?? (asNumber(metadata['phase']) === 2 ? 'ast' : null)
    ?? 'unknown'
  );
}

function isAstLikeSignalSource(value: string): boolean {
  return value === 'ast' || value === 'hybrid';
}

function determineExtractionStrategy(entries: SummarySignalEntry[]): ExtractionStrategy {
  const hasAstLike = entries.some((entry) => isAstLikeSignalSource(entry.signalSource));
  if (!hasAstLike) return 'legacy_edges_fallback';
  return entries.some((entry) => !isAstLikeSignalSource(entry.signalSource))
    ? 'mixed_signals'
    : 'ast_primary';
}

function roundCompleteness(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}

function hasStringEntries(value: unknown): boolean {
  return mergeUniqueStrings(value, []).length > 0;
}

function computeHttpCompleteness(
  outboundHttp: Record<string, unknown> | null,
  flags: SummaryFlags,
): number {
  if (!outboundHttp) return 0;

  const path = asString(outboundHttp['path']);
  const hasProviderHint =
    asString(outboundHttp['hostAlias']) !== null || hasStringEntries(outboundHttp['configKeys']);

  let score = 0;
  if (asString(outboundHttp['method'])) score += 0.35;
  if (path) score += flags.dynamicPath ? 0.25 : 0.45;
  if (hasProviderHint) score += flags.dynamicHost ? 0.1 : 0.2;
  return score;
}

function computeDbCompleteness(outboundDb: Record<string, unknown> | null): number {
  if (!outboundDb) return 0;

  const hasTableHint =
    asString(outboundDb['table']) !== null
    || asString(outboundDb['tableName']) !== null
    || hasStringEntries(outboundDb['tableHints']);
  const hasSourceHint =
    asString(outboundDb['schema']) !== null
    || hasStringEntries(outboundDb['schemaHints'])
    || hasStringEntries(outboundDb['datasourceAliases'])
    || hasStringEntries(outboundDb['queryFragmentHashes']);

  let score = 0;
  if (asString(outboundDb['action'])) score += 0.35;
  if (hasTableHint) score += 0.45;
  if (hasSourceHint) score += 0.2;
  return score;
}

function computeMessageCompleteness(outboundMessage: Record<string, unknown> | null): number {
  if (!outboundMessage) return 0;

  const hasChannelHint =
    asString(outboundMessage['topic']) !== null
    || asString(outboundMessage['queue']) !== null
    || hasStringEntries(outboundMessage['topicHints'])
    || hasStringEntries(outboundMessage['queueHints']);
  const hasBrokerHint =
    asString(outboundMessage['brokerKind']) !== null || hasStringEntries(outboundMessage['routingKeyHints']);

  let score = 0;
  if (asString(outboundMessage['action'])) score += 0.35;
  if (hasChannelHint) score += 0.45;
  if (hasBrokerHint) score += 0.2;
  return score;
}

function computeSummaryCompleteness(input: {
  outboundHttp: Record<string, unknown> | null;
  outboundDb: Record<string, unknown> | null;
  outboundMessage: Record<string, unknown> | null;
  flags: SummaryFlags;
}): number {
  const sectionScores = [
    input.outboundHttp ? computeHttpCompleteness(input.outboundHttp, input.flags) : null,
    input.outboundDb ? computeDbCompleteness(input.outboundDb) : null,
    input.outboundMessage ? computeMessageCompleteness(input.outboundMessage) : null,
  ].filter((entry): entry is number => entry !== null);

  if (sectionScores.length === 0) return 0;

  const baseScore = sectionScores.reduce((sum, entry) => sum + entry, 0) / sectionScores.length;
  const penalty = Number(input.flags.truncated) * 0.1 + Number(input.flags.unsupportedPattern) * 0.15;
  return roundCompleteness(baseScore - penalty);
}

function collectUnresolvedReasons(input: {
  outboundHttp: Record<string, unknown> | null;
  outboundDb: Record<string, unknown> | null;
  outboundMessage: Record<string, unknown> | null;
  signalSources: string[];
  provenanceEvidenceIds: string[];
  flags: SummaryFlags;
}): string[] {
  const reasons: Array<string | null> = [];

  if (input.outboundHttp) {
    const configKeys = mergeUniqueStrings(input.outboundHttp['configKeys'], []);
    reasons.push(asString(input.outboundHttp['method']) ? null : 'missing_http_method');
    reasons.push(asString(input.outboundHttp['path']) ? null : 'missing_http_path');
    reasons.push(
      asString(input.outboundHttp['hostAlias']) !== null || configKeys.length > 0
        ? null
        : 'missing_http_provider_hint',
    );
    reasons.push(input.flags.dynamicPath ? 'dynamic_http_path' : null);
    reasons.push(input.flags.dynamicHost ? 'dynamic_http_host' : null);
  }

  if (input.outboundDb) {
    const hasTableHint =
      asString(input.outboundDb['table']) !== null
      || asString(input.outboundDb['tableName']) !== null
      || hasStringEntries(input.outboundDb['tableHints']);
    const hasSourceHint =
      asString(input.outboundDb['schema']) !== null
      || hasStringEntries(input.outboundDb['schemaHints'])
      || hasStringEntries(input.outboundDb['datasourceAliases'])
      || hasStringEntries(input.outboundDb['queryFragmentHashes']);
    reasons.push(asString(input.outboundDb['action']) ? null : 'missing_db_action');
    reasons.push(hasTableHint ? null : 'missing_db_table');
    reasons.push(hasSourceHint ? null : 'missing_db_source_hint');
  }

  if (input.outboundMessage) {
    const hasChannelHint =
      asString(input.outboundMessage['topic']) !== null
      || asString(input.outboundMessage['queue']) !== null
      || hasStringEntries(input.outboundMessage['topicHints'])
      || hasStringEntries(input.outboundMessage['queueHints']);
    const hasBrokerHint =
      asString(input.outboundMessage['brokerKind']) !== null
      || hasStringEntries(input.outboundMessage['routingKeyHints']);
    reasons.push(asString(input.outboundMessage['action']) ? null : 'missing_message_action');
    reasons.push(hasChannelHint ? null : 'missing_message_channel');
    reasons.push(hasBrokerHint ? null : 'missing_message_broker_hint');
  }

  reasons.push(input.flags.truncated ? 'truncated_signal' : null);
  reasons.push(input.flags.unsupportedPattern ? 'unsupported_pattern' : null);
  reasons.push(input.signalSources.includes('unknown') ? 'signal_source_unknown' : null);
  reasons.push(input.provenanceEvidenceIds.length > 0 ? null : 'missing_provenance_evidence');

  return uniqueSortedStrings(reasons);
}

export interface ExtractFunctionSummariesOptions {
  workspaceId: string;
  repoRoot: string;
  runId?: string | null | undefined;
}

export interface ExtractFunctionSummariesResult {
  summaryCount: number;
}

function determineSummaryKind(parts: { hasHttp: boolean; hasDb: boolean; hasMessage: boolean }): SummaryKind {
  const count = Number(parts.hasHttp) + Number(parts.hasDb) + Number(parts.hasMessage);
  if (count > 1) return 'mixed';
  if (parts.hasHttp) return 'http';
  if (parts.hasDb) return 'db';
  return 'message';
}

function normalizeDbAction(kind: string): string | null {
  if (kind === 'db_read') return 'SELECT';
  if (kind === 'db_write') return 'WRITE';
  if (kind === 'db_mapping') return 'MAP';
  return null;
}

function parseDbHints(value: string): { schemaHints: string[]; tableHints: string[] } {
  const tokens = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return {
    schemaHints: uniqueSortedStrings(
      tokens
        .map((token) => (token.includes('.') ? (token.split('.')[0] ?? null) : null))
        .filter((entry): entry is string => entry !== null),
    ),
    tableHints: uniqueSortedStrings(tokens.map((token) => token.split('.').at(-1) ?? token)),
  };
}

function mergeUniqueStrings(existing: unknown, additions: Array<string | null | undefined>): string[] {
  return uniqueSortedStrings([
    ...(Array.isArray(existing) ? existing.map((entry) => asString(entry)) : []),
    ...additions,
  ]);
}

function extractPathVariables(path: string | null): string[] {
  if (!path) return [];
  return uniqueSortedStrings(
    [...path.matchAll(/\{([^}/]+)\}/g)].map((match) => match[1]?.trim() ?? null),
  );
}

function extractQueryKeys(path: string | null): string[] {
  if (!path || !path.includes('?')) return [];
  const query = path.split('?')[1] ?? '';
  return uniqueSortedStrings(
    query
      .split('&')
      .map((pair) => pair.split('=')[0]?.trim() ?? null),
  );
}

function isValidAliasHint(value: string | null): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith('/')) return false;
  if (trimmed.includes('{') || trimmed.includes('}')) return false;
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (trimmed.includes('/')) return false;
  return /^[a-z0-9._-]+$/i.test(trimmed);
}

async function loadSourceContexts(
  db: DbClient,
  workspaceId: string,
  ownerObjectIds: string[],
): Promise<{ sourceContexts: Map<string, SourceContext>; functionIdByOwnerKey: Map<string, string> }> {
  if (ownerObjectIds.length === 0) {
    return {
      sourceContexts: new Map(),
      functionIdByOwnerKey: new Map(),
    };
  }

  const ownerRows = await db
    .select({
      id: objects.id,
      objectType: objects.objectType,
      parentId: objects.parentId,
      metadata: objects.metadata,
    })
    .from(objects)
    .where(eq(objects.workspaceId, workspaceId));

  const objectById = new Map(ownerRows.map((row) => [row.id, row] as const));
  const context = new Map<string, SourceContext>();
  const functionIdByOwnerKey = new Map<string, string>();

  for (const row of ownerRows) {
    if (row.objectType !== 'function') continue;
    const metadata = asRecord(row.metadata) ?? {};
    const ownerKey = asString(metadata['functionKey']);
    if (ownerKey) {
      functionIdByOwnerKey.set(ownerKey, row.id);
    }
    if (row.parentId) {
      const parent = objectById.get(row.parentId);
      if (parent?.objectType === 'service') {
        context.set(row.id, {
          serviceId: parent.id,
          functionId: row.id,
          artifactFilePath: '',
        });
      }
    }
  }

  return {
    sourceContexts: context,
    functionIdByOwnerKey,
  };
}

async function upsertFunctionSummary(
  db: DbClient,
  input: {
    workspaceId: string;
    runId?: string | null | undefined;
    serviceId: string;
    functionId: string;
    summaryKind: SummaryKind;
    outboundHttp: Record<string, unknown> | null;
    outboundDb: Record<string, unknown> | null;
    outboundMessage: Record<string, unknown> | null;
    callChainHints: string[];
    aliasHints: string[];
    signalSources: string[];
    provenanceEvidenceIds: string[];
    extractionStrategy: ExtractionStrategy;
    unresolvedReasons: string[];
    summaryCompleteness: number;
    flags: Record<string, unknown>;
    confidence: number;
    sourceHash: string;
  },
): Promise<string> {
  const activeRows = await db
    .select()
    .from(functionSummaries)
    .where(
      and(
        eq(functionSummaries.workspaceId, input.workspaceId),
        eq(functionSummaries.functionId, input.functionId),
        eq(functionSummaries.status, 'ACTIVE'),
      ),
    );

  const active = activeRows.sort((left, right) => right.summaryVersion - left.summaryVersion)[0] ?? null;
  if (active && active.sourceHash === input.sourceHash) {
    await db
      .update(functionSummaries)
      .set({
        updatedRunId: normalizeOptionalUuid(input.runId),
        summaryKind: input.summaryKind,
        outboundHttp: input.outboundHttp,
        outboundDb: input.outboundDb,
        outboundMessage: input.outboundMessage,
        callChainHints: input.callChainHints,
        aliasHints: input.aliasHints,
        signalSources: input.signalSources,
        provenanceEvidenceIds: input.provenanceEvidenceIds,
        extractionStrategy: input.extractionStrategy,
        unresolvedReasons: input.unresolvedReasons,
        summaryCompleteness: input.summaryCompleteness,
        flags: input.flags,
        confidence: input.confidence,
        updatedAt: new Date(),
      })
      .where(eq(functionSummaries.id, active.id));
    return active.id;
  }

  if (active) {
    await db
      .update(functionSummaries)
      .set({
        status: 'SUPERSEDED',
        updatedRunId: normalizeOptionalUuid(input.runId),
        updatedAt: new Date(),
      })
      .where(eq(functionSummaries.id, active.id));
  }

  const summaryId = generateId();
  await db.insert(functionSummaries).values({
    id: summaryId,
    workspaceId: input.workspaceId,
    createdRunId: normalizeOptionalUuid(input.runId),
    updatedRunId: normalizeOptionalUuid(input.runId),
    functionId: input.functionId,
    serviceId: input.serviceId,
    summaryVersion: active ? active.summaryVersion + 1 : 1,
    summaryKind: input.summaryKind,
    outboundHttp: input.outboundHttp,
    outboundDb: input.outboundDb,
    outboundMessage: input.outboundMessage,
    callChainHints: input.callChainHints,
    aliasHints: input.aliasHints,
    signalSources: input.signalSources,
    provenanceEvidenceIds: input.provenanceEvidenceIds,
    extractionStrategy: input.extractionStrategy,
    unresolvedReasons: input.unresolvedReasons,
    summaryCompleteness: input.summaryCompleteness,
    flags: input.flags,
    confidence: input.confidence,
    sourceHash: input.sourceHash,
    status: 'ACTIVE',
  });
  return summaryId;
}

export async function extractFunctionSummariesFromCodeSignals(
  db: DbClient,
  options: ExtractFunctionSummariesOptions,
): Promise<ExtractFunctionSummariesResult> {
  const rows = await db
    .select({
      ownerObjectId: codeArtifacts.ownerObjectId,
      filePath: codeArtifacts.filePath,
      calleeSymbol: codeCallEdges.calleeSymbol,
      calleeOwnerObjectId: codeCallEdges.calleeOwnerObjectId,
      evidenceId: codeCallEdges.evidenceId,
      evidenceMetadata: evidences.metadata,
    })
    .from(codeCallEdges)
    .innerJoin(codeArtifacts, eq(codeCallEdges.callerArtifactId, codeArtifacts.id))
    .leftJoin(evidences, eq(codeCallEdges.evidenceId, evidences.id))
    .where(
      and(eq(codeCallEdges.workspaceId, options.workspaceId), eq(codeArtifacts.repoRoot, options.repoRoot)),
    );

  const { sourceContexts, functionIdByOwnerKey } = await loadSourceContexts(
    db,
    options.workspaceId,
    uniqueSortedStrings(
      rows.flatMap((row) => {
        const metadata = asRecord(row.evidenceMetadata) ?? {};
        return [
          preferredSignalOwnerId(metadata, row.ownerObjectId),
          row.ownerObjectId,
        ];
      }),
    ),
  );
  const knownOwnerIds = new Set(sourceContexts.keys());

  const grouped = new Map<string, { source: SourceContext; rows: CodeSignalRow[] }>();
  for (const row of rows) {
    const metadata = asRecord(row.evidenceMetadata) ?? {};
    const resolvedOwnerId = resolveExistingSignalOwnerId({
      metadata,
      artifactOwnerObjectId: row.ownerObjectId,
      knownOwnerIds,
      functionIdByOwnerKey,
    });
    if (!resolvedOwnerId) continue;
    const source = sourceContexts.get(resolvedOwnerId);
    if (!source) continue;
    const key = source.functionId;
    const bucket = grouped.get(key) ?? { source, rows: [] };
    bucket.rows.push(row);
    grouped.set(key, bucket);
  }

  let summaryCount = 0;
  for (const group of grouped.values()) {
    const signalEntries = group.rows
      .map((row) => {
        const metadata = asRecord(row.evidenceMetadata) ?? {};
        const kind = asString(metadata['kind']);
        if (!kind || kind === 'expose') return null;
        return {
          row,
          metadata,
          signalSource: inferSignalSource(metadata),
        } satisfies SummarySignalEntry;
      })
      .filter((entry): entry is SummarySignalEntry => entry !== null);
    if (signalEntries.length === 0) continue;

    const extractionStrategy = determineExtractionStrategy(signalEntries);
    const primaryEntries = extractionStrategy === 'legacy_edges_fallback'
      ? signalEntries
      : signalEntries.filter((entry) => isAstLikeSignalSource(entry.signalSource));

    let outboundHttp: Record<string, unknown> | null = null;
    let outboundDb: Record<string, unknown> | null = null;
    let outboundMessage: Record<string, unknown> | null = null;
    const callChainHints: string[] = [];
    const aliasHints: string[] = [];
    const signalSources: string[] = [];
    const provenanceEvidenceIds: string[] = [];
    let astConfidence = 0;
    let legacyConfidence = 0;
    let hasAstConfidence = false;
    const flags: SummaryFlags = {
      truncated: false,
      dynamicPath: false,
      dynamicHost: false,
      unsupportedPattern: false,
      astBacked: extractionStrategy !== 'legacy_edges_fallback',
    };

    for (const entry of signalEntries) {
      signalSources.push(entry.signalSource);
      if (entry.row.evidenceId) provenanceEvidenceIds.push(entry.row.evidenceId);
    }

    for (const entry of primaryEntries) {
      const { row, metadata } = entry;
      const kind = asString(metadata['kind']);
      if (!kind || kind === 'expose') continue;

      flags.truncated = flags.truncated || asBoolean(metadata['truncated']) === true;
      flags.unsupportedPattern =
        flags.unsupportedPattern
        || asBoolean(metadata['unsupportedPattern']) === true
        || asBoolean(metadata['unsupported_pattern']) === true;
      flags.dynamicPath =
        flags.dynamicPath
        || asBoolean(metadata['dynamicPath']) === true
        || asBoolean(metadata['dynamic_path']) === true;
      flags.dynamicHost =
        flags.dynamicHost
        || asBoolean(metadata['dynamicHost']) === true
        || asBoolean(metadata['dynamic_host']) === true;

      const method = normalizeMethod(metadata['method']);
      const confidenceHint = asNumber(metadata['confidence']);
      if (confidenceHint !== null) {
        if (isAstLikeSignalSource(entry.signalSource)) {
          astConfidence = Math.max(astConfidence, confidenceHint);
          hasAstConfidence = true;
        } else {
          legacyConfidence = Math.max(legacyConfidence, confidenceHint);
        }
      }
      if (row.calleeOwnerObjectId) callChainHints.push(row.calleeOwnerObjectId);

      const configKeys = extractConfigKeysFromMetadata(metadata);
      aliasHints.push(...configKeys);

      if (kind === 'call' || kind === 'http_call') {
        const path = extractHttpPathHint(row.calleeSymbol, metadata);
        const host = extractHttpHostHint(row.calleeSymbol, metadata);
        const pathTemplate = asString(metadata['pathTemplate']) ?? path;
        const pathVariables = uniqueSortedStrings([
          ...extractPathVariables(pathTemplate),
          ...(Array.isArray(metadata['pathVariables']) ? metadata['pathVariables'].map((entry) => asString(entry)) : []),
        ]);
        const queryKeys = uniqueSortedStrings([
          ...extractQueryKeys(path),
          ...(Array.isArray(metadata['queryKeys']) ? metadata['queryKeys'].map((entry) => asString(entry)) : []),
        ]);
        const serviceNameHint = asString(metadata['serviceNameHint']);
        const baseUrlVar = asString(metadata['baseUrlVar']);
        const clientFamily = asString(metadata['clientFamily']) ?? asString(metadata['client']);
        const pathSource = asString(metadata['pathSource']) ?? (asString(metadata['resolvedUrl']) ? 'resolved' : 'hint');
        const hostSource = asString(metadata['hostSource']) ?? (host ? 'hint' : 'unknown');
        const baseUrlExpr = asString(metadata['baseUrlExpr']) ?? baseUrlVar;
        const baseUrlHint = asString(metadata['baseUrlHint']) ?? asString(metadata['resolvedUrl']) ?? asString(metadata['hostHint']);
        if (host && isValidAliasHint(host)) aliasHints.push(host);
        if (serviceNameHint && isValidAliasHint(serviceNameHint)) aliasHints.push(serviceNameHint);
        if (baseUrlVar && isValidAliasHint(baseUrlVar)) aliasHints.push(baseUrlVar);
        if (!outboundHttp) {
          outboundHttp = {
            method: method ?? normalizeMethod(metadata['methodHint']),
            path,
            pathTemplate,
            pathVariables,
            queryKeys,
            hostAlias: host,
            configKeys,
            serviceNameHint,
            baseUrlVar,
            baseUrlExpr,
            baseUrlHint,
            clientFamily,
            pathSource,
            hostSource,
            dynamicPath: flags.dynamicPath,
            dynamicHost: flags.dynamicHost,
          };
        } else {
          outboundHttp['method'] = outboundHttp['method'] ?? method ?? normalizeMethod(metadata['methodHint']);
          outboundHttp['path'] = outboundHttp['path'] ?? path;
          outboundHttp['pathTemplate'] = outboundHttp['pathTemplate'] ?? pathTemplate;
          outboundHttp['pathVariables'] = mergeUniqueStrings(outboundHttp['pathVariables'], pathVariables);
          outboundHttp['queryKeys'] = mergeUniqueStrings(outboundHttp['queryKeys'], queryKeys);
          outboundHttp['hostAlias'] = outboundHttp['hostAlias'] ?? host;
          outboundHttp['serviceNameHint'] = outboundHttp['serviceNameHint'] ?? serviceNameHint;
          outboundHttp['baseUrlVar'] = outboundHttp['baseUrlVar'] ?? baseUrlVar;
          outboundHttp['baseUrlExpr'] = outboundHttp['baseUrlExpr'] ?? baseUrlExpr;
          outboundHttp['baseUrlHint'] = outboundHttp['baseUrlHint'] ?? baseUrlHint;
          outboundHttp['clientFamily'] = outboundHttp['clientFamily'] ?? clientFamily;
          outboundHttp['pathSource'] = outboundHttp['pathSource'] ?? pathSource;
          outboundHttp['hostSource'] = outboundHttp['hostSource'] ?? hostSource;
          outboundHttp['dynamicPath'] = outboundHttp['dynamicPath'] ?? flags.dynamicPath;
          outboundHttp['dynamicHost'] = outboundHttp['dynamicHost'] ?? flags.dynamicHost;
          outboundHttp['configKeys'] = uniqueSortedStrings([
            ...(
              Array.isArray(outboundHttp['configKeys'])
                ? (outboundHttp['configKeys'] as Array<string | null | undefined>)
                : []
            ),
            ...configKeys,
          ]);
        }
        if (detectDynamicPath(path)) flags.dynamicPath = true;
        if (host && !host.includes('.')) flags.dynamicHost = true;
        continue;
      }

      if (kind === 'db_read' || kind === 'db_write' || kind === 'db_mapping') {
        const dbHints = parseDbHints(row.calleeSymbol.trim());
        outboundDb = {
          action: outboundDb?.['action'] ?? normalizeDbAction(kind),
          table: outboundDb?.['table'] ?? row.calleeSymbol.trim(),
          tableHints: mergeUniqueStrings(outboundDb?.['tableHints'], dbHints.tableHints),
          schemaHints: mergeUniqueStrings(outboundDb?.['schemaHints'], dbHints.schemaHints),
          datasourceAliases: mergeUniqueStrings(outboundDb?.['datasourceAliases'], configKeys),
          queryFragmentHashes: mergeUniqueStrings(outboundDb?.['queryFragmentHashes'], [
            asString(metadata['queryFragmentHash']),
          ]),
        };
        continue;
      }

      if (kind === 'produce' || kind === 'consume') {
        const channelType = asString(metadata['channelType']) ?? 'topic';
        outboundMessage = {
          action: outboundMessage?.['action'] ?? kind,
          channelType: outboundMessage?.['channelType'] ?? channelType,
          topic: channelType === 'queue' ? null : row.calleeSymbol.trim(),
          queue: channelType === 'queue' ? row.calleeSymbol.trim() : null,
          brokerKind: outboundMessage?.['brokerKind'] ?? asString(metadata['brokerKind']) ?? asString(metadata['broker_kind']),
          topicHints: mergeUniqueStrings(outboundMessage?.['topicHints'], [
            channelType === 'queue' ? null : row.calleeSymbol.trim(),
            asString(metadata['topic']),
          ]),
          queueHints: mergeUniqueStrings(outboundMessage?.['queueHints'], [
            channelType === 'queue' ? row.calleeSymbol.trim() : null,
            asString(metadata['queue']),
          ]),
          routingKeyHints: mergeUniqueStrings(outboundMessage?.['routingKeyHints'], [
            asString(metadata['routingKey']),
            asString(metadata['routing_key']),
          ]),
        };
      }
    }

    if (!outboundHttp && !outboundDb && !outboundMessage) continue;

    const summaryKind = determineSummaryKind({
      hasHttp: outboundHttp !== null,
      hasDb: outboundDb !== null,
      hasMessage: outboundMessage !== null,
    });
    const normalizedSignalSources = uniqueSortedStrings(signalSources);
    const normalizedProvenanceEvidenceIds = uniqueSortedStrings(provenanceEvidenceIds);
    const unresolvedReasons = collectUnresolvedReasons({
      outboundHttp,
      outboundDb,
      outboundMessage,
      signalSources: normalizedSignalSources,
      provenanceEvidenceIds: normalizedProvenanceEvidenceIds,
      flags,
    });
    // AST 신호가 있으면 AST confidence 우선, 없으면 legacy confidence 사용
    const confidence = hasAstConfidence
      ? Math.max(astConfidence, 0.5)
      : Math.max(legacyConfidence, 0.5);

    // summaryCompleteness는 순수 slot completeness — extraction strategy 보너스를 섞지 않음
    const summaryCompleteness = computeSummaryCompleteness({
      outboundHttp,
      outboundDb,
      outboundMessage,
      flags,
    });
    const sourceHash = stableHash([
      FUNCTION_SUMMARY_SOURCE_HASH_VERSION,
      group.source.functionId,
      JSON.stringify(outboundHttp),
      JSON.stringify(outboundDb),
      JSON.stringify(outboundMessage),
      JSON.stringify(uniqueSortedStrings(callChainHints)),
      JSON.stringify(uniqueSortedStrings(aliasHints)),
      JSON.stringify(normalizedSignalSources),
      JSON.stringify(normalizedProvenanceEvidenceIds),
      extractionStrategy,
      JSON.stringify(unresolvedReasons),
      summaryCompleteness,
      JSON.stringify(flags),
    ]);

    await upsertFunctionSummary(db, {
      workspaceId: options.workspaceId,
      runId: options.runId,
      serviceId: group.source.serviceId,
      functionId: group.source.functionId,
      summaryKind,
      outboundHttp,
      outboundDb,
      outboundMessage,
      callChainHints: uniqueSortedStrings(callChainHints),
      aliasHints: uniqueSortedStrings(aliasHints),
      signalSources: normalizedSignalSources,
      provenanceEvidenceIds: normalizedProvenanceEvidenceIds,
      extractionStrategy,
      unresolvedReasons,
      summaryCompleteness,
      flags,
      confidence,
      sourceHash,
    });
    summaryCount += 1;
  }

  return { summaryCount };
}
