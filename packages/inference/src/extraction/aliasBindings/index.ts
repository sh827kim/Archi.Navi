import { readFileSync } from 'node:fs';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import { aliasBindings, codeArtifacts, codeCallEdges, evidences, objects } from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import { detectPlugins, parseConfigWithPluginParsers } from '@/code';
import { parseApplicationYml } from '@/relation/parsers/applicationYml';
import {
  describeConfigEntries,
  loadApplicationConfigBundle,
  materializeConfigEntriesFromSignals,
  mergeConfigBindingBundles,
  resolveConfigKeysAgainstEntries,
} from '@/relation/configBinder';
import { findFiles } from '@/utils/fileDiscovery';
import {
  asRecord,
  asString,
  extractHost,
  isLikelyServiceName,
  normalizeOptionalUuid,
  stableHash,
  uniqueSortedStrings,
} from '../shared';

export interface ExtractAliasBindingsOptions {
  workspaceId: string;
  repoRoot: string;
  runId?: string | null | undefined;
}

export interface ExtractAliasBindingsResult {
  bindingCount: number;
  configBindingCount?: number;
  configBindingUnresolvedCount?: number;
}

interface ServiceRef {
  id: string;
  name: string;
}

interface IndexedServiceRef extends ServiceRef {
  normalizedName: string;
  tokens: string[];
}

interface ServiceLookupIndex {
  byNormalizedAlias: Map<string, ServiceRef>;
  services: IndexedServiceRef[];
}

function normalizeAlias(value: string): string {
  return value.toLowerCase().replace(/[-_]/g, '');
}

function toAliasTokens(value: string): string[] {
  return uniqueSortedStrings(
    value
      .replace(/\$\{([^}:]+)(?::[^}]*)?\}/g, '$1')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[^A-Za-z0-9]+/)
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length >= 2),
  );
}

function buildConfigAliasCandidates(aliasKey: string, aliasValue: string, resolvedHost: string | null): string[] {
  const keySegments = aliasKey
    .replace(/\$\{([^}:]+)(?::[^}]*)?\}/g, '$1')
    .split(/[.\-_]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  const keySuffixCandidates: string[] = [];
  for (let start = Math.max(0, keySegments.length - 4); start < keySegments.length; start += 1) {
    const suffix = keySegments.slice(start).join('');
    if (suffix.length > 0) {
      keySuffixCandidates.push(suffix);
    }
  }

  const envPlaceholders = uniqueSortedStrings([
    ...aliasValue.matchAll(/\$\{([^}:]+)(?::[^}]*)?\}/g),
    ...(resolvedHost ? [...resolvedHost.matchAll(/\$\{([^}:]+)(?::[^}]*)?\}/g)] : []),
  ].map((match) => match[1] ?? ''));

  const semanticSegments = keySegments.filter((segment) => ![
    'api',
    'apis',
    'client',
    'clients',
    'service',
    'services',
    'base',
    'url',
    'uri',
    'host',
    'http',
    'https',
    'config',
    'properties',
  ].includes(segment.toLowerCase()));

  return uniqueSortedStrings([
    aliasKey,
    aliasValue,
    ...(resolvedHost ? [resolvedHost] : []),
    ...envPlaceholders,
    ...keySuffixCandidates,
    ...semanticSegments,
  ]);
}

function findApplicationConfigFiles(repoRoot: string): string[] {
  return findFiles(repoRoot, (filePath) => {
    const base = filePath.split('/').pop() ?? '';
    return (
      (base.startsWith('application') || base.startsWith('bootstrap'))
      && (base.endsWith('.yml') || base.endsWith('.yaml') || base.endsWith('.json'))
    );
  });
}

function loadConfigRegistry(repoRoot: string) {
  return loadApplicationConfigBundle(repoRoot);
}

