/**
 * export 커맨드
 * 아키텍처 데이터를 JSON/YAML/DOT 형식으로 내보냅니다
 * 사용법: anavi export --workspace <id> --format json --output ./arch.json
 */
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { getDb } from '@archi-navi/db';
import { objects, objectRelations } from '@archi-navi/db';
import { eq, and } from 'drizzle-orm';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

type ExportFormat = 'json' | 'dot';

export function createExportCommand(): Command {
  return new Command('export')
    .description('아키텍처 데이터를 파일로 내보냅니다')
    .requiredOption('-w, --workspace <id>', '워크스페이스 ID')
    .option('--format <fmt>', '출력 형식 (json | dot)', 'json')
    .option('-o, --output <path>', '출력 파일 경로', './arch-export.json')
    .option('--include-candidates', '후보 관계도 포함 (미승인 포함)')
    .action(async (options: {
      workspace: string;
      format: string;
      output: string;
      includeCandidates?: boolean;
    }) => {
      const spinner = ora('데이터 내보내기 중...').start();

      try {
        const db = await getDb();
        const fmt = options.format as ExportFormat;
        const outputPath = resolve(options.output);

        // Object 조회
        const allObjects = await db
          .select()
          .from(objects)
          .where(eq(objects.workspaceId, options.workspace));

        // Relation 조회
        const allRelations = await db
          .select()
          .from(objectRelations)
          .where(
            and(
              eq(objectRelations.workspaceId, options.workspace),
              eq(objectRelations.status, 'APPROVED'),
            ),
          );

        let output: string;

        if (fmt === 'json') {
          const data = {
            exportedAt: new Date().toISOString(),
            workspaceId: options.workspace,
            objects: allObjects,
            relations: allRelations,
          };
          output = JSON.stringify(data, null, 2);
        } else if (fmt === 'dot') {
          // Graphviz DOT 형식
          const lines = ['digraph ArchiNavi {', '  rankdir=LR;'];
          for (const obj of allObjects) {
            lines.push(`  "${obj.id}" [label="${obj.displayName ?? obj.name}"];`);
          }
          for (const rel of allRelations) {
            lines.push(
              `  "${rel.subjectObjectId}" -> "${rel.objectId}" [label="${rel.relationType}"];`,
            );
          }
          lines.push('}');
          output = lines.join('\n');
        } else {
          spinner.fail(chalk.red(`알 수 없는 형식: ${fmt}`));
          process.exit(1);
          return;
        }

        writeFileSync(outputPath, output, 'utf-8');
        spinner.succeed(chalk.green('내보내기 완료'));
        console.log(chalk.dim(`  형식: ${fmt}`));
        console.log(chalk.dim(`  Objects: ${allObjects.length}개`));
        console.log(chalk.dim(`  Relations: ${allRelations.length}개`));
        console.log(chalk.dim(`  파일: ${outputPath}`));
      } catch (error) {
        spinner.fail(chalk.red('내보내기 실패'));
        console.error(error);
        process.exit(1);
      }
    });
}
