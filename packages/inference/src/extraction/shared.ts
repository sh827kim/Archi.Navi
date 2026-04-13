import { createHash } from 'node:crypto';

export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function uniqueSortedStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.map((value) => asString(value)).filter((value): value is string => value !== null))].sort();
}

export function stableHash(parts: Array<string | number | null | undefined>): string {
  return createHash('sha256')
    .update(
      parts
        .map((part) => {
          if (part === null || part === undefined) return '';
          return String(part);
        })
        .join('|'),
    )
    .digest('hex');
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeOptionalUuid(value: string | null | undefined): string | null {
  const normalized = asString(value);
  if (!normalized) return null;
  return UUID_PATTERN.test(normalized) ? normalized : null;
}

export function extractPath(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
      const url = new URL(trimmed);
      return normalizePath(url.pathname);
    }
  } catch {
    // fall through
  }

  if (!trimmed.startsWith('/')) return null;
  return normalizePath(trimmed);
}

export function extractHost(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
      const url = new URL(trimmed);
      return asString(url.hostname);
    }
  } catch {
    // fall through
  }

  if (trimmed.startsWith('/')) return null;
  if (trimmed.includes('/')) return null;
  return trimmed;
}

export function normalizePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return '';

  let normalized = trimmed;
  if (!normalized.startsWith('/')) {
    normalized = `/${normalized}`;
  }
  normalized = normalized.split('?')[0] ?? normalized;
  normalized = normalized.split('#')[0] ?? normalized;
  normalized = normalized.replace(/\/+/g, '/');
  if (normalized.length > 1) {
    normalized = normalized.replace(/\/+$/g, '');
  }
  return normalized;
}

export function normalizeHint(value: string | null): string {
  return value?.trim().toLowerCase() ?? '';
}

export function normalizeMethod(value: unknown): string | null {
  const method = asString(value)?.toUpperCase() ?? null;
  return method;
}

export function detectDynamicPath(path: string | null): boolean {
  if (!path) return false;
  return /[:{*]/.test(path);
}

export function isLikelyServiceName(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith('/')) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return false;
  return /^[a-z0-9][a-z0-9._-]*$/i.test(trimmed);
}

export function extractHttpPathHint(value: string | null, metadata?: JsonRecord | null): string | null {
  const metadataPath =
    asString(metadata?.['pathHint'])
    ?? asString(metadata?.['path'])
    ?? asString(metadata?.['externalPath']);
  return metadataPath ? normalizePath(metadataPath) : (value ? extractPath(value) : null);
}

export function extractHttpHostHint(value: string | null, metadata?: JsonRecord | null): string | null {
  return asString(metadata?.['hostHint'])
    ?? asString(metadata?.['hostAlias'])
    ?? asString(metadata?.['serviceNameHint'])
    ?? (value ? extractHost(value) : null);
}
