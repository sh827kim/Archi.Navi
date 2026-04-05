import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import {
  codeArtifacts,
  codeCallEdges,
  evidences,
  functionSummaries,
  interactionIntents,
  objects,
} from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import { preferredSignalOwnerId, resolveExistingSignalOwnerId } from '@/code/ownerResolution';
import { parseApplicationYml } from '@/relation/parsers/applicationYml';
import { findFiles } from '@/utils/fileDiscovery';
import {
  asRecord,
  asString,
  extractHost,
  extractPath,
  normalizeHint,
  normalizeMethod,
  normalizeOptionalUuid,
  stableHash,
  uniqueSortedStrings,
} from '../shared';

type IntentType = 'http_call' | 'http_gateway_route' | 'db_access' | 'message_publish' | 'message_consume';
const CODE_SIGNAL_INTENT_TYPES: IntentType[] = ['http_call', 'db_access', 'message_publish', 'message_consume'];

interface SourceContext {
  serviceId: string;
  functionId: string | null;
}

interface IntentSeed {
  intentType: IntentType;
  sourceServiceId: string;
  sourceFunctionId: string | null;
  sourceFilePath: string;
  methodHint: string | null;
  externalPathHint: string | null;
  gatewayKind: string | null;
  routeScopeKind: 'exact' | 'prefix' | 'regex' | null;
  externalRoutePattern: string | null;
  providerHint: string | null;
  targetServiceHint: string | null;
  routeTransformRefs: string[];
  methodConstraint: 'unknown' | 'any' | 'exact' | null;
  hostHint: string | null;
  resourceHint: string | null;
  dbSchemaHint: string | null;
  dbTableHints: string[];
  dbQueryFragmentHash: string | null;
  messageBrokerKind: string | null;
  messageTopicHints: string[];
  messageQueueHints: string[];
  messageRoutingKeyHints: string[];
  configKeys: string[];
  evidenceIds: string[];
  summaryRefs: string[];
}

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

export interface ExtractInteractionIntentsOptions {
  workspaceId: string;
  repoRoot: string;
  runId?: string | null | undefined;
}

export interface ExtractInteractionIntentsResult {
  intentCount: number;
  gatewayRouteSeedCount?: number;
}

function buildConfigEvidenceId(repoRoot: string, filePath: string, routeKey: string): string {
  const relativePath = relative(repoRoot, filePath).trim();
  return `config:${relativePath.length > 0 ? relativePath : filePath}#${routeKey}`;
}

function findApplicationYmls(repoRoot: string): string[] {
  return findFiles(repoRoot, (filePath) => {
    const base = filePath.split('/').pop() ?? '';
    return (
      (base.startsWith('application') || base.startsWith('bootstrap'))
      && (base.endsWith('.yml') || base.endsWith('.yaml'))
    );
  });
}

function normalizeGatewayPathHint(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const withoutWildcard = trimmed.replace(/\/\*\*.*$/, '').trim();
  if (withoutWildcard.length === 0) return null;
  return withoutWildcard.startsWith('/') ? withoutWildcard : `/${withoutWildcard}`;
}

function inferRouteScopeKind(value: string | null): 'exact' | 'prefix' | 'regex' | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes('**') || trimmed.includes('*')) return 'prefix';
  return 'exact';
}

function mapKindToIntentType(kind: string): IntentType | null {
  if (kind === 'call' || kind === 'http_call') return 'http_call';
  if (kind === 'db_read' || kind === 'db_write' || kind === 'db_mapping') return 'db_access';
  if (kind === 'produce') return 'message_publish';
  if (kind === 'consume') return 'message_consume';
  return null;
}

function normalizeDbAction(kind: string): string | null {
  if (kind === 'db_read') return 'SELECT';
  if (kind === 'db_write') return 'WRITE';
  if (kind === 'db_mapping') return 'MAP';
  return null;
}

function parseDbResourceHints(value: string | null): { schemaHint: string | null; tableHints: string[] } {
  if (!value) {
    return { schemaHint: null, tableHints: [] };
  }
  const tokens = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const tableHints = uniqueSortedStrings(tokens.map((token) => token.split('.').at(-1) ?? token));
  const schemaHint = tokens[0]?.includes('.') ? (tokens[0].split('.')[0] ?? null) : null;
  return { schemaHint, tableHints };
}

