import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  calibrateMultiModuleServiceBoundaries,
  scoreModuleExecutability,
} from '@/orchestration/moduleBoundaryCalibrator';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');

  return {
    ...actual,
    existsSync(target: string) {
      if (actual.existsSync(target)) return true;

      if (/\/src\/main\/resources\/application\.(yml|yaml|json)$/.test(target)) {
        return actual.existsSync(target.replace(/application\.(yml|yaml|json)$/, 'application.properties'));
      }

      return false;
    },
  };
});

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

  it('Maven multi-module parent pom.xml 기준으로 service 모듈과 library 모듈을 구분해야 한다', () => {
    const repoRoot = createRepoRoot();
    writeFileSync(
      join(repoRoot, 'pom.xml'),
      `<project>
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>reactor-parent</artifactId>
  <packaging>pom</packaging>
  <modules>
    <module>services/order-service</module>
    <module>libs/common-domain</module>
  </modules>
</project>`,
    );

    const serviceRoot = join(repoRoot, 'services/order-service');
    mkdirSync(join(serviceRoot, 'src/main/java'), { recursive: true });
    mkdirSync(join(serviceRoot, 'src/main/resources'), { recursive: true });
    writeFileSync(
      join(serviceRoot, 'pom.xml'),
      `<project>
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>com.example</groupId>
    <artifactId>reactor-parent</artifactId>
    <version>1.0.0</version>
  </parent>
  <artifactId>order-service</artifactId>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
  </dependencies>
</project>`,
    );
    writeFileSync(join(serviceRoot, 'src/main/resources/application.properties'), 'server.port=8080');

    const libraryRoot = join(repoRoot, 'libs/common-domain');
    mkdirSync(join(libraryRoot, 'src/main/java'), { recursive: true });
    writeFileSync(
      join(libraryRoot, 'pom.xml'),
      `<project>
  <modelVersion>4.0.0</modelVersion>
  <parent>
    <groupId>com.example</groupId>
    <artifactId>reactor-parent</artifactId>
    <version>1.0.0</version>
  </parent>
  <artifactId>common-domain</artifactId>
</project>`,
    );

    const service = scoreModuleExecutability(repoRoot, 'services/order-service');
    const library = scoreModuleExecutability(repoRoot, 'libs/common-domain');

    expect(service.classification).toBe('service_candidate');
    expect(library.classification).toBe('library_candidate');
    expect(service.score).toBeGreaterThan(library.score);
    expect(service.reasons).toContain('application config found (+3)');
  });

  it('application.properties는 application config 점수에 반영되어 threshold 경계를 inherited로 유지해야 한다', () => {
    const repoRoot = createRepoRoot();

    const baseModuleRoot = join(repoRoot, 'apps/catalog-base');
    mkdirSync(join(baseModuleRoot, 'src/main/resources'), { recursive: true });

    const configModuleRoot = join(repoRoot, 'apps/catalog-config');
    mkdirSync(join(configModuleRoot, 'src/main/resources'), { recursive: true });
    writeFileSync(join(configModuleRoot, 'src/main/resources/application.properties'), 'server.port=8081');

    const baseResult = scoreModuleExecutability(repoRoot, 'apps/catalog-base');
    const configResult = scoreModuleExecutability(repoRoot, 'apps/catalog-config');

    expect(baseResult.classification).toBe('library_candidate');
    expect(configResult.classification).toBe('inherited');
    expect(configResult.score).toBeGreaterThan(baseResult.score);
    expect(configResult.reasons).toContain('application config found (+3)');
  });

  it('threshold 경계값에서는 inherited와 reasons를 함께 보존해야 한다', () => {
    const repoRoot = createRepoRoot();
    const moduleRoot = join(repoRoot, 'apps/threshold-service');

    mkdirSync(join(moduleRoot, 'src/main/resources'), { recursive: true });
    writeFileSync(join(moduleRoot, 'src/main/resources/application.properties'), 'server.port=9090');

    const result = scoreModuleExecutability(repoRoot, 'apps/threshold-service');

    expect(result.classification).toBe('inherited');
    expect(result.score).toBe(1);
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        'application config found (+3)',
        'no entrypoint and no executable plugin (-3)',
      ]),
    );
  });
});
