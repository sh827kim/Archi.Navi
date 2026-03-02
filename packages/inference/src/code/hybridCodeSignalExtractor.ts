import { readFileSync, readdirSync, statSync } from 'fs';
import { extname, join } from 'path';
import { and, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '@archi-navi/db';
import { codeArtifacts, codeCallEdges, evidences, objects } from '@archi-navi/db';
import { generateId } from '@archi-navi/shared';
import type {
  CodeSignalOptions,
  CodeSignalResult,
  ExtractedSignal,
  FileScanResult,
} from './codeSignalExtractor';
import { scanJavaKotlin, scanMyBatisXml } from './scanners/javaKotlin';
import { scanTypeScript } from './scanners/typeScript';
import { scanPython } from './scanners/python';
import { scanJavaKotlinAst } from './ast/astJavaKotlin';
import { scanTypeScriptAst } from './ast/astTypeScript';
import { scanPythonAst } from './ast/astPython';
import { mergeHybridSignals } from './hybridSignalMerge';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'target',
  '__pycache__',
  '.gradle',
  'out',
  'coverage',
]);

function findFiles(dir: string, predicate: (path: string) => boolean): string[] {
  const results: string[] = [];

  function walk(current: string) {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const fullPath = join(current, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile() && predicate(fullPath)) {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}

function findJavaKotlinFiles(repoRoot: string): string[] {
  return findFiles(repoRoot, (p) => {
    const ext = extname(p).toLowerCase();
    return ext === '.java' || ext === '.kt';
  });
}

function findTypeScriptFiles(repoRoot: string): string[] {
  return findFiles(repoRoot, (p) => {
    const ext = extname(p).toLowerCase();
    return ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx';
  });
}

function findPythonFiles(repoRoot: string): string[] {
  return findFiles(repoRoot, (p) => extname(p).toLowerCase() === '.py');
}

function findMyBatisXmlFiles(repoRoot: string): string[] {
  return findFiles(repoRoot, (p) => {
    if (extname(p).toLowerCase() !== '.xml') return false;
    try {
      const head = readFileSync(p, 'utf-8').slice(0, 2000);
      return head.includes('<mapper ') || head.includes('<mapper\n');
    } catch {
      return false;
    }
  });
}

function findOwnerServiceByPath(
  filePath: string,
  allServices: { id: string; name: string }[],
): string | null {
  const parts = filePath.replace(/\\/g, '/').split('/');

  for (let i = parts.length - 2; i >= 0; i--) {
    const segment = parts[i];
    if (!segment) continue;

    const exactMatch = allServices.find((s) => s.name.toLowerCase() === segment.toLowerCase());
    if (exactMatch) return exactMatch.id;

    const normalizedSegment = segment.toLowerCase().replace(/[-_]/g, '');
    const normalizedMatch = allServices.find(
      (s) => s.name.toLowerCase().replace(/[-_]/g, '') === normalizedSegment,
    );
    if (normalizedMatch) return normalizedMatch.id;
  }

  return null;
}

interface ProcessFileContext {
  db: DbClient;
  workspaceId: string;
  repoRoot: string;
  allServices: { id: string; name: string }[];
  forceRescan: boolean;
}

interface ProcessFileResult {
  skipped: boolean;
  isNew: boolean;
  signalCount: number;
}

async function deleteArtifactEdgesAndEvidences(
  db: DbClient,
  workspaceId: string,
  artifactId: string,
) {
  const existingEdgeRows = await db
    .select({ evidenceId: codeCallEdges.evidenceId })
    .from(codeCallEdges)
    .where(
      and(
        eq(codeCallEdges.workspaceId, workspaceId),
        eq(codeCallEdges.callerArtifactId, artifactId),
      ),
    );

  await db
    .delete(codeCallEdges)
    .where(
      and(
        eq(codeCallEdges.workspaceId, workspaceId),
        eq(codeCallEdges.callerArtifactId, artifactId),
      ),
    );

  const evidenceIds = Array.from(
    new Set(
      existingEdgeRows
        .map((row) => row.evidenceId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  );

  if (evidenceIds.length === 0) return;

  await db
    .delete(evidences)
    .where(and(eq(evidences.workspaceId, workspaceId), inArray(evidences.id, evidenceIds)));
}

async function processFile(
  filePath: string,
  scanResult: FileScanResult,
  ctx: ProcessFileContext,
): Promise<ProcessFileResult> {
  const { db, workspaceId, repoRoot, allServices, forceRescan } = ctx;

  const existing = await db
    .select({ id: codeArtifacts.id, sha256: codeArtifacts.sha256 })
    .from(codeArtifacts)
    .where(
      and(eq(codeArtifacts.workspaceId, workspaceId), eq(codeArtifacts.filePath, filePath)),
    )
    .limit(1);

  const existingArtifact = existing[0];

  if (!forceRescan && existingArtifact?.sha256 === scanResult.sha256) {
    return { skipped: true, isNew: false, signalCount: 0 };
  }

  let artifactId: string;
  let isNew = false;

  if (existingArtifact) {
    await deleteArtifactEdgesAndEvidences(db, workspaceId, existingArtifact.id);
    await db
      .update(codeArtifacts)
      .set({ sha256: scanResult.sha256, updatedAt: new Date() })
      .where(eq(codeArtifacts.id, existingArtifact.id));
    artifactId = existingArtifact.id;
  } else {
    isNew = true;
    artifactId = generateId();
    const ownerObjectId = findOwnerServiceByPath(filePath, allServices);
    await db.insert(codeArtifacts).values({
      id: artifactId,
      workspaceId,
      language: scanResult.language,
      repoRoot,
      filePath,
      packageName: scanResult.packageName ?? null,
      ownerObjectId,
      sha256: scanResult.sha256,
    });
  }

  for (const signal of scanResult.signals) {
    const evidenceId = generateId();
    await db.insert(evidences).values({
      id: evidenceId,
      workspaceId,
      evidenceType: 'FILE',
      filePath,
      lineStart: signal.lineStart,
      lineEnd: signal.lineEnd,
      excerpt: signal.excerpt,
      metadata: {
        kind: signal.kind,
        confidence: signal.confidence,
        language: scanResult.language,
        extractionMode: 'hybrid',
        ...signal.metadata,
      },
    });

    await db.insert(codeCallEdges).values({
      id: generateId(),
      workspaceId,
      callerArtifactId: artifactId,
      calleeSymbol: signal.symbol,
      weight: 1,
      evidenceId,
    });
  }

  return { skipped: false, isNew, signalCount: scanResult.signals.length };
}

function buildScanResult(base: FileScanResult, signals: ExtractedSignal[]): FileScanResult {
  const resultBase = {
    language: base.language,
    sha256: base.sha256,
    signals,
  };

  if (base.packageName) {
    return {
      ...resultBase,
      packageName: base.packageName,
    };
  }

  return resultBase;
}

async function mergeJavaOrKotlinSignals(filePath: string, content: string): Promise<FileScanResult> {
  const regexResult = scanJavaKotlin(filePath, content);
  let astResult: FileScanResult | null = null;

  try {
    astResult = await scanJavaKotlinAst(filePath, content);
  } catch {
    astResult = null;
  }

  const mergedSignals = mergeHybridSignals([
    ...regexResult.signals.map((signal) => ({ source: 'regex' as const, signal })),
    ...(astResult?.signals ?? []).map((signal) => ({ source: 'ast' as const, signal })),
  ]);

  return buildScanResult(astResult ?? regexResult, mergedSignals);
}

async function mergeTypeScriptSignals(filePath: string, content: string): Promise<FileScanResult> {
  const regexResult = scanTypeScript(filePath, content);
  let astResult: FileScanResult | null = null;

  try {
    astResult = await scanTypeScriptAst(filePath, content);
  } catch {
    astResult = null;
  }

  const mergedSignals = mergeHybridSignals([
    ...regexResult.signals.map((signal) => ({ source: 'regex' as const, signal })),
    ...(astResult?.signals ?? []).map((signal) => ({ source: 'ast' as const, signal })),
  ]);

  return buildScanResult(astResult ?? regexResult, mergedSignals);
}

async function mergePythonSignals(filePath: string, content: string): Promise<FileScanResult> {
  const regexResult = scanPython(filePath, content);
  let astResult: FileScanResult | null = null;

  try {
    astResult = await scanPythonAst(filePath, content);
  } catch {
    astResult = null;
  }

  const mergedSignals = mergeHybridSignals([
    ...regexResult.signals.map((signal) => ({ source: 'regex' as const, signal })),
    ...(astResult?.signals ?? []).map((signal) => ({ source: 'ast' as const, signal })),
  ]);

  return buildScanResult(astResult ?? regexResult, mergedSignals);
}

function mergeMyBatisSignals(filePath: string, content: string): FileScanResult {
  const regexResult = scanMyBatisXml(filePath, content);
  const mergedSignals = mergeHybridSignals(
    regexResult.signals.map((signal) => ({ source: 'regex' as const, signal })),
  );
  return buildScanResult(regexResult, mergedSignals);
}

export async function extractHybridCodeSignals(
  db: DbClient,
  options: CodeSignalOptions,
): Promise<CodeSignalResult> {
  const { workspaceId, repoRoot } = options;
  const forceRescan = options.forceRescan === true;

  const allServices = await db
    .select({ id: objects.id, name: objects.name })
    .from(objects)
    .where(and(eq(objects.workspaceId, workspaceId), eq(objects.objectType, 'service')));

  const ctx: ProcessFileContext = { db, workspaceId, repoRoot, allServices, forceRescan };
  const result: CodeSignalResult = {
    fileCount: 0,
    artifactCount: 0,
    signalCount: 0,
    skippedCount: 0,
  };

  async function processAll(
    files: string[],
    scanner: (filePath: string, content: string) => Promise<FileScanResult> | FileScanResult,
  ) {
    for (const filePath of files) {
      let content: string;
      try {
        content = readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }

      result.fileCount++;

      let scanResult: FileScanResult;
      try {
        scanResult = await scanner(filePath, content);
      } catch {
        continue;
      }

      const fileResult = await processFile(filePath, scanResult, ctx);
      if (fileResult.skipped) {
        result.skippedCount++;
      } else {
        if (fileResult.isNew) result.artifactCount++;
        result.signalCount += fileResult.signalCount;
      }
    }
  }

  await processAll(findJavaKotlinFiles(repoRoot), mergeJavaOrKotlinSignals);
  await processAll(findTypeScriptFiles(repoRoot), mergeTypeScriptSignals);
  await processAll(findPythonFiles(repoRoot), mergePythonSignals);
  await processAll(findMyBatisXmlFiles(repoRoot), mergeMyBatisSignals);

  return result;
}
