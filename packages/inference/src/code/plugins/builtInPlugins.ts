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

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();

    const requestAbsMatch = trimmed.match(/\b\w+\.requestAbs\(\s*["']([^"']+)["']/);
    if (requestAbsMatch) {
      signals.push({
        kind: 'call',
        symbol: requestAbsMatch[1]!,
        lineStart: index + 1,
        lineEnd: index + 1,
        excerpt: trimmed,
        confidence: 0.78,
        metadata: { framework: 'vertx', client: 'VertxWebClient', method: 'REQUEST_ABS' },
      });
    }

    const absMethodMatch = trimmed.match(/\b\w+\.(getAbs|postAbs|putAbs|deleteAbs|patchAbs)\(\s*["']([^"']+)["']/i);
    if (absMethodMatch) {
      signals.push({
        kind: 'call',
        symbol: absMethodMatch[2]!,
        lineStart: index + 1,
        lineEnd: index + 1,
        excerpt: trimmed,
        confidence: 0.8,
        metadata: {
          framework: 'vertx',
          client: 'VertxWebClient',
          method: absMethodMatch[1]!.replace('Abs', '').toUpperCase(),
        },
      });
    }

    const eventBusMatch = trimmed.match(/\beventBus\.(send|request)\(\s*["']([^"']+)["']/i);
    if (eventBusMatch) {
      signals.push({
        kind: 'produce',
        symbol: eventBusMatch[2]!,
        lineStart: index + 1,
        lineEnd: index + 1,
        excerpt: trimmed,
        confidence: 0.77,
        metadata: { framework: 'vertx', client: 'EventBus', pattern: eventBusMatch[1] },
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
  return base.startsWith('application') || base.startsWith('bootstrap');
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
    parse: (filePath: string, content: string) => ({
      entries: parseJsonConfigEntries(content).map((entry) => ({
        ...entry,
        filePath,
        sourceType: 'json' as const,
      })),
      metadata: { parser: 'application-json' },
    }),
  },
  {
    id: 'application-yaml',
    fileMatchers: [
      (filePath: string) =>
        isApplicationConfigFile(filePath)
        && (filePath.toLowerCase().endsWith('.yml') || filePath.toLowerCase().endsWith('.yaml')),
    ],
    parse: (filePath: string, content: string) => ({
      entries: parseYamlConfigEntries(content).map((entry) => ({
        ...entry,
        filePath,
        sourceType: 'yaml' as const,
      })),
      metadata: { parser: 'application-yaml' },
    }),
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