async function loadServiceMap(
  db: DbClient,
  workspaceId: string,
): Promise<ServiceLookupIndex> {
  const rows = await db
    .select({ id: objects.id, name: objects.name })
    .from(objects)
    .where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectType, 'service')));

  const byName = new Map<string, ServiceRef>();
  const indexedServices: IndexedServiceRef[] = [];
  for (const row of rows) {
    const normalized = normalizeAlias(row.name);
    byName.set(normalized, row);
    indexedServices.push({
      ...row,
      normalizedName: normalized,
      tokens: toAliasTokens(row.name),
    });
  }
  return { byNormalizedAlias: byName, services: indexedServices };
}

function findServiceByAlias(
  serviceMap: ServiceLookupIndex,
  alias: string,
): ServiceRef | null {
  const trimmed = alias.trim();
  if (trimmed.length === 0) return null;

  const direct = normalizeAlias(trimmed);
  const hostPrefix = normalizeAlias(trimmed.split('.')[0] ?? trimmed);
  const directMatch = serviceMap.byNormalizedAlias.get(direct) ?? serviceMap.byNormalizedAlias.get(hostPrefix);
  if (directMatch) return directMatch;

  const aliasTokens = toAliasTokens(trimmed);
  if (aliasTokens.length === 0) return null;

  let bestMatch: IndexedServiceRef | null = null;
  let bestScore = 0;
  for (const service of serviceMap.services) {
    if (service.tokens.length === 0) continue;
    const overlapCount = aliasTokens.filter((token) => service.tokens.includes(token)).length;
    const score = overlapCount / aliasTokens.length;
    if (overlapCount > 0 && score >= 0.5 && (score > bestScore || (score === bestScore && service.tokens.length < (bestMatch?.tokens.length ?? Number.MAX_SAFE_INTEGER)))) {
      bestMatch = service;
      bestScore = score;
    }
  }
  return bestMatch ? { id: bestMatch.id, name: bestMatch.name } : null;
}

async function loadOwnerServiceIdByObjectId(
  db: DbClient,
  workspaceId: string,
  ownerObjectIds: string[],
): Promise<Map<string, string | null>> {
  const uniqueOwnerObjectIds = uniqueSortedStrings(ownerObjectIds);
  if (uniqueOwnerObjectIds.length === 0) {
    return new Map();
  }

  const objectRowsById = new Map<
    string,
    {
      id: string;
      objectType: string;
      parentId: string | null;
    }
  >();

  const pendingObjectIds = new Set(uniqueOwnerObjectIds);
  while (pendingObjectIds.size > 0) {
    const batch = [...pendingObjectIds];
    batch.forEach((objectId) => pendingObjectIds.delete(objectId));

    const rows = await db
      .select({
        id: objects.id,
        objectType: objects.objectType,
        parentId: objects.parentId,
      })
      .from(objects)
      .where(and(eq(objects.workspaceId, workspaceId), inArray(objects.id, batch)));

    for (const row of rows) {
      objectRowsById.set(row.id, row);
      if (row.parentId && !objectRowsById.has(row.parentId)) {
        pendingObjectIds.add(row.parentId);
      }
    }
  }

  const ownerServiceIdByObjectId = new Map<string, string | null>();
  for (const ownerObjectId of uniqueOwnerObjectIds) {
    let currentObjectId: string | null = ownerObjectId;
    let resolvedServiceId: string | null = null;
    while (currentObjectId) {
      const current = objectRowsById.get(currentObjectId);
      if (!current) break;
      if (current.objectType === 'service') {
        resolvedServiceId = current.id;
        break;
      }
      currentObjectId = current.parentId;
    }
    ownerServiceIdByObjectId.set(ownerObjectId, resolvedServiceId);
  }

  return ownerServiceIdByObjectId;
}

function inferConfigBindingKind(propertyKey: string, aliasValue: string, resolvedHost: string | null): string {
  const normalizedKey = propertyKey.toLowerCase();
  if (normalizedKey.includes('base-url') || normalizedKey.endsWith('.url') || normalizedKey.endsWith('.uri')) {
    return 'base_url';
  }
  if (normalizedKey.includes('bootstrap-servers') || normalizedKey.includes('datasource')) {
    return 'property_alias';
  }
  if (resolvedHost && isLikelyServiceName(resolvedHost)) {
    return 'property_alias';
  }
  if (isLikelyServiceName(aliasValue)) {
    return 'property_alias';
  }
  return 'property_alias';
}

