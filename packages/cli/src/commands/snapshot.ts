/**
 * snapshot 커맨드
 * PGlite DB 파일을 백업/복원합니다
 * 사용법: anavi snapshot save --output ./backup.db
 *         anavi snapshot restore --input ./backup.db
 */
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_DB_PATH = resolve(homedir(), '.archi-navi', 'archi.db');

export function createSnapshotCommand(): Command {
  const snapshot = new Command('snapshot').description(
    'DB 스냅샷을 저장하거나 복원합니다',
  );

  // save 서브커맨드
  snapshot
    .command('save')
    .description('현재 DB 상태를 파일로 저장합니다')
    .option('--db-path <path>', 'DB 파일 경로', DEFAULT_DB_PATH)
    .option('-o, --output <path>', '출력 경로', './anavi-snapshot.db')
    .action(async (options: { dbPath: string; output: string }) => {
      const spinner = ora('스냅샷 저장 중...').start();

      try {
        const dbPath = resolve(options.dbPath);
        const outputPath = resolve(options.output);

        if (!existsSync(dbPath)) {
          spinner.fail(chalk.red(`DB 파일을 찾을 수 없습니다: ${dbPath}`));
          process.exit(1);
        }

        copyFileSync(dbPath, outputPath);
        spinner.succeed(chalk.green('스냅샷 저장 완료'));
        console.log(chalk.dim(`  원본: ${dbPath}`));
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
    .description('스냅샷 파일에서 DB를 복원합니다')
    .option('--db-path <path>', 'DB 파일 경로', DEFAULT_DB_PATH)
    .option('-i, --input <path>', '입력 스냅샷 경로', './anavi-snapshot.db')
    .action(async (options: { dbPath: string; input: string }) => {
      const spinner = ora('스냅샷 복원 중...').start();

      try {
        const dbPath = resolve(options.dbPath);
        const inputPath = resolve(options.input);

        if (!existsSync(inputPath)) {
          spinner.fail(chalk.red(`스냅샷 파일을 찾을 수 없습니다: ${inputPath}`));
          process.exit(1);
        }

        copyFileSync(inputPath, dbPath);
        spinner.succeed(chalk.green('스냅샷 복원 완료'));
        console.log(chalk.dim(`  스냅샷: ${inputPath}`));
        console.log(chalk.dim(`  복원 위치: ${dbPath}`));
        console.log(chalk.yellow('  ⚠️  서버를 재시작하여 복원된 DB를 적용하세요.'));
      } catch (error) {
        spinner.fail(chalk.red('스냅샷 복원 실패'));
        console.error(error);
        process.exit(1);
      }
    });

  return snapshot;
}
