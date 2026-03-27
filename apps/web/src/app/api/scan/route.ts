/**
 * POST /api/scan — 프로젝트 스캔 + Object 등록
 * CLI와 동일한 로직을 Web API로 제공
 */
import { type NextRequest, NextResponse } from 'next/server';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { getDb } from '@archi-navi/db';
import { objects } from '@archi-navi/db';
import { eq, and } from 'drizzle-orm';
import {
  generateId,
  buildPath,
} from '@archi-navi/shared';
import type {
  ScanMode,
  ScanRequest,
  ScanResult,
  DiscoveredProject,
} from '@archi-navi/shared';

/* ─── 마커 파일 → 언어 매핑 ─── */
const MARKER_MAP: Record<string, string> = {
  'package.json': 'node',
  'pom.xml': 'java',
  'build.gradle': 'java',
  'build.gradle.kts': 'kotlin',
  'pyproject.toml': 'python',
  'setup.py': 'python',
  'go.mod': 'go',
  'Cargo.toml': 'rust',
};

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', 'dist', 'build', 'target',
  '__pycache__', '.next', '.turbo', '.cache', 'vendor',
]);

/* ─── 프로젝트 감지 (CLI project-detector 로직 인라인) ─── */
function detectMarker(dirPath: string): { markerFile: string; language: string } | null {
  try {
    const entries = fs.readdirSync(dirPath);
    for (const [marker, lang] of Object.entries(MARKER_MAP)) {
      if (entries.includes(marker)) {
        return { markerFile: marker, language: lang };
      }
    }
  } catch { /* 디렉토리 읽기 실패 무시 */ }
  return null;
}

function detectProjects(rootDir: string): DiscoveredProject[] {
  const resolved = path.resolve(rootDir);
  const results: DiscoveredProject[] = [];

  // 루트 자체
  const rootMarker = detectMarker(resolved);
  if (rootMarker) {
    results.push({
      name: path.basename(resolved),
      path: resolved,
      language: rootMarker.language,
      markerFile: rootMarker.markerFile,
    });
  }

  // 1-depth 하위
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true });
  } catch { return results; }

  for (const entry of entries) {
    if (!entry.isDirectory() || IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const subDir = path.join(resolved, entry.name);
    const marker = detectMarker(subDir);
    if (marker) {
      results.push({ name: entry.name, path: subDir, language: marker.language, markerFile: marker.markerFile });
    }
  }
  return results;
}

function detectSingleProject(dirPath: string): DiscoveredProject | null {
  const resolved = path.resolve(dirPath);
  const marker = detectMarker(resolved);
  if (!marker) return null;
  return { name: path.basename(resolved), path: resolved, language: marker.language, markerFile: marker.markerFile };
}

/* ─── GitHub 헬퍼 ─── */
function checkGhAuth(): void {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'pipe' });
  } catch {
    throw new Error('gh CLI 인증 필요: gh auth login');
  }
}

interface GhRepo { name: string; url: string }

function listOrgRepos(org: string): GhRepo[] {
  try {
    const stdout = execFileSync(
      'gh', ['repo', 'list', org, '--json', 'name,url', '--limit', '200'],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return JSON.parse(stdout) as GhRepo[];
  } catch (err) {
    // execFileSync 실패 시 stderr가 err.message에 포함됨
    const msg = err instanceof Error ? err.message : String(err);

    // Org를 찾지 못한 경우 (이름 오타 or Private Org 권한 부족)
    if (
      msg.includes('not recognized') ||
      msg.includes('Could not resolve') ||
      msg.includes('Could not find')
    ) {
      throw new Error(
        `GitHub Org '${org}'를 찾을 수 없습니다.\n` +
        `• Org 이름이 정확한지 확인하세요.\n` +
        `• Private Org라면 'gh auth refresh -s read:org' 실행 후 재시도하세요.`,
      );
    }

    // 그 외 gh 실행 오류 (네트워크, 권한 등)
    throw new Error(`GitHub Org 레포 목록 조회 실패: ${msg}`);
  }
}

function cloneRepo(nwo: string, targetDir: string): void {
  execFileSync('gh', ['repo', 'clone', nwo, targetDir, '--', '--depth', '1'], { stdio: 'pipe' });
}

/**
 * GitHub API로 레포 루트 파일 목록을 조회해서 언어/마커 파일을 감지.
 * clone 없이 API 한 번 호출로 끝나므로 매우 빠름.
 */
async function detectProjectFromGitHub(
  owner: string,
  repo: string,
): Promise<DiscoveredProject | null> {
  try {
    // gh api 로 루트 파일 이름 목록만 추출 (--jq 사용)
    const { stdout } = await execFileAsync(
      'gh',
      ['api', `repos/${owner}/${repo}/contents/`, '--jq', '.[].name'],
      { encoding: 'utf-8' },
    );
    const files = stdout.trim().split('\n').filter(Boolean);

    for (const [marker, lang] of Object.entries(MARKER_MAP)) {
      if (files.includes(marker)) {
        return {
          name: repo,
          path: `https://github.com/${owner}/${repo}`,
          language: lang,
          markerFile: marker,
        };
      }
    }
    return null; // 마커 파일 없음 → 프로젝트 아님
  } catch {
    return null; // 접근 불가(private/삭제됨 등) → 건너뜀
  }
}

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `archi-scan-${prefix}-`));
}