function extractMessageHints(
  metadata: Record<string, unknown>,
  calleeSymbol: string,
): {
  brokerKind: string | null;
  topicHints: string[];
  queueHints: string[];
  routingKeyHints: string[];
} {
  const channelType = asString(metadata['channelType']) ?? asString(metadata['channel_type']);
  const topicHints = uniqueSortedStrings([
    asString(metadata['topic']),
    ...(channelType !== 'queue' ? [calleeSymbol] : []),
  ]);
  const queueHints = uniqueSortedStrings([
    asString(metadata['queue']),
    ...(channelType === 'queue' ? [calleeSymbol] : []),
  ]);
  return {
    brokerKind: asString(metadata['brokerKind']) ?? asString(metadata['broker_kind']),
    topicHints,
    queueHints,
    routingKeyHints: uniqueSortedStrings([
      asString(metadata['routingKey']),
      asString(metadata['routing_key']),
    ]),
  };
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
    if (row.objectType === 'service') {
      context.set(row.id, {
        serviceId: row.id,
        functionId: null,
      });
      continue;
    }

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
        });
      }
    }
  }

  return {
    sourceContexts: context,
    functionIdByOwnerKey,
  };
}

async function loadSummaryMap(
  db: DbClient,
  workspaceId: string,
): Promise<Map<string, string>> {
  const rows = await db
    .select({
      id: functionSummaries.id,
      functionId: functionSummaries.functionId,
      status: functionSummaries.status,
      summaryVersion: functionSummaries.summaryVersion,
    })
    .from(functionSummaries)
    .where(and(eq(functionSummaries.workspaceId, workspaceId), eq(functionSummaries.status, 'ACTIVE')));

  const byFunction = new Map<string, { id: string; version: number }>();
  for (const row of rows) {
    const current = byFunction.get(row.functionId);
    if (!current || current.version < row.summaryVersion) {
      byFunction.set(row.functionId, { id: row.id, version: row.summaryVersion });
    }
  }

  return new Map(Array.from(byFunction.entries()).map(([functionId, row]) => [functionId, row.id] as const));
}

function buildIntentHashes(seed: IntentSeed) {
  return {
    intentHash: stableHash([
      seed.intentType,
      seed.sourceServiceId,
      seed.sourceFunctionId ?? '',
      normalizeHint(seed.methodHint),
      normalizeHint(seed.externalPathHint),
      normalizeHint(seed.gatewayKind),
      normalizeHint(seed.routeScopeKind),
      normalizeHint(seed.externalRoutePattern),
      normalizeHint(seed.providerHint),
      normalizeHint(seed.targetServiceHint),
      JSON.stringify(uniqueSortedStrings(seed.routeTransformRefs)),
      normalizeHint(seed.methodConstraint),
      normalizeHint(seed.hostHint),
      normalizeHint(seed.resourceHint),
      normalizeHint(seed.dbSchemaHint),
      JSON.stringify(uniqueSortedStrings(seed.dbTableHints)),
      normalizeHint(seed.dbQueryFragmentHash),
      normalizeHint(seed.messageBrokerKind),
      JSON.stringify(uniqueSortedStrings(seed.messageTopicHints)),
      JSON.stringify(uniqueSortedStrings(seed.messageQueueHints)),
      JSON.stringify(uniqueSortedStrings(seed.messageRoutingKeyHints)),
      JSON.stringify(uniqueSortedStrings(seed.configKeys)),
      JSON.stringify(uniqueSortedStrings(seed.summaryRefs)),
    ]),
    anchorHash: stableHash([seed.intentType, seed.sourceServiceId, seed.sourceFunctionId ?? '']),
  };
}

function hasDownstreamHint(seed: IntentSeed): boolean {
  return seed.methodHint !== null
    || seed.externalPathHint !== null
    || seed.gatewayKind !== null
    || seed.routeScopeKind !== null
    || seed.externalRoutePattern !== null
    || seed.providerHint !== null
    || seed.targetServiceHint !== null
    || seed.routeTransformRefs.length > 0
    || seed.methodConstraint !== null
    || seed.hostHint !== null
    || seed.resourceHint !== null
    || seed.dbSchemaHint !== null
    || seed.dbTableHints.length > 0
    || seed.dbQueryFragmentHash !== null
    || seed.messageBrokerKind !== null
    || seed.messageTopicHints.length > 0
    || seed.messageQueueHints.length > 0
    || seed.messageRoutingKeyHints.length > 0
    || seed.configKeys.length > 0
    || seed.summaryRefs.length > 0;
}

