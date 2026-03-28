import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildProjectSymbolTable,
  getImplementationsForInterface,
  resolveJavaCallTargets,
  type AstProjectSymbolTable,
} from '@/code/ast/symbolTable';

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

  it('Kotlin constructor 타입 주석의 콜론은 inheritance로 해석하지 않아야 한다', async () => {
    const repoRoot = createTempRepoRoot();
    tempDirs.push(repoRoot);

    const srcDir = join(repoRoot, 'src');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(
      join(srcDir, 'PaymentGateway.kt'),
      `package com.example.payment
interface PaymentGateway {
  fun charge(): String
}`,
    );
    writeFileSync(
      join(srcDir, 'PaymentGatewayImpl.kt'),
      `package com.example.payment
class PaymentGatewayImpl(
  private val dependency: Dependency
) : PaymentGateway {
  override fun charge(): String = "ok"
}

class Dependency`,
    );

    const table = await buildProjectSymbolTable({ repoRoot });
    const implementations = getImplementationsForInterface(table, 'com.example.payment.PaymentGateway');

    expect(implementations.map((symbol) => symbol.fqcn)).toEqual([
      'com.example.payment.PaymentGatewayImpl',
    ]);
  });

  it('1000 파일 규모에서도 symbol table 구축이 30초 이내여야 한다', async () => {
    const repoRoot = createTempRepoRoot();
    tempDirs.push(repoRoot);

    const srcDir = join(repoRoot, 'src');
    mkdirSync(srcDir, { recursive: true });

    for (let index = 0; index < 1000; index += 1) {
      writeFileSync(
        join(srcDir, `Service${index}.java`),
        `package com.example.bulk;
public class Service${index} {
  String ping() { return "ok"; }
}`,
      );
    }

    const startedAt = Date.now();
    const table = await buildProjectSymbolTable({ repoRoot });
    const elapsedMs = Date.now() - startedAt;

    expect(table.symbolsByFqcn.size).toBe(1000);
    expect(elapsedMs).toBeLessThan(30_000);
  }, 40_000);

  it('인터페이스 다중 분기에서 동일 helper로 수렴해도 분기별 call evidence를 유지해야 한다', () => {
    const table: AstProjectSymbolTable = {
      symbolsByFqcn: new Map([
        [
          'com.example.Client',
          {
            kind: 'interface',
            name: 'Client',
            fqcn: 'com.example.Client',
            filePath: '',
            language: 'java',
            extendsTypes: [],
            implementsTypes: [],
          },
        ],
        [
          'com.example.ClientA',
          {
            kind: 'class',
            name: 'ClientA',
            fqcn: 'com.example.ClientA',
            filePath: '',
            language: 'java',
            extendsTypes: [],
            implementsTypes: ['com.example.Client'],
          },
        ],
        [
          'com.example.ClientB',
          {
            kind: 'class',
            name: 'ClientB',
            fqcn: 'com.example.ClientB',
            filePath: '',
            language: 'java',
            extendsTypes: [],
            implementsTypes: ['com.example.Client'],
          },
        ],
        [
          'com.example.Helper',
          {
            kind: 'class',
            name: 'Helper',
            fqcn: 'com.example.Helper',
            filePath: '',
            language: 'java',
            extendsTypes: [],
            implementsTypes: [],
          },
        ],
      ]),
      simpleNameIndex: new Map([
        ['Client', ['com.example.Client']],
        ['ClientA', ['com.example.ClientA']],
        ['ClientB', ['com.example.ClientB']],
        ['Helper', ['com.example.Helper']],
      ]),
      implementationMap: new Map([
        ['com.example.Client', ['com.example.ClientA', 'com.example.ClientB']],
      ]),
      methodCallsByType: new Map([
        [
          'com.example.Helper',
          new Map([
            [
              'send',
              [{ symbol: '/payments', confidence: 0.9, metadata: {} }],
            ],
          ]),
        ],
      ]),
      methodCallTargetsByType: new Map([
        [
          'com.example.ClientA',
          new Map([
            ['call', [{ typeName: 'com.example.Helper', methodName: 'send' }]],
          ]),
        ],
        [
          'com.example.ClientB',
          new Map([
            ['call', [{ typeName: 'com.example.Helper', methodName: 'send' }]],
          ]),
        ],
      ]),
    };

    const resolved = resolveJavaCallTargets(table, {
      typeName: 'com.example.Client',
      methodName: 'call',
      maxDepth: 2,
    });

    expect(resolved).toHaveLength(2);
    expect(
      resolved
        .map((call) => ({
          symbol: call.symbol,
          interfaceImpl: call.metadata['interfaceImpl'],
          ambiguous: call.metadata['ambiguous'],
        }))
        .sort((left, right) => String(left.interfaceImpl).localeCompare(String(right.interfaceImpl))),
    ).toEqual([
      { symbol: '/payments', interfaceImpl: 'ClientA', ambiguous: true },
      { symbol: '/payments', interfaceImpl: 'ClientB', ambiguous: true },
    ]);
  });
});
