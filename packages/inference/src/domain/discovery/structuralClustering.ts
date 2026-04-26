import type {
  CandidateMemberScore,
  DiscoveryCodeArtifactInput,
  DiscoveryInputs,
  DiscoveryIntentInput,
  DiscoveryObjectInput,
} from './types';

export const AFFINITY_THRESHOLD = 0.2;

const DEFAULT_SIGNAL_WEIGHTS = {
  path: 0.1,
  route: 0.3,
  topic: 0.2,
  name: 0.15,
  code: 0.2,
  table: 0.05,
} as const;

const TABLE_SIGNAL_WEIGHTS = {
  path: 0.05,
  route: 0.2,
  topic: 0.1,
  name: 0.15,
  code: 0.1,
  table: 0.4,
} as const;

const STRIPPABLE_NAME_SUFFIXES = [
  'service',
  'controller',
  'entity',
  'repository',
  'repo',
  'dao',
  'dto',
  'handler',
  'manager',
  'provider',
  'component',
  'module',
  'mapper',
];

const LOW_VALUE_TOKENS = new Set(['robot', 'core', 'mgt', 'mgmt', 'robotcore', 'rb']);
const ROUTE_LOW_VALUE_TOKENS = new Set([
  ...LOW_VALUE_TOKENS,
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'options',
  'head',
  'any',
  'id',
  'ids',
  'list',
  'show',
  'index',
  'home',
]);
const TABLE_OBJECT_TYPES = new Set(['db_table', 'db_view', 'database_table', 'table']);
const PACKAGE_NAMESPACE_ROOTS = new Set([
  'com',
  'org',
  'net',
  'io',
  'dev',
  'app',
  'co',
  'kr',
  'jp',
  'uk',
  'us',
]);
const NON_DOMAIN_PATH_PREFIXES = new Set([
  'api',
  'apis',
  'rest',
  'graphql',
  'gql',
  'rpc',
  'grpc',
  'public',
  'internal',
  'private',
  'app',
  'web',
]);
const INHERITED_INTENT_CHILD_TYPES = new Set(['function', 'api_endpoint']);

interface DomainSeed {
  slug: string;
  source: 'path' | 'name' | 'route' | 'topic' | 'class' | 'file' | 'table' | 'package';
  value: string;
  label: string;
}

interface SeedIndex {
  seedsByObjectId: Map<string, DomainSeed[]>;
}

export interface StructuralClusterCandidate {
  slug: string;
  autoName: string;
  members: CandidateMemberScore[];
  signals: {
    topPathPrefix: string | null;
    topRoutePrefix: string | null;
    topTopicPrefix: string | null;
    topCodeFamily: string | null;
    topTableFamily: string | null;
    seedSourceSummary: Array<{ source: string; value: string }>;
  };
}

export interface StructuralClusteringResult {
  candidates: StructuralClusterCandidate[];
}

