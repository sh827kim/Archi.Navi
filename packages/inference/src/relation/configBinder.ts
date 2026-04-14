import { readFileSync } from 'node:fs';
import type { ConfigEntry } from '@/code/plugins/types';
import { detectPlugins, parseConfigWithPluginParsers } from '@/code';
import type { ExtractedSignal } from '@/code/codeSignalExtractor';
import { findFiles } from '@/utils/fileDiscovery';
import { asString, extractHost, normalizePath, uniqueSortedStrings } from '../extraction/shared';

export type ConfigBindingSourceKind = 'config_entry' | 'config_key';
export type ConfigBindingValueKind = 'url' | 'host' | 'topic' | 'queue' | 'port' | 'path' | 'property';
export type ConfigBindingKind = 'base_url' | 'gateway_target' | 'service_discovery' | 'property_alias';
export type ConfigBindingMatchStrategy = 'exact' | 'suffix' | 'token' | 'value' | 'key';

export interface ConfigBindingDescriptor {
  sourceKind: ConfigBindingSourceKind;
  key: string;
  normalizedKey: string;
  value: string | null;
  sourceType: ConfigEntry['sourceType'] | 'derived';
  filePath: string | null;
  bindingKind: ConfigBindingKind;
  valueKind: ConfigBindingValueKind;
  hostHints: string[];
  pathHints: string[];
  portHints: string[];
  messageTopicHints: string[];
  messageQueueHints: string[];
  resolvedUrl: string | null;
  matchedConfigKeys: string[];
  matchStrategy: ConfigBindingMatchStrategy;
  matchScore: number;
  unresolvedReason: string | null;
}

export interface ConfigBindingUnresolved {
  key: string;
  value: string | null;
  sourceKind: ConfigBindingSourceKind;
  sourceType: ConfigEntry['sourceType'] | 'derived';
  filePath: string | null;
  reason: string;
}

export interface ConfigBindingSummary {
  total: number;
  bindingCount: number;
  unresolvedCount: number;
  valueKindCounts: Record<ConfigBindingValueKind, number>;
  bindingKindCounts: Record<ConfigBindingKind, number>;
}

export interface ConfigBindingBundle {
  descriptors: ConfigBindingDescriptor[];
  unresolved: ConfigBindingUnresolved[];
  summary: ConfigBindingSummary;
}

