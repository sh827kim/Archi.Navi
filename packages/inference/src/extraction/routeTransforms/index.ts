import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import { objects, routeTransforms } from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import { parseApplicationYml } from '@/relation/parsers/applicationYml';
import { findFiles } from '@/utils/fileDiscovery';
import { normalizeOptionalUuid, stableHash } from '../shared';

export interface GatewayRouteTransformCandidate {
  routeKey: string;
  gatewayKind: string;
  matchPath?: string;
  path?: string;
  matchMode?: 'exact' | 'prefix' | 'regex' | null;
  serviceId?: string | null;
  targetServiceHint?: string | null;
  url?: string | null;
  stripPrefix?: boolean | null;
  stripPrefixCount?: number | null;
  prefix?: string | null;
  prependPrefix?: string | null;
  host?: string | null;
  matchHost?: string | null;
  rewriteRegex: string | null;
  rewriteReplacement: string | null;
  pathCapturePolicy?: string | null;
  routeMountPrefix?: string | null;
  targetHostAlias?: string | null;
  targetPathBaseHint?: string | null;
  priority?: number | null;
  evidenceIds?: string[];
}

export interface GatewayRouteTransformPluginResult {
  ownerServiceName: string | null;
  routes: GatewayRouteTransformCandidate[];
}

export interface GatewayRouteTransformPlugin {
  id: string;
  displayName: string;
  supportsFile?(input: {
    filePath: string;
    repoRoot: string;
  }): boolean;
  extract(input: {
    filePath: string;
    repoRoot: string;
    content: string;
  }): GatewayRouteTransformPluginResult | null;
}

export interface ExtractRouteTransformsOptions {
  workspaceId: string;
  repoRoot: string;
  runId?: string | null | undefined;
  plugins?: GatewayRouteTransformPlugin[];
}

export interface ExtractRouteTransformsResult {
  routeTransformCount: number;
  deletedRouteTransformCount: number;
  deletedOwnerServiceIds: string[];
  fileCount: number;
  processedFileCount: number;
  skippedFileCount: number;
}

function inferStripPrefixCount(matchPath: string): number | null {
  const segments = matchPath
    .trim()
    .split('/')
    .filter((segment) => segment.length > 0);
  const fixedSegments = segments.filter((segment) => !segment.includes('*')).length;
  const stripPrefixCount = Math.max(fixedSegments - 1, 0);
  return stripPrefixCount > 0 ? stripPrefixCount : null;
}

function normalizePathPrefix(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function extractTargetHostAlias(urlValue: string | null): string | null {
  if (!urlValue) return null;
  try {
    return new URL(urlValue).host;
  } catch {
    return null;
  }
}

function buildConfigEvidenceId(repoRoot: string, filePath: string, routeKey: string): string {
  const relativePath = relative(repoRoot, filePath).trim();
  return `config:${relativePath.length > 0 ? relativePath : filePath}#${routeKey}`;
}

function buildConfigRepoEvidenceId(repoRoot: string): string {
  return `config_repo:${stableHash([repoRoot])}`;
}

function isDefaultGatewayRouteConfigFile(filePath: string): boolean {
  const base = filePath.split('/').pop() ?? '';
  return (
    (base.startsWith('application') || base.startsWith('bootstrap'))
    && (base.endsWith('.yml') || base.endsWith('.yaml'))
  );
}

function parseScgTargetServiceHint(uri: string | null): string | null {
  if (!uri || !uri.startsWith('lb://')) return null;
  const withoutScheme = uri.slice('lb://'.length);
  const serviceName = withoutScheme.split('/')[0]?.trim() ?? null;
  return serviceName && serviceName.length > 0 ? serviceName : null;
}

function findGatewayRouteCandidateFiles(
  repoRoot: string,
  plugins: GatewayRouteTransformPlugin[],
): string[] {
  return findFiles(repoRoot, (filePath) =>
    plugins.some((plugin) => {
      if (plugin.supportsFile) {
        return plugin.supportsFile({ filePath, repoRoot });
      }
      return isDefaultGatewayRouteConfigFile(filePath);
    }));
}

function toServiceLookupKey(value: string): string {
  return value.toLowerCase().replace(/[-_]/g, '');
}

async function loadServiceIdByName(
  db: DbClient,
  workspaceId: string,
): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: objects.id, name: objects.name })
    .from(objects)
    .where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectType, 'service')));

  return new Map(rows.map((row) => [toServiceLookupKey(row.name), row.id] as const));
}