function extractConfigKeysFromMetadata(metadata: Record<string, unknown>): string[] {
  return uniqueSortedStrings([
    asString(metadata['configKey']),
    ...(Array.isArray(metadata['configKeys']) ? metadata['configKeys'].map((entry) => asString(entry)) : []),
    asString(metadata['baseUrlConfigKey']),
    asString(metadata['hostConfigKey']),
    asString(metadata['propertyKey']),
  ]);
}

function resolveConfigAliasValue(rawValue: string): { aliasValue: string; resolvedHost: string | null } {
  const extractedHost = extractHost(rawValue);
  if (extractedHost) {
    return { aliasValue: rawValue.trim(), resolvedHost: extractedHost };
  }

  const normalized = rawValue.trim();
  if (normalized.length === 0) {
    return { aliasValue: '', resolvedHost: null };
  }

  const firstToken = normalized.split(',')[0]?.trim() ?? normalized;
  const hostToken = firstToken.split(':')[0]?.trim() ?? firstToken;
  return {
    aliasValue: normalized,
    resolvedHost: hostToken.length > 0 ? hostToken : null,
  };
}

async function upsertAliasBinding(
  db: DbClient,
  input: {
    workspaceId: string;
    runId?: string | null | undefined;
    bindingKind: string;
    ownerServiceId: string | null;
    aliasKey: string;
    aliasValue: string;
    resolvedServiceId: string | null;
    resolvedHost: string | null;
    evidenceIds: string[];
    confidence: number;
  },
): Promise<void> {
  const sourceHash = stableHash([
    input.bindingKind,
    input.ownerServiceId ?? '',
    input.aliasKey,
    input.aliasValue,
    input.resolvedServiceId ?? '',
    input.resolvedHost ?? '',
  ]);
  const existing = await db
    .select({ id: aliasBindings.id })
    .from(aliasBindings)
    .where(and(eq(aliasBindings.workspaceId, input.workspaceId), eq(aliasBindings.sourceHash, sourceHash)))
    .limit(1);

  const payload = {
    updatedRunId: normalizeOptionalUuid(input.runId),
    bindingKind: input.bindingKind,
    ownerServiceId: input.ownerServiceId,
    aliasKey: input.aliasKey,
    aliasValue: input.aliasValue,
    resolvedServiceId: input.resolvedServiceId,
    resolvedHost: input.resolvedHost,
    evidenceIds: uniqueSortedStrings(input.evidenceIds),
    confidence: input.confidence,
    status: 'ACTIVE',
    updatedAt: new Date(),
  };

  const existingId = existing[0]?.id ?? null;
  let currentBindingId = existingId;
  if (existingId) {
    await db.update(aliasBindings).set(payload).where(eq(aliasBindings.id, existingId));
  } else {
    currentBindingId = generateId();
    await db.insert(aliasBindings).values({
      id: currentBindingId,
      workspaceId: input.workspaceId,
      createdRunId: normalizeOptionalUuid(input.runId),
      sourceHash,
      ...payload,
    });
  }

  const ownerServicePredicate = input.ownerServiceId
    ? eq(aliasBindings.ownerServiceId, input.ownerServiceId)
    : isNull(aliasBindings.ownerServiceId);
  const conflictingBindings = await db
    .select({ id: aliasBindings.id })
    .from(aliasBindings)
    .where(
      and(
        eq(aliasBindings.workspaceId, input.workspaceId),
        eq(aliasBindings.bindingKind, input.bindingKind),
        ownerServicePredicate,
        eq(aliasBindings.aliasKey, input.aliasKey),
        eq(aliasBindings.status, 'ACTIVE'),
      ),
    );

  for (const binding of conflictingBindings) {
    if (binding.id === currentBindingId) continue;
    await db
      .update(aliasBindings)
      .set({
        status: 'SUPERSEDED',
        updatedRunId: normalizeOptionalUuid(input.runId),
        updatedAt: new Date(),
      })
      .where(eq(aliasBindings.id, binding.id));
  }
}

