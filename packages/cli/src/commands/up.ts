/**
 * up 커맨드
 * Archi.Navi Web 앱을 실행한다.
 *
 * 실행 우선순위:
 * 1) 현재/상위 디렉토리에서 monorepo 루트 탐지 → workspace web 실행
 * 2) 설치된 @archi-navi/web 패키지 탐지 → 해당 패키지의 스크립트 실행
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

type PackageManager = 'pnpm' | 'npm' | 'yarn';

function findRepoRoot(startDir: string): string | null {
  let current = resolve(startDir);
  while (true) {
    const webPkg = resolve(current, 'apps', 'web', 'package.json');
    const wsFile = resolve(current, 'pnpm-workspace.yaml');
    if (existsSync(webPkg) && existsSync(wsFile)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function detectPackageManager(repoRoot: string): PackageManager {
  if (existsSync(resolve(repoRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(resolve(repoRoot, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function commandExists(bin: string): boolean {
  const envPath = process.env['PATH'] ?? '';
  const entries = envPath.split(process.platform === 'win32' ? ';' : ':');
  const exts =
    process.platform === 'win32'
      ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM')
          .split(';')
          .map((v) => v.toLowerCase())
      : [''];

  for (const dir of entries) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = resolve(dir, process.platform === 'win32' ? `${bin}${ext}` : bin);
      if (existsSync(candidate)) return true;
    }
  }
  return false;
}

async function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return await new Promise<number>((resolveCode, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('error', reject);
    child.on('close', (code) => resolveCode(code ?? 0));
  });
}

async function runRepoWeb(options: {
  repoRoot: string;
  prod: boolean;
  port: number;
  host: string;
}): Promise<number> {
  const { repoRoot, prod, port, host } = options;
  const pm = detectPackageManager(repoRoot);
  const env = {
    ...process.env,
    PORT: String(port),
    HOSTNAME: host,
  };

  const runPm = async (script: 'dev' | 'build' | 'start'): Promise<number> => {
    if (pm === 'pnpm') {
      return runCommand('pnpm', ['--filter', '@archi-navi/web', script], repoRoot, env);
    }
    if (pm === 'yarn') {
      return runCommand('yarn', ['workspace', '@archi-navi/web', script], repoRoot, env);
    }
    return runCommand('npm', ['run', script, '--workspace', '@archi-navi/web'], repoRoot, env);
  };

  if (prod) {
    const buildCode = await runPm('build');
    if (buildCode !== 0) return buildCode;
    return runPm('start');
  }
  return runPm('dev');
}

function findInstalledWebPackage(cwd: string): string | null {
  const requireFn = createRequire(resolve(cwd, 'noop.js'));
  try {
    const pkgJsonPath = requireFn.resolve('@archi-navi/web/package.json');
    return dirname(pkgJsonPath);
  } catch {
    return null;
  }
}

function findInstalledPackageDir(cwd: string, packageName: string): string | null {
  const requireFn = createRequire(resolve(cwd, 'noop.js'));
  try {
    const pkgJsonPath = requireFn.resolve(`${packageName}/package.json`);
    return dirname(pkgJsonPath);
  } catch {
    return null;
  }
}

async function runInstalledWeb(options: {
  webDir: string;
  prod: boolean;
  port: number;
  host: string;
  startDir: string;
}): Promise<number> {
  const { webDir, prod, port, host, startDir } = options;
  const defaultDataDir = resolve(homedir(), '.archi-navi', 'db');
  const installedDbDir = findInstalledPackageDir(startDir, '@archi-navi/db');
  const installedMigrations =
    installedDbDir && existsSync(resolve(installedDbDir, 'src', 'migrations'))
      ? resolve(installedDbDir, 'src', 'migrations')
      : undefined;

  const env = {
    ...process.env,
    PORT: String(port),
    HOSTNAME: host,
    ARCHI_NAVI_DB_DATA_DIR: process.env['ARCHI_NAVI_DB_DATA_DIR'] ?? defaultDataDir,
    ARCHI_NAVI_DB_PORT: process.env['ARCHI_NAVI_DB_PORT'] ?? '54329',
    MIGRATIONS_FOLDER: process.env['MIGRATIONS_FOLDER'] ?? installedMigrations,
  };

  if (prod) {
    const buildCode = await runCommand('npm', ['run', 'build'], webDir, env);
    if (buildCode !== 0) return buildCode;
    return runCommand('npm', ['run', 'start'], webDir, env);
  }
  return runCommand('npm', ['run', 'dev'], webDir, env);
}

function readVersion(): string {
  const candidates = [
    resolve(__dirname, '../../package.json'),   // src/commands -> package root
    resolve(__dirname, '../../../package.json'), // dist/src/commands -> package root
  ];
  for (const candidate of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf-8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === '@archi-navi/cli' && pkg.version) {
        return pkg.version;
      }
    } catch {
      // ignore and try next candidate
    }
  }
  return 'unknown';
}

export function createUpCommand(): Command {
  return new Command('up')
    .description('Archi.Navi 웹 앱을 실행합니다')
    .option('--prod', '프로덕션 모드(build 후 start)로 실행')
    .option('--port <port>', '서버 포트 (기본: 3000)', '3000')
    .option('--host <host>', '서버 호스트 (기본: 127.0.0.1)', '127.0.0.1')
    .option('--cwd <path>', '탐색 시작 디렉토리 (기본: 현재 디렉토리)')
    .action(async (opts: { prod?: boolean; port: string; host: string; cwd?: string }) => {
      const prod = opts.prod ?? false;
      const port = Number.parseInt(opts.port, 10);
      const host = opts.host.trim() || '127.0.0.1';
      const startDir = resolve(opts.cwd ?? process.cwd());

      if (!Number.isFinite(port) || port < 1 || port > 65535) {
        console.error(chalk.red(`유효하지 않은 포트입니다: ${opts.port}`));
        process.exit(1);
      }

      console.log(chalk.bold(`anavi up (v${readVersion()})`));
      console.log(chalk.dim(`mode=${prod ? 'prod' : 'dev'} port=${port} host=${host}`));

      const repoRoot = findRepoRoot(startDir);
      if (repoRoot) {
        const pm = detectPackageManager(repoRoot);
        if ((pm === 'pnpm' || pm === 'yarn') && !commandExists(pm)) {
          console.error(chalk.red(`${pm} 명령을 찾을 수 없습니다.`));
          process.exit(1);
        }
        const exitCode = await runRepoWeb({ repoRoot, prod, port, host });
        process.exit(exitCode);
      }

      const webDir = findInstalledWebPackage(startDir);
      if (webDir) {
        if (!commandExists('npm')) {
          console.error(chalk.red('npm 명령을 찾을 수 없습니다.'));
          process.exit(1);
        }
        const exitCode = await runInstalledWeb({ webDir, prod, port, host, startDir });
        process.exit(exitCode);
      }

      console.error(chalk.red('실행 가능한 Web 패키지를 찾지 못했습니다.'));
      console.error(
        chalk.dim(
          [
            '다음 중 하나를 준비하세요:',
            '1) Archi.Navi 모노레포 루트(또는 하위)에서 anavi up 실행',
            '2) @archi-navi/web 패키지가 설치된 환경에서 anavi up 실행',
          ].join('\n'),
        ),
      );
      process.exit(1);
    });
}
