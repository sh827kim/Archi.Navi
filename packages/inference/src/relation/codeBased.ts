/**
 * Code Signal 기반 Relation 후보 추론
 *
 * 목표:
 * - code_call_edges(+evidences.metadata.kind/confidence)를 기반으로 relation_candidates를 생성한다.
 * - config 기반 추론이 불가능한 환경에서도(code-only) 후보가 생성되도록 한다.
 *
 * 주의:
 * - expose 신호는 실제 의존성으로 오인 가능성이 높아 후보 생성에서 제외한다.
 * - 경로만 있는 호출(/api/...)은 타겟 서비스를 식별하기 어려워 기본적으로 스킵한다.
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
import { saveRelationCandidate } from './candidateStore';
import { asRecord } from './utils';
import { preferredSignalOwnerId, resolveExistingSignalOwnerId } from '../code/ownerResolution';

export interface CodeCandidateInferenceOptions {
  workspaceId: string;
  repoRoot: string;
  serviceIds?: string[];
  bootstrapOnly?: boolean;
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

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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

function normalizeTableName(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  // quoting/escaping 흔적을 최대한 제거하고 보수적으로 검증한다.
  const unquoted = trimmed.replace(/[`"'[\]]/g, '');
  const lower = unquoted.toLowerCase();

  // table 또는 schema.table 형태까지만 허용(Phase 1 보수적)
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/.test(lower)) return null;
  return lower;
}

type DatabaseResolved = { id: string; urn: string; isNew: boolean };

async function resolveDatabaseForService(
  db: DbClient,
  params: {
    workspaceId: string;
    serviceId: string;
    serviceName: string;
    repoRoot: string;
  },
): Promise<DatabaseResolved> {
  const { workspaceId, serviceId, serviceName, repoRoot } = params;

  // 1) 실제 관계(object_relations)의 database를 우선 사용한다(결정론적으로 1개 선택).
  const relationDbRows = await db
    .select({ id: objects.id, urn: objects.urn })
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
    return { id: chosen.id, urn, isNew: false };
  }

  // 2) 후보(relation_candidates) 기반으로 database를 선택한다(confidence 우선, tie-break는 objectId).
  const candDbRows = await db
    .select({
      id: objects.id,
      urn: objects.urn,
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
    return { id: chosen.id, urn, isNew: false };
  }

  // 3) code-only fallback: 서비스 단위 기본 database를 생성한다(결정론적 URN).
  const databaseKey = `${serviceName}:default`;
  const urn = buildUrn(workspaceId, 'storage', 'database', databaseKey);

  const existing = await db
    .select({ id: objects.id })
    .from(objects)
    .where(and(eq(objects.workspaceId, workspaceId), eq(objects.urn, urn)))
    .limit(1);
  if (existing[0]) return { id: existing[0].id, urn, isNew: false };

  const id = generateId();
  await db.insert(objects).values({
    id,
    workspaceId,
    objectType: 'database',
    category: 'STORAGE',
    granularity: 'COMPOUND',
    urn,
    name: `${serviceName} DB`,
    displayName: `${serviceName} DB`,
    path: `/${id}`,
    depth: 0,
    visibility: 'VISIBLE',
    metadata: { inferredFrom: 'CODE', repoRoot, databaseKey },
  });

  return { id, urn, isNew: true };
}

async function upsertDbTable(
  db: DbClient,
  params: {
    workspaceId: string;
    databaseId: string;
    databaseUrn: string;
    normalizedTableName: string;
  },
): Promise<{ id: string; isNew: boolean }> {
  const { workspaceId, databaseId, databaseUrn, normalizedTableName } = params;
  const urn = buildUrn(
    workspaceId,
    'storage',
    'db_table',
    `${databaseUrn}:${normalizedTableName}`,
  );

  const existingByUrn = await db
    .select({ id: objects.id })
    .from(objects)
    .where(and(eq(objects.workspaceId, workspaceId), eq(objects.urn, urn)))
    .limit(1);
  if (existingByUrn[0]) return { id: existingByUrn[0].id, isNew: false };

  // legacy/seed 등 urn 없는 데이터와의 중복을 줄이기 위해 parentId+name도 확인
  const existingByName = await db
    .select({ id: objects.id })
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
  if (existingByName[0]) return { id: existingByName[0].id, isNew: false };

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
    metadata: { source: 'CODE' },
  });

  return { id, isNew: true };
}

export async function inferRelationsFromCodeSignals(
  db: DbClient,
  options: CodeCandidateInferenceOptions,
): Promise<CodeCandidateInferenceResult> {
  const { workspaceId, repoRoot } = options;
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
      // path-only(/api/...) 호출은 타겟 서비스를 알 수 없어 스킵
      const trimmed = calleeSymbol.trim();

      const serviceCandidates = extractServiceCandidatesFromSymbol(trimmed);
      let targetServiceId: string | null = null;
      for (const candidate of serviceCandidates) {
        targetServiceId = findServiceIdByName(candidate, allServices);
        if (targetServiceId) break;
      }

      if (!targetServiceId) {
        skippedEdgeCount += 1;
        continue;
      }

      const targetPath = extractPathFromUrlLike(trimmed);
      if (!targetPath) {
        skippedEdgeCount += 1;
        continue;
      }

      const endpointKey = `${targetServiceId}|${targetPath}`;
      if (endpointPathCollision.has(endpointKey)) {
        skippedEdgeCount += 1;
        continue;
      }

      const endpointId = endpointByServiceAndPath.get(endpointKey);
      if (!endpointId) {
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
          objectId: endpointId,
          confidence,
          metadata: {
            ...specializationMetadata,
            source: 'CODE',
            kind,
            calleeSymbol,
            repoRoot,
            targetType: 'api_endpoint',
            targetServiceId,
            path: targetPath,
          },
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
        },
        evidenceId,
      );
      if (saved.created) candidateCount += 1;
      continue;
    }

    if (kind === 'db_mapping' || kind === 'db_read' || kind === 'db_write') {
      const serviceName = serviceNameById.get(ownerContext.serviceId);
      if (!serviceName) {
        skippedEdgeCount += 1;
        continue;
      }

      const normalized = normalizeTableName(calleeSymbol);
      if (!normalized) {
        skippedEdgeCount += 1;
        continue;
      }

      const cached = databaseCache.get(ownerContext.serviceId);
      const database =
        cached ??
        (await resolveDatabaseForService(db, {
          workspaceId,
          serviceId: ownerContext.serviceId,
          serviceName,
          repoRoot,
        }));
      databaseCache.set(ownerContext.serviceId, database);
      if (database.isNew) createdDatabaseCount += 1;

      const { id: tableId, isNew } = await upsertDbTable(db, {
        workspaceId,
        databaseId: database.id,
        databaseUrn: database.urn,
        normalizedTableName: normalized,
      });
      if (isNew) createdDbTableCount += 1;

      // db_mapping은 “존재/매핑” 신호이므로 후보 생성은 하지 않는다.
      if (kind === 'db_mapping') {
        processedEdgeCount += 1;
        continue;
      }

      const relationType = kind === 'db_read' ? 'read' : 'write';
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
          },
        },
        evidenceId,
      );
      if (saved.created) candidateCount += 1;
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
  };
}
