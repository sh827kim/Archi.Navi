import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildProjectSymbolTable, getImplementationsForInterface } from '@/code/ast/symbolTable';

function createTempRepoRoot() {
  const repoRoot = join(tmpdir(), `archi-navi-symbol-table-${Date.now()}-${Math.random()}`);
  mkdirSync(repoRoot, { recursive: true });
  return repoRoot;
}

describe('symbolTable', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Java 다중 파일에서 interface -> implementation 매핑을 구축해야 한다', async () => {
    const repoRoot = createTempRepoRoot();
    tempDirs.push(repoRoot);

    const srcDir = join(repoRoot, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, 'PaymentClient.java'),
      `package com.example.payment;
public interface PaymentClient {
  String charge();
}`,
    );
    writeFileSync(
      join(srcDir, 'PaymentClientImpl.java'),
      `package com.example.payment;
public class PaymentClientImpl implements PaymentClient {
  public String charge() { return "ok"; }
}`,
    );

    const table = await buildProjectSymbolTable({ repoRoot });
    const implementations = getImplementationsForInterface(table, 'com.example.payment.PaymentClient');

    expect(table.symbolsByFqcn.has('com.example.payment.PaymentClient')).toBe(true);
    expect(table.symbolsByFqcn.has('com.example.payment.PaymentClientImpl')).toBe(true);
    expect(implementations.map((symbol) => symbol.fqcn)).toEqual([
      'com.example.payment.PaymentClientImpl',
    ]);
  });

  it('TypeScript 다중 구현체를 interface 이름으로 조회할 수 있어야 한다', async () => {
    const repoRoot = createTempRepoRoot();
    tempDirs.push(repoRoot);

    const srcDir = join(repoRoot, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, 'contracts.ts'),
      `export interface PaymentGateway {
  charge(): Promise<string>;
}`,
    );
    writeFileSync(
      join(srcDir, 'stripe.ts'),
      `export class StripeGateway implements PaymentGateway {
  async charge() { return 'stripe'; }
}`,
    );
    writeFileSync(
      join(srcDir, 'mock.ts'),
      `export class MockGateway implements PaymentGateway {
  async charge() { return 'mock'; }
}`,
    );

    const table = await buildProjectSymbolTable({ repoRoot });
    const implementations = getImplementationsForInterface(table, 'PaymentGateway');

    expect(implementations.map((symbol) => symbol.fqcn).sort()).toEqual([
      'MockGateway',
      'StripeGateway',
    ]);
  });

  it('targetFilePaths가 주어지면 해당 파일만 symbol 수집 대상으로 제한해야 한다', async () => {
    const repoRoot = createTempRepoRoot();
    tempDirs.push(repoRoot);

    const srcDir = join(repoRoot, 'src');
    mkdirSync(srcDir, { recursive: true });
    const includedFile = join(srcDir, 'Included.ts');
    const excludedFile = join(srcDir, 'Excluded.ts');
    writeFileSync(includedFile, 'export interface IncludedContract {}');
    writeFileSync(excludedFile, 'export interface ExcludedContract {}');

    const table = await buildProjectSymbolTable({
      repoRoot,
      targetFilePaths: [includedFile],
    });

    expect(table.symbolsByFqcn.has('IncludedContract')).toBe(true);
    expect(table.symbolsByFqcn.has('ExcludedContract')).toBe(false);
  });

  it('Java 메서드 반환 타입이 클래스여도 실제 메서드명으로 호출 매핑해야 한다', async () => {
    const repoRoot = createTempRepoRoot();
    tempDirs.push(repoRoot);

    const srcDir = join(repoRoot, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, 'PaymentClient.java'),
      `package com.example.payment;
public class PaymentClient {
  public ResponseEntity charge() {
    return webClient.get().uri("/charge");
  }
}`,
    );

    const table = await buildProjectSymbolTable({ repoRoot });
    const calls = table.methodCallsByType.get('com.example.payment.PaymentClient')?.get('charge') ?? [];

    expect(calls).toHaveLength(1);
    expect(calls[0]?.symbol).toBe('/charge');
  });
});
