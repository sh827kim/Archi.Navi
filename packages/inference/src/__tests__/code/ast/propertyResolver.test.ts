import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildAstPropertyResolver } from '@/code/ast/propertyResolver';

function createTempRepoRoot() {
  const repoRoot = join(tmpdir(), `archi-navi-property-resolver-${Date.now()}-${Math.random()}`);
  mkdirSync(repoRoot, { recursive: true });
  return repoRoot;
}

describe('propertyResolver', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('멀티 문서 application.yml(---)도 property를 정상 해석해야 한다', () => {
    const repoRoot = createTempRepoRoot();
    tempDirs.push(repoRoot);
    const serviceDir = join(repoRoot, 'services', 'order', 'src', 'main', 'resources');
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(
      join(serviceDir, 'application.yml'),
      `spring:
  application:
    name: order-service
---
server:
  port: 8081
`,
    );

    const resolver = buildAstPropertyResolver(repoRoot);
    const propertyMap = resolver.resolveForFile(join(repoRoot, 'services', 'order', 'src', 'OrderClient.java'));

    expect(resolver.hasEntries).toBe(true);
    expect(propertyMap.get('spring.application.name')).toBe('order-service');
    expect(propertyMap.get('server.port')).toBe('8081');
  });

  it('같은 key가 멀티 문서에서 재정의되면 뒤 문서 값이 우선해야 한다', () => {
    const repoRoot = createTempRepoRoot();
    tempDirs.push(repoRoot);
    const serviceDir = join(repoRoot, 'service-a');
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(
      join(serviceDir, 'application.yml'),
      `client:
  endpoint: http://default.internal
---
client:
  endpoint: http://prod.internal
`,
    );

    const resolver = buildAstPropertyResolver(repoRoot);
    const propertyMap = resolver.resolveForFile(join(serviceDir, 'src', 'HttpClient.java'));

    expect(propertyMap.get('client.endpoint')).toBe('http://prod.internal');
  });
});
