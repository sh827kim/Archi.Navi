/**
 * anavi CLI 메인 진입점
 * Commander.js 기반 CLI 구성
 */
import { Command } from 'commander';
import chalk from 'chalk';
import { createUpCommand } from './commands/up';

const program = new Command();

program
  .name('anavi')
  .description(
    chalk.bold('Archi.Navi') +
      ' — MSA 아키텍처 내비게이션 도구\n' +
      chalk.dim('서비스 간 의존 관계를 수집, 추론, 시각화합니다.'),
  )
  .version('0.1.0', '-v, --version', '버전 출력');

function createUnavailableCommand(
  name: string,
  description: string,
  reason: unknown,
): Command {
  return new Command(name)
    .description(`${description} (현재 런타임에서 사용 불가)`)
    .action(() => {
      const message = reason instanceof Error ? reason.message : String(reason);
      console.error(chalk.red(`'${name}' 커맨드를 로드하지 못했습니다.`));
      console.error(chalk.dim(message));
      console.error(
        chalk.dim(
          'workspace 패키지가 모두 설치/빌드된 모노레포 환경에서 실행하거나, 배포된 의존 패키지를 함께 설치하세요.',
        ),
      );
      process.exit(1);
    });
}

async function registerLazyCommand(
  name: string,
  description: string,
  loader: () => Promise<{ createCommand: () => Command }>,
): Promise<void> {
  try {
    const loaded = await loader();
    program.addCommand(loaded.createCommand());
  } catch (error) {
    program.addCommand(createUnavailableCommand(name, description, error));
  }
}

async function bootstrap(): Promise<void> {
  // 의존성 없는 커맨드는 즉시 등록
  program.addCommand(createUpCommand());

  // 의존성 무거운 커맨드는 지연 로드(실패 시 stub 등록)
  await registerLazyCommand('scan', '프로젝트를 탐색하여 서비스 Object를 등록합니다', async () => {
    const mod = await import('./commands/scan.js');
    return { createCommand: mod.createScanCommand };
  });
  await registerLazyCommand('infer', '도메인 추론을 실행합니다 (Track A: Seed 기반, Track B: 자동 탐지)', async () => {
    const mod = await import('./commands/infer.js');
    return { createCommand: mod.createInferCommand };
  });
  await registerLazyCommand('rebuild-rollup', 'Roll-up 집계 테이블을 재계산합니다', async () => {
    const mod = await import('./commands/rebuild-rollup.js');
    return { createCommand: mod.createRebuildRollupCommand };
  });
  await registerLazyCommand('export', '아키텍처 데이터를 파일로 내보냅니다', async () => {
    const mod = await import('./commands/export.js');
    return { createCommand: mod.createExportCommand };
  });
  await registerLazyCommand('snapshot', 'DB 스냅샷을 저장하거나 복원합니다', async () => {
    const mod = await import('./commands/snapshot.js');
    return { createCommand: mod.createSnapshotCommand };
  });

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
}

void bootstrap();
