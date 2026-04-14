import { describe, expect, it } from 'vitest';
import type { FrameworkPlugin } from '@/code/plugins/types';
import { parseConfigWithPluginParsers, scanFileWithAstPlugins, scanFileWithHybridPlugins } from '@/code/plugins/runtime';

describe('plugin runtime', () => {
  it('AST 전용 경로는 plugin 예외를 상위로 전파해야 한다', async () => {
    const plugin: FrameworkPlugin = {
      id: 'throwing-ast',
      displayName: 'Throwing AST',
      version: '1.0.0',
      languages: ['java'],
      astExtractor: () => {
        throw new Error('ast parse failed');
      },
    };

    await expect(
      scanFileWithAstPlugins('/tmp/Test.java', 'class Test {}', '/tmp', {}, [plugin]),
    ).rejects.toThrow('ast parse failed');
  });

  it('hybrid 경로는 AST 예외가 있어도 regex 결과를 유지해야 한다', async () => {
    const plugin: FrameworkPlugin = {
      id: 'hybrid-fallback',
      displayName: 'Hybrid Fallback',
      version: '1.0.0',
      languages: ['java'],
      regexScanner: () => ({
        language: 'java',
        sha256: 'sha',
        signals: [
          {
            kind: 'call',
            symbol: 'http://payment/pay',
            lineStart: 1,
            lineEnd: 1,
            excerpt: 'call',
            confidence: 0.7,
            metadata: {},
          },
        ],
      }),
      astExtractor: () => {
        throw new Error('ast failed');
      },
    };

    const result = await scanFileWithHybridPlugins(
      '/tmp/Test.java',
      'class Test {}',
      '/tmp',
      [plugin],
    );

    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.symbol).toBe('http://payment/pay');
  });

  it('config parser hook은 파일 matcher에 맞는 parser만 실행해야 한다', () => {
    const plugin: FrameworkPlugin = {
      id: 'config-test',
      displayName: 'Config Test',
      version: '1.0.0',
      languages: ['java'],
      configParsers: [
        {
          id: 'json-only',
          fileMatchers: [(filePath) => filePath.endsWith('.json')],
          parse: (filePath, _content) => ({
            entries: [{
              key: 'client.orders.url',
              value: 'http://orders',
              sourceType: 'json',
              filePath,
            }],
          }),
        },
      ],
    };

    const parsed = parseConfigWithPluginParsers(
      '/tmp/application.json',
      '{"client":{"orders":{"url":"http://orders"}}}',
      [plugin],
    );
    expect(parsed.entries).toEqual([
      {
        key: 'client.orders.url',
        value: 'http://orders',
        sourceType: 'json',
        filePath: '/tmp/application.json',
      },
    ]);
  });
});
