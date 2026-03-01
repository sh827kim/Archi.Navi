/**
 * anavi CLI 메인 진입점
 * Commander.js 기반 CLI 구성
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { createScanCommand } from './commands/scan';
import { createInferCommand } from './commands/infer';
import { createRebuildRollupCommand } from './commands/rebuild-rollup';
import { createExportCommand } from './commands/export';
import { createSnapshotCommand } from './commands/snapshot';

const program = new Command();

program
  .name('anavi')
  .description(
    chalk.bold('Archi.Navi') +
      ' — MSA 아키텍처 내비게이션 도구\n' +
      chalk.dim('서비스 간 의존 관계를 수집, 추론, 시각화합니다.'),
  )
  .version('0.1.0', '-v, --version', '버전 출력');

// 커맨드 등록
program.addCommand(createScanCommand());
program.addCommand(createInferCommand());
program.addCommand(createRebuildRollupCommand());
program.addCommand(createExportCommand());
program.addCommand(createSnapshotCommand());

// 알 수 없는 커맨드 처리
program.on('command:*', (operands: string[]) => {
  console.error(chalk.red(`알 수 없는 커맨드: ${operands.join(' ')}`));
  console.log(chalk.dim('anavi --help 를 실행하여 사용법을 확인하세요.'));
  process.exit(1);
});

program.parse(process.argv);

// 커맨드 없이 실행 시 help 출력
if (process.argv.length <= 2) {
  program.help();
}
