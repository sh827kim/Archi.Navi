import { existsSync, readFileSync } from 'fs';
import { extname, join } from 'path';
import { findJavaKotlinFiles, findPythonFiles, findTypeScriptFiles } from '../../utils/fileDiscovery';
import { BUILT_IN_FRAMEWORK_PLUGINS } from './builtInPlugins';
import type { DetectPluginsOptions, FrameworkLanguage, FrameworkPlugin } from './types';

function inferLanguage(filePath: string): FrameworkLanguage | null {
  const ext = extname(filePath).toLowerCase();

  if (ext === '.java') return 'java';
  if (ext === '.kt' || ext === '.kts') return 'kotlin';
  if (ext === '.ts' || ext === '.tsx') return 'typescript';
  if (ext === '.js' || ext === '.jsx') return 'javascript';
  if (ext === '.py') return 'python';

  return null;
}

function readTextIfExists(filePath: string): string | null {
  if (!existsSync(filePath)) return null;

  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function readPackageJsonDeps(repoRoot: string): Set<string> {
  const packageJsonRaw = readTextIfExists(join(repoRoot, 'package.json'));
  if (!packageJsonRaw) return new Set();

  try {
    const parsed = JSON.parse(packageJsonRaw) as Record<string, unknown>;
    const sections = ['dependencies', 'devDependencies', 'peerDependencies'] as const;
    const deps = new Set<string>();

    for (const section of sections) {
      const value = parsed[section];
      if (!value || typeof value !== 'object') continue;
      for (const depName of Object.keys(value)) {
        deps.add(depName);
      }
    }

    return deps;
  } catch {
    return new Set();
  }
}

function dedupePlugins(plugins: FrameworkPlugin[]): FrameworkPlugin[] {
  const seen = new Set<string>();

  return plugins.filter((plugin) => {
    if (seen.has(plugin.id)) return false;
    seen.add(plugin.id);
    return true;
  });
}

export class PluginRegistry {
  private readonly plugins: FrameworkPlugin[];

  constructor(plugins: FrameworkPlugin[] = BUILT_IN_FRAMEWORK_PLUGINS) {
    this.plugins = [...plugins];
  }

  register(plugin: FrameworkPlugin): void {
    this.plugins.push(plugin);
  }

  getById(id: string): FrameworkPlugin | undefined {
    return this.plugins.find((plugin) => plugin.id === id);
  }

  list(): FrameworkPlugin[] {
    return [...this.plugins];
  }

  getFallbackForLanguage(language: FrameworkLanguage): FrameworkPlugin | undefined {
    return this.plugins.find(
      (plugin) => plugin.fallback === true && plugin.languages.includes(language),
    );
  }

  detectPlugins(options: DetectPluginsOptions): FrameworkPlugin[] {
    const languages = new Set<FrameworkLanguage>(
      options.filePaths
        .map((filePath) => inferLanguage(filePath))
        .filter((language): language is FrameworkLanguage => language !== null),
    );

    if (existsSync(join(options.repoRoot, 'pom.xml')) || existsSync(join(options.repoRoot, 'build.gradle')) || existsSync(join(options.repoRoot, 'build.gradle.kts'))) {
      languages.add('java');
    }
    if (existsSync(join(options.repoRoot, 'package.json'))) {
      languages.add('typescript');
    }
    if (existsSync(join(options.repoRoot, 'pyproject.toml')) || existsSync(join(options.repoRoot, 'setup.py')) || existsSync(join(options.repoRoot, 'requirements.txt'))) {
      languages.add('python');
    }

    const packageJsonDeps = readPackageJsonDeps(options.repoRoot);
    const manifestCache = new Map<string, string>();
    const selected: FrameworkPlugin[] = [];

    for (const language of languages) {
      const pluginsForLanguage = this.plugins.filter((plugin) => plugin.languages.includes(language));
      const detectedSpecific = pluginsForLanguage.filter(
        (plugin) =>
          plugin.fallback !== true &&
          this.matchesDetector(plugin, options.repoRoot, packageJsonDeps, manifestCache),
      );

      if (detectedSpecific.length > 0) {
        selected.push(...detectedSpecific);
        continue;
      }

      selected.push(...pluginsForLanguage.filter((plugin) => plugin.fallback === true));
    }

    return dedupePlugins(selected);
  }

  private matchesDetector(
    plugin: FrameworkPlugin,
    repoRoot: string,
    packageJsonDeps: Set<string>,
    manifestCache: Map<string, string>,
  ): boolean {
    const detector = plugin.detector;
    if (!detector) return false;

    if (
      detector.packageJsonDeps?.some((depName) => packageJsonDeps.has(depName))
    ) {
      return true;
    }

    if (detector.manifestMatches?.some(({ fileName, pattern }) => {
      let content = manifestCache.get(fileName);
      if (content === undefined) {
        content = readTextIfExists(join(repoRoot, fileName)) ?? '';
        manifestCache.set(fileName, content);
      }
      return pattern.test(content);
    })) {
      return true;
    }

    if (detector.filePatterns?.some((fileName) => existsSync(join(repoRoot, fileName)))) {
      return true;
    }

    return false;
  }
}

export const pluginRegistry = new PluginRegistry();

export function detectPlugins(
  repoRoot: string,
  registry: PluginRegistry = pluginRegistry,
): FrameworkPlugin[] {
  return registry.detectPlugins({
    repoRoot,
    filePaths: [
      ...findJavaKotlinFiles(repoRoot),
      ...findTypeScriptFiles(repoRoot),
      ...findPythonFiles(repoRoot),
    ],
  });
}
