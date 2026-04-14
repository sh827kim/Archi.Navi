import { createHash } from 'crypto';
import yaml from 'js-yaml';
import { scanJavaKotlin } from '../scanners/javaKotlin';
import { scanTypeScript } from '../scanners/typeScript';
import { scanPython } from '../scanners/python';
import { scanJavaKotlinAst } from '../ast/astJavaKotlin';
import { scanTypeScriptAst } from '../ast/astTypeScript';
import { scanPythonAst } from '../ast/astPython';
import type { ExtractedSignal, FileScanResult } from '../codeSignalExtractor';
import type { FrameworkPlugin } from './types';

function signalMetadata(signal: ExtractedSignal): Record<string, unknown> {
  return (signal.metadata ?? {}) as Record<string, unknown>;
}

function metadataString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function metadataStringArray(metadata: Record<string, unknown>, key: string): string[] {
  const value = metadata[key];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
  }
  const singleValue = metadataString(metadata, key);
  return singleValue ? [singleValue] : [];
}

function metadataHasAnyToken(metadata: Record<string, unknown>, tokens: string[]): boolean {
  const keys = [
    ...metadataStringArray(metadata, 'configKeys'),
    metadataString(metadata, 'configKey'),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  return keys.some((key) => tokens.some((token) => key.toLowerCase().includes(token)));
}

function signalKey(signal: ExtractedSignal): string {
  return `${signal.kind}::${signal.symbol}::${signal.lineStart}::${signal.lineEnd}`;
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

function createNestJsScanResult(filePath: string, content: string): FileScanResult {
  const base = scanTypeScript(filePath, content);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const language = base.language;
  const lines = content.split('\n');
  const signals: ExtractedSignal[] = [];
  let controllerPath = '';

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    const controllerMatch = line.match(/@Controller\(\s*(?:["'`]([^"'`]+)["'`])?\s*\)/);
    if (controllerMatch) {
      controllerPath = controllerMatch[1] ?? '';
      continue;
    }

    const methodMatch = line.match(/@(Get|Post|Put|Delete|Patch)\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)/);
    if (!methodMatch) continue;

    const controllerBase = controllerPath.length === 0
      ? ''
      : controllerPath.startsWith('/')
        ? controllerPath
        : `/${controllerPath}`;
    const methodPath = !methodMatch[2]
      ? ''
      : methodMatch[2]!.startsWith('/')
        ? methodMatch[2]!
        : `/${methodMatch[2]!}`;

    signals.push({
      kind: 'expose',
      symbol: `${controllerBase}${methodPath}` || '/',
      lineStart: index + 1,
      lineEnd: index + 1,
      excerpt: line.trim(),
      confidence: 0.8,
      metadata: {
        framework: 'nestjs',
        method: methodMatch[1]!.toUpperCase(),
        controllerPath,
      },
    });
  }

  return {
    language,
    sha256,
    signals: mergeSignals(base.signals, signals),
  };
}

function createVertxScanResult(filePath: string, content: string): FileScanResult {
  const base = scanJavaKotlin(filePath, content);
  const sha256 = createHash('sha256').update(content).digest('hex');
  const lines = content.split('\n');
  const signals: ExtractedSignal[] = [];

  const readStringLiteral = (expr: string): string | null => {
    const match = expr.trim().match(/^["'`]([^"'`]+)["'`]$/);
    return match?.[1] ?? null;
  };
  const extractConfigKey = (expr: string): string | null => {
    const literal = readStringLiteral(expr);
    if (literal && /\./.test(literal)) return literal;
    const getterMatch = expr.match(/getString\(\s*["'`]([^"'`]+)["'`]\s*\)/);
    return getterMatch?.[1] ?? null;
  };
  const extractPathHint = (expr: string): string | null => {
    const pathMatch = expr.match(/["'`]([^"'`]*\/[^"'`]*)["'`]/);
    return pathMatch?.[1] ?? null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();

    const requestAbsMatch = trimmed.match(/\b\w+\.requestAbs\(\s*([^,]+)\s*,\s*([^)]+)\)/);
    if (requestAbsMatch) {
      const rawTarget = requestAbsMatch[2]!.trim();
      const literalTarget = readStringLiteral(rawTarget);
      const configKey = extractConfigKey(rawTarget);
      signals.push({
        kind: 'call',
        symbol: literalTarget ?? extractPathHint(rawTarget) ?? rawTarget,
        lineStart: index + 1,
        lineEnd: index + 1,
        excerpt: trimmed,
        confidence: 0.78,
        metadata: {
          framework: 'vertx',
          client: 'VertxWebClient',
          method: 'REQUEST_ABS',
          ...(extractPathHint(rawTarget) ? { pathHint: extractPathHint(rawTarget) } : {}),
          ...(configKey ? { configKeys: [configKey] } : {}),
          dynamicPath: literalTarget === null,
          unsupportedPattern: true,
        },
      });
    }

    const absMethodMatch = trimmed.match(/\b\w+\.(getAbs|postAbs|putAbs|deleteAbs|patchAbs)\(\s*([^)]+)\)/i);
    if (absMethodMatch) {
      const rawTarget = absMethodMatch[2]!.trim();
      const literalTarget = readStringLiteral(rawTarget);
      const configKey = extractConfigKey(rawTarget);
      signals.push({
        kind: 'call',
        symbol: literalTarget ?? extractPathHint(rawTarget) ?? rawTarget,
        lineStart: index + 1,
        lineEnd: index + 1,
        excerpt: trimmed,
        confidence: 0.8,
        metadata: {
          framework: 'vertx',
          client: 'VertxWebClient',
          method: absMethodMatch[1]!.replace('Abs', '').toUpperCase(),
          ...(extractPathHint(rawTarget) ? { pathHint: extractPathHint(rawTarget) } : {}),
          ...(configKey ? { configKeys: [configKey] } : {}),
          dynamicPath: literalTarget === null,
          unsupportedPattern: true,
        },
      });
    }

    const eventBusMatch = trimmed.match(/(?:\bvertx\.)?eventBus\(\)\.(send|request)\(\s*([^,\n]+)/i)
      ?? trimmed.match(/\beventBus\.(send|request)\(\s*([^,\n]+)/i);
    if (eventBusMatch) {
      const rawAddress = eventBusMatch[2]!.trim();
      const literalAddress = readStringLiteral(rawAddress);
      const configKey = extractConfigKey(rawAddress);
      signals.push({
        kind: 'produce',
        symbol: literalAddress ?? rawAddress,
        lineStart: index + 1,
        lineEnd: index + 1,
        excerpt: trimmed,
        confidence: 0.77,
        metadata: {
          framework: 'vertx',
          client: 'EventBus',
          pattern: eventBusMatch[1],
          ...(configKey ? { configKeys: [configKey] } : {}),
          dynamicPath: literalAddress === null,
          unsupportedPattern: true,
        },
      });
    }

    const producerFactoryMatch = trimmed.match(/\.(publish|produce)\(\s*([^,\n]+)/i);
    if (producerFactoryMatch && /MessageProducerFactory|ProducerFactory|producerFactory/i.test(trimmed)) {
      const rawAddress = producerFactoryMatch[2]!.trim();
      const literalAddress = readStringLiteral(rawAddress);
      const configKey = extractConfigKey(rawAddress);
      signals.push({
        kind: 'produce',
        symbol: literalAddress ?? rawAddress,
        lineStart: index + 1,
        lineEnd: index + 1,
        excerpt: trimmed,
        confidence: 0.76,
        metadata: {
          framework: 'vertx',
          client: 'MessageProducerFactory',
          pattern: producerFactoryMatch[1]!.toLowerCase(),
          ...(configKey ? { configKeys: [configKey] } : {}),
          unsupportedPattern: true,
        },
      });
    }

    const routerMatch = trimmed.match(/\brouter\.(route|get|post|put|delete|patch)\(\s*["']([^"']+)["']/i);
    if (routerMatch) {
      const method = routerMatch[1]!.toUpperCase();
      signals.push({
        kind: 'expose',
        symbol: routerMatch[2]!,
        lineStart: index + 1,
        lineEnd: index + 1,
        excerpt: trimmed,
        confidence: 0.8,
        metadata: { framework: 'vertx', method: method === 'ROUTE' ? 'ANY' : method, annotation: '@VertxRoute' },
      });
    }
  }

  return {
    language: base.language,
    sha256,
    ...(base.packageName ? { packageName: base.packageName } : {}),
    signals: mergeSignals(base.signals, signals),
  };
}

function isApplicationConfigFile(filePath: string): boolean {
  const base = filePath.split('/').pop()?.toLowerCase() ?? '';
  return (
    (base.startsWith('application') || base.startsWith('bootstrap'))
    && (base.endsWith('.yml') || base.endsWith('.yaml') || base.endsWith('.json') || base.endsWith('.properties'))
  );
}

function parsePropertiesConfigEntries(content: string): Array<{ key: string; value: string }> {
  const flattened: Array<{ key: string; value: string }> = [];
  const lines = content.split(/\r?\n/);
  let currentKey = '';
  let currentValue = '';
  let continuing = false;

  const commitEntry = () => {
    const key = currentKey.trim();
    const value = currentValue.trim();
    if (key.length > 0) {
      flattened.push({ key, value });
    }
    currentKey = '';
    currentValue = '';
    continuing = false;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith('!')) {
      if (!continuing) commitEntry();
      continue;
    }

    if (continuing) {
      currentValue += line.replace(/\\$/, '');
      continuing = rawLine.endsWith('\\');
      if (!continuing) commitEntry();
      continue;
    }

    const separatorIndex = line.search(/[:=\s]/);
    if (separatorIndex <= 0) {
      currentKey = line;
      currentValue = '';
      commitEntry();
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (value.startsWith('=') || value.startsWith(':')) {
      value = value.slice(1).trim();
    }
    currentKey = key;
    currentValue = value.replace(/\\$/, '');
    continuing = rawLine.endsWith('\\');
    if (!continuing) commitEntry();
  }

  if (continuing || currentKey.length > 0) {
    commitEntry();
  }

  return flattened.filter((entry) => entry.key.length > 0);
}

function inferConfigDerivedSignalKind(key: string, value: string): ExtractedSignal['kind'] {
  const normalizedKey = key.toLowerCase();
  if (normalizedKey.includes('queue')) return 'consume';
  if (normalizedKey.includes('topic') || normalizedKey.includes('producer')) return 'produce';
  if (normalizedKey.includes('consumer')) return 'consume';
  if (normalizedKey.includes('datasource') || normalizedKey.includes('database') || normalizedKey.includes('db')) {
    return 'db_read';
  }
  if (
    normalizedKey.includes('url')
    || normalizedKey.includes('uri')
    || normalizedKey.includes('path')
    || normalizedKey.includes('host')
    || normalizedKey.includes('port')
    || normalizedKey.includes('endpoint')
  ) {
    return 'call';
  }
  if (/^(http|https|jdbc|amqp|kafka|rabbitmq|redis):/i.test(value)) {
    return 'call';
  }
  return 'call';
}

function buildDerivedSignalsFromConfigEntries(
  filePath: string,
  sourceType: 'yaml' | 'json' | 'properties',
  entries: Array<{ key: string; value: string }>,
): ExtractedSignal[] {
  return entries.map((entry, index) => ({
    kind: inferConfigDerivedSignalKind(entry.key, entry.value),
    symbol: entry.value || entry.key,
    lineStart: index + 1,
    lineEnd: index + 1,
    excerpt: `${entry.key}=${entry.value}`.trim(),
    confidence: 0.62,
    metadata: {
      parser: `application-${sourceType}`,
      sourceType,
      filePath,
      configKey: entry.key,
      configKeys: [entry.key],
      value: entry.value,
    },
  }));
}

function flattenConfigValue(
  value: unknown,
  prefix: string,
  collector: Array<{ key: string; value: string }>,
): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      flattenConfigValue(entry, `${prefix}.${index}`, collector);
    });
    return;
  }
  if (typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const nestedPrefix = prefix.length > 0 ? `${prefix}.${key}` : key;
      flattenConfigValue(nested, nestedPrefix, collector);
    }
    return;
  }
  collector.push({ key: prefix, value: String(value) });
}

function parseJsonConfigEntries(content: string): Array<{ key: string; value: string }> {
  const parsed = JSON.parse(content) as unknown;
  const flattened: Array<{ key: string; value: string }> = [];
  flattenConfigValue(parsed, '', flattened);
  return flattened.filter((entry) => entry.key.length > 0);
}

function parseYamlConfigEntries(content: string): Array<{ key: string; value: string }> {
  const documents = yaml.loadAll(content) as unknown[];
  const flattened: Array<{ key: string; value: string }> = [];
  for (const document of documents) {
    flattenConfigValue(document, '', flattened);
  }
  return flattened.filter((entry) => entry.key.length > 0);
}

const DEFAULT_CONFIG_PARSERS = [
  {
    id: 'application-json',
    fileMatchers: [
      (filePath: string) => isApplicationConfigFile(filePath) && filePath.toLowerCase().endsWith('.json'),
    ],
    parse: (filePath: string, content: string) => {
      const entries = parseJsonConfigEntries(content);
      return {
        entries: entries.map((entry) => ({
          ...entry,
          filePath,
          sourceType: 'json' as const,
        })),
        derivedSignals: buildDerivedSignalsFromConfigEntries(filePath, 'json', entries),
        metadata: {
          parser: 'application-json',
          entryCount: entries.length,
          derivedSignalCount: entries.length,
        },
      };
    },
  },
  {
    id: 'application-yaml',
    fileMatchers: [
      (filePath: string) =>
        isApplicationConfigFile(filePath)
        && (filePath.toLowerCase().endsWith('.yml') || filePath.toLowerCase().endsWith('.yaml')),
    ],
    parse: (filePath: string, content: string) => {
      const entries = parseYamlConfigEntries(content);
      return {
        entries: entries.map((entry) => ({
          ...entry,
          filePath,
          sourceType: 'yaml' as const,
        })),
        derivedSignals: buildDerivedSignalsFromConfigEntries(filePath, 'yaml', entries),
        metadata: {
          parser: 'application-yaml',
          entryCount: entries.length,
          derivedSignalCount: entries.length,
        },
      };
    },
  },
  {
    id: 'application-properties',
    fileMatchers: [
      (filePath: string) =>
        isApplicationConfigFile(filePath) && filePath.toLowerCase().endsWith('.properties'),
    ],
    parse: (filePath: string, content: string) => {
      const entries = parsePropertiesConfigEntries(content);
      return {
        entries: entries.map((entry) => ({
          ...entry,
          filePath,
          sourceType: 'properties' as const,
        })),
        derivedSignals: buildDerivedSignalsFromConfigEntries(filePath, 'properties', entries),
        metadata: {
          parser: 'application-properties',
          entryCount: entries.length,
          derivedSignalCount: entries.length,
        },
      };
    },
  },
];

export const BUILT_IN_FRAMEWORK_PLUGINS: FrameworkPlugin[] = [
  {
    id: 'spring-boot',
    displayName: 'Spring Boot',
    version: '1.0.0',
    languages: ['java', 'kotlin'],
    detector: {
      manifestMatches: [
        { fileName: 'pom.xml', pattern: /spring-boot|org\.springframework/i },
        { fileName: 'build.gradle', pattern: /spring-boot|org\.springframework/i },
        { fileName: 'build.gradle.kts', pattern: /spring-boot|org\.springframework/i },
      ],
    },
    regexScanner: scanJavaKotlin,
    scanRegex: scanJavaKotlin,
    astExtractor: (filePath, content, context) => scanJavaKotlinAst(filePath, content, context),
    scanAst: (filePath, content, context) => scanJavaKotlinAst(filePath, content, context),
    configParsers: DEFAULT_CONFIG_PARSERS,
    confidenceRules: [
      {
        signalKind: 'call',
        condition: (signal) => {
          const metadata = signalMetadata(signal);
          const sourceType = metadataString(metadata, 'sourceType');
          return (
            sourceType !== null
            && ['yaml', 'json', 'properties'].includes(sourceType)
            && metadataHasAnyToken(metadata, ['url', 'uri', 'endpoint', 'path', 'host', 'port'])
          );
        },
        adjustment: 0.08,
      },
      {
        signalKind: 'produce',
        condition: (signal) => metadataHasAnyToken(signalMetadata(signal), ['topic', 'queue', 'producer']),
        adjustment: 0.06,
      },
      {
        signalKind: 'consume',
        condition: (signal) => metadataHasAnyToken(signalMetadata(signal), ['topic', 'queue', 'consumer']),
        adjustment: 0.05,
      },
    ],
  },
  {
    id: 'vertx',
    displayName: 'Vert.x',
    version: '1.0.0',
    languages: ['java', 'kotlin'],
    detector: {
      manifestMatches: [
        { fileName: 'pom.xml', pattern: /io\.vertx|vertx-web-client|vertx-core/i },
        { fileName: 'build.gradle', pattern: /io\.vertx|vertx-web-client|vertx-core/i },
        { fileName: 'build.gradle.kts', pattern: /io\.vertx|vertx-web-client|vertx-core/i },
      ],
    },
    regexScanner: createVertxScanResult,
    scanRegex: createVertxScanResult,
    astExtractor: (filePath, content, context) => scanJavaKotlinAst(filePath, content, context),
    scanAst: (filePath, content, context) => scanJavaKotlinAst(filePath, content, context),
    configParsers: DEFAULT_CONFIG_PARSERS,
  },
  {
    id: 'java-common',
    displayName: 'Java Common',
    version: '1.0.0',
    languages: ['java', 'kotlin'],
    regexScanner: scanJavaKotlin,
    scanRegex: scanJavaKotlin,
    astExtractor: (filePath, content, context) => scanJavaKotlinAst(filePath, content, context),
    scanAst: (filePath, content, context) => scanJavaKotlinAst(filePath, content, context),
    configParsers: DEFAULT_CONFIG_PARSERS,
    fallback: true,
  },
  {
    id: 'express',
    displayName: 'Express',
    version: '1.0.0',
    languages: ['typescript', 'javascript'],
    detector: {
      packageJsonDeps: ['express'],
    },
    regexScanner: scanTypeScript,
    scanRegex: scanTypeScript,
    astExtractor: (filePath, content) => scanTypeScriptAst(filePath, content),
    scanAst: (filePath, content) => scanTypeScriptAst(filePath, content),
  },
  {
    id: 'nestjs',
    displayName: 'NestJS',
    version: '1.0.0',
    languages: ['typescript', 'javascript'],
    detector: {
      packageJsonDeps: ['@nestjs/core', '@nestjs/common'],
    },
    regexScanner: createNestJsScanResult,
    scanRegex: createNestJsScanResult,
    astExtractor: (filePath, content) => scanTypeScriptAst(filePath, content),
    scanAst: (filePath, content) => scanTypeScriptAst(filePath, content),
  },
  {
    id: 'typescript-common',
    displayName: 'TypeScript Common',
    version: '1.0.0',
    languages: ['typescript', 'javascript'],
    regexScanner: scanTypeScript,
    scanRegex: scanTypeScript,
    astExtractor: (filePath, content) => scanTypeScriptAst(filePath, content),
    scanAst: (filePath, content) => scanTypeScriptAst(filePath, content),
    fallback: true,
  },
  {
    id: 'fastapi',
    displayName: 'FastAPI',
    version: '1.0.0',
    languages: ['python'],
    detector: {
      manifestMatches: [
        { fileName: 'pyproject.toml', pattern: /fastapi/i },
        { fileName: 'setup.py', pattern: /fastapi/i },
        { fileName: 'requirements.txt', pattern: /fastapi/i },
      ],
    },
    regexScanner: scanPython,
    scanRegex: scanPython,
    astExtractor: (filePath, content) => scanPythonAst(filePath, content),
    scanAst: (filePath, content) => scanPythonAst(filePath, content),
  },
  {
    id: 'flask',
    displayName: 'Flask',
    version: '1.0.0',
    languages: ['python'],
    detector: {
      manifestMatches: [
        { fileName: 'pyproject.toml', pattern: /flask/i },
        { fileName: 'setup.py', pattern: /flask/i },
        { fileName: 'requirements.txt', pattern: /flask/i },
      ],
    },
    regexScanner: scanPython,
    scanRegex: scanPython,
    astExtractor: (filePath, content) => scanPythonAst(filePath, content),
    scanAst: (filePath, content) => scanPythonAst(filePath, content),
  },
  {
    id: 'python-common',
    displayName: 'Python Common',
    version: '1.0.0',
    languages: ['python'],
    regexScanner: scanPython,
    scanRegex: scanPython,
    astExtractor: (filePath, content) => scanPythonAst(filePath, content),
    scanAst: (filePath, content) => scanPythonAst(filePath, content),
    fallback: true,
  },
];

export const builtInPlugins = BUILT_IN_FRAMEWORK_PLUGINS;

export function getBuiltInPlugins(): FrameworkPlugin[] {
  return [...BUILT_IN_FRAMEWORK_PLUGINS];
}