async function upsertInteractionIntent(
  db: DbClient,
  input: IntentSeed & { workspaceId: string; runId?: string | null | undefined },
): Promise<void> {
  const { intentHash, anchorHash } = buildIntentHashes(input);
  const existingRows = await db
    .select({ id: interactionIntents.id })
    .from(interactionIntents)
    .where(
      and(eq(interactionIntents.workspaceId, input.workspaceId), eq(interactionIntents.intentHash, intentHash)),
    )
    .limit(1);

  const payload = {
    updatedRunId: normalizeOptionalUuid(input.runId),
    intentType: input.intentType,
    sourceServiceId: input.sourceServiceId,
    sourceFunctionId: input.sourceFunctionId,
    sourceFilePath: input.sourceFilePath,
    methodHint: input.methodHint,
    externalPathHint: input.externalPathHint,
    gatewayKind: input.gatewayKind,
    routeScopeKind: input.routeScopeKind,
    externalRoutePattern: input.externalRoutePattern,
    providerHint: input.providerHint,
    targetServiceHint: input.targetServiceHint,
    routeTransformRefs: uniqueSortedStrings(input.routeTransformRefs),
    methodConstraint: input.methodConstraint,
    hostHint: input.hostHint,
    resourceHint: input.resourceHint,
    dbSchemaHint: input.dbSchemaHint,
    dbTableHints: uniqueSortedStrings(input.dbTableHints),
    dbQueryFragmentHash: input.dbQueryFragmentHash,
    messageBrokerKind: input.messageBrokerKind,
    messageTopicHints: uniqueSortedStrings(input.messageTopicHints),
    messageQueueHints: uniqueSortedStrings(input.messageQueueHints),
    messageRoutingKeyHints: uniqueSortedStrings(input.messageRoutingKeyHints),
    configKeys: uniqueSortedStrings(input.configKeys),
    summaryRefs: uniqueSortedStrings(input.summaryRefs),
    evidenceIds: uniqueSortedStrings(input.evidenceIds),
    anchorHash,
    updatedAt: new Date(),
  };

  const existing = existingRows[0];
  if (existing) {
    await db.update(interactionIntents).set(payload).where(eq(interactionIntents.id, existing.id));
    return;
  }

  await db.insert(interactionIntents).values({
    id: generateId(),
    workspaceId: input.workspaceId,
    createdRunId: normalizeOptionalUuid(input.runId),
    intentHash,
    status: 'NEW',
    ...payload,
  });
}

async function retireMissingCodeSignalIntents(
  db: DbClient,
  options: ExtractInteractionIntentsOptions,
  currentIntentHashes: Set<string>,
): Promise<void> {
  const artifactRows = await db
    .select({ filePath: codeArtifacts.filePath })
    .from(codeArtifacts)
    .where(and(eq(codeArtifacts.workspaceId, options.workspaceId), eq(codeArtifacts.repoRoot, options.repoRoot)));
  const artifactPaths = uniqueSortedStrings(artifactRows.map((row) => row.filePath));
  if (artifactPaths.length === 0) return;

  const existingRows = await db
    .select({ id: interactionIntents.id, intentHash: interactionIntents.intentHash })
    .from(interactionIntents)
    .where(
      and(
        eq(interactionIntents.workspaceId, options.workspaceId),
        inArray(interactionIntents.intentType, CODE_SIGNAL_INTENT_TYPES),
        inArray(interactionIntents.sourceFilePath, artifactPaths),
      ),
    );
  const staleIntentIds = existingRows
    .filter((row) => !currentIntentHashes.has(row.intentHash))
    .map((row) => row.id);
  if (staleIntentIds.length === 0) return;

  await db.delete(interactionIntents).where(inArray(interactionIntents.id, staleIntentIds));
}

