/**
 * Code Signal 기반 Relation 후보 추론
 *
 * 목표:
 * - code_call_edges(+evidences.metadata.kind/confidence)를 기반으로 relation_candidates를 생성한다.
 * - config 기반 추론이 불가능한 환경에서도(code-only) 후보가 생성되도록 한다.
 *
 * 주의:
 * - expose 신호는 실제 의존성으로 오인 가능성이 높아 후보 생성에서 제외한다.
 * - path-only 호출은 hostHint 같은 추가 힌트가 없으면 여전히 스킵한다.
 */
import type { DbClient } from '@archi-navi/db';
import {
  codeArtifacts,
  codeCallEdges,
  evidences,
  objectRelations,
  objects,
  relationCandidates,
} from '@archi-navi/db';
import { buildUrn, generateId } from '@archi-navi/shared';
import { and, eq, like, or } from 'drizzle-orm';
import { saveRelationCandidate, saveRelationCandidateWithLazyEvidence } from './candidateStore';
import { asRecord } from './utils';
import { preferredSignalOwnerId, resolveExistingSignalOwnerId } from '../code/ownerResolution';
import { normalizePath, uniqueSortedStrings } from '../extraction/shared';

export interface CodeCandidateInferenceOptions {
  workspaceId: string;
  repoRoot: string;
  serviceIds?: string[];
  bootstrapOnly?: boolean;
  candidateGenerationMode?: 'compat_deterministic';
  enableDbScan?: boolean;
}

export interface CodeCandidateInferenceResult {
  edgeCount: number;
  processedEdgeCount: number;
  skippedEdgeCount: number;
  candidateCount: number;
  createdTopicCount: number;
  createdQueueCount: number;
  createdDatabaseCount: number;
  createdDbTableCount: number;
  createdEndpointCount: number;
  sqlParseFallbackCount?: number;
  suspectedSharedDatabaseCount?: number;
  sharedDbTableCount?: number;
  implicitSchemaTableCandidateCount?: number;
}

export interface ApiEndpointBootstrapOptions {
  workspaceId: string;
  repoRoot: string;
  endpointSource?: string;
}

export interface ApiEndpointBootstrapResult {
  createdEndpointCount: number;
  processedExposeCount: number;
}

export interface CodeExposeEndpointBootstrapOptions {
  workspaceId: string;
  repoRoot: string;
  serviceIds?: string[];
}

export interface CodeExposeEndpointBootstrapResult {
  edgeCount: number;
  exposeEdgeCount: number;
  createdEndpointCount: number;
}

type EvidenceMeta = Record<string, unknown>;
type OwnerContext = {
  serviceId: string;
  functionId: string | null;
};
type HttpCandidateSource = 'calleeSymbol' | 'hostHint' | 'pathHint';
type HttpCandidate = {
  value: string;
  source: HttpCandidateSource;
};

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function extractStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => asString(entry)).filter((entry): entry is string => entry !== null);
}

async function loadOwnerContexts(
  db: DbClient,
  workspaceId: string,
  ownerObjectIds: string[],
): Promise<Map<string, OwnerContext>> {
  if (ownerObjectIds.length === 0) return new Map();

  const ownerRows = await db
    .select({
      id: objects.id,
      objectType: objects.objectType,
      parentId: objects.parentId,
    })
    .from(objects)
    .where(eq(objects.workspaceId, workspaceId));

  const objectById = new Map(ownerRows.map((row) => [row.id, row] as const));
  const context = new Map<string, OwnerContext>();

  for (const ownerObjectId of ownerObjectIds) {
    const owner = objectById.get(ownerObjectId);
    if (!owner) continue;

    if (owner.objectType === 'service') {
      context.set(ownerObjectId, {
        serviceId: owner.id,
        functionId: null,
      });
      continue;
    }

    if (owner.objectType === 'function' && owner.parentId) {
      const parent = objectById.get(owner.parentId);
      if (parent?.objectType === 'service') {
        context.set(ownerObjectId, {
          serviceId: parent.id,
          functionId: owner.id,
        });
      }
    }
  }

  return context;
}

function extractCodeSpecializationMetadata(meta: EvidenceMeta): Record<string, string> {
  const specialization: Record<string, string> = {};
  const framework = asString(meta['framework']);
  const language = asString(meta['language']);

  if (framework) specialization.framework = framework;
  if (language) specialization.language = language;

  return specialization;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function normalizeNameKey(value: string): string {
  return value.toLowerCase().replace(/[-_]/g, '');
}

function findServiceIdByName(
  serviceName: string,
  allServices: { id: string; name: string }[],
): string | null {
  const exactMatch = allServices.find(
    (service) => service.name.toLowerCase() === serviceName.toLowerCase(),
  );
  if (exactMatch) return exactMatch.id;

  const normalizedInput = normalizeNameKey(serviceName);
  const normalizedMatch = allServices.find(
    (service) => normalizeNameKey(service.name) === normalizedInput,
  );
  if (normalizedMatch) return normalizedMatch.id;

  return null;
}

function extractHostnameFromUrlLike(value: string): string | null {
  // URL()은 lb:// 등 커스텀 스킴도 파싱 가능
  try {
    const url = new URL(value);
    return url.hostname || null;
  } catch {
    // no-op
  }

  const m = value.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/]+)(\/|$)/);
  if (!m) return null;
  const hostPort = m[1] ?? '';
  const host = hostPort.split(':')[0] ?? hostPort;
  return host.length > 0 ? host : null;
}

