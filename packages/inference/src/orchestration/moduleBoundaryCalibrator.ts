import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findFiles } from '@/utils/fileDiscovery';

export interface ModuleBoundaryScore {
  modulePath: string;
  score: number;
  reasons: string[];
  classification: 'service_candidate' | 'library_candidate' | 'inherited';
}

function parseGradleIncludes(content: string): string[] {
  const includes = [...content.matchAll(/include\(([^)]+)\)/g)]
    .flatMap((match) => match[1]?.split(',') ?? [])
    .map((entry) => entry.replace(/['"`\s]/g, ''))
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.replace(/^:/, '').replace(/:/g, '/'));
  return Array.from(new Set(includes));
}

function parseMavenModules(content: string): string[] {
  const modules = [...content.matchAll(/<modules\b[^>]*>([\s\S]*?)<\/modules>/gi)]
    .flatMap((match) => [...(match[1]?.matchAll(/<module>\s*([^<]+?)\s*<\/module>/gi) ?? [])])
    .map((match) => match[1]?.trim() ?? '')
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.replace(/\\/g, '/'));
  return Array.from(new Set(modules));
}

function collectMultiModulePaths(repoRoot: string): string[] {
  const modules = new Set<string>();

  const settingsGradle = ['settings.gradle', 'settings.gradle.kts']
    .map((name) => join(repoRoot, name))
    .find((path) => existsSync(path));
  if (settingsGradle) {
    const content = readFileSync(settingsGradle, 'utf-8');
    parseGradleIncludes(content).forEach((modulePath) => modules.add(modulePath));
  }

  const pomPath = join(repoRoot, 'pom.xml');
  if (existsSync(pomPath)) {
    const content = readFileSync(pomPath, 'utf-8');
    parseMavenModules(content).forEach((modulePath) => modules.add(modulePath));
  }

  return Array.from(modules);
}

function hasAnyFile(moduleRoot: string, relativePaths: string[]): boolean {
  return relativePaths.some((relativePath) => existsSync(join(moduleRoot, relativePath)));
}

export function scoreModuleExecutability(repoRoot: string, modulePath: string): ModuleBoundaryScore {
  const moduleRoot = join(repoRoot, modulePath);
  let score = 0;
  const reasons: string[] = [];

  if (
    hasAnyFile(moduleRoot, [
      'src/main/resources/application.yml',
      'src/main/resources/application.yaml',
      'src/main/resources/application.json',
      'src/main/resources/application.properties',
      'src/main/resources/bootstrap.properties',
    ])
  ) {
    score += 3;
    reasons.push('application config found (+3)');
  }

  if (hasAnyFile(moduleRoot, ['src/main/java', 'src/main/kotlin', 'src/main/ts', 'src/main/python'])) {
    score += 2;
    reasons.push('main source set found (+2)');
  }

  if (hasAnyFile(moduleRoot, ['src/main/resources', 'src/main'])) {
    score += 1;
    reasons.push('runtime resource root found (+1)');
  }

  const buildFiles = ['build.gradle', 'build.gradle.kts', 'pom.xml']
    .map((name) => join(moduleRoot, name))
    .filter((path) => existsSync(path));
  const hasExecutablePlugin = buildFiles.some((filePath) => {
    const content = readFileSync(filePath, 'utf-8');
    return /(spring-boot|application|org\.springframework\.boot|io\.quarkus|shadowJar)/i.test(content);
  });
  if (hasExecutablePlugin) {
    score += 3;
    reasons.push('executable plugin/entry found (+3)');
  }

  if (/(common|domain|shared|lib|library)/i.test(modulePath)) {
    score -= 3;
    reasons.push('library-like module naming (-3)');
  }

  const hasEntrypointFile = findFiles(moduleRoot, (filePath) => /Application\.(java|kt)$|main\.(ts|js|py)$/.test(filePath)).length > 0;
  if (!hasEntrypointFile && !hasExecutablePlugin) {
    score -= 3;
    reasons.push('no entrypoint and no executable plugin (-3)');
  }

  const classification = score >= 3
    ? 'service_candidate'
    : score <= -1
      ? 'library_candidate'
      : 'inherited';

  return { modulePath, score, reasons, classification };
}

export function calibrateMultiModuleServiceBoundaries(repoRoot: string): ModuleBoundaryScore[] {
  const modules = collectMultiModulePaths(repoRoot);
  if (modules.length === 0) return [];

  return modules
    .map((modulePath) => scoreModuleExecutability(repoRoot, modulePath))
    .sort((left, right) => right.score - left.score || left.modulePath.localeCompare(right.modulePath));
}