export async function extractInteractionIntentsFromCodeSignals(
  db: DbClient,
  options: ExtractInteractionIntentsOptions,
): Promise<ExtractInteractionIntentsResult> {
  const rows = await db
    .select({
      ownerObjectId: codeArtifacts.ownerObjectId,
      filePath: codeArtifacts.filePath,
      calleeSymbol: codeCallEdges.calleeSymbol,
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
  const summaryMap = await loadSummaryMap(db, options.workspaceId);

  let intentCount = 0;
  const extractedIntentHashes = new Set<string>();
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

    const kind = asString(metadata['kind']);
    if (!kind || kind === 'expose') continue;

    const intentType = mapKindToIntentType(kind);
    if (!intentType) continue;

    const summaryRefs = source.functionId ? [summaryMap.get(source.functionId) ?? null] : [];
    const configKeys = extractConfigKeysFromMetadata(metadata);
    const rawResourceHint =
      intentType === 'db_access' || intentType === 'message_publish' || intentType === 'message_consume'
        ? asString(row.calleeSymbol)
        : null;
    const dbHints = intentType === 'db_access'
      ? parseDbResourceHints(rawResourceHint)
      : { schemaHint: null, tableHints: [] as string[] };
    const messageHints = intentType === 'message_publish' || intentType === 'message_consume'
      ? extractMessageHints(metadata, row.calleeSymbol.trim())
      : { brokerKind: null, topicHints: [] as string[], queueHints: [] as string[], routingKeyHints: [] as string[] };
    const seed: IntentSeed = {
      intentType,
      sourceServiceId: source.serviceId,
      sourceFunctionId: source.functionId,
      sourceFilePath: row.filePath,
      methodHint: intentType === 'db_access' ? normalizeDbAction(kind) : normalizeMethod(metadata['method']),
      externalPathHint: intentType === 'http_call' ? extractPath(row.calleeSymbol) : null,
      gatewayKind: null,
      routeScopeKind: null,
      externalRoutePattern: null,
      providerHint: null,
      targetServiceHint: null,
      routeTransformRefs: [],
      methodConstraint: null,
      hostHint: intentType === 'http_call' ? extractHost(row.calleeSymbol) : null,
      resourceHint: rawResourceHint,
      dbSchemaHint: dbHints.schemaHint ?? asString(metadata['schema']),
      dbTableHints: dbHints.tableHints,
      dbQueryFragmentHash: asString(metadata['queryFragmentHash']) ?? asString(metadata['query_fragment_hash']),
      messageBrokerKind: messageHints.brokerKind,
      messageTopicHints: messageHints.topicHints,
      messageQueueHints: messageHints.queueHints,
      messageRoutingKeyHints: messageHints.routingKeyHints,
      configKeys,
      evidenceIds: uniqueSortedStrings([row.evidenceId]),
      summaryRefs: uniqueSortedStrings(summaryRefs),
    };

    if (!hasDownstreamHint(seed)) continue;

    const { intentHash } = buildIntentHashes(seed);
    extractedIntentHashes.add(intentHash);

    await upsertInteractionIntent(db, {
      workspaceId: options.workspaceId,
      runId: options.runId,
      ...seed,
    });
    intentCount += 1;
  }
  await retireMissingCodeSignalIntents(db, options, extractedIntentHashes);

  return { intentCount };
}

export async function extractInteractionIntentsFromConfigRoutes(
  db: DbClient,
  options: ExtractInteractionIntentsOptions,
): Promise<ExtractInteractionIntentsResult> {
  const serviceRows = await db
    .select({ id: objects.id, name: objects.name })
    .from(objects)
    .where(and(eq(objects.workspaceId, options.workspaceId), eq(objects.objectType, 'service')));
  const serviceIdByAlias = new Map(
    serviceRows.map((row) => [row.name.toLowerCase().replace(/[-_]/g, ''), row.id] as const),
  );

  const applicationFiles = findApplicationYmls(options.repoRoot);
  let intentCount = 0;
  let gatewayRouteSeedCount = 0;

  for (const filePath of applicationFiles) {
    const signal = parseApplicationYml(filePath, readFileSync(filePath, 'utf-8'));
    const sourceServiceId = signal.serviceName
      ? (serviceIdByAlias.get(signal.serviceName.toLowerCase().replace(/[-_]/g, '')) ?? null)
      : null;
    if (!sourceServiceId) continue;

    for (const route of signal.zuulRoutes) {
      const externalPathHint = normalizeGatewayPathHint(route.path);
      const hostHint = route.serviceId ?? extractHost(route.url ?? '') ?? null;
      if (!externalPathHint && !hostHint) continue;

      await upsertInteractionIntent(db, {
        workspaceId: options.workspaceId,
        runId: options.runId,
        intentType: 'http_gateway_route',
        sourceServiceId,
        sourceFunctionId: null,
        sourceFilePath: filePath,
        methodHint: null,
        externalPathHint,
        gatewayKind: 'zuul',
        routeScopeKind: inferRouteScopeKind(route.path),
        externalRoutePattern: route.path,
        providerHint: route.serviceId ?? extractHost(route.url ?? '') ?? null,
        targetServiceHint: route.serviceId ?? null,
        routeTransformRefs: [],
        methodConstraint: 'unknown',
        hostHint,
        resourceHint: null,
        dbSchemaHint: null,
        dbTableHints: [],
        dbQueryFragmentHash: null,
        messageBrokerKind: null,
        messageTopicHints: [],
        messageQueueHints: [],
        messageRoutingKeyHints: [],
        configKeys: [],
        evidenceIds: [buildConfigEvidenceId(options.repoRoot, filePath, route.routeKey)],
        summaryRefs: [],
      });
      intentCount += 1;
      gatewayRouteSeedCount += 1;
    }
  }

  return { intentCount, gatewayRouteSeedCount };
}