function extractPathFromUrlLike(value: string): string | null {
  try {
    const url = new URL(value);
    return url.pathname || null;
  } catch {
    // no-op
  }

  const m = value.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+(\/[^?#]*)/);
  if (!m) return null;
  return m[1] ?? null;
}

function extractServiceCandidatesFromSymbol(symbol: string): string[] {
  const candidates: string[] = [];
  const trimmed = symbol.trim();

  const host = extractHostnameFromUrlLike(trimmed);
  if (host) {
    candidates.push(host);
    if (host.includes('.')) candidates.push(host.split('.')[0] ?? host);
  }

  // FeignClient(name="service") 등: 심볼 자체가 서비스명인 경우
  if (/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,128}$/.test(trimmed) && !trimmed.includes('/')) {
    candidates.push(trimmed);
    if (trimmed.includes('.')) candidates.push(trimmed.split('.')[0] ?? trimmed);
  }

  return Array.from(new Set(candidates.filter(Boolean)));
}

function extractHostHints(meta: EvidenceMeta): string[] {
  return uniqueSortedStrings([
    asString(meta['hostHint']),
    ...extractStringArray(meta['hostHints']),
  ]);
}

function extractPathHints(meta: EvidenceMeta): string[] {
  return uniqueSortedStrings([
    asString(meta['pathHint']),
    ...extractStringArray(meta['pathHints']),
  ].map((value) => (value ? normalizePath(value) : null)));
}

function extractConfigKeys(meta: EvidenceMeta): string[] {
  return uniqueSortedStrings([
    asString(meta['configKey']),
    ...extractStringArray(meta['configKeys']),
  ]);
}

function collectHttpCandidates(
  calleeSymbol: string,
  meta: EvidenceMeta,
): {
  hostCandidates: HttpCandidate[];
  pathCandidates: HttpCandidate[];
  hostHints: string[];
  pathHints: string[];
  configKeys: string[];
  dynamicHost: boolean;
  dynamicPath: boolean;
} {
  const symbol = calleeSymbol.trim();
  const symbolHostHints = extractServiceCandidatesFromSymbol(symbol);
  const hostHints = uniqueSortedStrings([...symbolHostHints, ...extractHostHints(meta)]);
  const symbolPathHint = extractPathFromUrlLike(symbol);
  const pathHints = uniqueSortedStrings([
    ...(symbolPathHint ? [normalizePath(symbolPathHint)] : []),
    ...extractPathHints(meta),
  ]);
  const configKeys = extractConfigKeys(meta);
  const dynamicHost = asBoolean(meta['dynamicHost']);
  const dynamicPath = asBoolean(meta['dynamicPath']);

  const hostCandidates: HttpCandidate[] = [];
  for (const candidate of symbolHostHints) {
    hostCandidates.push({ value: candidate, source: 'calleeSymbol' });
  }
  for (const candidate of hostHints) {
    hostCandidates.push({ value: candidate, source: 'hostHint' });
  }

  const pathCandidates: HttpCandidate[] = [];
  if (symbolPathHint) {
    pathCandidates.push({ value: normalizePath(symbolPathHint), source: 'calleeSymbol' });
  }
  for (const candidate of pathHints) {
    pathCandidates.push({ value: normalizePath(candidate), source: 'pathHint' });
  }

  return {
    hostCandidates,
    pathCandidates,
    hostHints,
    pathHints,
    configKeys,
    dynamicHost,
    dynamicPath,
  };
}

function resolveHttpCallCandidate(
  calleeSymbol: string,
  meta: EvidenceMeta,
  allServices: { id: string; name: string }[],
  endpointByServiceAndPath: Map<string, string>,
  endpointPathCollision: Set<string>,
): {
  targetServiceId: string | null;
  targetPath: string | null;
  targetEndpointId: string | null;
  resolvedVia: string | null;
  hostHint: string | null;
  hostHints: string[];
  pathHint: string | null;
  pathHints: string[];
  configKeys: string[];
  dynamicHost: boolean;
  dynamicPath: boolean;
} {
  const {
    hostCandidates,
    pathCandidates,
    hostHints,
    pathHints,
    configKeys,
    dynamicHost,
    dynamicPath,
  } = collectHttpCandidates(calleeSymbol, meta);

  let targetServiceId: string | null = null;
  let targetPath: string | null = null;
  let targetEndpointId: string | null = null;
  let chosenHost: HttpCandidate | null = null;
  let chosenPath: HttpCandidate | null = null;

  for (const hostCandidate of hostCandidates) {
    const serviceCandidates = extractServiceCandidatesFromSymbol(hostCandidate.value);
    const matchedServiceIds = serviceCandidates
      .map((serviceCandidate) => findServiceIdByName(serviceCandidate, allServices))
      .filter((value): value is string => value !== null);
    if (matchedServiceIds.length === 0) continue;

    for (const matchedServiceId of matchedServiceIds) {
      for (const pathCandidate of pathCandidates) {
        const normalized = normalizePath(pathCandidate.value);
        if (normalized.length === 0) continue;
        const endpointKey = `${matchedServiceId}|${normalized}`;
        if (endpointPathCollision.has(endpointKey)) continue;
        const endpointId = endpointByServiceAndPath.get(endpointKey);
        if (!endpointId) continue;

        targetServiceId = matchedServiceId;
        targetPath = normalized;
        targetEndpointId = endpointId;
        chosenHost = hostCandidate;
        chosenPath = pathCandidate;
        break;
      }
      if (targetEndpointId) break;
    }
    if (targetEndpointId) break;
  }

  const resolvedViaParts = [
    chosenHost?.source,
    chosenPath?.source,
  ].filter((value): value is HttpCandidateSource => typeof value === 'string');

  return {
    targetServiceId,
    targetPath,
    targetEndpointId,
    resolvedVia: resolvedViaParts.length > 0 ? [...new Set(resolvedViaParts)].join('+') : null,
    hostHint: asString(meta['hostHint']) ?? hostCandidates[0]?.value ?? null,
    hostHints,
    pathHint: asString(meta['pathHint']) ?? pathCandidates[0]?.value ?? null,
    pathHints,
    configKeys,
    dynamicHost,
    dynamicPath,
  };
}

function slugifyPath(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const replaced = trimmed.replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return replaced.length > 0 ? replaced : 'root';
}

function parseEndpointDisplay(value: string): { method: string; path: string } | null {
  const m = value.trim().match(/^(GET|POST|PUT|DELETE|PATCH|ANY)\s+(.+)$/i);
  if (!m) return null;
  const method = (m[1] ?? '').toUpperCase();
  const path = (m[2] ?? '').trim();
  if (!method || !path) return null;
  return { method, path };
}

async function upsertTopic(
  db: DbClient,
  workspaceId: string,
  topicName: string,
): Promise<{ id: string; isNew: boolean }> {
  const urn = buildUrn(workspaceId, 'channel', 'topic', topicName);
  const existing = await db
    .select({ id: objects.id })
    .from(objects)
    .where(and(eq(objects.workspaceId, workspaceId), eq(objects.urn, urn)))
    .limit(1);

  if (existing[0]) return { id: existing[0].id, isNew: false };

  const id = generateId();
  await db.insert(objects).values({
    id,
    workspaceId,
    objectType: 'topic',
    category: 'CHANNEL',
    granularity: 'ATOMIC',
    urn,
    name: topicName,
    displayName: topicName,
    path: `/${id}`,
    depth: 0,
    visibility: 'VISIBLE',
    metadata: {},
  });

  return { id, isNew: true };
}

async function upsertQueue(
  db: DbClient,
  workspaceId: string,
  queueName: string,
): Promise<{ id: string; isNew: boolean }> {
  const urn = buildUrn(workspaceId, 'channel', 'queue', queueName);
  const existing = await db
    .select({ id: objects.id })
    .from(objects)
    .where(and(eq(objects.workspaceId, workspaceId), eq(objects.urn, urn)))
    .limit(1);

  if (existing[0]) return { id: existing[0].id, isNew: false };

  const id = generateId();
  await db.insert(objects).values({
    id,
    workspaceId,
    objectType: 'queue',
    category: 'CHANNEL',
    granularity: 'ATOMIC',
    urn,
    name: queueName,
    displayName: queueName,
    path: `/${id}`,
    depth: 0,
    visibility: 'VISIBLE',
    metadata: {},
  });

  return { id, isNew: true };
}

async function upsertApiEndpoint(
  db: DbClient,
  params: {
    workspaceId: string;
    serviceId: string;
    serviceName: string;
    method: string;
    path: string;
    repoRoot: string;
    source?: string;
  },
): Promise<{ id: string; isNew: boolean }> {
  const { workspaceId, serviceId, serviceName, method, path, repoRoot, source } = params;
  const endpointKey = `${serviceName}:${method}:${path}`;
  const urn = buildUrn(workspaceId, 'compute', 'api_endpoint', endpointKey);
  const displayName = `${method} ${path}`;

  const existingByUrn = await db
    .select({ id: objects.id })
    .from(objects)
    .where(and(eq(objects.workspaceId, workspaceId), eq(objects.urn, urn)))
    .limit(1);
  if (existingByUrn[0]) return { id: existingByUrn[0].id, isNew: false };

  // urn이 없는 기존 데이터(legacy/seed 등)와의 중복을 줄이기 위해 parentId+name 기준도 확인
  const existingByName = await db
    .select({ id: objects.id })
    .from(objects)
    .where(
      and(
        eq(objects.workspaceId, workspaceId),
        eq(objects.objectType, 'api_endpoint'),
        eq(objects.parentId, serviceId),
        eq(objects.name, displayName),
      ),
    )
    .limit(1);
  if (existingByName[0]) return { id: existingByName[0].id, isNew: false };

  const id = generateId();
  const slug = `${method.toLowerCase()}-${slugifyPath(path)}`;
  await db.insert(objects).values({
    id,
    workspaceId,
    objectType: 'api_endpoint',
    category: 'COMPUTE',
    granularity: 'ATOMIC',
    urn,
    name: displayName,
    displayName,
    parentId: serviceId,
    path: `/${serviceName}/${slug}`,
    depth: 1,
    visibility: 'VISIBLE',
    metadata: { method, path, repoRoot, source: source ?? 'CODE' },
  });

  return { id, isNew: true };
}

export async function bootstrapApiEndpointsFromCodeSignals(
  db: DbClient,
  options: ApiEndpointBootstrapOptions,
): Promise<ApiEndpointBootstrapResult> {
  const { workspaceId, repoRoot } = options;
  const endpointSource = options.endpointSource ?? 'CODE';

  const allServices = await db
    .select({ id: objects.id, name: objects.name })
    .from(objects)
    .where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectType, 'service')));

  const serviceNameById = new Map(allServices.map((svc) => [svc.id, svc.name] as const));

  const rows = await db
    .select({
      ownerObjectId: codeArtifacts.ownerObjectId,
      calleeSymbol: codeCallEdges.calleeSymbol,
      evidenceMeta: evidences.metadata,
    })
    .from(codeCallEdges)
    .innerJoin(codeArtifacts, eq(codeCallEdges.callerArtifactId, codeArtifacts.id))
    .leftJoin(evidences, eq(codeCallEdges.evidenceId, evidences.id))
    .where(
      and(
        eq(codeCallEdges.workspaceId, workspaceId),
        eq(codeArtifacts.workspaceId, workspaceId),
        or(
          eq(codeArtifacts.repoRoot, repoRoot),
          like(codeArtifacts.repoRoot, `${repoRoot}/%`),
        ),
      ),
    );
  const ownerContexts = await loadOwnerContexts(
    db,
    workspaceId,
    [...new Set(
      rows
        .flatMap((row) => [
          preferredSignalOwnerId((row.evidenceMeta ?? {}) as EvidenceMeta, row.ownerObjectId),
          row.ownerObjectId,
        ])
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    )],
  );
  const knownOwnerIds = new Set(ownerContexts.keys());

  let processedExposeCount = 0;
  let createdEndpointCount = 0;

  for (const row of rows) {
    const ownerObjectId = row.ownerObjectId;
    if (!ownerObjectId) continue;

    const meta = (row.evidenceMeta ?? {}) as EvidenceMeta;
    const resolvedOwnerId = resolveExistingSignalOwnerId({
      metadata: meta,
      artifactOwnerObjectId: ownerObjectId,
      knownOwnerIds,
    });
    if (!resolvedOwnerId) continue;
    const ownerContext = ownerContexts.get(resolvedOwnerId);
    if (!ownerContext) continue;
    if (asString(meta['kind']) !== 'expose') continue;

    const serviceName = serviceNameById.get(ownerContext.serviceId);
    const path = (asString(meta['path']) ?? row.calleeSymbol).trim();
    if (!serviceName || !path.startsWith('/')) continue;

    processedExposeCount += 1;
    const method = (asString(meta['method']) ?? 'ANY').toUpperCase();
    const { isNew } = await upsertApiEndpoint(db, {
      workspaceId,
      serviceId: ownerContext.serviceId,
      serviceName,
      method,
      path,
      repoRoot,
      source: endpointSource,
    });
    if (isNew) createdEndpointCount += 1;
  }

  return {
    createdEndpointCount,
    processedExposeCount,
  };
}

