import { extname } from 'path';
import type { ExtractedSignal, FileScanResult } from '../codeSignalExtractor';
import { mergeHybridSignals } from '../hybridSignalMerge';
import { detectPlugins, pluginRegistry } from './pluginRegistry';
import type {
  ConfigEntry,
  FrameworkAstScanContext,
  FrameworkConfigParserResult,
  FrameworkLanguage,
  FrameworkPlugin,
} from './types';

function signalKey(signal: ExtractedSignal): string {
  return [
    signal.kind,
    signal.symbol,
    signal.lineStart,
    signal.lineEnd,
    signal.excerpt,
  ].join('::');
}

function mergeSignals(...groups: ExtractedSignal[][]): ExtractedSignal[] {
  const merged = new Map<string, ExtractedSignal>();

  for (const group of groups) {
    for (const signal of group) {
      const key = signalKey(signal);
      const existing = merged.get(key);
      if (!existing || signal.confidence > existing.confidence) {
        merged.set(key, signal);
      }
    }
  }

  return Array.from(merged.values());
}

function clampConfidence(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function applyConfidenceRules(
  signal: ExtractedSignal,
  rules: NonNullable<FrameworkPlugin['confidenceRules']> | undefined,
): ExtractedSignal {
  if (!rules || rules.length === 0) return signal;

  let confidence = signal.confidence;
  for (const rule of rules) {
    if (rule.signalKind !== signal.kind) continue;
    if (!rule.condition(signal)) continue;
    confidence = clampConfidence(confidence + rule.adjustment);
  }

  return confidence === signal.confidence ? signal : { ...signal, confidence };
}

function applyConfidenceRulesToSignals(
  signals: ExtractedSignal[],
  rules: NonNullable<FrameworkPlugin['confidenceRules']> | undefined,
): ExtractedSignal[] {
  if (!rules || rules.length === 0 || signals.length === 0) return signals;
  return signals.map((signal) => applyConfidenceRules(signal, rules));
}

function applyConfidenceRulesToResult(
  result: FileScanResult,
  rules: NonNullable<FrameworkPlugin['confidenceRules']> | undefined,
): FileScanResult {
  if (!rules || rules.length === 0 || result.signals.length === 0) return result;
  return {
    ...result,
    signals: applyConfidenceRulesToSignals(result.signals, rules),
  };
}

export function detectLanguageFromFilePath(filePath: string): FrameworkLanguage | null {
  const extension = extname(filePath).toLowerCase();

  if (extension === '.java') return 'java';
  if (extension === '.kt' || extension === '.kts') return 'kotlin';
  if (extension === '.ts' || extension === '.tsx') return 'typescript';
  if (extension === '.js' || extension === '.jsx') return 'javascript';
  if (extension === '.py') return 'python';

  return null;
}

function mergeFileResults(language: FrameworkLanguage, sha256: string, results: FileScanResult[]): FileScanResult {
  const signals = mergeSignals(...results.map((result) => result.signals));
  const packageName = results.find((result) => typeof result.packageName === 'string')?.packageName;

  return packageName ? { language, sha256, packageName, signals } : { language, sha256, signals };
}

function selectPluginsForFile(filePath: string, detected: FrameworkPlugin[]): FrameworkPlugin[] {
  const language = detectLanguageFromFilePath(filePath);
  if (!language) return [];

  const matched = detected.filter((plugin) => plugin.languages.includes(language));
  if (matched.length > 0) return matched;

  const fallback = pluginRegistry.getFallbackForLanguage(language);
  return fallback ? [fallback] : [];
}

function configEntryKey(entry: ConfigEntry): string {
  return `${entry.filePath}::${entry.key}::${entry.value}::${entry.sourceType}`;
}

type ConfigBindingValueKind = 'url' | 'host' | 'topic' | 'queue' | 'port' | 'path' | 'property';
type ConfigBindingKind = 'base_url' | 'gateway_target' | 'service_discovery' | 'property_alias';

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
  if (isHostPortLike(normalizedValue) || /^[^/\s:]+$/.test(normalizedValue)) return 'host';
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

function summarizeConfigEntries(entries: ConfigEntry[]): {
  total: number;
  bindingCount: number;
  unresolvedCount: number;
  valueKindCounts: Record<ConfigBindingValueKind, number>;
  bindingKindCounts: Record<ConfigBindingKind, number>;
} {
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

  let bindingCount = 0;
  for (const entry of entries) {
    const value = entry.value.trim();
    const valueKind = inferValueKind(entry.key, value.length > 0 ? value : null);
    const bindingKind = inferBindingKind(entry.key, valueKind);
    valueKindCounts[valueKind] += 1;
    bindingKindCounts[bindingKind] += 1;
    if (value.length > 0) {
      bindingCount += 1;
    }
  }

  return {
    total: entries.length,
    bindingCount,
    unresolvedCount: entries.length - bindingCount,
    valueKindCounts,
    bindingKindCounts,
  };
}

export function parseConfigWithPluginParsers(
  filePath: string,
  content: string,
  detectedPlugins: FrameworkPlugin[],
): FrameworkConfigParserResult {
  const entries = new Map<string, ConfigEntry>();
  const derivedSignals: ExtractedSignal[] = [];
  const metadataByParser: Record<string, unknown> = {};

  for (const plugin of detectedPlugins) {
    for (const parser of plugin.configParsers ?? []) {
      const isMatch = parser.fileMatchers.some((matcher) => {
        try {
          return matcher(filePath);
        } catch {
          return false;
        }
      });
      if (!isMatch) continue;

      let parsed: FrameworkConfigParserResult;
      try {
        parsed = parser.parse(filePath, content);
      } catch {
        continue;
      }

      for (const entry of parsed.entries ?? []) {
        entries.set(configEntryKey(entry), entry);
      }
      derivedSignals.push(...applyConfidenceRulesToSignals(parsed.derivedSignals ?? [], plugin.confidenceRules));
      const entryCount = parsed.entries?.length ?? 0;
      const configBindingSummary = summarizeConfigEntries(parsed.entries ?? []);
      if (parsed.metadata) {
        metadataByParser[`${plugin.id}:${parser.id}`] = {
          ...parsed.metadata,
          derivedSignalCount: parsed.derivedSignals?.length ?? 0,
          configBindingSummary,
        };
      } else if (entryCount > 0) {
        metadataByParser[`${plugin.id}:${parser.id}`] = {
          derivedSignalCount: parsed.derivedSignals?.length ?? 0,
          configBindingSummary,
        };
      }
    }
  }

  return {
    entries: Array.from(entries.values()),
    derivedSignals,
    ...(Object.keys(metadataByParser).length > 0 ? { metadata: metadataByParser } : {}),
  };
}

export function scanFileWithRegexPlugins(
  filePath: string,
  content: string,
  repoRoot: string,
  detectedPlugins: FrameworkPlugin[] = detectPlugins(repoRoot),
): FileScanResult {
  const language = detectLanguageFromFilePath(filePath);
  if (!language) {
    throw new Error(`unsupported file language: ${filePath}`);
  }

  const selected = selectPluginsForFile(filePath, detectedPlugins);
  const results = selected
    .map((plugin) => plugin.regexScanner?.(filePath, content) ?? plugin.scanRegex?.(filePath, content) ?? null)
    .map((result, index) => (
      result ? applyConfidenceRulesToResult(result, selected[index]?.confidenceRules) : null
    ))
    .filter((result): result is FileScanResult => result !== null);

  if (results.length === 0) {
    return { language, sha256: '', signals: [] };
  }

  return mergeFileResults(language, results[0]!.sha256, results);
}

export async function scanFileWithHybridPlugins(
  filePath: string,
  content: string,
  repoRoot: string,
  detectedPlugins: FrameworkPlugin[] = detectPlugins(repoRoot),
): Promise<FileScanResult> {
  const language = detectLanguageFromFilePath(filePath);
  if (!language) {
    throw new Error(`unsupported file language: ${filePath}`);
  }

  const selected = selectPluginsForFile(filePath, detectedPlugins);
  const regexResults = selected
    .map((plugin) => {
      const result = plugin.regexScanner?.(filePath, content) ?? plugin.scanRegex?.(filePath, content) ?? null;
      return result ? applyConfidenceRulesToResult(result, plugin.confidenceRules) : null;
    })
    .filter((result): result is FileScanResult => result !== null);
  const astResults = (
    await Promise.all(
      selected.map(async (plugin) => {
        try {
          const result = await Promise.resolve(
            plugin.astExtractor?.(filePath, content, {}) ??
              plugin.scanAst?.(filePath, content, {}) ??
              null,
          );
          return result ? applyConfidenceRulesToResult(result, plugin.confidenceRules) : null;
        } catch {
          return null;
        }
      }),
    )
  ).filter((result): result is FileScanResult => result !== null);

  if (regexResults.length === 0 && astResults.length === 0) {
    return { language, sha256: '', signals: [] };
  }

  const base = astResults[0] ?? regexResults[0]!;
  const mergedSignals = mergeHybridSignals([
    ...mergeSignals(...regexResults.map((result) => result.signals)).map((signal) => ({
      source: 'regex' as const,
      signal,
    })),
    ...mergeSignals(...astResults.map((result) => result.signals)).map((signal) => ({
      source: 'ast' as const,
      signal,
    })),
  ]);

  return base.packageName
    ? { language: base.language, sha256: base.sha256, packageName: base.packageName, signals: mergedSignals }
    : { language: base.language, sha256: base.sha256, signals: mergedSignals };
}

export async function scanFileWithAstPlugins(
  filePath: string,
  content: string,
  repoRoot: string,
  context: FrameworkAstScanContext = {},
  detectedPlugins: FrameworkPlugin[] = detectPlugins(repoRoot),
): Promise<FileScanResult> {
  const language = detectLanguageFromFilePath(filePath);
  if (!language) {
    throw new Error(`unsupported file language: ${filePath}`);
  }

  const selected = selectPluginsForFile(filePath, detectedPlugins);
  const astResults = (
    await Promise.all(
      selected.map((plugin) =>
        Promise.resolve(
          plugin.scanAst?.(filePath, content, context)
            ?? plugin.astExtractor?.(filePath, content, context)
            ?? null,
        ).then((result) => (result ? applyConfidenceRulesToResult(result, plugin.confidenceRules) : null)),
      ),
    )
  ).filter((result): result is FileScanResult => result !== null);

  if (astResults.length === 0) {
    return { language, sha256: '', signals: [] };
  }

  return mergeFileResults(language, astResults[0]!.sha256, astResults);
}