/* ─── Object 등록 ─── */
export async function registerProjects(
  workspaceId: string,
  projects: DiscoveredProject[],
  dryRun: boolean,
): Promise<{ registered: number; skipped: number }> {
  if (dryRun || projects.length === 0) return { registered: 0, skipped: projects.length };

  const db = await getDb();
  let registered = 0;
  let skipped = 0;

  for (const proj of projects) {
    const existing = await db
      .select({ id: objects.id, metadata: objects.metadata })
      .from(objects)
      .where(and(eq(objects.workspaceId, workspaceId), eq(objects.name, proj.name)))
      .limit(1);

    if (existing.length > 0) {
      const current = existing[0]!;
      const metadata = (current.metadata ?? {}) as Record<string, unknown>;
      await db
        .update(objects)
        .set({
          metadata: {
            ...metadata,
            scanPath: proj.path,
            language: proj.language,
            markerFile: proj.markerFile,
          },
        })
        .where(eq(objects.id, current.id));
      skipped++;
      continue;
    }

    const id = generateId();
    await db.insert(objects).values({
      id,
      workspaceId,
      objectType: 'service',
      category: 'COMPUTE',
      granularity: 'COMPOUND',
      name: proj.name,
      displayName: null,
      path: buildPath(null, id),
      depth: 0,
      visibility: 'VISIBLE',
      metadata: { scanPath: proj.path, language: proj.language, markerFile: proj.markerFile },
    });
    registered++;
  }

  return { registered, skipped };
}

/* ─── POST /api/scan (SSE 스트리밍) ─── */
export async function POST(req: NextRequest) {
  // body 파싱 실패는 스트림 시작 전에 처리
  let body: ScanRequest;
  try {
    body = (await req.json()) as ScanRequest;
  } catch {
    return NextResponse.json({ error: '잘못된 요청 형식' }, { status: 400 });
  }

  const workspaceId = body.workspaceId?.trim();
  if (!workspaceId) {
    return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
  }
  const mode: ScanMode = body.mode || 'local';
  const target = body.target;
  const dryRun = body.dryRun ?? false;

  if (!target) {
    return NextResponse.json({ error: 'target은 필수입니다' }, { status: 400 });
  }

  const encoder = new TextEncoder();

  /*
   * SSE(Server-Sent Events) 스트리밍 응답:
   * 각 레포 처리 진행 상황을 실시간으로 클라이언트에 전달.
   *
   * 이벤트 형식:
   *   { type: 'start',    total: number }
   *   { type: 'progress', current: number, total: number, message: string }
   *   { type: 'complete', result: ScanResult }
   *   { type: 'error',    message: string }
   */
  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        let projects: DiscoveredProject[] = [];

        switch (mode) {
          case 'local': {
            const single = detectSingleProject(target);
            projects = single ? [single] : detectProjects(target);
            break;
          }
          case 'workspace-dir': {
            projects = detectProjects(target);
            break;
          }
          case 'github-repo': {
            checkGhAuth();
            const tmpDir = createTempDir('repo');
            try {
              cloneRepo(target, path.join(tmpDir, target.split('/').pop() ?? 'repo'));
              projects = detectProjects(tmpDir);
            } finally {
              fs.rmSync(tmpDir, { recursive: true, force: true });
            }
            break;
          }
          case 'github-org': {
            checkGhAuth();
            const repos = listOrgRepos(target);
            send({ type: 'start', total: repos.length });

            if (dryRun) {
              /*
               * 미리보기: GitHub API로 루트 파일만 조회 (clone 없음)
               *   - 디스크 I/O 없음, 훨씬 빠름
               *   - 동시 10개 배치로 부하 제한
               */
              const BATCH = 10;
              for (let i = 0; i < repos.length; i += BATCH) {
                const end = Math.min(i + BATCH, repos.length);
                send({
                  type: 'progress',
                  current: i,
                  total: repos.length,
                  message: `${end} / ${repos.length} 레포 확인 중...`,
                });
                const batch = repos.slice(i, i + BATCH);
                const results = await Promise.all(
                  batch.map((r) => detectProjectFromGitHub(target, r.name)),
                );
                projects.push(...results.filter((p): p is DiscoveredProject => p !== null));
              }
            } else {
              /*
               * 실제 스캔: 레포를 clone하여 추론 엔진이 코드를 직접 분석할 수 있도록 준비.
               *   - 미래의 inference pipeline에서 tmpDir 경로를 사용
               */
              const tmpDir = createTempDir('org');
              try {
                for (let i = 0; i < repos.length; i++) {
                  const repo = repos[i]!;
                  send({
                    type: 'progress',
                    current: i,
                    total: repos.length,
                    message: `${repo.name} 클로닝 중... (${i + 1} / ${repos.length})`,
                  });
                  const repoDir = path.join(tmpDir, repo.name);
                  try {
                    cloneRepo(`${target}/${repo.name}`, repoDir);
                    const detected = detectSingleProject(repoDir);
                    if (detected) projects.push(detected);
                  } catch { /* 개별 실패 건너뜀 */ }
                }
              } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
              }
            }
            break;
          }
        }

        // 언어 필터
        if (body.lang) {
          const langs = body.lang.split(',').map((l) => l.trim().toLowerCase());
          projects = projects.filter((p) => langs.includes(p.language));
        }

        // DB 등록
        const { registered, skipped } = await registerProjects(workspaceId, projects, dryRun);
        const result: ScanResult = { mode, target, projects, registered, skipped };
        send({ type: 'complete', result });
      } catch (err) {
        console.error('[POST /api/scan]', err);
        send({ type: 'error', message: err instanceof Error ? err.message : '스캔 중 오류 발생' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
