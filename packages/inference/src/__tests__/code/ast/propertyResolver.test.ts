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

  it('타겟 파일의 상위 경로가 아닌 sibling 서비스의 property 파일은 선택하면 안 된다', () => {
    const repoRoot = createTempRepoRoot();
    tempDirs.push(repoRoot);

    const billingResourceDir = join(repoRoot, 'services', 'billing', 'src', 'main', 'resources');
    const orderSourceDir = join(repoRoot, 'services', 'order', 'src');
    mkdirSync(billingResourceDir, { recursive: true });
    mkdirSync(orderSourceDir, { recursive: true });

    writeFileSync(
      join(billingResourceDir, 'application.yml'),
      `client:
  endpoint: http://billing.internal
`,
    );

    const resolver = buildAstPropertyResolver(repoRoot);
    const propertyMap = resolver.resolveForFile(join(orderSourceDir, 'OrderClient.java'));

    expect(resolver.hasEntries).toBe(true);
    expect(propertyMap.size).toBe(0);
    expect(propertyMap.get('client.endpoint')).toBeUndefined();
  });

  it('src/main 파일 해석 시 src/test/resources 설정이 섞여 override 되지 않아야 한다', () => {
    const repoRoot = createTempRepoRoot();
    tempDirs.push(repoRoot);

    const resourceRoot = join(repoRoot, 'services', 'order', 'src');
    const mainResourceDir = join(resourceRoot, 'main', 'resources');
    const testResourceDir = join(resourceRoot, 'test', 'resources');
    mkdirSync(mainResourceDir, { recursive: true });
    mkdirSync(testResourceDir, { recursive: true });

    writeFileSync(
      join(mainResourceDir, 'application.yml'),
      `client:
  endpoint: http://main.internal
`,
    );
    writeFileSync(
      join(testResourceDir, 'application-test.yml'),
      `client:
  endpoint: http://test.internal
`,
    );

    const resolver = buildAstPropertyResolver(repoRoot);

    const mainPropertyMap = resolver.resolveForFile(
      join(repoRoot, 'services', 'order', 'src', 'main', 'java', 'OrderClient.java'),
    );
    const testPropertyMap = resolver.resolveForFile(
      join(repoRoot, 'services', 'order', 'src', 'test', 'java', 'OrderClientTest.java'),
    );

    expect(mainPropertyMap.get('client.endpoint')).toBe('http://main.internal');
    expect(testPropertyMap.get('client.endpoint')).toBe('http://test.internal');
  });
});
