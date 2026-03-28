import { extname } from 'path';
import type { ExtractedSignal, FileScanResult } from '../codeSignalExtractor';
import { mergeHybridSignals } from '../hybridSignalMerge';
import { detectPlugins, pluginRegistry } from './pluginRegistry';
import type { FrameworkAstScanContext, FrameworkLanguage, FrameworkPlugin } from './types';

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
    .map((plugin) => plugin.regexScanner?.(filePath, content) ?? plugin.scanRegex?.(filePath, content) ?? null)
    .filter((result): result is FileScanResult => result !== null);
  const astResults = (
    await Promise.all(
      selected.map(async (plugin) => {
        try {
          return await Promise.resolve(
            plugin.astExtractor?.(filePath, content, {}) ??
              plugin.scanAst?.(filePath, content, {}) ??
              null,
          );
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
        ),
      ),
    )
  ).filter((result): result is FileScanResult => result !== null);

  if (astResults.length === 0) {
    return { language, sha256: '', signals: [] };
  }

  return mergeFileResults(language, astResults[0]!.sha256, astResults);
}