export function runStructuralClustering(inputs: DiscoveryInputs): StructuralClusteringResult {
  const intentsByObject = groupIntentsByObject(inputs.intents, inputs.objects);
  const seedIndex = buildSeedIndex(inputs);

  const slugSet = new Set<string>();
  for (const obj of inputs.objects) {
    for (const seed of seedIndex.seedsByObjectId.get(obj.id) ?? []) slugSet.add(seed.slug);
    const intents = intentsByObject.get(obj.id) ?? [];
    for (const intent of intents) {
      for (const seed of extractIntentRouteSeeds(intent)) slugSet.add(seed.slug);
      for (const seed of extractIntentTopicSeeds(intent)) slugSet.add(seed.slug);
    }
  }

  const candidates: StructuralClusterCandidate[] = [];
  for (const slug of slugSet) {
    const memberScores: CandidateMemberScore[] = [];
    const candidateTokens = new Set([slug]);
    let topPathPrefix: string | null = null;
    let topRoutePrefix: string | null = null;
    let topTopicPrefix: string | null = null;
    let topCodeFamily: string | null = null;
    let topTableFamily: string | null = null;
    const signalSummary = new Map<string, { source: string; value: string }>();

    for (const obj of inputs.objects) {
      const intents = intentsByObject.get(obj.id) ?? [];
      const pathMatch = matchPathPrefix(obj.path, slug);
      const routeMatch = matchRoutePrefix(intents, slug);
      const topicMatch = matchTopicPrefix(intents, slug);
      const nameJaccard = jaccardSimilarity(tokenizeName(obj.name), candidateTokens);
      const objectSeeds = seedIndex.seedsByObjectId.get(obj.id) ?? [];
      const codeMatch = hasSeedSlug(objectSeeds, slug, ['class', 'file', 'package']) ? 1 : 0;
      const tableMatch = hasSeedSlug(objectSeeds, slug, ['table']) ? 1 : 0;

      const affinity = computeWeightedAffinity(obj, {
        pathMatch,
        routeMatch,
        topicMatch,
        nameJaccard,
        codeMatch,
        tableMatch,
      });
      if (affinity < AFFINITY_THRESHOLD) continue;

      if (pathMatch === 1 && topPathPrefix === null) topPathPrefix = firstPathSegment(obj.path);
      if (routeMatch === 1 && topRoutePrefix === null)
        topRoutePrefix = pickFirstRouteMatch(intents, slug);
      if (topicMatch === 1 && topTopicPrefix === null)
        topTopicPrefix = pickFirstTopicMatch(intents, slug);
      if (codeMatch === 1 && topCodeFamily === null) {
        topCodeFamily =
          objectSeeds.find(
            (seed) => seed.slug === slug && ['class', 'file', 'package'].includes(seed.source),
          )?.label ?? capitalize(slug);
      }
      if (tableMatch === 1 && topTableFamily === null) {
        topTableFamily =
          objectSeeds.find((seed) => seed.slug === slug && seed.source === 'table')?.label ??
          capitalize(slug);
      }

      const directSeedSources: string[] = [];
      if (pathMatch === 1) directSeedSources.push(`path:${slug}`);
      if (routeMatch === 1 && topRoutePrefix) directSeedSources.push(`route:${topRoutePrefix}`);
      if (topicMatch === 1 && topTopicPrefix) directSeedSources.push(`topic:${topTopicPrefix}`);
      if (codeMatch === 1) directSeedSources.push(`code:${slug}`);
      if (tableMatch === 1) directSeedSources.push(`table:${slug}`);

      const allObjectSeedSources = collectObjectSeedSources(obj, intents, objectSeeds);
      for (const seedSource of uniqueStrings([...directSeedSources, ...allObjectSeedSources])) {
        const [sourceRaw, ...rest] = seedSource.split(':');
        const source = sourceRaw ?? 'seed';
        const value = rest.join(':');
        signalSummary.set(`${source}:${value}`, { source, value });
      }

      if (obj.memberEligible === false) continue;

      memberScores.push({
        objectId: obj.id,
        pathPrefixMatch: pathMatch,
        routePrefixMatch: routeMatch,
        topicPrefixMatch: topicMatch,
        nameTokenJaccard: round3(nameJaccard),
        codeFamilyMatch: codeMatch,
        tableFamilyMatch: tableMatch,
        seedSources: uniqueStrings([...directSeedSources, ...allObjectSeedSources]),
        affinity: round3(affinity),
        relationCohesion: 0,
      });
    }

    if (memberScores.length === 0) continue;

    candidates.push({
      slug,
      autoName: capitalize(slug),
      members: memberScores,
      signals: {
        topPathPrefix,
        topRoutePrefix,
        topTopicPrefix,
        topCodeFamily,
        topTableFamily,
        seedSourceSummary: Array.from(signalSummary.values()).slice(0, 12),
      },
    });
  }

  candidates.sort((a, b) => b.members.length - a.members.length || a.slug.localeCompare(b.slug));
  return { candidates };
}

