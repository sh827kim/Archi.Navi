import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { calibrateMultiModuleServiceBoundaries } from '@/orchestration/moduleBoundaryCalibrator';

const tempDirs: string[] = [];

function createRepoRoot(): string {
  const dir = join(tmpdir(), `archi-navi-module-calibrator-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('moduleBoundaryCalibrator', () => {
  it('실행 모듈과 라이브러리 모듈을 점수 기반으로 구분해야 한다', () => {
    const repoRoot = createRepoRoot();
    writeFileSync(join(repoRoot, 'settings.gradle'), "include(':apps:orders', ':libs:common')");

    const ordersRoot = join(repoRoot, 'apps/orders');
    mkdirSync(join(ordersRoot, 'src/main/resources'), { recursive: true });
    mkdirSync(join(ordersRoot, 'src/main/java'), { recursive: true });
    writeFileSync(join(ordersRoot, 'build.gradle'), 'plugins { id "org.springframework.boot" }');
    writeFileSync(join(ordersRoot, 'src/main/resources/application.yml'), 'server:\n  port: 8080');

    const commonRoot = join(repoRoot, 'libs/common');
    mkdirSync(join(commonRoot, 'src/main/java'), { recursive: true });
    writeFileSync(join(commonRoot, 'build.gradle'), 'plugins { id "java-library" }');

    const result = calibrateMultiModuleServiceBoundaries(repoRoot);

    const orders = result.find((entry) => entry.modulePath === 'apps/orders');
    const common = result.find((entry) => entry.modulePath === 'libs/common');

    expect(orders?.classification).toBe('service_candidate');
    expect(common?.classification).toBe('library_candidate');
    expect((orders?.score ?? 0) > (common?.score ?? 0)).toBe(true);
  });
});
