// @vitest-environment node

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const requireFromTest = createRequire(import.meta.url);
const currentDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(currentDir, '../..');
const distRoot = resolve(packageRoot, 'dist');
const distEntry = resolve(distRoot, 'index.js');

function collectDistFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectDistFiles(entryPath));
      continue;
    }

    const extension = extname(entry.name);
    if (extension === '.js' || extension === '.d.ts') {
      files.push(entryPath);
    }
  }

  return files;
}

describe('@archi-navi/inference package runtime', () => {
  it(
    'rewrites emitted aliases and loads the published entrypoint',
    () => {
      execFileSync('pnpm', ['run', 'build'], {
        cwd: packageRoot,
        stdio: 'pipe',
      });

      const emittedFiles = collectDistFiles(distRoot);
      const aliasLeakingFiles = emittedFiles.filter((filePath) => readFileSync(filePath, 'utf8').includes("'@/"))
        .concat(emittedFiles.filter((filePath) => readFileSync(filePath, 'utf8').includes('"@/')));

      expect(aliasLeakingFiles).toEqual([]);

      delete requireFromTest.cache[distEntry];
      const inferencePackage = requireFromTest(distEntry) as typeof import('@/index');

      expect('buildProofEngineSummaryFromLegacyRun' in inferencePackage).toBe(false);
      expect('inferRelationsFromConfig' in inferencePackage).toBe(false);
      expect('bindConfigToCodeEndpoints' in inferencePackage).toBe(false);
      expect(inferencePackage.buildEmptyProofEngineSummary()).toMatchObject({
        engine: 'intent_proof',
        intentCount: 0,
        gatewayRouteSeedCount: 0,
        projectedCandidateCount: 0,
        serviceTargetProjectionCount: 0,
      });
    },
    60_000,
  );
});