async function upsertRouteTransform(
  db: DbClient,
  input: {
    workspaceId: string;
    runId?: string | null | undefined;
    gatewayKind: string;
    ownerServiceId: string | null;
    matchHost: string | null;
    matchPath: string;
    matchMode: 'exact' | 'prefix' | 'regex';
    prependPrefix: string | null;
    rewriteRegex: string | null;
    rewriteReplacement: string | null;
    pathCapturePolicy: string | null;
    routeMountPrefix: string | null;
    targetServiceHint: string | null;
    targetHostAlias: string | null;
    targetPathBaseHint: string | null;
    priority: number;
    stripPrefixCount: number | null;
    evidenceIds: string[];
  },
): Promise<void> {
  const sourceHash = buildRouteTransformSourceHash(input);

  const existing = await db
    .select({ id: routeTransforms.id })
    .from(routeTransforms)
    .where(and(eq(routeTransforms.workspaceId, input.workspaceId), eq(routeTransforms.sourceHash, sourceHash)))
    .limit(1);

  const payload = {
    updatedRunId: normalizeOptionalUuid(input.runId),
    gatewayKind: input.gatewayKind,
    ownerServiceId: input.ownerServiceId,
    matchHost: input.matchHost,
    matchPath: input.matchPath,
    matchMode: input.matchMode,
    stripPrefixCount: input.stripPrefixCount,
    prependPrefix: input.prependPrefix,
    rewriteRegex: input.rewriteRegex,
    rewriteReplacement: input.rewriteReplacement,
    pathCapturePolicy: input.pathCapturePolicy,
    routeMountPrefix: input.routeMountPrefix,
    targetServiceHint: input.targetServiceHint,
    targetHostAlias: input.targetHostAlias,
    targetPathBaseHint: input.targetPathBaseHint,
    priority: input.priority,
    evidenceIds: input.evidenceIds,
    updatedAt: new Date(),
  };

  if (existing[0]) {
    await db.update(routeTransforms).set(payload).where(eq(routeTransforms.id, existing[0].id));
    return;
  }

  await db.insert(routeTransforms).values({
    id: generateId(),
    workspaceId: input.workspaceId,
    createdRunId: normalizeOptionalUuid(input.runId),
    sourceHash,
    ...payload,
  });
}

function buildRouteTransformSourceHash(input: {
  gatewayKind: string;
  ownerServiceId: string | null;
  matchHost: string | null;
  matchPath: string;
  matchMode: 'exact' | 'prefix' | 'regex';
  prependPrefix: string | null;
  rewriteRegex: string | null;
  rewriteReplacement: string | null;
  pathCapturePolicy: string | null;
  routeMountPrefix: string | null;
  targetServiceHint: string | null;
  targetHostAlias: string | null;
  targetPathBaseHint: string | null;
  priority: number;
  stripPrefixCount: number | null;
}): string {
  return stableHash([
    input.gatewayKind,
    input.ownerServiceId ?? '',
    input.matchHost ?? '',
    input.matchPath,
    input.matchMode,
    input.stripPrefixCount ?? '',
    input.prependPrefix ?? '',
    input.rewriteRegex ?? '',
    input.rewriteReplacement ?? '',
    input.pathCapturePolicy ?? '',
    input.routeMountPrefix ?? '',
    input.targetServiceHint ?? '',
    input.targetHostAlias ?? '',
    input.targetPathBaseHint ?? '',
    input.priority,
  ]);
}

