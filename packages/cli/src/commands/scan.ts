/**
 * scan 커맨드 — 4가지 모드로 프로젝트 탐색 + Object 등록
 *
 * 모드:
 *   --path <dir>           단일 디렉토리 스캔 (기본)
 *   --workspace-dir <dir>  하위 프로젝트 일괄 감지
 *   --github-repo <nwo>    GitHub 레포 클론 → 스캔 → 정리
 *   --github-org <org>     GitHub Org 전체 레포 스캔
 */
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import * as path from 'node:path';
import { getDb } from '@archi-navi/db';
import { objects } from '@archi-navi/db';
import { eq, and } from 'drizzle-orm';
import { generateId, buildPath } from '@archi-navi/shared';
import type { ScanMode, DiscoveredProject, ScanResult } from '@archi-navi/shared';
import { detectProjects, detectSingleProject } from '../utils/project-detector';
import {
  checkGhAuth,
  listOrgRepos,
  cloneRepo,
  cleanupClone,
  createTempDir,
} from '../utils/github-helper';

/** 발견된 프로젝트를 service Object로 DB에 등록 */
async function registerProjects(
  workspaceId: string,
  projects: DiscoveredProject[],
  dryRun: boolean,
): Promise<{ registered: number; skipped: number }> {
  if (dryRun || projects.length === 0) {
    return { registered: 0, skipped: projects.length };
  }

  const db = await getDb();
  let registered = 0;
  let skipped = 0;

  for (const proj of projects) {
    // 이름 중복 체크
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
      metadata: {
        scanPath: proj.path,
        language: proj.language,
        markerFile: proj.markerFile,
      },
    });
    registered++;
  }

  return { registered, skipped };
}

/** 결과 출력 포맷 */
function printResult(result: ScanResult, dryRun: boolean): void {
  console.log('');
  console.log(chalk.bold(`  모드: ${result.mode}`));
  console.log(chalk.bold(`  대상: ${result.target}`));
  console.log(chalk.bold(`  발견: ${result.projects.length}개 프로젝트`));
  console.log('');

  for (const proj of result.projects) {
    const langTag = chalk.cyan(`[${proj.language}]`);
    const marker = chalk.dim(`(${proj.markerFile})`);
    console.log(`    ${langTag} ${proj.name} ${marker}`);
    console.log(chalk.dim(`       ${proj.path}`));
  }

  if (!dryRun) {
    console.log('');
    console.log(chalk.green(`  등록: ${result.registered}개`));
    if (result.skipped > 0) {
      console.log(chalk.yellow(`  스킵 (이미 존재): ${result.skipped}개`));
    }
  } else {
    console.log('');
    console.log(chalk.blue('  [Dry-run] 실제 등록하지 않았습니다.'));
  }
}

export function createScanCommand(): Command {
  return new Command('scan')
    .description('프로젝트를 탐색하여 서비스 Object를 등록합니다')
    .requiredOption('-w, --workspace <id>', '워크스페이스 ID')
    .option('-p, --path <dir>', '단일 디렉토리 스캔')
    .option('--workspace-dir <dir>', '워크스페이스 폴더 하위 프로젝트 일괄 스캔')
    .option('--github-repo <nwo>', 'GitHub 레포 스캔 (owner/repo)')
    .option('--github-org <org>', 'GitHub Org 전체 레포 스캔')
    .option('--lang <langs>', '언어 필터 (comma-separated)', '')
    .option('--dry-run', '실제 저장 없이 스캔 결과만 출력')
    .action(async (options: {
      workspace: string;
      path?: string;
      workspaceDir?: string;
      githubRepo?: string;
      githubOrg?: string;
      lang: string;
      dryRun?: boolean;
    }) => {
      const spinner = ora('스캔 준비 중...').start();
      const dryRun = options.dryRun ?? false;

      try {
        // 모드 결정
        const mode: ScanMode = options.githubOrg
          ? 'github-org'
          : options.githubRepo
            ? 'github-repo'
            : options.workspaceDir
              ? 'workspace-dir'
              : 'local';

        let projects: DiscoveredProject[] = [];
        let target = '';

        switch (mode) {
          /* ── 로컬 단일 디렉토리 ── */
          case 'local': {
            target = path.resolve(options.path ?? process.cwd());
            spinner.text = `${target} 스캔 중...`;
            const single = detectSingleProject(target);
            if (single) {
              projects = [single];
            } else {
              // 단일 프로젝트가 아니면 하위 탐색
              projects = detectProjects(target);
            }
            break;
          }

          /* ── 워크스페이스 폴더 하위 일괄 ── */
          case 'workspace-dir': {
            target = path.resolve(options.workspaceDir!);
            spinner.text = `${target} 하위 프로젝트 탐색 중...`;
            projects = detectProjects(target);
            break;
          }

          /* ── GitHub 단일 레포 ── */
          case 'github-repo': {
            target = options.githubRepo!;
            spinner.text = 'gh CLI 인증 확인 중...';
            checkGhAuth();

            const tmpDir = createTempDir('repo');
            try {
              spinner.text = `${target} 클론 중...`;
              cloneRepo(target, path.join(tmpDir, target.split('/').pop() ?? 'repo'));
              spinner.text = '프로젝트 감지 중...';
              projects = detectProjects(tmpDir);
            } finally {
              cleanupClone(tmpDir);
            }
            break;
          }

          /* ── GitHub Org 전체 ── */
          case 'github-org': {
            target = options.githubOrg!;
            spinner.text = 'gh CLI 인증 확인 중...';
            checkGhAuth();

            spinner.text = `${target} 레포 목록 조회 중...`;
            const repos = listOrgRepos(target);
            spinner.text = `${repos.length}개 레포 클론+스캔 중...`;

            const tmpDir = createTempDir('org');
            try {
              for (let i = 0; i < repos.length; i++) {
                const repo = repos[i]!;
                spinner.text = `[${i + 1}/${repos.length}] ${repo.name} 클론 중...`;
                const repoDir = path.join(tmpDir, repo.name);
                try {
                  cloneRepo(`${target}/${repo.name}`, repoDir);
                  const detected = detectSingleProject(repoDir);
                  if (detected) {
                    projects.push(detected);
                  }
                } catch {
                  // 개별 레포 클론 실패는 건너뜀
                }
              }
            } finally {
              cleanupClone(tmpDir);
            }
            break;
          }
        }

        // 언어 필터 적용
        if (options.lang) {
          const langs = options.lang.split(',').map((l) => l.trim().toLowerCase());
          projects = projects.filter((p) => langs.includes(p.language));
        }

        // DB 등록
        spinner.text = '프로젝트 등록 중...';
        const { registered, skipped } = await registerProjects(
          options.workspace,
          projects,
          dryRun,
        );

        const result: ScanResult = {
          mode,
          target,
          projects,
          registered,
          skipped,
        };

        spinner.succeed(chalk.green(`스캔 완료 — ${projects.length}개 프로젝트 발견`));
        printResult(result, dryRun);
      } catch (error) {
        spinner.fail(chalk.red('스캔 실패'));
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });
}