function buildSeedIndex(inputs: DiscoveryInputs): SeedIndex {
  const seedsByObjectId = new Map<string, DomainSeed[]>();
  const artifactsByOwner = groupArtifactsByOwner(inputs.codeArtifacts);

  for (const obj of inputs.objects) {
    const seeds: DomainSeed[] = [];
    for (const slug of extractPathSlugs(obj.path)) seeds.push(makeSeed(slug, 'path', obj.path));
    for (const slug of extractNameSlugs(obj.name)) seeds.push(makeSeed(slug, 'name', obj.name));

    const className = asString(obj.metadata?.['className']);
    const metaFilePath = asString(obj.metadata?.['filePath']);
    for (const seed of extractClassSeeds(className)) seeds.push(seed);
    for (const seed of extractFilePathSeeds(metaFilePath)) seeds.push(seed);
    if (isTableLikeObject(obj)) {
      for (const seed of extractTableSeeds(obj.name)) seeds.push(seed);
    }

    for (const artifact of artifactsByOwner.get(obj.id) ?? []) {
      for (const seed of extractFilePathSeeds(artifact.filePath)) seeds.push(seed);
      for (const seed of extractPackageSeeds(artifact.packageName)) seeds.push(seed);
    }

    const uniqSeeds = uniqueSeeds(seeds);
    seedsByObjectId.set(obj.id, uniqSeeds);
  }

  return { seedsByObjectId };
}

