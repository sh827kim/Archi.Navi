import { readFileSync } from 'fs';
import { dirname, extname } from 'path';
import yaml from 'js-yaml';
import { findFiles } from '../../utils/fileDiscovery';

const PROPERTY_FILE_PATTERN = /^(?:application|bootstrap)(?:-[^.]+)?\.ya?ml$/i;

export type AstPropertyMap = Map<string, string>;

interface PropertyFileEntry {
  filePath: string;
  dirPath: string;
  scopePath: string;
  sourceSet: PropertySourceSet;
  priority: number;
  properties: AstPropertyMap;
}

type PropertySourceSet = 'main' | 'test' | 'unknown';

export interface AstPropertyResolver {
  hasEntries: boolean;
  resolveForFile(filePath: string): AstPropertyMap;
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function findPropertyFiles(repoRoot: string): string[] {
  return findFiles(repoRoot, (filePath) => {
    const extension = extname(filePath).toLowerCase();
    if (extension !== '.yml' && extension !== '.yaml') return false;
    const baseName = normalizePath(filePath).split('/').pop() ?? '';
    return PROPERTY_FILE_PATTERN.test(baseName);
  });
}

function flattenYamlObject(
  value: unknown,
  prefix: string,
  target: AstPropertyMap,
): void {
  if (value === null || value === undefined) return;

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (prefix.length > 0) {
      target.set(prefix, String(value));
    }
    return;
  }

  if (Array.isArray(value)) {
    if (prefix.length > 0) {
      target.set(prefix, value.map((item) => String(item)).join(','));
    }
    return;
  }

  if (typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const nextPrefix = prefix.length > 0 ? `${prefix}.${key}` : key;
    flattenYamlObject(child, nextPrefix, target);
  }
}

function parsePropertyFile(filePath: string): AstPropertyMap {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return new Map();
  }

  const parsedDocuments: unknown[] = [];
  try {
    yaml.loadAll(content, (document) => {
      parsedDocuments.push(document);
    });
  } catch {
    return new Map();
  }

  const properties: AstPropertyMap = new Map();
  for (const parsedDocument of parsedDocuments) {
    flattenYamlObject(parsedDocument, '', properties);
  }
  return properties;
}

function inferPropertyScopePath(dirPath: string): string {
  const segments = splitPathSegments(dirPath);
  if (segments.length >= 3) {
    const srcIndex = segments.length - 3;
    const isSpringResourceDir =
      segments[srcIndex] === 'src' &&
      (segments[srcIndex + 1] === 'main' || segments[srcIndex + 1] === 'test') &&
      segments[srcIndex + 2] === 'resources';
    if (isSpringResourceDir && srcIndex > 0) {
      return `/${segments.slice(0, srcIndex).join('/')}`;
    }
  }
  return dirPath;
}

function inferPropertySourceSet(dirPath: string): PropertySourceSet {
  const segments = splitPathSegments(dirPath);
  for (let index = 0; index <= segments.length - 3; index += 1) {
    const isSourceSetResourceDir =
      segments[index] === 'src' &&
      (segments[index + 1] === 'main' || segments[index + 1] === 'test') &&
      segments[index + 2] === 'resources';
    if (isSourceSetResourceDir) {
      return segments[index + 1] as PropertySourceSet;
    }
  }
  return 'unknown';
}

function inferTargetSourceSet(filePath: string): PropertySourceSet {
  const segments = splitPathSegments(filePath);
  for (let index = 0; index <= segments.length - 2; index += 1) {
    const isSourceSetPath =
      segments[index] === 'src' && (segments[index + 1] === 'main' || segments[index + 1] === 'test');
    if (isSourceSetPath) {
      return segments[index + 1] as PropertySourceSet;
    }
  }
  return 'unknown';
}

