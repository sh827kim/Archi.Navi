/**
 * infer 커맨드
 * 수집된 신호를 바탕으로 도메인/관계 추론을 실행
 * 사용법: anavi infer --workspace <id> [--track a|b|all]
 */
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getDb } from '@archi-navi/db';
import { runSeedBasedInference, runDiscovery } from '@archi-navi/inference';

export function createInferCommand(): Command {
  return new Command('infer')
    .description('도메인 추론을 실행합니다 (Track A: Seed 기반, Track B: 자동 탐지)')
    .requiredOption('-w, --workspace <id>', '워크스페이스 ID')
    .option('--track <track>', '추론 트랙 (a | b | all)', 'all')
    .option('--profile <id>', 'Track A에서 사용할 추론 프로필 ID')
    .option('--generation <ver>', 'Track B에서 참조할 rollup generation 버전', '1')
    .option('--min-cluster-size <n>', 'Track B 최소 클러스터 크기', '3')
    .option('--resolution <r>', 'Track B Louvain resolution 파라미터', '1.0')
    .action(async (options: {
      workspace: string;
      track: string;
      profile?: string;
      generation: string;
      minClusterSize: string;
      resolution: string;
    }) => {
      const db = await getDb();
      const track = options.track.toLowerCase();

      // Track A: Seed 기반 Affinity 추론
      if (track === 'a' || track === 'all') {
        const spinner = ora('Track A: Seed 기반 도메인 추론 중...').start();
        try {
          const result = await runSeedBasedInference(db, {
            workspaceId: options.workspace,
            ...(options.profile ? { profileId: options.profile } : {}),
          });
          spinner.succeed(
            chalk.green(`Track A 완료: 후보 ${result.candidateCount}개 생성`),
          );
        } catch (error) {
          spinner.fail(chalk.red('Track A 실패'));
          console.error(error);
        }
      }

      // Track B: Seed-less 자동 탐지
      if (track === 'b' || track === 'all') {
        const spinner = ora('Track B: Louvain 커뮤니티 탐지 중...').start();
        try {
          const result = await runDiscovery(db, {
            workspaceId: options.workspace,
            generationVersion: parseInt(options.generation, 10),
            minClusterSize: parseInt(options.minClusterSize, 10),
            resolution: parseFloat(options.resolution),
          });
          spinner.succeed(
            chalk.green(
              `Track B 완료: ${result.clusterCount}개 클러스터 발견 (run: ${result.runId})`,
            ),
          );
        } catch (error) {
          spinner.fail(chalk.red('Track B 실패'));
          console.error(error);
        }
      }
    });
}
