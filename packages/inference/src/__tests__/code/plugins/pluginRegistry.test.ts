import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { FrameworkPlugin } from '@/code';
import { PluginRegistry, detectPlugins } from '@/code';
import { scanFileWithRegexPlugins } from '@/code';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join(tmpdir(), `archi-navi-plugin-registry-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('pluginRegistry', () => {
  it('built-in plugin registry에서 spring-boot와 express를 조회할 수 있어야 한다', () => {
    const registry = new PluginRegistry();

    expect(registry.getById('spring-boot')?.id).toBe('spring-boot');
    expect(registry.getById('express')?.id).toBe('express');
  });

  it('package.json 의존성에서 express와 nestjs를 자동 감지해야 한다', () => {
    const repoRoot = makeTempDir();
    writeFileSync(
      join(repoRoot, 'package.json'),
      JSON.stringify({
        dependencies: {
          express: '^5.0.0',
          '@nestjs/core': '^11.0.0',
        },
      }),
    );

    const detected = detectPlugins(repoRoot).map((plugin) => plugin.id);

    expect(detected).toContain('express');
    expect(detected).toContain('nestjs');
    expect(detected).not.toContain('typescript-common');
  });

  it('pom.xml에서 spring-boot를 자동 감지해야 한다', () => {
    const repoRoot = makeTempDir();
    writeFileSync(
      join(repoRoot, 'pom.xml'),
      `<project>
        <dependencies>
          <dependency>
            <groupId>org.springframework.boot</groupId>
            <artifactId>spring-boot-starter-web</artifactId>
          </dependency>
        </dependencies>
      </project>`,
    );

    const detected = detectPlugins(repoRoot).map((plugin) => plugin.id);

    expect(detected).toContain('spring-boot');
    expect(detected).not.toContain('java-common');
  });

  it('일반 Maven 프로젝트는 spring-boot가 아니라 java-common으로 fallback 되어야 한다', () => {
    const repoRoot = makeTempDir();
    writeFileSync(
      join(repoRoot, 'pom.xml'),
      `<project>
        <groupId>com.example</groupId>
        <artifactId>plain-java-app</artifactId>
      </project>`,
    );

    const detected = detectPlugins(repoRoot).map((plugin) => plugin.id);

    expect(detected).toContain('java-common');
    expect(detected).not.toContain('spring-boot');
  });

  it('pyproject.toml에서 fastapi를 자동 감지해야 한다', () => {
    const repoRoot = makeTempDir();
    writeFileSync(
      join(repoRoot, 'pyproject.toml'),
      `[project]
dependencies = ["fastapi>=0.110.0"]`,
    );

    const detected = detectPlugins(repoRoot).map((plugin) => plugin.id);

    expect(detected).toContain('fastapi');
    expect(detected).not.toContain('python-common');
  });

  it('manifest가 없어도 java/typescript/python 파일이 있으면 fallback plugin을 선택해야 한다', () => {
    const repoRoot = makeTempDir();
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    writeFileSync(join(repoRoot, 'src', 'OrderController.java'), 'class OrderController {}');
    writeFileSync(join(repoRoot, 'src', 'orderRoutes.ts'), 'export const route = true;');
    writeFileSync(join(repoRoot, 'src', 'app.py'), 'print("ok")');

    const detected = detectPlugins(repoRoot).map((plugin) => plugin.id);

    expect(detected).toContain('java-common');
    expect(detected).toContain('typescript-common');
    expect(detected).toContain('python-common');
  });

  it('register()로 추가한 커스텀 플러그인을 extractor가 바로 사용할 수 있어야 한다', () => {
    const repoRoot = makeTempDir();
    const registry = new PluginRegistry([]);
    const customPlugin: FrameworkPlugin = {
      id: 'custom-ts',
      displayName: 'Custom TS',
      version: '1.0.0',
      languages: ['typescript'],
      scanRegex: (filePath, content) => ({
        language: 'typescript',
        sha256: `${filePath}:${content.length}`,
        signals: [
          {
            kind: 'call',
            symbol: 'custom://target',
            lineStart: 1,
            lineEnd: 1,
            excerpt: content.trim(),
            confidence: 0.9,
            metadata: { frameworkPluginId: 'custom-ts' },
          },
        ],
      }),
    };

    registry.register(customPlugin);

    const result = scanFileWithRegexPlugins(
      join(repoRoot, 'custom.ts'),
      'client.call()',
      repoRoot,
      [customPlugin],
    );

    expect(registry.getById('custom-ts')?.id).toBe('custom-ts');
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.symbol).toBe('custom://target');
  });
});