function normalizePathSeparator(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function findApplicationConfigFiles(repoRoot: string): string[] {
  return findFiles(repoRoot, (filePath) => {
    const base = normalizePathSeparator(filePath).split('/').pop()?.toLowerCase() ?? '';
    return (
      (base.startsWith('application') || base.startsWith('bootstrap'))
      && (base.endsWith('.yml') || base.endsWith('.yaml') || base.endsWith('.json') || base.endsWith('.properties'))
    );
  });
}

export function materializeConfigEntriesFromSignals(
  signals: ExtractedSignal[],
  filePath: string,
): ConfigEntry[] {
  const entries: ConfigEntry[] = [];

  for (const signal of signals) {
    const metadata = (signal.metadata ?? {}) as Record<string, unknown>;
    const sourceType = asString(metadata['sourceType']);
    const value = asString(metadata['value']) ?? signal.symbol;
    const keys = uniqueSortedStrings([
      asString(metadata['configKey']),
      asString(metadata['propertyKey']),
      asString(metadata['baseUrlConfigKey']),
      asString(metadata['hostConfigKey']),
      ...(Array.isArray(metadata['configKeys'])
        ? metadata['configKeys'].map((entry) => asString(entry))
        : []),
    ]).filter((entry): entry is string => entry.length > 0);

    const normalizedKeys = keys.length > 0 ? keys : [signal.symbol.trim()].filter((entry) => entry.length > 0);
    if (normalizedKeys.length === 0) continue;

    for (const key of normalizedKeys) {
      entries.push({
        key,
        value: value.length > 0 ? value : key,
        sourceType:
          sourceType === 'yaml' || sourceType === 'json' || sourceType === 'properties'
            ? sourceType
            : 'other',
        filePath: asString(metadata['filePath']) ?? filePath,
      });
    }
  }

  return entries;
}

function normalizeConfigKey(value: string): string {
  return value.trim().toLowerCase().replace(/\[(\d+)\]/g, '.$1');
}

function splitConfigKeySegments(value: string): string[] {
  return normalizeConfigKey(value)
    .split(/[./_\-\s]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function splitConfigValueTokens(value: string): string[] {
  return value
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function isUrlLike(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim());
}

function isHostPortLike(value: string): boolean {
  return /^[^/\s:]+:\d{1,5}$/.test(value.trim());
}

function isNumericPortLike(value: string): boolean {
  return /^\d{1,5}$/.test(value.trim());
}

function hasKeyToken(key: string, tokens: string[]): boolean {
  const segments = splitConfigKeySegments(key);
  return tokens.some((token) => segments.includes(token));
}

function inferValueKind(key: string, value: string | null): ConfigBindingValueKind {
  if (!value || value.trim().length === 0) {
    return 'property';
  }

  const normalizedValue = value.trim();
  if (isUrlLike(normalizedValue)) return 'url';
  if (isNumericPortLike(normalizedValue) || hasKeyToken(key, ['port'])) return 'port';
  if (hasKeyToken(key, ['topic'])) return 'topic';
  if (hasKeyToken(key, ['queue'])) return 'queue';
  if (hasKeyToken(key, ['path', 'route', 'uri', 'endpoint'])) return 'path';
  if (isHostPortLike(normalizedValue) || extractHost(normalizedValue) !== null) return 'host';
  return 'property';
}

function inferBindingKind(key: string, valueKind: ConfigBindingValueKind): ConfigBindingKind {
  if (valueKind === 'url') return 'base_url';
  if (hasKeyToken(key, ['gateway', 'route'])) return 'gateway_target';
  if (valueKind === 'host' && hasKeyToken(key, ['host', 'service', 'url', 'uri'])) {
    return 'service_discovery';
  }
  return 'property_alias';
}

function parseHostAndPort(rawValue: string): {
  hostHints: string[];
  portHints: string[];
  resolvedUrl: string | null;
} {
  const value = rawValue.trim();
  if (value.length === 0) {
    return { hostHints: [], portHints: [], resolvedUrl: null };
  }

  if (isUrlLike(value)) {
    try {
      const url = new URL(value);
      const hostHints = uniqueSortedStrings([url.hostname]);
      const portHints = uniqueSortedStrings([url.port || null]);
      return {
        hostHints,
        portHints,
        resolvedUrl: value,
      };
    } catch {
      return { hostHints: uniqueSortedStrings([extractHost(value)]), portHints: [], resolvedUrl: null };
    }
  }

  if (isHostPortLike(value)) {
    const [host, port] = value.split(':');
    return {
      hostHints: uniqueSortedStrings([host]),
      portHints: uniqueSortedStrings([port]),
      resolvedUrl: null,
    };
  }

  const host = extractHost(value);
  return {
    hostHints: uniqueSortedStrings([host]),
    portHints: [],
    resolvedUrl: null,
  };
}

function buildDescriptor(input: {
  key: string;
  value: string | null;
  sourceKind: ConfigBindingSourceKind;
  sourceType: ConfigEntry['sourceType'] | 'derived';
  filePath: string | null;
  matchedConfigKeys?: string[];
  matchStrategy?: ConfigBindingMatchStrategy;
  matchScore?: number;
  unresolvedReason?: string | null;
}): ConfigBindingDescriptor {
  const normalizedKey = normalizeConfigKey(input.key);
  const value = input.value?.trim() ?? null;
  const valueKind = inferValueKind(input.key, value);
  const bindingKind = inferBindingKind(input.key, valueKind);
  const tokens = value ? splitConfigValueTokens(value) : [];
  const parsedValue = value ? parseHostAndPort(value) : { hostHints: [], portHints: [], resolvedUrl: null };
  const hostHints = valueKind === 'url' || valueKind === 'host'
    ? parsedValue.hostHints
    : uniqueSortedStrings([
        ...parsedValue.hostHints,
        ...(hasKeyToken(input.key, ['host', 'service', 'url', 'uri']) ? [value] : []),
      ]);
  const portHints = uniqueSortedStrings([
    ...parsedValue.portHints,
    ...(valueKind === 'port' ? [value] : []),
  ]);
  const pathHints = valueKind === 'url' && parsedValue.resolvedUrl
    ? (() => {
        try {
          return uniqueSortedStrings([normalizePath(new URL(parsedValue.resolvedUrl).pathname)]);
        } catch {
          return [];
        }
      })()
    : valueKind === 'path' && value
      ? uniqueSortedStrings([normalizePath(value)])
      : [];
  const messageTopicHints = valueKind === 'topic'
    ? uniqueSortedStrings([...tokens, ...(value ? [value] : [])])
    : [];
  const messageQueueHints = valueKind === 'queue'
    ? uniqueSortedStrings([...tokens, ...(value ? [value] : [])])
    : [];
  const hasResolvedHint =
    (valueKind === 'url' && (hostHints.length > 0 || pathHints.length > 0))
    || (valueKind === 'host' && hostHints.length > 0)
    || (valueKind === 'topic' && messageTopicHints.length > 0)
    || (valueKind === 'queue' && messageQueueHints.length > 0)
    || (valueKind === 'port' && portHints.length > 0)
    || (valueKind === 'path' && pathHints.length > 0)
    || valueKind === 'property';
  const unresolvedReason =
    input.unresolvedReason
    ?? (input.sourceKind === 'config_key' ? 'value_not_available' : null)
    ?? (value === null || value.length === 0 ? 'empty_value' : null)
    ?? (!hasResolvedHint ? `${valueKind}_unresolved` : null);

  return {
    sourceKind: input.sourceKind,
    key: input.key,
    normalizedKey,
    value,
    sourceType: input.sourceType,
    filePath: input.filePath,
    bindingKind,
    valueKind,
    hostHints,
    pathHints,
    portHints,
    messageTopicHints,
    messageQueueHints,
    resolvedUrl: parsedValue.resolvedUrl,
    matchedConfigKeys: uniqueSortedStrings([...(input.matchedConfigKeys ?? []), input.key]),
    matchStrategy: input.matchStrategy ?? 'key',
    matchScore: input.matchScore ?? 0,
    unresolvedReason,
  };
}

function buildSummary(descriptors: ConfigBindingDescriptor[], unresolved: ConfigBindingUnresolved[]): ConfigBindingSummary {
  const valueKindCounts: Record<ConfigBindingValueKind, number> = {
    url: 0,
    host: 0,
    topic: 0,
    queue: 0,
    port: 0,
    path: 0,
    property: 0,
  };
  const bindingKindCounts: Record<ConfigBindingKind, number> = {
    base_url: 0,
    gateway_target: 0,
    service_discovery: 0,
    property_alias: 0,
  };
  for (const descriptor of descriptors) {
    valueKindCounts[descriptor.valueKind] += 1;
    bindingKindCounts[descriptor.bindingKind] += 1;
  }
  return {
    total: descriptors.length,
    bindingCount: descriptors.filter((descriptor) => descriptor.unresolvedReason === null).length,
    unresolvedCount: unresolved.length,
    valueKindCounts,
    bindingKindCounts,
  };
}

export function loadApplicationConfigBundle(repoRoot: string): ConfigBindingBundle {
  const detectedPlugins = detectPlugins(repoRoot);
  const bundles: ConfigBindingBundle[] = [];

  for (const filePath of findApplicationConfigFiles(repoRoot)) {
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const parsed = parseConfigWithPluginParsers(filePath, content, detectedPlugins);
    if (parsed.entries.length > 0) {
      bundles.push(describeConfigEntries(parsed.entries));
    }

    const materializedEntries = materializeConfigEntriesFromSignals(parsed.derivedSignals ?? [], filePath);
    if (materializedEntries.length > 0) {
      bundles.push(describeConfigEntries(materializedEntries));
    }
  }

  return mergeConfigBindingBundles(...bundles);
}

function descriptorKey(descriptor: ConfigBindingDescriptor): string {
  return [
    descriptor.sourceKind,
    descriptor.normalizedKey,
    descriptor.value ?? '',
    descriptor.sourceType,
    descriptor.filePath ?? '',
  ].join('|');
}

function uniqueDescriptors(descriptors: ConfigBindingDescriptor[]): ConfigBindingDescriptor[] {
  const seen = new Set<string>();
  const unique: ConfigBindingDescriptor[] = [];
  for (const descriptor of descriptors) {
    const key = descriptorKey(descriptor);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(descriptor);
  }
  return unique;
}

function scoreConfigKeyMatch(configKey: string, candidate: ConfigBindingDescriptor): number {
  const requested = normalizeConfigKey(configKey);
  const candidateKey = candidate.normalizedKey;
  if (requested.length === 0 || candidateKey.length === 0) return 0;
  if (requested === candidateKey) return 1000 + candidateKey.length;
  const requestedSegments = splitConfigKeySegments(requested);
  const candidateSegments = splitConfigKeySegments(candidateKey);
  const overlap = requestedSegments.filter((segment) => candidateSegments.includes(segment)).length;
  let score = overlap * 25;
  if (candidateKey.endsWith(`.${requested}`) || candidateKey.endsWith(requested)) {
    score += 200;
  }
  if (requested.endsWith(`.${candidateKey}`) || requested.endsWith(candidateKey)) {
    score += 120;
  }
  if (candidateKey.includes(requested) || requested.includes(candidateKey)) {
    score += 60;
  }
  return score + Math.min(candidateKey.length, 120) / 10;
}

function resolveConfigKeyDescriptors(
  configKeys: string[],
  descriptors: ConfigBindingDescriptor[],
): { descriptors: ConfigBindingDescriptor[]; unresolved: ConfigBindingUnresolved[] } {
  const resolved: ConfigBindingDescriptor[] = [];
  const unresolved: ConfigBindingUnresolved[] = [];

  for (const rawKey of uniqueSortedStrings(configKeys)) {
    const normalizedKey = normalizeConfigKey(rawKey);
    const candidates = descriptors
      .map((descriptor) => ({ descriptor, score: scoreConfigKeyMatch(normalizedKey, descriptor) }))
      .filter((row) => row.score > 0)
      .sort((left, right) => right.score - left.score || right.descriptor.normalizedKey.length - left.descriptor.normalizedKey.length);

    const best = candidates[0];
    if (!best) {
      const keyDescriptor = buildDescriptor({
        key: rawKey,
        value: null,
        sourceKind: 'config_key',
        sourceType: 'derived',
        filePath: null,
        unresolvedReason: 'no_matching_config_entry',
      });
      resolved.push(keyDescriptor);
      unresolved.push({
        key: rawKey,
        value: null,
        sourceKind: 'config_key',
        sourceType: 'derived',
        filePath: null,
        reason: 'no_matching_config_entry',
      });
      continue;
    }

    const candidate = best.descriptor;
    const merged = buildDescriptor({
      key: rawKey,
      value: candidate.value,
      sourceKind: 'config_key',
      sourceType: candidate.sourceType,
      filePath: candidate.filePath,
      matchedConfigKeys: uniqueSortedStrings([rawKey, ...candidate.matchedConfigKeys]),
      matchStrategy: best.score >= 1000 ? 'exact' : best.score >= 200 ? 'suffix' : 'token',
      matchScore: best.score,
      unresolvedReason: candidate.unresolvedReason,
    });

    resolved.push({
      ...merged,
      hostHints: uniqueSortedStrings([...merged.hostHints, ...candidate.hostHints]),
      pathHints: uniqueSortedStrings([...merged.pathHints, ...candidate.pathHints]),
      portHints: uniqueSortedStrings([...merged.portHints, ...candidate.portHints]),
      messageTopicHints: uniqueSortedStrings([...merged.messageTopicHints, ...candidate.messageTopicHints]),
      messageQueueHints: uniqueSortedStrings([...merged.messageQueueHints, ...candidate.messageQueueHints]),
      resolvedUrl: merged.resolvedUrl ?? candidate.resolvedUrl,
      unresolvedReason: merged.unresolvedReason === 'value_not_available' && candidate.unresolvedReason === null
        ? null
        : merged.unresolvedReason,
    });
  }

  return { descriptors: resolved, unresolved };
}

export function describeConfigEntries(entries: ConfigEntry[]): ConfigBindingBundle {
  const descriptors = uniqueDescriptors(entries.map((entry) =>
    buildDescriptor({
      key: entry.key,
      value: entry.value,
      sourceKind: 'config_entry',
      sourceType: entry.sourceType,
      filePath: entry.filePath,
    })));
  const unresolved = descriptors
    .filter((descriptor) => descriptor.unresolvedReason !== null)
    .map((descriptor) => ({
      key: descriptor.key,
      value: descriptor.value,
      sourceKind: descriptor.sourceKind,
      sourceType: descriptor.sourceType,
      filePath: descriptor.filePath,
      reason: descriptor.unresolvedReason ?? 'unresolved',
    }));
  return {
    descriptors,
    unresolved,
    summary: buildSummary(descriptors, unresolved),
  };
}

export function describeConfigKeys(configKeys: string[]): ConfigBindingBundle {
  const descriptors = uniqueDescriptors(uniqueSortedStrings(configKeys).map((key) =>
    buildDescriptor({
      key,
      value: null,
      sourceKind: 'config_key',
      sourceType: 'derived',
      filePath: null,
    })));
  const unresolved = descriptors
    .filter((descriptor) => descriptor.unresolvedReason !== null)
    .map((descriptor) => ({
      key: descriptor.key,
      value: descriptor.value,
      sourceKind: descriptor.sourceKind,
      sourceType: descriptor.sourceType,
      filePath: descriptor.filePath,
      reason: descriptor.unresolvedReason ?? 'unresolved',
    }));
  return {
    descriptors,
    unresolved,
    summary: buildSummary(descriptors, unresolved),
  };
}

export function resolveConfigKeysAgainstEntries(
  configKeys: string[],
  entryBundle: ConfigBindingBundle,
): ConfigBindingBundle {
  const { descriptors, unresolved } = resolveConfigKeyDescriptors(configKeys, entryBundle.descriptors);
  const combinedUnresolved = [...entryBundle.unresolved, ...unresolved];
  return {
    descriptors,
    unresolved: combinedUnresolved,
    summary: buildSummary(descriptors, combinedUnresolved),
  };
}

export function mergeConfigBindingBundles(...bundles: ConfigBindingBundle[]): ConfigBindingBundle {
  const descriptors = uniqueDescriptors(bundles.flatMap((bundle) => bundle.descriptors));
  const unresolved = bundles.flatMap((bundle) => bundle.unresolved);
  return {
    descriptors,
    unresolved,
    summary: buildSummary(descriptors, unresolved),
  };
}
