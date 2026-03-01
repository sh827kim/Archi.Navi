import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectProjects, detectSingleProject } from '../../utils/project-detector';

describe('project-detector', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'anavi-project-detector-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('루트와 1-depth 하위 프로젝트를 감지해야 한다', () => {
    writeFileSync(join(root, 'package.json'), '{}');
    mkdirSync(join(root, 'order-service'));
    writeFileSync(join(root, 'order-service', 'pom.xml'), '<project/>');
    mkdirSync(join(root, 'payment-service'));
    writeFileSync(join(root, 'payment-service', 'pyproject.toml'), '[project]');

    const projects = detectProjects(root);
    const names = projects.map((p) => p.name);
    expect(names).toContain('order-service');
    expect(names).toContain('payment-service');
    expect(names).toContain(root.split('/').pop());
    expect(projects.find((p) => p.name === 'order-service')?.language).toBe('java');
    expect(projects.find((p) => p.name === 'payment-service')?.language).toBe('python');
  });

  it('무시 디렉터리/숨김 디렉터리는 탐색하지 않아야 한다', () => {
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'package.json'), '{}');
    mkdirSync(join(root, '.hidden'));
    writeFileSync(join(root, '.hidden', 'package.json'), '{}');
    mkdirSync(join(root, 'real'));
    writeFileSync(join(root, 'real', 'Cargo.toml'), '[package]');

    const projects = detectProjects(root);
    expect(projects).toHaveLength(1);
    expect(projects[0]?.name).toBe('real');
    expect(projects[0]?.language).toBe('rust');
  });

  it('detectSingleProject는 루트만 검사해야 한다', () => {
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', 'go.mod'), 'module x');

    expect(detectSingleProject(root)).toBeNull();

    writeFileSync(join(root, 'build.gradle.kts'), 'plugins {}');
    const detected = detectSingleProject(root);
    expect(detected?.name).toBe(root.split('/').pop());
    expect(detected?.language).toBe('kotlin');
  });

  it('존재하지 않는 디렉터리면 빈 배열을 반환해야 한다', () => {
    const result = detectProjects(join(root, 'not-exists'));
    expect(result).toEqual([]);
  });
});