async function pruneObsoleteConfigRouteTransforms(
  db: DbClient,
  input: {
    workspaceId: string;
    activeSourceHashes: Set<string>;
    repoEvidenceId: string;
  },
): Promise<{ deletedCount: number; deletedOwnerServiceIds: string[] }> {
  const existing = await db
    .select({
      id: routeTransforms.id,
      sourceHash: routeTransforms.sourceHash,
      ownerServiceId: routeTransforms.ownerServiceId,
      evidenceIds: routeTransforms.evidenceIds,
    })
    .from(routeTransforms)
    .where(eq(routeTransforms.workspaceId, input.workspaceId));

  const obsoleteRows = existing
    .filter((row) => {
      const evidenceIds = Array.isArray(row.evidenceIds)
        ? row.evidenceIds.filter((entry): entry is string => typeof entry === 'string')
        : [];
      const isConfigDerived = evidenceIds.some((evidenceId) => evidenceId.startsWith('config:'));
      const belongsToCurrentRepo = evidenceIds.includes(input.repoEvidenceId);
      if (!isConfigDerived) return false;
      if (!belongsToCurrentRepo) return false;
      return !input.activeSourceHashes.has(row.sourceHash);
    });

  if (obsoleteRows.length === 0) {
    return { deletedCount: 0, deletedOwnerServiceIds: [] };
  }

  await db.delete(routeTransforms).where(inArray(routeTransforms.id, obsoleteRows.map((row) => row.id)));

  const deletedOwnerServiceIds = [...new Set(
    obsoleteRows
      .map((row) => row.ownerServiceId)
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
  )];
  return { deletedCount: obsoleteRows.length, deletedOwnerServiceIds };
}

function trimWildcardPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length === 0) return '/';
  const normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const wildcardIndex = normalized.indexOf('*');
  const base = wildcardIndex >= 0 ? normalized.slice(0, wildcardIndex) : normalized;
  if (base.length === 0) return '/';
  return base.endsWith('/') && base.length > 1 ? base.slice(0, -1) : base;
}

function inferMatchMode(matchPath: string): 'exact' | 'prefix' | 'regex' {
  return matchPath.includes('*') ? 'prefix' : 'exact';
}

function inferTargetPathBaseHint(matchPath: string, stripPrefixCount: number | null): string | null {
  const base = trimWildcardPath(matchPath);
  const segments = base
    .split('/')
    .filter((segment) => segment.length > 0);
  const strippedSegments = typeof stripPrefixCount === 'number' && stripPrefixCount > 0
    ? segments.slice(stripPrefixCount)
    : segments;
  if (strippedSegments.length === 0) {
    return segments.length > 0 ? '/' : null;
  }
  return `/${strippedSegments.join('/')}`;
}

function normalizePluginRouteCandidate(
  route: GatewayRouteTransformCandidate,
  input: { repoRoot: string; filePath: string; index: number },
) {
  const matchPath = route.matchPath ?? route.path;
  if (!matchPath) {
    throw new Error(`gateway route transform candidate는 matchPath/path가 필요합니다: ${route.routeKey}`);
  }
  const stripPrefixCount = typeof route.stripPrefixCount === 'number'
    ? route.stripPrefixCount
    : route.stripPrefix === false
      ? 0
      : inferStripPrefixCount(matchPath);

  return {
    gatewayKind: route.gatewayKind,
    matchHost: route.matchHost ?? route.host ?? null,
    matchPath,
    matchMode: route.matchMode ?? inferMatchMode(matchPath),
    stripPrefixCount,
    prependPrefix: normalizePathPrefix(route.prependPrefix ?? route.prefix ?? null),
    rewriteRegex: route.rewriteRegex,
    rewriteReplacement: route.rewriteReplacement,
    pathCapturePolicy: route.pathCapturePolicy ?? (matchPath.includes('*') ? 'glob' : null),
    routeMountPrefix: normalizePathPrefix(route.routeMountPrefix ?? route.prefix ?? null),
    targetServiceHint: route.targetServiceHint ?? route.serviceId ?? null,
    targetHostAlias: route.targetHostAlias === undefined ? extractTargetHostAlias(route.url ?? null) : route.targetHostAlias,
    targetPathBaseHint: normalizePathPrefix(
      route.targetPathBaseHint ?? inferTargetPathBaseHint(matchPath, stripPrefixCount),
    ),
    priority: typeof route.priority === 'number' ? route.priority : 100 - input.index,
    evidenceIds: route.evidenceIds ?? [buildConfigEvidenceId(input.repoRoot, input.filePath, route.routeKey)],
  };
}