export async function extractAliasBindingsFromCodeSignals(
  db: DbClient,
  options: ExtractAliasBindingsOptions,
): Promise<ExtractAliasBindingsResult> {
  const serviceMap = await loadServiceMap(db, options.workspaceId);
  const configRegistry = loadConfigRegistry(options.repoRoot);
  const rows = await db
    .select({
      calleeSymbol: codeCallEdges.calleeSymbol,
      ownerObjectId: codeArtifacts.ownerObjectId,
      evidenceId: codeCallEdges.evidenceId,
      evidenceMetadata: evidences.metadata,
    })
    .from(codeCallEdges)
    .innerJoin(codeArtifacts, eq(codeCallEdges.callerArtifactId, codeArtifacts.id))
    .leftJoin(evidences, eq(codeCallEdges.evidenceId, evidences.id))
    .where(
      and(eq(codeCallEdges.workspaceId, options.workspaceId), eq(codeArtifacts.repoRoot, options.repoRoot)),
    );
  const ownerServiceIdByObjectId = await loadOwnerServiceIdByObjectId(
    db,
    options.workspaceId,
    rows
      .map((row) => row.ownerObjectId)
      .filter((ownerObjectId): ownerObjectId is string => typeof ownerObjectId === 'string' && ownerObjectId.length > 0),
  );

  let bindingCount = 0;
  let configBindingCount = 0;
  let configBindingUnresolvedCount = 0;
  for (const row of rows) {
    const metadata = asRecord(row.evidenceMetadata) ?? {};
    const kind = asString(metadata['kind']);
    if (kind !== 'call' && kind !== 'http_call') continue;

    const configKeys = extractConfigKeysFromMetadata(metadata);
    const configBindings = resolveConfigKeysAgainstEntries(configKeys, configRegistry);
    configBindingCount += configBindings.descriptors.length;
    configBindingUnresolvedCount += configBindings.unresolved.length;
    const configHostHints = uniqueSortedStrings(configBindings.descriptors.flatMap((binding) => binding.hostHints));
    const host = configHostHints[0] ?? extractHost(row.calleeSymbol);
    const service = host ? findServiceByAlias(serviceMap, host) : null;
    const ownerServiceId = row.ownerObjectId ? (ownerServiceIdByObjectId.get(row.ownerObjectId) ?? null) : null;
    if (host && isLikelyServiceName(host) && service) {
      await upsertAliasBinding(db, {
        workspaceId: options.workspaceId,
        runId: options.runId,
        bindingKind: 'service_discovery',
        ownerServiceId: null,
        aliasKey: host,
        aliasValue: host,
        resolvedServiceId: service.id,
        resolvedHost: host,
        evidenceIds: uniqueSortedStrings([row.evidenceId]),
        confidence: 0.9,
      });
      bindingCount += 1;
    }

    for (const binding of configBindings.descriptors) {
      const aliasValue = binding.resolvedUrl ?? binding.value ?? row.calleeSymbol.trim();
      const bindingHost = binding.hostHints[0] ?? host ?? null;
      const bindingService = bindingHost ? findServiceByAlias(serviceMap, bindingHost) : null;
      if (!bindingHost) {
        continue;
      }

      await upsertAliasBinding(db, {
        workspaceId: options.workspaceId,
        runId: options.runId,
        bindingKind: binding.bindingKind,
        ownerServiceId,
        aliasKey: binding.key,
        aliasValue,
        resolvedServiceId: bindingService?.id ?? null,
        resolvedHost: bindingHost,
        evidenceIds: uniqueSortedStrings([row.evidenceId]),
        confidence: binding.bindingKind === 'base_url' ? 0.9 : 0.85,
      });
      bindingCount += 1;
    }
  }

  return { bindingCount, configBindingCount, configBindingUnresolvedCount };
}

