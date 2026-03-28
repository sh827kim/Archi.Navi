import { createHash } from 'crypto';
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