export const zuulGatewayRouteTransformPlugin: GatewayRouteTransformPlugin = {
  id: 'zuul',
  displayName: 'Zuul Gateway Route Plugin',
  supportsFile({ filePath }) {
    return isDefaultGatewayRouteConfigFile(filePath);
  },
  extract(input) {
    const signal = parseApplicationYml(input.filePath, input.content);
    if (signal.zuulRoutes.length === 0) {
      return null;
    }

    return {
      ownerServiceName: signal.serviceName,
      routes: signal.zuulRoutes.map((route) => ({
        routeKey: route.routeKey,
        gatewayKind: 'zuul',
        matchPath: route.path,
        matchMode: inferMatchMode(route.path),
        targetServiceHint: route.serviceId,
        url: route.url,
        stripPrefix: route.stripPrefix,
        prependPrefix: route.prefix,
        matchHost: route.host,
        rewriteRegex: route.rewriteRegex,
        rewriteReplacement: route.rewriteReplacement,
        pathCapturePolicy: route.path.includes('*') ? 'glob' : null,
        routeMountPrefix: route.prefix,
        targetPathBaseHint: inferTargetPathBaseHint(
          route.path,
          route.stripPrefix === false ? 0 : inferStripPrefixCount(route.path),
        ),
      })),
    };
  },
};

export const springCloudGatewayRouteTransformPlugin: GatewayRouteTransformPlugin = {
  id: 'spring-cloud-gateway',
  displayName: 'Spring Cloud Gateway Route Plugin',
  supportsFile({ filePath }) {
    return isDefaultGatewayRouteConfigFile(filePath);
  },
  extract(input) {
    const signal = parseApplicationYml(input.filePath, input.content);
    if (signal.springCloudGatewayRoutes.length === 0) {
      return null;
    }

    return {
      ownerServiceName: signal.serviceName,
      routes: signal.springCloudGatewayRoutes.map((route) => ({
        routeKey: route.routeKey,
        gatewayKind: 'spring_cloud_gateway',
        matchPath: route.path,
        matchMode: inferMatchMode(route.path),
        targetServiceHint: parseScgTargetServiceHint(route.uri),
        url: route.uri,
        stripPrefixCount: route.stripPrefixCount,
        targetHostAlias: null,
        prependPrefix: route.prefixPath,
        matchHost: null,
        rewriteRegex: route.rewriteRegex,
        rewriteReplacement: route.rewriteReplacement,
        pathCapturePolicy: route.path.includes('*') ? 'glob' : null,
        routeMountPrefix: route.prefixPath,
        targetPathBaseHint: inferTargetPathBaseHint(route.path, route.stripPrefixCount),
      })),
    };
  },
};

export function getBuiltInGatewayRouteTransformPlugins(): GatewayRouteTransformPlugin[] {
  return [zuulGatewayRouteTransformPlugin, springCloudGatewayRouteTransformPlugin];
}

function resolveGatewayRouteTransformPlugins(
  plugins?: GatewayRouteTransformPlugin[],
): GatewayRouteTransformPlugin[] {
  return [...getBuiltInGatewayRouteTransformPlugins(), ...(plugins ?? [])];
}

