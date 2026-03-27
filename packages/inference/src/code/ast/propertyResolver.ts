import { readFileSync } from 'fs';
import { dirname, extname } from 'path';
import yaml from 'js-yaml';
import { findFiles } from '../../utils/fileDiscovery';

const PROPERTY_FILE_PATTERN = /^(?:application|bootstrap)(?:-[^.]+)?\.ya?ml$/i;

export type AstPropertyMap = Map<string, string>;

interface PropertyFileEntry {
  filePath: string;
  dirPath: string;
  priority: number;
  properties: AstPropertyMap;
}

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

  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch {
    return new Map();
  }

  const properties: AstPropertyMap = new Map();
  flattenYamlObject(parsed, '', properties);
  return properties;
}

function propertyFilePriority(filePath: string): number {
  const baseName = normalizePath(filePath).split('/').pop()?.toLowerCase() ?? '';
  return /^(?:application|bootstrap)-/.test(baseName) ? 1 : 0;
}

function commonPrefixLength(left: string, right: string): number {
  const leftParts = normalizePath(left).split('/').filter(Boolean);
  const rightParts = normalizePath(right).split('/').filter(Boolean);
  const max = Math.min(leftParts.length, rightParts.length);
  let count = 0;
  while (count < max && leftParts[count] === rightParts[count]) {
    count += 1;
  }
  return count;
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
        priority: propertyFilePriority(filePath),
        properties,
      } satisfies PropertyFileEntry;
    })
    .filter((entry) => entry.properties.size > 0);

  return {
    hasEntries: entries.length > 0,
    resolveForFile(filePath: string): AstPropertyMap {
      const normalizedFilePath = normalizePath(filePath);
      let bestScore = 0;

      for (const entry of entries) {
        const score = commonPrefixLength(normalizedFilePath, entry.dirPath);
        if (score > bestScore) {
          bestScore = score;
        }
      }

      if (bestScore === 0) return new Map();

      return mergePropertyMaps(
        entries.filter((entry) => commonPrefixLength(normalizedFilePath, entry.dirPath) === bestScore),
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
