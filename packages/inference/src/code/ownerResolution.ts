import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import { objects } from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';

type SupportedLanguage = 'java' | 'kotlin' | 'typescript' | 'javascript' | 'python';

export interface OwnerFunctionDescriptor {
  functionKey: string;
  functionName: string;
  className: string | null;
  signature: string | null;
  lineStart: number;
  lineEnd: number;
}

type ScopeState =
  | {
      type: 'class';
      name: string;
      depth: number;
      lineStart: number;
    }
  | {
      type: 'function';
      name: string;
      className: string | null;
      signature: string | null;
      depth: number;
      lineStart: number;
    };

interface ResolveFunctionOwnerInput {
  workspaceId: string;
  serviceId: string | null;
  filePath: string;
  language: string;
  content: string;
  signalLine: number;
  metadata: Record<string, unknown>;
  cache: Map<string, string>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function hashSegment(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 16);
}

function countChars(value: string, target: string): number {
  return [...value].filter((char) => char === target).length;
}

function stripInlineComment(value: string, language: SupportedLanguage): string {
  if (language === 'python') {
    return value.replace(/#.*$/, '');
  }
  return value.replace(/\/\/.*$/, '');
}

function buildDescriptor(
  filePath: string,
  functionName: string,
  className: string | null,
  signature: string | null,
  lineStart: number,
  lineEnd: number,
): OwnerFunctionDescriptor {
  const normalizedSignature = signature?.replace(/\s+/g, ' ').trim() ?? null;
  const keyParts = [filePath, className ?? '_', functionName, normalizedSignature ?? `${lineStart}-${lineEnd}`];
  return {
    functionKey: keyParts.join('::'),
    functionName,
    className,
    signature: normalizedSignature,
    lineStart,
    lineEnd,
  };
}

function descriptorFromMetadata(filePath: string, metadata: Record<string, unknown>): OwnerFunctionDescriptor | null {
  const functionKey = asString(metadata['ownerFunctionKey']);
  const functionName = asString(metadata['ownerFunctionName']);
  if (!functionKey || !functionName) return null;

  return {
    functionKey,
    functionName,
    className: asString(metadata['ownerClassName']),
    signature: asString(metadata['ownerFunctionSignature']),
    lineStart: asNumber(metadata['ownerFunctionLineStart']) ?? 0,
    lineEnd: asNumber(metadata['ownerFunctionLineEnd']) ?? 0,
  };
}

function closeBraceScopes(
  filePath: string,
  openScopes: ScopeState[],
  currentDepth: number,
  currentLine: number,
): OwnerFunctionDescriptor[] {
  const closed: OwnerFunctionDescriptor[] = [];

  while (openScopes.length > 0 && currentDepth < openScopes[openScopes.length - 1]!.depth) {
    const scope = openScopes.pop()!;
    if (scope.type === 'function') {
      closed.push(
        buildDescriptor(
          filePath,
          scope.name,
          scope.className,
          scope.signature,
          scope.lineStart,
          currentLine,
        ),
      );
    }
  }

  return closed;
}

function parseJavaLikeFunctions(
  filePath: string,
  language: 'java' | 'kotlin',
  content: string,
): OwnerFunctionDescriptor[] {
  const lines = content.split('\n');
  const openScopes: ScopeState[] = [];
  const descriptors: OwnerFunctionDescriptor[] = [];
  let braceDepth = 0;

  const classRegex = /\b(class|interface|enum|object)\s+([A-Za-z_][A-Za-z0-9_]*)/;
  const methodRegex =
    /^\s*(?:public|private|protected|internal|open|final|abstract|override|static|suspend|async|inline|data|operator|external|tailrec|\w+\s+)*([A-Za-z_][A-Za-z0-9_]*)\s*\([^;{}]*\)\s*(?::\s*[A-Za-z0-9_<>,.?[\]! ]+)?\s*\{/;
  const excluded = new Set(['if', 'for', 'while', 'switch', 'catch', 'when']);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const rawLine = lines[index] ?? '';
    const line = stripInlineComment(rawLine, language).trim();
    const opens = countChars(rawLine, '{');
    const closes = countChars(rawLine, '}');
    const nextDepth = braceDepth + opens - closes;

    const classMatch = line.match(classRegex);
    if (classMatch && opens > 0) {
      openScopes.push({
        type: 'class',
        name: classMatch[2]!,
        depth: nextDepth,
        lineStart: lineNumber,
      });
    }

    const methodMatch = line.match(methodRegex);
    if (methodMatch && opens > 0) {
      const functionName = methodMatch[1]!;
      if (!excluded.has(functionName)) {
        const nearestClass = [...openScopes].reverse().find((scope) => scope.type === 'class') as Extract<ScopeState, { type: 'class' }> | undefined;
        openScopes.push({
          type: 'function',
          name: functionName,
          className: nearestClass?.name ?? null,
          signature: line,
          depth: nextDepth,
          lineStart: lineNumber,
        });
      }
    }

    descriptors.push(...closeBraceScopes(filePath, openScopes, nextDepth, lineNumber));
    braceDepth = nextDepth;
  }

  while (openScopes.length > 0) {
    const scope = openScopes.pop()!;
    if (scope.type === 'function') {
      descriptors.push(
        buildDescriptor(
          filePath,
          scope.name,
          scope.className,
          scope.signature,
          scope.lineStart,
          lines.length,
        ),
      );
    }
  }

  return descriptors;
}

function parseTypeScriptFunctions(
  filePath: string,
  content: string,
): OwnerFunctionDescriptor[] {
  const lines = content.split('\n');
  const openScopes: ScopeState[] = [];
  const descriptors: OwnerFunctionDescriptor[] = [];
  let braceDepth = 0;

  const classRegex = /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)/;
  const functionRegex = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*\{/;
  const methodRegex = /^\s*(?:public|private|protected|static|async|readonly|get|set|\s)*([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*\{/;
  const arrowRegex = /^\s*(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/;
  const excluded = new Set(['if', 'for', 'while', 'switch', 'catch']);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const rawLine = lines[index] ?? '';
    const line = stripInlineComment(rawLine, 'typescript').trim();
    const opens = countChars(rawLine, '{');
    const closes = countChars(rawLine, '}');
    const nextDepth = braceDepth + opens - closes;

    const classMatch = line.match(classRegex);
    if (classMatch && opens > 0) {
      openScopes.push({
        type: 'class',
        name: classMatch[1]!,
        depth: nextDepth,
        lineStart: lineNumber,
      });
    }

    const functionName =
      line.match(functionRegex)?.[1]
      ?? line.match(arrowRegex)?.[1]
      ?? (() => {
        const match = line.match(methodRegex)?.[1];
        return match && !excluded.has(match) ? match : null;
      })();

    if (functionName && opens > 0) {
      const nearestClass = [...openScopes].reverse().find((scope) => scope.type === 'class') as Extract<ScopeState, { type: 'class' }> | undefined;
      openScopes.push({
        type: 'function',
        name: functionName,
        className: nearestClass?.name ?? null,
        signature: line,
        depth: nextDepth,
        lineStart: lineNumber,
      });
    }

    descriptors.push(...closeBraceScopes(filePath, openScopes, nextDepth, lineNumber));
    braceDepth = nextDepth;
  }

  while (openScopes.length > 0) {
    const scope = openScopes.pop()!;
    if (scope.type === 'function') {
      descriptors.push(
        buildDescriptor(
          filePath,
          scope.name,
          scope.className,
          scope.signature,
          scope.lineStart,
          lines.length,
        ),
      );
    }
  }

  return descriptors;
}

function parsePythonFunctions(
  filePath: string,
  content: string,
): OwnerFunctionDescriptor[] {
  const lines = content.split('\n');
  const classStack: Array<{ name: string; indent: number }> = [];
  const functionStack: Array<OwnerFunctionDescriptor & { indent: number }> = [];
  const descriptors: OwnerFunctionDescriptor[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const rawLine = lines[index] ?? '';
    const withoutComment = stripInlineComment(rawLine, 'python');
    const trimmed = withoutComment.trim();
    if (trimmed.length === 0) continue;

    const indent = rawLine.length - rawLine.trimStart().length;

    while (functionStack.length > 0 && indent <= functionStack[functionStack.length - 1]!.indent) {
      const scope = functionStack.pop()!;
      descriptors.push({
        functionKey: scope.functionKey,
        functionName: scope.functionName,
        className: scope.className,
        signature: scope.signature,
        lineStart: scope.lineStart,
        lineEnd: lineNumber - 1,
      });
    }

    while (classStack.length > 0 && indent <= classStack[classStack.length - 1]!.indent) {
      classStack.pop();
    }

    const classMatch = trimmed.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (classMatch) {
      classStack.push({ name: classMatch[1]!, indent });
      continue;
    }

    const functionMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (functionMatch) {
      const className = classStack[classStack.length - 1]?.name ?? null;
      const descriptor = buildDescriptor(
        filePath,
        functionMatch[1]!,
        className,
        trimmed,
        lineNumber,
        lines.length,
      );
      functionStack.push({ ...descriptor, indent });
    }
  }

  while (functionStack.length > 0) {
    const scope = functionStack.pop()!;
    descriptors.push({
      functionKey: scope.functionKey,
      functionName: scope.functionName,
      className: scope.className,
      signature: scope.signature,
      lineStart: scope.lineStart,
      lineEnd: lines.length,
    });
  }

  return descriptors;
}

function inferDescriptorFromFile(
  filePath: string,
  language: SupportedLanguage,
  content: string,
  signalLine: number,
): OwnerFunctionDescriptor | null {
  const descriptors =
    language === 'java' || language === 'kotlin'
      ? parseJavaLikeFunctions(filePath, language, content)
      : language === 'typescript' || language === 'javascript'
        ? parseTypeScriptFunctions(filePath, content)
        : parsePythonFunctions(filePath, content);

  return descriptors.find((descriptor) => signalLine >= descriptor.lineStart && signalLine <= descriptor.lineEnd) ?? null;
}

export function extractOwnerFunctionId(metadata: Record<string, unknown>): string | null {
  return asString(metadata['ownerFunctionId']);
}

export function preferredSignalOwnerId(
  metadata: Record<string, unknown>,
  artifactOwnerObjectId: string | null,
): string | null {
  return extractOwnerFunctionId(metadata) ?? artifactOwnerObjectId;
}

export function resolveExistingSignalOwnerId(input: {
  metadata: Record<string, unknown>;
  artifactOwnerObjectId: string | null;
  knownOwnerIds: ReadonlySet<string>;
  functionIdByOwnerKey?: ReadonlyMap<string, string>;
}): string | null {
  const preferredOwnerId = extractOwnerFunctionId(input.metadata);
  if (preferredOwnerId && input.knownOwnerIds.has(preferredOwnerId)) {
    return preferredOwnerId;
  }

  const ownerFunctionKey = asString(input.metadata['ownerFunctionKey']);
  if (ownerFunctionKey) {
    const recoveredFunctionId = input.functionIdByOwnerKey?.get(ownerFunctionKey) ?? null;
    if (recoveredFunctionId) {
      return recoveredFunctionId;
    }
  }

  return input.artifactOwnerObjectId;
}

export async function resolveSignalOwnerMetadata(
  db: DbClient,
  input: ResolveFunctionOwnerInput,
): Promise<Record<string, unknown>> {
  const serviceId = input.serviceId;
  if (!serviceId) return input.metadata;

  const supportedLanguage = ((): SupportedLanguage | null => {
    if (input.language === 'java' || input.language === 'kotlin') return input.language;
    if (input.language === 'typescript' || input.language === 'javascript') return input.language;
    if (input.language === 'python') return input.language;
    return null;
  })();

  if (!supportedLanguage) return input.metadata;

  const descriptor =
    descriptorFromMetadata(input.filePath, input.metadata)
    ?? inferDescriptorFromFile(input.filePath, supportedLanguage, input.content, input.signalLine);

  if (!descriptor) return input.metadata;

  const cacheKey = `${serviceId}::${descriptor.functionKey}`;
  let functionId = input.cache.get(cacheKey) ?? null;

  if (!functionId) {
    const existingFunctions = await db
      .select({
        id: objects.id,
        metadata: objects.metadata,
      })
      .from(objects)
      .where(
        and(
          eq(objects.workspaceId, input.workspaceId),
          eq(objects.objectType, 'function'),
          eq(objects.parentId, serviceId),
        ),
      );

    for (const existing of existingFunctions) {
      const metadata = (existing.metadata ?? {}) as Record<string, unknown>;
      if (asString(metadata['functionKey']) === descriptor.functionKey) {
        functionId = existing.id;
        input.cache.set(cacheKey, functionId);
        break;
      }
    }
  }

  if (!functionId) {
    functionId = generateId();
    const displayName = descriptor.className ? `${descriptor.className}.${descriptor.functionName}` : descriptor.functionName;
    await db.insert(objects).values({
      id: functionId,
      workspaceId: input.workspaceId,
      objectType: 'function',
      category: 'CODE',
      granularity: 'ATOMIC',
      name: displayName,
      parentId: serviceId,
      path: `/${serviceId}/function/${hashSegment(descriptor.functionKey)}`,
      depth: 1,
      visibility: 'VISIBLE',
      metadata: {
        functionKey: descriptor.functionKey,
        functionName: descriptor.functionName,
        className: descriptor.className,
        signature: descriptor.signature,
        filePath: input.filePath,
        lineStart: descriptor.lineStart,
        lineEnd: descriptor.lineEnd,
      },
    });
    input.cache.set(cacheKey, functionId);
  }

  return {
    ...input.metadata,
    ownerFunctionId: functionId,
    ownerFunctionKey: descriptor.functionKey,
    ownerFunctionName: descriptor.functionName,
    ...(descriptor.className ? { ownerClassName: descriptor.className } : {}),
    ...(descriptor.signature ? { ownerFunctionSignature: descriptor.signature } : {}),
    ownerFunctionLineStart: descriptor.lineStart,
    ownerFunctionLineEnd: descriptor.lineEnd,
  };
}