function groupArtifactsByOwner(
  artifacts: DiscoveryCodeArtifactInput[],
): Map<string, DiscoveryCodeArtifactInput[]> {
  const map = new Map<string, DiscoveryCodeArtifactInput[]>();
  for (const artifact of artifacts) {
    if (!artifact.ownerObjectId) continue;
    const list = map.get(artifact.ownerObjectId) ?? [];
    list.push(artifact);
    map.set(artifact.ownerObjectId, list);
  }
  return map;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function collectObjectSeedSources(
  obj: DiscoveryObjectInput,
  intents: DiscoveryIntentInput[],
  objectSeeds: DomainSeed[],
): string[] {
  const sources: string[] = [];
  const pathPrefix = firstPathSegment(obj.path);
  if (pathPrefix) sources.push(`path:${pathPrefix}`);
  sources.push(`name:${obj.name}`);
  for (const seed of objectSeeds) sources.push(`${seed.source}:${seed.value}`);
  for (const intent of intents) {
    for (const routeSeed of extractIntentRouteSeeds(intent)) {
      sources.push(`route:/${routeSeed.slug}`);
    }
  }
  return uniqueStrings(sources);
}

function groupIntentsByObject(
  intents: DiscoveryIntentInput[],
  objects: DiscoveryObjectInput[],
): Map<string, DiscoveryIntentInput[]> {
  const map = new Map<string, DiscoveryIntentInput[]>();
  const objectById = new Map(objects.map((obj) => [obj.id, obj] as const));
  const codeChildrenByService = new Map<string, DiscoveryObjectInput[]>();
  for (const obj of objects) {
    if (!obj.parentId || !INHERITED_INTENT_CHILD_TYPES.has(obj.objectType)) continue;
    const parent = objectById.get(obj.parentId);
    if (!parent || parent.objectType !== 'service') continue;
    const list = codeChildrenByService.get(parent.id) ?? [];
    list.push(obj);
    codeChildrenByService.set(parent.id, list);
  }

  for (const intent of intents) {
    appendIntent(map, intent.sourceObjectId, intent);
    const source = objectById.get(intent.sourceObjectId);
    if (source?.objectType !== 'service') continue;
    for (const child of codeChildrenByService.get(source.id) ?? [])
      appendIntent(map, child.id, intent);
  }
  return map;
}

function appendIntent(
  map: Map<string, DiscoveryIntentInput[]>,
  objectId: string,
  intent: DiscoveryIntentInput,
): void {
  const list = map.get(objectId) ?? [];
  list.push(intent);
  map.set(objectId, list);
}

function extractPathSlugs(path: string): string[] {
  const seg = firstPathSegment(path);
  if (!seg) return [];
  const slug = normalizeSlug(seg);
  return isUsefulSlug(slug) ? [slug] : [];
}

function extractNameSlugs(name: string): string[] {
  return Array.from(tokenizeName(name)).filter(isUsefulSlug);
}

function extractClassSeeds(className: string | null): DomainSeed[] {
  if (!className) return [];
  return Array.from(tokenizeName(className))
    .filter(isUsefulSlug)
    .map((slug) => makeSeed(slug, 'class', className));
}

function extractPackageSeeds(packageName: string | null): DomainSeed[] {
  if (!packageName) return [];
  const slugs = packageName.split(/[./]/).map((segment) => normalizeSlug(segment));
  const startsWithNamespaceRoot = PACKAGE_NAMESPACE_ROOTS.has(slugs[0] ?? '');
  const semanticStart = startsWithNamespaceRoot ? Math.min(2, slugs.length - 1) : 0;
  return slugs
    .map((slug, index) => ({ slug, index }))
    .filter(({ slug, index }) => index >= semanticStart && isUsefulPackageSlug(slug, index))
    .map(({ slug }) => makeSeed(slug, 'package', packageName));
}

function extractFilePathSeeds(filePath: string | null): DomainSeed[] {
  if (!filePath) return [];
  const parts = filePath.split(/[\/]/).filter(Boolean);
  const name = parts[parts.length - 1] ?? '';
  const withoutExt = name.replace(/\.[^.]+$/, '');
  return Array.from(tokenizeName(withoutExt))
    .filter(isUsefulSlug)
    .map((slug) => makeSeed(slug, 'file', filePath));
}

function extractTableSeeds(name: string): DomainSeed[] {
  if (!name.includes('_')) return [];
  const parts = name
    .split('_')
    .map((p) => normalizeSlug(p))
    .filter(isUsefulSlug);
  return parts.map((slug) => makeSeed(slug, 'table', name));
}

function isTableLikeObject(obj: DiscoveryObjectInput): boolean {
  if (TABLE_OBJECT_TYPES.has(obj.objectType.toLowerCase())) return true;
  const metadataType = asString(obj.metadata?.['objectType']) ?? asString(obj.metadata?.['type']);
  return metadataType !== null && TABLE_OBJECT_TYPES.has(metadataType.toLowerCase());
}

function computeWeightedAffinity(
  obj: DiscoveryObjectInput,
  signals: {
    pathMatch: 0 | 1;
    routeMatch: 0 | 1;
    topicMatch: 0 | 1;
    nameJaccard: number;
    codeMatch: 0 | 1;
    tableMatch: 0 | 1;
  },
): number {
  const weights = isTableLikeObject(obj) ? TABLE_SIGNAL_WEIGHTS : DEFAULT_SIGNAL_WEIGHTS;
  const totalWeight =
    weights.path + weights.route + weights.topic + weights.name + weights.code + weights.table;
  const weighted =
    signals.pathMatch * weights.path +
    signals.routeMatch * weights.route +
    signals.topicMatch * weights.topic +
    signals.nameJaccard * weights.name +
    signals.codeMatch * weights.code +
    signals.tableMatch * weights.table;

  return Math.min(1, weighted / totalWeight);
}

function extractIntentRouteSeeds(intent: DiscoveryIntentInput): DomainSeed[] {
  const seeds: DomainSeed[] = [];
  for (const candidate of [intent.externalPathHint, intent.externalRoutePattern]) {
    if (!candidate) continue;
    for (const slug of extractRouteSlugs(candidate)) {
      seeds.push(makeSeed(slug, 'route', candidate));
    }
  }
  return uniqueSeeds(seeds);
}

function extractIntentTopicSeeds(intent: DiscoveryIntentInput): DomainSeed[] {
  const seeds: DomainSeed[] = [];
  for (const topic of intent.messageTopicHints) {
    const seg = firstTopicSegment(topic);
    if (!seg) continue;
    const slug = normalizeSlug(seg);
    if (!isUsefulSlug(slug)) continue;
    seeds.push(makeSeed(slug, 'topic', topic));
  }
  return uniqueSeeds(seeds);
}

function matchPathPrefix(path: string, slug: string): 0 | 1 {
  const seg = firstPathSegment(path);
  if (!seg) return 0;
  return normalizeSlug(seg) === slug ? 1 : 0;
}

function matchRoutePrefix(intents: DiscoveryIntentInput[], slug: string): 0 | 1 {
  for (const intent of intents) {
    for (const seed of extractIntentRouteSeeds(intent)) {
      if (seed.slug === slug) return 1;
    }
  }
  return 0;
}

function matchTopicPrefix(intents: DiscoveryIntentInput[], slug: string): 0 | 1 {
  for (const intent of intents) {
    for (const seed of extractIntentTopicSeeds(intent)) {
      if (seed.slug === slug) return 1;
    }
  }
  return 0;
}

function pickFirstRouteMatch(intents: DiscoveryIntentInput[], slug: string): string | null {
  for (const intent of intents) {
    for (const seed of extractIntentRouteSeeds(intent)) {
      if (seed.slug !== slug) continue;
      return `/${slug}`;
    }
  }
  return null;
}

function pickFirstTopicMatch(intents: DiscoveryIntentInput[], slug: string): string | null {
  for (const intent of intents) {
    for (const seed of extractIntentTopicSeeds(intent)) {
      if (seed.slug === slug) return firstTopicSegment(seed.value);
    }
  }
  return null;
}

function hasSeedSlug(seeds: DomainSeed[], slug: string, sources: DomainSeed['source'][]): boolean {
  return seeds.some((seed) => seed.slug === slug && sources.includes(seed.source));
}

function firstPathSegment(input: string): string | null {
  const segments = input
    .split(/[\/]/)
    .filter((s) => s.length > 0 && !s.startsWith(':') && !s.startsWith('{'));
  for (const segment of segments) {
    if (!isNonDomainSegment(segment)) return segment;
  }
  return segments[segments.length - 1] ?? null;
}

function extractRouteSlugs(input: string): string[] {
  const segments = input
    .split(/[\/]/)
    .filter((s) => s.length > 0 && !s.startsWith(':') && !s.startsWith('{'));
  const slugs: string[] = [];
  for (const segment of segments) {
    if (isNonDomainSegment(segment)) continue;
    const slug = normalizeSlug(segment);
    if (!isUsefulRouteSlug(slug)) continue;
    slugs.push(slug);
  }
  return uniqueStrings(slugs);
}

function firstTopicSegment(topic: string): string | null {
  const segments = topic.split(/[.\-_/]/).filter((s) => s.length > 0);
  return segments[0] ?? null;
}

function normalizeSlug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
}