export async function extractAliasBindingsFromConfig(
  db: DbClient,
  options: ExtractAliasBindingsOptions,
): Promise<ExtractAliasBindingsResult> {
  const serviceMap = await loadServiceMap(db, options.workspaceId);
  const applicationFiles = findApplicationConfigFiles(options.repoRoot);
  const detectedPlugins = detectPlugins(options.repoRoot);

  let bindingCount = 0;
  let configBindingCount = 0;
  let configBindingUnresolvedCount = 0;
  for (const filePath of applicationFiles) {
    const content = readFileSync(filePath, 'utf-8');
    const pluginParsed = parseConfigWithPluginParsers(filePath, content, detectedPlugins);
    const fileBundle = mergeConfigBindingBundles(
      describeConfigEntries(pluginParsed.entries),
      describeConfigEntries(materializeConfigEntriesFromSignals(pluginParsed.derivedSignals ?? [], filePath)),
      filePath.endsWith('.yml') || filePath.endsWith('.yaml')
        ? describeConfigEntries(parseApplicationYml(filePath, content).propertyEntries.map((entry) => ({
            key: entry.key,
            value: entry.value,
            sourceType: 'yaml',
            filePath,
          })))
        : { descriptors: [], unresolved: [], summary: { total: 0, bindingCount: 0, unresolvedCount: 0, valueKindCounts: { url: 0, host: 0, topic: 0, queue: 0, port: 0, path: 0, property: 0 }, bindingKindCounts: { base_url: 0, gateway_target: 0, service_discovery: 0, property_alias: 0 } } },
    );
    configBindingCount += fileBundle.descriptors.length;
    configBindingUnresolvedCount += fileBundle.unresolved.length;
    for (const binding of fileBundle.descriptors) {
      const aliasValue = binding.resolvedUrl ?? binding.value ?? '';
      const resolvedHost = binding.hostHints[0] ?? extractHost(aliasValue);
      const directResolvedService = resolvedHost
        ? findServiceByAlias(serviceMap, resolvedHost)
        : findServiceByAlias(serviceMap, aliasValue);
      const keyResolvedService = buildConfigAliasCandidates(binding.key, aliasValue, resolvedHost)
        .map((candidate) => findServiceByAlias(serviceMap, candidate))
        .find((service): service is ServiceRef => service !== null);
      const resolvedService = directResolvedService ?? keyResolvedService ?? null;
      if (!resolvedService && !resolvedHost) continue;

      await upsertAliasBinding(db, {
        workspaceId: options.workspaceId,
        runId: options.runId,
        bindingKind: binding.bindingKind,
        ownerServiceId: null,
        aliasKey: binding.key,
        aliasValue: aliasValue.length > 0 ? aliasValue : binding.key,
        resolvedServiceId: resolvedService?.id ?? null,
        resolvedHost,
        evidenceIds: [],
        confidence: binding.bindingKind === 'base_url' ? 0.95 : 0.85,
      });
      bindingCount += 1;
    }

    if (!(filePath.endsWith('.yml') || filePath.endsWith('.yaml'))) continue;

    const signal = parseApplicationYml(filePath, content);
    const ownerService = signal.serviceName ? findServiceByAlias(serviceMap, signal.serviceName) : null;

    for (const route of signal.zuulRoutes) {
      const targetAlias = route.serviceId ?? route.url ?? null;
      if (!targetAlias) continue;
      const service = findServiceByAlias(serviceMap, route.serviceId ?? route.url ?? '');
      if (!service) continue;

      await upsertAliasBinding(db, {
        workspaceId: options.workspaceId,
        runId: options.runId,
        bindingKind: 'gateway_target',
        ownerServiceId: ownerService?.id ?? null,
        aliasKey: targetAlias,
        aliasValue: targetAlias,
        resolvedServiceId: service.id,
        resolvedHost: route.url ? extractHost(route.url) : null,
        evidenceIds: [],
        confidence: 0.9,
      });
      bindingCount += 1;
    }
  }

  return { bindingCount, configBindingCount, configBindingUnresolvedCount };
}
