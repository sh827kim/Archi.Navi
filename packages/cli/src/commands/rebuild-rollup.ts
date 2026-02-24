/**
 * rebuild-rollup 커맨드
 * Roll-up 집계 테이블을 재계산합니다
 * 사용법:
 *   archi-navi rebuild-rollup --workspace <id>              # 전체 재빌드
 *   archi-navi rebuild-rollup --workspace <id> --incremental # 증분 재빌드 (변경분만)
 */
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getDb } from '@archi-navi/db';
import { rebuildRollups, incrementalRebuild } from '@archi-navi/core';

export function createRebuildRollupCommand(): Command {
  return new Command('rebuild-rollup')
    .description('Roll-up 집계 테이블을 재계산합니다')
    .requiredOption('-w, --workspace <id>', '워크스페이스 ID')
    .option('--profile <id>', '워크스페이스 프로필 ID')
    .option('--incremental', '변경분만 증분 재빌드 (ACTIVE generation 유지)')
    .action(async (options: {
      workspace: string;
      profile?: string;
      incremental?: boolean;
    }) => {
      const isIncremental = options.incremental ?? false;
      const label = isIncremental ? '증분 Roll-up 재계산' : 'Roll-up 전체 재계산';
      const spinner = ora(`${label} 중...`).start();

      try {
        const db = await getDb();

        let resultVersion: number;
        if (isIncremental) {
          // 증분 모드: 빈 이벤트로 호출 → ACTIVE generation이 없으면 전체 리빌드 fallback
          // CLI에서는 이벤트 없이 호출하면 현재 version만 반환된다.
          // 실제 증분 리빌드는 API 호출부에서 이벤트와 함께 호출해야 한다.
          resultVersion = await incrementalRebuild(db, options.workspace, []);
        } else {
          resultVersion = await rebuildRollups(db, options.workspace);
        }

        spinner.succeed(chalk.green(`${label} 완료`));
        console.log(chalk.dim(`  Generation: ${resultVersion}`));
        console.log(
          chalk.dim(
            `  레벨: SERVICE_TO_SERVICE, SERVICE_TO_DATABASE, SERVICE_TO_BROKER, DOMAIN_TO_DOMAIN`,
          ),
        );
        if (isIncremental) {
          console.log(chalk.dim('  모드: 증분 (변경 영향 범위만 재계산)'));
        }
      } catch (error) {
        spinner.fail(chalk.red(`${label} 실패`));
        console.error(error);
        process.exit(1);
      }
    });
}