export function tokenizeName(name: string): Set<string> {
  const tokens = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_\-./]+/)
    .map((t) => t.toLowerCase().replace(/[^a-z0-9가-힣]/g, ''))
    .filter((t) => t.length >= 2)
    .filter((t) => !STRIPPABLE_NAME_SUFFIXES.includes(t));
  return new Set(tokens);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function makeSeed(slug: string, source: DomainSeed['source'], value: string): DomainSeed {
  return { slug, source, value, label: capitalize(slug) };
}

function uniqueSeeds(seeds: DomainSeed[]): DomainSeed[] {
  const map = new Map<string, DomainSeed>();
  for (const seed of seeds) map.set(`${seed.source}:${seed.slug}:${seed.value}`, seed);
  return Array.from(map.values());
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isVersionSegment(segment: string): boolean {
  return /^v\d+$/i.test(segment);
}

function isNonDomainSegment(segment: string): boolean {
  return NON_DOMAIN_PATH_PREFIXES.has(segment.toLowerCase()) || isVersionSegment(segment);
}

function isUsefulSlug(slug: string): boolean {
  if (!slug) return false;
  if (LOW_VALUE_TOKENS.has(slug)) return false;
  return slug.length >= 2 || /[가-힣]/.test(slug);
}

function isUsefulRouteSlug(slug: string): boolean {
  if (!slug) return false;
  if (/^\d+$/.test(slug)) return false;
  if (ROUTE_LOW_VALUE_TOKENS.has(slug)) return false;
  return slug.length >= 2 || /[가-힣]/.test(slug);
}

function isUsefulPackageSlug(slug: string, index: number): boolean {
  if (!isUsefulSlug(slug)) return false;
  if (PACKAGE_NAMESPACE_ROOTS.has(slug)) return false;
  if (index === 0 && slug.length <= 3) return false;
  return true;
}

function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s[0]!.toUpperCase() + s.slice(1);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