export async function extractRouteTransformsFromConfig(
  db: DbClient,
  options: ExtractRouteTransformsOptions,
): Promise<ExtractRouteTransformsResult> {
  const serviceIdByName = await loadServiceIdByName(db, options.workspaceId);
  const plugins = resolveGatewayRouteTransformPlugins(options.plugins);
  const discoveredFiles = findGatewayRouteCandidateFiles(options.repoRoot, plugins);
  const activeSourceHashes = new Set<string>();
  const repoEvidenceId = buildConfigRepoEvidenceId(options.repoRoot);

  let routeTransformCount = 0;
  for (const filePath of discoveredFiles) {
    const content = readFileSync(filePath, 'utf-8');

    for (const plugin of plugins) {
      if (plugin.supportsFile && !plugin.supportsFile({ filePath, repoRoot: options.repoRoot })) {
        continue;
      }
      const extracted = plugin.extract({
        filePath,
        repoRoot: options.repoRoot,
        content,
      });
      if (!extracted || extracted.routes.length === 0) continue;

      const ownerServiceId = extracted.ownerServiceName
        ? (serviceIdByName.get(toServiceLookupKey(extracted.ownerServiceName)) ?? null)
        : null;

      for (const [index, route] of extracted.routes.entries()) {
        const normalizedRoute = normalizePluginRouteCandidate(route, {
          repoRoot: options.repoRoot,
          filePath,
          index,
        });
        const evidenceIds = [...new Set([repoEvidenceId, ...normalizedRoute.evidenceIds])];
        await upsertRouteTransform(db, {
          workspaceId: options.workspaceId,
          runId: options.runId,
          gatewayKind: normalizedRoute.gatewayKind,
          ownerServiceId,
          matchHost: normalizedRoute.matchHost,
          matchPath: normalizedRoute.matchPath,
          matchMode: normalizedRoute.matchMode,
          prependPrefix: normalizedRoute.prependPrefix,
          rewriteRegex: normalizedRoute.rewriteRegex,
          rewriteReplacement: normalizedRoute.rewriteReplacement,
          pathCapturePolicy: normalizedRoute.pathCapturePolicy,
          routeMountPrefix: normalizedRoute.routeMountPrefix,
          targetServiceHint: normalizedRoute.targetServiceHint,
          targetHostAlias: normalizedRoute.targetHostAlias,
          targetPathBaseHint: normalizedRoute.targetPathBaseHint,
          priority: normalizedRoute.priority,
          stripPrefixCount: normalizedRoute.stripPrefixCount,
          evidenceIds,
        });
        activeSourceHashes.add(
          buildRouteTransformSourceHash({
            gatewayKind: normalizedRoute.gatewayKind,
            ownerServiceId,
            matchHost: normalizedRoute.matchHost,
            matchPath: normalizedRoute.matchPath,
            matchMode: normalizedRoute.matchMode,
            stripPrefixCount: normalizedRoute.stripPrefixCount,
            prependPrefix: normalizedRoute.prependPrefix,
            rewriteRegex: normalizedRoute.rewriteRegex,
            rewriteReplacement: normalizedRoute.rewriteReplacement,
            pathCapturePolicy: normalizedRoute.pathCapturePolicy,
            routeMountPrefix: normalizedRoute.routeMountPrefix,
            targetServiceHint: normalizedRoute.targetServiceHint,
            targetHostAlias: normalizedRoute.targetHostAlias,
            targetPathBaseHint: normalizedRoute.targetPathBaseHint,
            priority: normalizedRoute.priority,
          }),
        );
        routeTransformCount += 1;
      }
    }
  }

  const pruneResult = await pruneObsoleteConfigRouteTransforms(db, {
    workspaceId: options.workspaceId,
    activeSourceHashes,
    repoEvidenceId,
  });

  return {
    routeTransformCount,
    deletedRouteTransformCount: pruneResult.deletedCount,
    deletedOwnerServiceIds: pruneResult.deletedOwnerServiceIds,
    fileCount: discoveredFiles.length,
    processedFileCount: discoveredFiles.length,
    skippedFileCount: 0,
  };
}