function shouldIncludePropertyEntry(
  entrySourceSet: PropertySourceSet,
  targetSourceSet: PropertySourceSet,
): boolean {
  if (entrySourceSet === 'unknown' || targetSourceSet === 'unknown') return true;
  if (targetSourceSet === 'main') return entrySourceSet === 'main';
  if (targetSourceSet === 'test') return entrySourceSet === 'main' || entrySourceSet === 'test';
  return true;
}

function propertyFilePriority(filePath: string): number {
  const baseName = normalizePath(filePath).split('/').pop()?.toLowerCase() ?? '';
  return /^(?:application|bootstrap)-/.test(baseName) ? 1 : 0;
}

function splitPathSegments(filePath: string): string[] {
  return normalizePath(filePath).split('/').filter(Boolean);
}

function isAncestorDirectory(ancestorDirPath: string, targetFilePath: string): boolean {
  const ancestorParts = splitPathSegments(ancestorDirPath);
  const targetParts = splitPathSegments(targetFilePath);
  if (ancestorParts.length === 0 || ancestorParts.length > targetParts.length) return false;

  for (let index = 0; index < ancestorParts.length; index += 1) {
    if (ancestorParts[index] !== targetParts[index]) {
      return false;
    }
  }
  return true;
}

function mergePropertyMaps(entries: PropertyFileEntry[]): AstPropertyMap {
  const merged: AstPropertyMap = new Map();
  const sorted = [...entries].sort((left, right) => {
    if (left.priority !== right.priority) return left.priority - right.priority;
    return left.filePath.localeCompare(right.filePath);
  });

  for (const entry of sorted) {
    for (const [key, value] of entry.properties.entries()) {
      merged.set(key, value);
    }
  }

  return merged;
}

export function buildAstPropertyResolver(repoRoot: string): AstPropertyResolver {
  const entries = findPropertyFiles(repoRoot)
    .map((filePath) => {
      const properties = parsePropertyFile(filePath);
      return {
        filePath: normalizePath(filePath),
        dirPath: normalizePath(dirname(filePath)),
        scopePath: inferPropertyScopePath(dirname(filePath)),
        sourceSet: inferPropertySourceSet(dirname(filePath)),
        priority: propertyFilePriority(filePath),
        properties,
      } satisfies PropertyFileEntry;
    })
    .filter((entry) => entry.properties.size > 0);

  return {
    hasEntries: entries.length > 0,
    resolveForFile(filePath: string): AstPropertyMap {
      const normalizedFilePath = normalizePath(filePath);
      const targetSourceSet = inferTargetSourceSet(normalizedFilePath);
      let bestDepth = 0;

      for (const entry of entries) {
        if (!shouldIncludePropertyEntry(entry.sourceSet, targetSourceSet)) continue;
        if (!isAncestorDirectory(entry.scopePath, normalizedFilePath)) continue;
        const depth = splitPathSegments(entry.scopePath).length;
        if (depth > bestDepth) {
          bestDepth = depth;
        }
      }

      if (bestDepth === 0) return new Map();

      return mergePropertyMaps(
        entries.filter(
          (entry) =>
            shouldIncludePropertyEntry(entry.sourceSet, targetSourceSet) &&
            isAncestorDirectory(entry.scopePath, normalizedFilePath) &&
            splitPathSegments(entry.scopePath).length === bestDepth,
        ),
      );
    },
  };
}

export function resolveValueExpression(
  expression: string,
  propertyMap?: AstPropertyMap,
): string | null {
  const trimmed = expression.trim();
  const placeholderMatch = trimmed.match(/^\$\{([^}:]+)(?::([^}]*))?\}$/);

  if (!placeholderMatch) {
    return trimmed.length > 0 ? trimmed : null;
  }

  const propertyKey = placeholderMatch[1]?.trim() ?? '';
  if (propertyKey.length === 0) return null;

  const propertyValue = propertyMap?.get(propertyKey);
  if (propertyValue && propertyValue.length > 0) {
    return propertyValue;
  }

  const fallbackValue = placeholderMatch[2]?.trim();
  return fallbackValue && fallbackValue.length > 0 ? fallbackValue : null;
}
