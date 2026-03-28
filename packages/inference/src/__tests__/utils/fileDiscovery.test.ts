import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  findFiles,
  findJavaKotlinFiles,
  findMyBatisXmlFiles,
  findPythonFiles,
  findTypeScriptFiles,
} from '@/utils/fileDiscovery';

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'archi-navi-file-discovery-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0, tempRoots.length)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('fileDiscovery', () => {
  it('skip 디렉토리를 제외하고 파일을 재귀 탐색해야 한다', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;');
    writeFileSync(join(root, 'node_modules', 'b.ts'), 'export const b = 1;');

    expect(findFiles(root, (path) => path.endsWith('.ts'))).toEqual([join(root, 'src', 'a.ts')]);
  });

  it('언어별 finder가 각 확장자를 올바르게 찾아야 한다', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'OrderController.java'), 'class OrderController {}');
    writeFileSync(join(root, 'src', 'handler.kt'), 'class Handler');
    writeFileSync(join(root, 'src', 'routes.ts'), 'export const routes = [];');
    writeFileSync(join(root, 'src', 'view.jsx'), 'export default function View() {}');
    writeFileSync(join(root, 'src', 'worker.py'), 'print("ok")');

    expect(findJavaKotlinFiles(root)).toHaveLength(2);
    expect(findTypeScriptFiles(root)).toHaveLength(2);
    expect(findPythonFiles(root)).toEqual([join(root, 'src', 'worker.py')]);
  });

  it('MyBatis mapper XML만 골라야 한다', () => {
    const root = createTempRoot();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'mapper.xml'), '<mapper namespace="orders"></mapper>');
    writeFileSync(join(root, 'src', 'plain.xml'), '<root></root>');

    expect(findMyBatisXmlFiles(root)).toEqual([join(root, 'src', 'mapper.xml')]);
  });
});
