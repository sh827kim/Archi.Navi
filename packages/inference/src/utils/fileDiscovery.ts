import { readFileSync, readdirSync, statSync } from 'fs';
import { extname, join } from 'path';

const DEFAULT_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'target',
  '__pycache__',
  '.gradle',
  '.cache',
  'out',
  'coverage',
]);

export function findFiles(dir: string, predicate: (path: string) => boolean): string[] {
  const results: string[] = [];

  function walk(current: string) {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (DEFAULT_SKIP_DIRS.has(entry)) continue;
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

export function findJavaKotlinFiles(repoRoot: string): string[] {
  return findFiles(repoRoot, (filePath) => {
    const extension = extname(filePath).toLowerCase();
    return extension === '.java' || extension === '.kt';
  });
}

export function findTypeScriptFiles(repoRoot: string): string[] {
  return findFiles(repoRoot, (filePath) => {
    const extension = extname(filePath).toLowerCase();
    return extension === '.ts' || extension === '.tsx' || extension === '.js' || extension === '.jsx';
  });
}

export function findPythonFiles(repoRoot: string): string[] {
  return findFiles(repoRoot, (filePath) => extname(filePath).toLowerCase() === '.py');
}

export function findMyBatisXmlFiles(repoRoot: string): string[] {
  return findFiles(repoRoot, (filePath) => {
    if (extname(filePath).toLowerCase() !== '.xml') return false;
    try {
      const head = readFileSync(filePath, 'utf-8').slice(0, 2000);
      return head.includes('<mapper ') || head.includes('<mapper\n');
    } catch {
      return false;
    }
  });
}
