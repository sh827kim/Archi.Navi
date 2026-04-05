/**
 * snapshot 커맨드
 * embedded postgres 데이터 디렉터리를 백업/복원합니다
 * 사용법: anavi snapshot save --output ./backup-db
 *         anavi snapshot restore --input ./backup-db
 */
import { resolveDefaultEmbeddedPostgresDataDir } from '@archi-navi/db';
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const DEFAULT_DB_DIR = resolveDefaultEmbeddedPostgresDataDir();

export function createSnapshotCommand(): Command {
  const snapshot = new Command('snapshot').description(
    'DB 스냅샷을 저장하거나 복원합니다',
  );

  // save 서브커맨드
  snapshot
    .command('save')
    .description('현재 DB 데이터 디렉터리를 저장합니다')
    .option('--db-dir <path>', 'DB 데이터 디렉터리', DEFAULT_DB_DIR)
    .option('-o, --output <path>', '출력 디렉터리', './anavi-snapshot-db')
    .action(async (options: { dbDir: string; output: string }) => {
      const spinner = ora('스냅샷 저장 중...').start();

      try {
        const dbDir = resolve(options.dbDir);
        const outputPath = resolve(options.output);

        if (!existsSync(dbDir)) {
          spinner.fail(chalk.red(`DB 데이터 디렉터리를 찾을 수 없습니다: ${dbDir}`));
          process.exit(1);
        }

        rmSync(outputPath, { recursive: true, force: true });
        cpSync(dbDir, outputPath, { recursive: true });
        spinner.succeed(chalk.green('스냅샷 저장 완료'));
        console.log(chalk.dim(`  원본: ${dbDir}`));
        console.log(chalk.dim(`  저장: ${outputPath}`));
      } catch (error) {
        spinner.fail(chalk.red('스냅샷 저장 실패'));
        console.error(error);
        process.exit(1);
      }
    });

  // restore 서브커맨드
  snapshot
    .command('restore')
    .description('스냅샷 디렉터리에서 DB를 복원합니다')
    .option('--db-dir <path>', 'DB 데이터 디렉터리', DEFAULT_DB_DIR)
    .option('-i, --input <path>', '입력 스냅샷 디렉터리', './anavi-snapshot-db')
    .action(async (options: { dbDir: string; input: string }) => {
      const spinner = ora('스냅샷 복원 중...').start();

      try {
        const dbDir = resolve(options.dbDir);
        const inputPath = resolve(options.input);

        if (!existsSync(inputPath)) {
          spinner.fail(chalk.red(`스냅샷 디렉터리를 찾을 수 없습니다: ${inputPath}`));
          process.exit(1);
        }

        rmSync(dbDir, { recursive: true, force: true });
        cpSync(inputPath, dbDir, { recursive: true });
        spinner.succeed(chalk.green('스냅샷 복원 완료'));
        console.log(chalk.dim(`  스냅샷: ${inputPath}`));
        console.log(chalk.dim(`  복원 위치: ${dbDir}`));
        console.log(chalk.yellow('  ⚠️  서버를 재시작하여 복원된 DB를 적용하세요.'));
      } catch (error) {
        spinner.fail(chalk.red('스냅샷 복원 실패'));
        console.error(error);
        process.exit(1);
      }
    });

  return snapshot;
}