export async function bootstrapApiEndpointsFromExposeSignals(
  db: DbClient,
  options: CodeExposeEndpointBootstrapOptions,
): Promise<CodeExposeEndpointBootstrapResult> {
  const result = await bootstrapApiEndpointsFromCodeSignals(db, options);

  return {
    edgeCount: result.processedExposeCount,
    exposeEdgeCount: result.processedExposeCount,
    createdEndpointCount: result.createdEndpointCount,
  };
}

type SharingModel = 'PRIVATE' | 'SHARED' | 'SUSPECTED_SHARED';
type DatabaseIdentitySource = 'explicit_relation' | 'candidate_relation' | 'canonical_key' | 'fallback';

function metadataRecord(value: unknown): Record<string, unknown> {
  return asRecord(value) ?? {};
}

function mergeObservedServiceIds(value: unknown, serviceId: string): string[] {
  const existing = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
  return [...new Set([...existing, serviceId])].sort();
}

function sharingModelForObservedServices(observedServiceIds: string[]): SharingModel {
  return observedServiceIds.length > 1 ? 'SHARED' : 'PRIVATE';
}

function canonicalizeJdbcUrl(value: string): string | null {
  const trimmed = value.trim();
  const match = trimmed.match(/^jdbc:([a-zA-Z0-9]+):\/\/([^/:?#]+)(?::(\d+))?\/?([^?#;]*)/);
  if (!match) return null;

  const dbType = (match[1] ?? 'unknown').toLowerCase();
  const host = (match[2] ?? 'localhost').toLowerCase();
  const port = match[3] ?? '';
  const dbName = (match[4] ?? '').split('/')[0]?.toLowerCase() ?? '';
  return [dbType, host, port, dbName].filter((part) => part.length > 0).join(':');
}

function extractDatabaseIdentity(
  meta: EvidenceMeta,
  serviceName: string,
): { databaseKey: string; source: DatabaseIdentitySource; schema: string | null } {
  const explicitKey = asString(meta['databaseKey']);
  if (explicitKey) {
    return { databaseKey: explicitKey.toLowerCase(), source: 'canonical_key', schema: null };
  }

  for (const key of ['datasourceUrl', 'jdbcUrl', 'dbUrl']) {
    const rawUrl = asString(meta[key]);
    if (!rawUrl) continue;
    const canonical = canonicalizeJdbcUrl(rawUrl);
    if (canonical) {
      return { databaseKey: canonical, source: 'canonical_key', schema: null };
    }
  }

  const schema = asString(meta['schema']) ?? asString(meta['catalog']);
  if (schema) {
    return {
      databaseKey: `schema:${schema.toLowerCase()}`,
      source: 'canonical_key',
      schema: schema.toLowerCase(),
    };
  }

  return { databaseKey: `${serviceName}:default`, source: 'fallback', schema: null };
}

function normalizeSqlTableIdentifier(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  // quoting/escaping 흔적을 최대한 제거하고 보수적으로 검증한다.
  const unquoted = trimmed.replace(/[`"'[\]]/g, '');
  const lower = unquoted.toLowerCase();

  // table 또는 schema.table 형태까지만 허용(Phase 1 보수적)
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/.test(lower)) return null;

  return lower;
}

function normalizeTableName(value: string, meta?: EvidenceMeta): string | null {
  const lower = normalizeSqlTableIdentifier(value);
  if (!lower) return null;

  const sqlTables = extractStringArray(meta?.['tables']);
  if (sqlTables.length > 0) {
    const normalizedTables = new Set(
      sqlTables
        .map((table) => normalizeSqlTableIdentifier(table))
        .filter((table): table is string => table !== null),
    );
    return normalizedTables.has(lower) ? lower : null;
  }

  const aliases = metadataRecord(meta?.['aliases']);
  if (Object.keys(aliases).some((alias) => alias.toLowerCase() === lower)) return null;

  return lower;
}

type DatabaseResolved = {
  id: string;
  urn: string;
  isNew: boolean;
  databaseKey: string;
  sharingModel: SharingModel;
  identitySource: DatabaseIdentitySource;
  dbTopologyConfidence: number;
};

async function upsertDatabaseByIdentity(
  db: DbClient,
  params: {
    workspaceId: string;
    serviceId: string;
    serviceName: string;
    repoRoot: string;
    databaseKey: string;
    schema: string | null;
  },
): Promise<DatabaseResolved> {
  const { workspaceId, serviceId, serviceName, repoRoot, databaseKey, schema } = params;
  const urn = buildUrn(workspaceId, 'storage', 'database', databaseKey);

  const existing = await db
    .select({ id: objects.id, metadata: objects.metadata })
    .from(objects)
    .where(and(eq(objects.workspaceId, workspaceId), eq(objects.urn, urn)))
    .limit(1);

  if (existing[0]) {
    const meta = metadataRecord(existing[0].metadata);
    const observedByServiceIds = mergeObservedServiceIds(meta['observedByServiceIds'], serviceId);
    const sharingModel = sharingModelForObservedServices(observedByServiceIds);
    await db
      .update(objects)
      .set({
        metadata: {
          ...meta,
          inferredFrom: meta['inferredFrom'] ?? 'CODE',
          repoRoot,
          databaseKey,
          ...(schema ? { schema } : {}),
          observedByServiceIds,
          sharingModel,
        },
        updatedAt: new Date(),
      })
      .where(eq(objects.id, existing[0].id));

    return {
      id: existing[0].id,
      urn,
      isNew: false,
      databaseKey,
      sharingModel,
      identitySource: 'canonical_key',
      dbTopologyConfidence: sharingModel === 'SHARED' ? 0.9 : 0.8,
    };
  }

  const id = generateId();
  await db.insert(objects).values({
    id,
    workspaceId,
    objectType: 'database',
    category: 'STORAGE',
    granularity: 'COMPOUND',
    urn,
    name: databaseKey === `${serviceName}:default` ? `${serviceName} DB` : databaseKey,
    displayName: databaseKey === `${serviceName}:default` ? `${serviceName} DB` : databaseKey,
    path: `/${id}`,
    depth: 0,
    visibility: 'VISIBLE',
    metadata: {
      inferredFrom: 'CODE',
      repoRoot,
      databaseKey,
      ...(schema ? { schema } : {}),
      observedByServiceIds: [serviceId],
      sharingModel: 'PRIVATE',
    },
  });

  return {
    id,
    urn,
    isNew: true,
    databaseKey,
    sharingModel: 'PRIVATE',
    identitySource: 'canonical_key',
    dbTopologyConfidence: 0.8,
  };
}

async function resolveDatabaseForService(
  db: DbClient,
  params: {
    workspaceId: string;
    serviceId: string;
    serviceName: string;
    repoRoot: string;
    metadata: EvidenceMeta;
  },
): Promise<DatabaseResolved> {
  const { workspaceId, serviceId, serviceName, repoRoot, metadata } = params;

  // 1) 실제 관계(object_relations)의 database를 우선 사용한다(결정론적으로 1개 선택).
  const relationDbRows = await db
    .select({ id: objects.id, urn: objects.urn, metadata: objects.metadata })
    .from(objectRelations)
    .innerJoin(objects, eq(objectRelations.objectId, objects.id))
    .where(
      and(
        eq(objectRelations.workspaceId, workspaceId),
        eq(objects.workspaceId, workspaceId),
        eq(objectRelations.subjectObjectId, serviceId),
        or(eq(objectRelations.relationType, 'read'), eq(objectRelations.relationType, 'write')),
        eq(objects.objectType, 'database'),
      ),
    );
  if (relationDbRows.length > 0) {
    const chosen = [...relationDbRows]
      .sort((a, b) => a.id.localeCompare(b.id))[0]!;
    const urn = chosen.urn && chosen.urn.length > 0 ? chosen.urn : `database:${chosen.id}`;
    const meta = metadataRecord(chosen.metadata);
    return {
      id: chosen.id,
      urn,
      isNew: false,
      databaseKey: asString(meta['databaseKey']) ?? urn,
      sharingModel: (asString(meta['sharingModel']) as SharingModel | null) ?? 'PRIVATE',
      identitySource: 'explicit_relation',
      dbTopologyConfidence: 0.95,
    };
  }

  // 2) 후보(relation_candidates) 기반으로 database를 선택한다(confidence 우선, tie-break는 objectId).
  const candDbRows = await db
    .select({
      id: objects.id,
      urn: objects.urn,
      metadata: objects.metadata,
      confidence: relationCandidates.confidence,
    })
    .from(relationCandidates)
    .innerJoin(objects, eq(relationCandidates.objectId, objects.id))
    .where(
      and(
        eq(relationCandidates.workspaceId, workspaceId),
        eq(objects.workspaceId, workspaceId),
        eq(relationCandidates.subjectObjectId, serviceId),
        or(eq(relationCandidates.relationType, 'read'), eq(relationCandidates.relationType, 'write')),
        or(eq(relationCandidates.status, 'APPROVED'), eq(relationCandidates.status, 'PENDING')),
        eq(objects.objectType, 'database'),
      ),
    );
  if (candDbRows.length > 0) {
    const chosen = [...candDbRows].sort((a, b) => {
      const ca = a.confidence ?? 0;
      const cb = b.confidence ?? 0;
      if (ca !== cb) return cb - ca; // 높은 confidence 우선
      return a.id.localeCompare(b.id);
    })[0]!;
    const urn = chosen.urn && chosen.urn.length > 0 ? chosen.urn : `database:${chosen.id}`;
    const meta = metadataRecord(chosen.metadata);
    return {
      id: chosen.id,
      urn,
      isNew: false,
      databaseKey: asString(meta['databaseKey']) ?? urn,
      sharingModel: (asString(meta['sharingModel']) as SharingModel | null) ?? 'PRIVATE',
      identitySource: 'candidate_relation',
      dbTopologyConfidence: clamp01((chosen.confidence ?? 0.8) + 0.05),
    };
  }

  // 3) code signal metadata의 datasource/JDBC/schema canonical key를 사용한다.
  const identity = extractDatabaseIdentity(metadata, serviceName);
  const resolved = await upsertDatabaseByIdentity(db, {
    workspaceId,
    serviceId,
    serviceName,
    repoRoot,
    databaseKey: identity.databaseKey,
    schema: identity.schema,
  });
  return {
    ...resolved,
    identitySource: identity.source,
    dbTopologyConfidence: identity.source === 'fallback' ? 0.65 : resolved.dbTopologyConfidence,
  };
}

async function upsertDbTable(
  db: DbClient,
  params: {
    workspaceId: string;
    databaseId: string;
    databaseUrn: string;
    normalizedTableName: string;
    serviceId: string;
    databaseKey: string;
    sharingModel: SharingModel;
  },
): Promise<{ id: string; isNew: boolean }> {
  const {
    workspaceId,
    databaseId,
    databaseUrn,
    normalizedTableName,
    serviceId,
    databaseKey,
    sharingModel,
  } = params;
  const urn = buildUrn(
    workspaceId,
    'storage',
    'db_table',
    `${databaseUrn}:${normalizedTableName}`,
  );

  const existingByUrn = await db
    .select({ id: objects.id, metadata: objects.metadata })
    .from(objects)
    .where(and(eq(objects.workspaceId, workspaceId), eq(objects.urn, urn)))
    .limit(1);
  if (existingByUrn[0]) {
    const meta = metadataRecord(existingByUrn[0].metadata);
    const observedByServiceIds = mergeObservedServiceIds(meta['observedByServiceIds'], serviceId);
    await db
      .update(objects)
      .set({
        metadata: {
          ...meta,
          source: meta['source'] ?? 'CODE',
          databaseKey,
          sharingModel: sharingModelForObservedServices(observedByServiceIds) === 'SHARED'
            ? 'SHARED'
            : sharingModel,
          table: normalizedTableName.split('.').pop() ?? normalizedTableName,
          ...(normalizedTableName.includes('.') ? { schema: normalizedTableName.split('.')[0] } : {}),
          observedByServiceIds,
        },
        updatedAt: new Date(),
      })
      .where(eq(objects.id, existingByUrn[0].id));
    return { id: existingByUrn[0].id, isNew: false };
  }

  // legacy/seed 등 urn 없는 데이터와의 중복을 줄이기 위해 parentId+name도 확인
  const existingByName = await db
    .select({ id: objects.id, metadata: objects.metadata })
    .from(objects)
    .where(
      and(
        eq(objects.workspaceId, workspaceId),
        eq(objects.objectType, 'db_table'),
        eq(objects.parentId, databaseId),
        eq(objects.name, normalizedTableName),
      ),
    )
    .limit(1);
  if (existingByName[0]) {
    const meta = metadataRecord(existingByName[0].metadata);
    const observedByServiceIds = mergeObservedServiceIds(meta['observedByServiceIds'], serviceId);
    await db
      .update(objects)
      .set({
        metadata: {
          ...meta,
          source: meta['source'] ?? 'CODE',
          databaseKey,
          sharingModel: sharingModelForObservedServices(observedByServiceIds) === 'SHARED'
            ? 'SHARED'
            : sharingModel,
          table: normalizedTableName.split('.').pop() ?? normalizedTableName,
          ...(normalizedTableName.includes('.') ? { schema: normalizedTableName.split('.')[0] } : {}),
          observedByServiceIds,
        },
        updatedAt: new Date(),
      })
      .where(eq(objects.id, existingByName[0].id));
    return { id: existingByName[0].id, isNew: false };
  }

  const id = generateId();
  await db.insert(objects).values({
    id,
    workspaceId,
    objectType: 'db_table',
    category: 'STORAGE',
    granularity: 'ATOMIC',
    urn,
    name: normalizedTableName,
    displayName: normalizedTableName,
    parentId: databaseId,
    path: `/${id}`,
    depth: 1,
    visibility: 'VISIBLE',
    metadata: {
      source: 'CODE',
      databaseKey,
      sharingModel,
      table: normalizedTableName.split('.').pop() ?? normalizedTableName,
      ...(normalizedTableName.includes('.') ? { schema: normalizedTableName.split('.')[0] } : {}),
      observedByServiceIds: [serviceId],
    },
  });

  return { id, isNew: true };
}

type DbTableNameParts = {
  schema: string | null;
  table: string;
};

function parseDbTableNameParts(name: string, metadata?: unknown): DbTableNameParts | null {
  const meta = metadataRecord(metadata);
  const explicitTable = asString(meta['table']);
  const explicitSchema = asString(meta['schema']);
  if (explicitTable) {
    return {
      schema: explicitSchema ? explicitSchema.toLowerCase() : null,
      table: explicitTable.toLowerCase(),
    };
  }

  const normalized = normalizeTableName(name);
  if (!normalized) return null;
  const parts = normalized.split('.');
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { schema: parts[0], table: parts[1] };
  }
  if (parts.length === 1 && parts[0]) {
    return { schema: null, table: parts[0] };
  }
  return null;
}

async function hasRejectedSameDbTableCandidate(
  db: DbClient,
  workspaceId: string,
  sourceObjectId: string,
  targetObjectId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: relationCandidates.id })
    .from(relationCandidates)
    .where(
      and(
        eq(relationCandidates.workspaceId, workspaceId),
        eq(relationCandidates.relationType, 'same_db_table'),
        eq(relationCandidates.subjectObjectId, sourceObjectId),
        eq(relationCandidates.objectId, targetObjectId),
        eq(relationCandidates.status, 'REJECTED'),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function createImplicitSchemaTableCandidates(
  db: DbClient,
  params: {
    workspaceId: string;
    databaseId: string;
    databaseKey: string;
    tableId: string;
    normalizedTableName: string;
    repoRoot: string;
  },
): Promise<number> {
  const {
    workspaceId,
    databaseId,
    databaseKey,
    tableId,
    normalizedTableName,
    repoRoot,
  } = params;
  const currentParts = parseDbTableNameParts(normalizedTableName);
  if (!currentParts) return 0;

  const tableRows = await db
    .select({
      id: objects.id,
      name: objects.name,
      metadata: objects.metadata,
    })
    .from(objects)
    .where(
      and(
        eq(objects.workspaceId, workspaceId),
        eq(objects.objectType, 'db_table'),
        eq(objects.parentId, databaseId),
      ),
    );

  const siblings = tableRows
    .map((row) => ({
      ...row,
      parts: parseDbTableNameParts(row.name, row.metadata),
    }))
    .filter((row): row is typeof row & { parts: DbTableNameParts } => row.parts !== null)
    .filter((row) => row.parts.table === currentParts.table);
  const unqualified = siblings.find((row) => row.parts.schema === null);
  const qualified = siblings
    .filter((row) => row.parts.schema !== null)
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!unqualified || qualified.length === 0) return 0;
  if (!siblings.some((row) => row.id === tableId)) return 0;

  const confidence = qualified.length === 1 ? 0.65 : 0.4;
  let createdCount = 0;

  for (const target of qualified) {
    if (target.id === unqualified.id) continue;
    if (await hasRejectedSameDbTableCandidate(db, workspaceId, unqualified.id, target.id)) {
      continue;
    }

    const saved = await saveRelationCandidateWithLazyEvidence(
      db,
      {
        workspaceId,
        relationType: 'same_db_table',
        subjectObjectId: unqualified.id,
        objectId: target.id,
        confidence,
        metadata: {
          source: 'CODE',
          kind: 'same_db_table',
          reason: 'implicit_schema_match',
          databaseKey,
          table: currentParts.table,
          unqualifiedName: unqualified.name,
          qualifiedSchema: target.parts.schema,
          qualifiedName: target.name,
          sourceTableObjectId: unqualified.id,
          targetTableObjectId: target.id,
          mergeMode: 'hard_merge_available',
          repoRoot,
          ...(qualified.length > 1
            ? { ambiguity: 'multiple_schema_candidates', candidateTargetCount: qualified.length }
            : {}),
        },
      },
      async () => {
        const evidenceId = generateId();
        await db.insert(evidences).values({
          id: evidenceId,
          workspaceId,
          evidenceType: 'SCHEMA',
          excerpt: `implicit schema table candidate: ${unqualified.name} -> ${target.name}`,
          metadata: {
            source: 'CODE',
            reason: 'implicit_schema_match',
            databaseKey,
            table: currentParts.table,
            unqualifiedName: unqualified.name,
            qualifiedName: target.name,
            qualifiedSchema: target.parts.schema,
            repoRoot,
          },
        });
        return evidenceId;
      },
    );
    if (saved.created) createdCount += 1;
  }

  if (qualified.length > 1) {
    for (const target of qualified) {
      const [pending] = await db
        .select({
          id: relationCandidates.id,
          metadata: relationCandidates.metadata,
        })
        .from(relationCandidates)
        .where(
          and(
            eq(relationCandidates.workspaceId, workspaceId),
            eq(relationCandidates.relationType, 'same_db_table'),
            eq(relationCandidates.subjectObjectId, unqualified.id),
            eq(relationCandidates.objectId, target.id),
            eq(relationCandidates.status, 'PENDING'),
          ),
        )
        .limit(1);
      if (!pending) continue;
      await db
        .update(relationCandidates)
        .set({
          confidence: 0.4,
          metadata: {
            ...(metadataRecord(pending.metadata)),
            ambiguity: 'multiple_schema_candidates',
            candidateTargetCount: qualified.length,
          },
        })
        .where(eq(relationCandidates.id, pending.id));
    }
  }

  return createdCount;
}

async function markSuspectedSharedTables(
  db: DbClient,
  workspaceId: string,
  normalizedTableName: string,
): Promise<number> {
  const tableRows = await db
    .select({ id: objects.id, metadata: objects.metadata })
    .from(objects)
    .where(
      and(
        eq(objects.workspaceId, workspaceId),
        eq(objects.objectType, 'db_table'),
        eq(objects.name, normalizedTableName),
      ),
    );

  const fallbackTableRows = tableRows.filter((row) => {
    const meta = metadataRecord(row.metadata);
    const databaseKey = asString(meta['databaseKey']);
    return databaseKey?.endsWith(':default') === true;
  });

  if (fallbackTableRows.length < 2) return 0;

  for (const row of fallbackTableRows) {
    const meta = metadataRecord(row.metadata);
    if (meta['sharingModel'] === 'SHARED') continue;
    await db
      .update(objects)
      .set({
        metadata: {
          ...meta,
          sharingModel: 'SUSPECTED_SHARED',
        },
        updatedAt: new Date(),
      })
      .where(eq(objects.id, row.id));
    await markDbTableCandidatesTopology(db, workspaceId, row.id, {
      sharingModel: 'SUSPECTED_SHARED',
      dbTopologyConfidence: 0.55,
    });
  }

  return fallbackTableRows.length;
}

async function markDbTableCandidatesTopology(
  db: DbClient,
  workspaceId: string,
  tableId: string,
  params: {
    sharingModel: SharingModel;
    dbTopologyConfidence: number;
    databaseKey?: string;
  },
) {
  const rows = await db
    .select({
      id: relationCandidates.id,
      relationType: relationCandidates.relationType,
      metadata: relationCandidates.metadata,
    })
    .from(relationCandidates)
    .where(
      and(
        eq(relationCandidates.workspaceId, workspaceId),
        eq(relationCandidates.objectId, tableId),
      ),
    );

  for (const row of rows) {
    const meta = metadataRecord(row.metadata);
    const kind = asString(meta['kind']);
    const isReader = kind === 'db_read' || row.relationType === 'read';
    await db
      .update(relationCandidates)
      .set({
        metadata: {
          ...meta,
          ...(params.databaseKey ? { databaseKey: params.databaseKey } : {}),
          sharingModel: params.sharingModel,
          dbTopologyConfidence: params.dbTopologyConfidence,
          ...(isReader ? { dbAccessRole: 'shared_user' } : {}),
        },
      })
      .where(eq(relationCandidates.id, row.id));
  }
}

export async function inferRelationsFromCodeSignals(
  db: DbClient,
  options: CodeCandidateInferenceOptions,
): Promise<CodeCandidateInferenceResult> {
  const { workspaceId, repoRoot } = options;
  const candidateGenerationMode = options.candidateGenerationMode;
  const enableDbScan = options.enableDbScan !== false;
  const serviceIds = Array.from(
    new Set((options.serviceIds ?? []).filter((value): value is string => value.length > 0)),
  );
  const bootstrapOnly = options.bootstrapOnly === true;

  const allServices = await db
    .select({ id: objects.id, name: objects.name })
    .from(objects)
    .where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectType, 'service')));

  const serviceNameById = new Map(allServices.map((svc) => [svc.id, svc.name] as const));

  const bootstrapResult = await bootstrapApiEndpointsFromCodeSignals(db, {
    workspaceId,
    repoRoot,
  });

  const existingEndpoints = await db
    .select({
      id: objects.id,
      parentId: objects.parentId,
      name: objects.name,
      displayName: objects.displayName,
      metadata: objects.metadata,
    })
    .from(objects)
    .where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectType, 'api_endpoint')));

  const endpointByServiceAndPath = new Map<string, string>();
  const endpointPathCollision = new Set<string>();
  const noteEndpoint = (serviceId: string, endpointPath: string, endpointId: string) => {
    const key = `${serviceId}|${endpointPath}`;
    const existing = endpointByServiceAndPath.get(key);
    if (!existing) {
      endpointByServiceAndPath.set(key, endpointId);
      return;
    }
    if (existing !== endpointId) {
      endpointByServiceAndPath.delete(key);
      endpointPathCollision.add(key);
    }
  };

  for (const endpoint of existingEndpoints) {
    if (!endpoint.parentId) continue;
    const meta = (endpoint.metadata ?? {}) as Record<string, unknown>;
    const metaPath = asString(meta['path']);
    const parsed = metaPath
      ? { method: asString(meta['method']) ?? 'ANY', path: metaPath }
      : parseEndpointDisplay(endpoint.displayName ?? endpoint.name);
    if (!parsed) continue;
    noteEndpoint(endpoint.parentId, parsed.path, endpoint.id);
  }

  const rows = await db
    .select({
      callerOwnerObjectId: codeArtifacts.ownerObjectId,
      calleeSymbol: codeCallEdges.calleeSymbol,
      evidenceId: codeCallEdges.evidenceId,
      evidenceMeta: evidences.metadata,
    })
    .from(codeCallEdges)
    .innerJoin(codeArtifacts, eq(codeCallEdges.callerArtifactId, codeArtifacts.id))
    .leftJoin(evidences, eq(codeCallEdges.evidenceId, evidences.id))
    .where(
      and(
        eq(codeCallEdges.workspaceId, workspaceId),
        eq(codeArtifacts.workspaceId, workspaceId),
        eq(codeArtifacts.repoRoot, repoRoot),
      ),
    );
  const ownerContexts = await loadOwnerContexts(
    db,
    workspaceId,
    [...new Set(
      rows
        .flatMap((row) => [
          preferredSignalOwnerId((row.evidenceMeta ?? {}) as EvidenceMeta, row.callerOwnerObjectId),
          row.callerOwnerObjectId,
        ])
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    )],
  );
  const knownOwnerIds = new Set(ownerContexts.keys());

  let processedEdgeCount = 0;
  let skippedEdgeCount = 0;
  let candidateCount = 0;
  let createdTopicCount = 0;
  let createdQueueCount = 0;
  let createdDatabaseCount = 0;
  let createdDbTableCount = 0;
  let sqlParseFallbackCount = 0;
  let suspectedSharedDatabaseCount = 0;
  let sharedDbTableCount = 0;
  let implicitSchemaTableCandidateCount = 0;
  const createdEndpointCount = bootstrapResult.createdEndpointCount;

  const databaseCache = new Map<string, DatabaseResolved>();

  if (bootstrapOnly) {
    return {
      edgeCount: rows.length,
      processedEdgeCount: bootstrapResult.processedExposeCount,
      skippedEdgeCount: Math.max(rows.length - bootstrapResult.processedExposeCount, 0),
      candidateCount: 0,
      createdTopicCount: 0,
      createdQueueCount: 0,
      createdDatabaseCount: 0,
      createdDbTableCount: 0,
      createdEndpointCount,
      sqlParseFallbackCount: 0,
      suspectedSharedDatabaseCount: 0,
      sharedDbTableCount: 0,
      implicitSchemaTableCandidateCount: 0,
    };
  }

  for (const row of rows) {
    const callerOwnerObjectId = row.callerOwnerObjectId;
    const evidenceId = row.evidenceId;
    if (!callerOwnerObjectId || !evidenceId) {
      skippedEdgeCount += 1;
      continue;
    }

    const meta = (row.evidenceMeta ?? {}) as EvidenceMeta;
    const resolvedOwnerId = resolveExistingSignalOwnerId({
      metadata: meta,
      artifactOwnerObjectId: callerOwnerObjectId,
      knownOwnerIds,
    });
    if (!resolvedOwnerId) {
      skippedEdgeCount += 1;
      continue;
    }
    const ownerContext = ownerContexts.get(resolvedOwnerId);
    if (!ownerContext) {
      skippedEdgeCount += 1;
      continue;
    }
    if (serviceIds.length > 0 && !serviceIds.includes(ownerContext.serviceId)) {
      skippedEdgeCount += 1;
      continue;
    }
    const kind = asString(meta['kind']);
    if (!kind) {
      skippedEdgeCount += 1;
      continue;
    }

    // expose는 후보에서 제외 (실제 의존성으로 오인 가능)
    if (kind === 'expose') {
      skippedEdgeCount += 1;
      continue;
    }

    const confidence = clamp01(asNumber(meta['confidence']) ?? 0.7);
    const calleeSymbol = row.calleeSymbol;
    const specializationMetadata = extractCodeSpecializationMetadata(meta);

    if (kind === 'call') {
      const resolved = resolveHttpCallCandidate(
        calleeSymbol,
        meta,
        allServices,
        endpointByServiceAndPath,
        endpointPathCollision,
      );

      if (!resolved.targetServiceId || !resolved.targetPath || !resolved.targetEndpointId) {
        skippedEdgeCount += 1;
        continue;
      }

      processedEdgeCount += 1;
      const saved = await saveRelationCandidate(
        db,
        {
          workspaceId,
          relationType: 'call',
          subjectObjectId: ownerContext.serviceId,
          objectId: resolved.targetEndpointId,
          confidence,
          metadata: {
            ...specializationMetadata,
            source: 'CODE',
            kind,
            calleeSymbol,
            repoRoot,
            targetType: 'api_endpoint',
            targetServiceId: resolved.targetServiceId,
            targetPath: resolved.targetPath,
            hostHint: resolved.hostHint,
            hostHints: resolved.hostHints,
            pathHint: resolved.pathHint,
            pathHints: resolved.pathHints,
            configKeys: resolved.configKeys,
            dynamicHost: resolved.dynamicHost,
            dynamicPath: resolved.dynamicPath,
            resolvedVia: resolved.resolvedVia,
          },
          ...(candidateGenerationMode ? { generationMode: candidateGenerationMode } : {}),
        },
        evidenceId,
      );
      if (saved.created) candidateCount += 1;
      continue;
    }

    if (kind === 'produce' || kind === 'consume') {
      const channelName = calleeSymbol.trim();
      if (channelName.length === 0) {
        skippedEdgeCount += 1;
        continue;
      }

      const channelType = asString(meta['channelType']) ?? 'topic';
      const isQueue = channelType === 'queue';
      const upserted = isQueue
        ? await upsertQueue(db, workspaceId, channelName)
        : await upsertTopic(db, workspaceId, channelName);
      if (upserted.isNew) {
        if (isQueue) createdQueueCount += 1;
        else createdTopicCount += 1;
      }

      processedEdgeCount += 1;
      const saved = await saveRelationCandidate(
        db,
        {
          workspaceId,
          relationType: kind,
          subjectObjectId: ownerContext.serviceId,
          objectId: upserted.id,
          confidence,
          metadata: {
            ...specializationMetadata,
            source: 'CODE',
            kind,
            channelType: isQueue ? 'queue' : 'topic',
            broker: asString(meta['broker']) ?? null,
            channel: channelName,
            repoRoot,
          },
          ...(candidateGenerationMode ? { generationMode: candidateGenerationMode } : {}),
        },
        evidenceId,
      );
      if (saved.created) candidateCount += 1;
      continue;
    }

    if (kind === 'db_mapping' || kind === 'db_read' || kind === 'db_write') {
      if (!enableDbScan) {
        skippedEdgeCount += 1;
        continue;
      }

      const serviceName = serviceNameById.get(ownerContext.serviceId);
      if (!serviceName) {
        skippedEdgeCount += 1;
        continue;
      }

      if (asString(meta['parser']) === 'fallback_regex') sqlParseFallbackCount += 1;

      const normalized = normalizeTableName(calleeSymbol, meta);
      if (!normalized) {
        skippedEdgeCount += 1;
        continue;
      }

      const databaseIdentity = extractDatabaseIdentity(meta, serviceName);
      const databaseCacheKey = `${ownerContext.serviceId}::${databaseIdentity.databaseKey}`;
      const cached = databaseCache.get(databaseCacheKey);
      const database =
        cached ??
        (await resolveDatabaseForService(db, {
          workspaceId,
          serviceId: ownerContext.serviceId,
          serviceName,
          repoRoot,
          metadata: meta,
        }));
      databaseCache.set(databaseCacheKey, database);
      if (database.isNew) createdDatabaseCount += 1;

      const { id: tableId, isNew } = await upsertDbTable(db, {
        workspaceId,
        databaseId: database.id,
        databaseUrn: database.urn,
        normalizedTableName: normalized,
        serviceId: ownerContext.serviceId,
        databaseKey: database.databaseKey,
        sharingModel: database.sharingModel,
      });
      if (isNew) createdDbTableCount += 1;
      const implicitSchemaCandidates = await createImplicitSchemaTableCandidates(db, {
        workspaceId,
        databaseId: database.id,
        databaseKey: database.databaseKey,
        tableId,
        normalizedTableName: normalized,
        repoRoot,
      });
      if (implicitSchemaCandidates > 0) {
        candidateCount += implicitSchemaCandidates;
        implicitSchemaTableCandidateCount += implicitSchemaCandidates;
      }
      let effectiveSharingModel = database.sharingModel;
      let effectiveTopologyConfidence = database.dbTopologyConfidence;
      if (database.sharingModel === 'SHARED') sharedDbTableCount += 1;
      if (database.identitySource === 'fallback') {
        const marked = await markSuspectedSharedTables(db, workspaceId, normalized);
        if (marked > 0) {
          suspectedSharedDatabaseCount += 1;
          effectiveSharingModel = 'SUSPECTED_SHARED';
          effectiveTopologyConfidence = 0.55;
        }
      }

      // db_mapping은 “존재/매핑” 신호이므로 후보 생성은 하지 않는다.
      if (kind === 'db_mapping') {
        processedEdgeCount += 1;
        continue;
      }

      const relationType = kind === 'db_read' ? 'read' : 'write';
      const dbAccessRole = kind === 'db_write'
        ? 'owner_candidate'
        : effectiveSharingModel === 'SHARED' || effectiveSharingModel === 'SUSPECTED_SHARED'
          ? 'shared_user'
          : 'reader';
      processedEdgeCount += 1;
      const saved = await saveRelationCandidate(
        db,
        {
          workspaceId,
          relationType,
          subjectObjectId: ownerContext.serviceId,
          objectId: tableId,
          confidence,
          metadata: {
            ...specializationMetadata,
            source: 'CODE',
            kind,
            table: normalized,
            repoRoot,
            dbAccessRole,
            dbTopologyConfidence: effectiveTopologyConfidence,
            databaseKey: database.databaseKey,
            sharingModel: effectiveSharingModel,
          },
          ...(candidateGenerationMode ? { generationMode: candidateGenerationMode } : {}),
        },
        evidenceId,
      );
      if (saved.created) candidateCount += 1;
      if (effectiveSharingModel === 'SHARED' || effectiveSharingModel === 'SUSPECTED_SHARED') {
        await markDbTableCandidatesTopology(db, workspaceId, tableId, {
          sharingModel: effectiveSharingModel,
          dbTopologyConfidence: effectiveTopologyConfidence,
          databaseKey: database.databaseKey,
        });
      }
      continue;
    }

    skippedEdgeCount += 1;
  }

  return {
    edgeCount: rows.length,
    processedEdgeCount,
    skippedEdgeCount,
    candidateCount,
    createdTopicCount,
    createdQueueCount,
    createdDatabaseCount,
    createdDbTableCount,
    createdEndpointCount,
    sqlParseFallbackCount,
    suspectedSharedDatabaseCount,
    sharedDbTableCount,
    implicitSchemaTableCandidateCount,
  };
}
