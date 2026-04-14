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

  it('config parser hook은 nested config key, derivedSignals, metadata를 함께 보존해야 한다', () => {
    const plugin: FrameworkPlugin = {
      id: 'binder-test',
      displayName: 'Binder Test',
      version: '1.0.0',
      languages: ['java'],
      configParsers: [
        {
          id: 'yaml-binder',
          fileMatchers: [(filePath) => filePath.endsWith('.yml') || filePath.endsWith('.yaml')],
          parse: (filePath) => ({
            entries: [
              { key: 'client.orders.url', value: 'http://orders.internal:8080/api/orders', sourceType: 'yaml', filePath },
              { key: 'client.orders.topic', value: 'orders.created', sourceType: 'yaml', filePath },
              { key: 'client.orders.queue', value: 'orders.queue', sourceType: 'yaml', filePath },
              { key: 'client.orders.port', value: '8080', sourceType: 'yaml', filePath },
              { key: 'server.port', value: '8081', sourceType: 'yaml', filePath },
            ],
            derivedSignals: [
              {
                kind: 'call',
                symbol: 'http://orders.internal:8080/api/orders',
                lineStart: 1,
                lineEnd: 1,
                excerpt: 'client.orders.url',
                confidence: 0.9,
                metadata: {
                  kind: 'call',
                  hostHint: 'orders.internal',
                  pathHint: '/api/orders',
                  configKeys: ['client.orders.url', 'client.orders.port'],
                },
              },
              {
                kind: 'produce',
                symbol: 'orders.created',
                lineStart: 2,
                lineEnd: 2,
                excerpt: 'client.orders.topic',
                confidence: 0.85,
                metadata: {
                  kind: 'produce',
                  channelType: 'topic',
                  brokerKind: 'kafka',
                  configKeys: ['client.orders.topic'],
                },
              },
              {
                kind: 'consume',
                symbol: 'orders.queue',
                lineStart: 3,
                lineEnd: 3,
                excerpt: 'client.orders.queue',
                confidence: 0.85,
                metadata: {
                  kind: 'consume',
                  channelType: 'queue',
                  brokerKind: 'rabbitmq',
                  configKeys: ['client.orders.queue'],
                },
              },
            ],
            metadata: {
              binder: 'enabled',
              nested: true,
            },
          }),
        },
      ],
    };

    const parsed = parseConfigWithPluginParsers(
      '/tmp/application.yml',
      'client:\n  orders:\n    url: http://orders.internal:8080/api/orders\n',
      [plugin],
    );

    expect(parsed.entries).toEqual([
      {
        key: 'client.orders.url',
        value: 'http://orders.internal:8080/api/orders',
        sourceType: 'yaml',
        filePath: '/tmp/application.yml',
      },
      {
        key: 'client.orders.topic',
        value: 'orders.created',
        sourceType: 'yaml',
        filePath: '/tmp/application.yml',
      },
      {
        key: 'client.orders.queue',
        value: 'orders.queue',
        sourceType: 'yaml',
        filePath: '/tmp/application.yml',
      },
      {
        key: 'client.orders.port',
        value: '8080',
        sourceType: 'yaml',
        filePath: '/tmp/application.yml',
      },
      {
        key: 'server.port',
        value: '8081',
        sourceType: 'yaml',
        filePath: '/tmp/application.yml',
      },
    ]);
    expect(parsed.derivedSignals).toHaveLength(3);
    expect(parsed.derivedSignals[0]?.metadata).toMatchObject({
      hostHint: 'orders.internal',
      pathHint: '/api/orders',
      configKeys: ['client.orders.url', 'client.orders.port'],
    });
    expect(parsed.metadata).toEqual({
      'binder-test:yaml-binder': {
        binder: 'enabled',
        nested: true,
        derivedSignalCount: 3,
        configBindingSummary: {
          total: 5,
          bindingCount: 5,
          unresolvedCount: 0,
          valueKindCounts: {
            url: 1,
            host: 0,
            topic: 1,
            queue: 1,
            port: 2,
            path: 0,
            property: 0,
          },
          bindingKindCounts: {
            base_url: 1,
            gateway_target: 0,
            service_discovery: 0,
            property_alias: 4,
          },
        },
      },
    });
  });

  it('config parser hook은 yaml/json/properties가 동일한 parser contract를 유지해야 한다', () => {
    const plugin: FrameworkPlugin = {
      id: 'multi-format-binder',
      displayName: 'Multi Format Binder',
      version: '1.0.0',
      languages: ['java'],
      configParsers: [
        {
          id: 'yaml-binder',
          fileMatchers: [(filePath) => filePath.endsWith('.yml') || filePath.endsWith('.yaml')],
          parse: (filePath) => ({
            entries: [
              { key: 'client.orders.url', value: 'http://orders.internal:8080/api/orders', sourceType: 'yaml', filePath },
            ],
            derivedSignals: [
              {
                kind: 'call',
                symbol: 'http://orders.internal:8080/api/orders',
                lineStart: 1,
                lineEnd: 1,
                excerpt: 'client.orders.url',
                confidence: 0.91,
                metadata: {
                  kind: 'call',
                  hostHint: 'orders.internal',
                  pathHint: '/api/orders',
                  configKeys: ['client.orders.url'],
                },
              },
            ],
            metadata: { sourceFormat: 'yaml' },
          }),
        },
        {
          id: 'json-binder',
          fileMatchers: [(filePath) => filePath.endsWith('.json')],
          parse: (filePath) => ({
            entries: [
              { key: 'client.orders.url', value: 'http://orders.internal:8080/api/orders', sourceType: 'json', filePath },
            ],
            metadata: { sourceFormat: 'json' },
          }),
        },
        {
          id: 'properties-binder',
          fileMatchers: [(filePath) => filePath.endsWith('.properties')],
          parse: (filePath) => ({
            entries: [
              { key: 'client.orders.url', value: 'http://orders.internal:8080/api/orders', sourceType: 'properties', filePath },
            ],
            derivedSignals: [
              {
                kind: 'call',
                symbol: 'http://orders.internal:8080/api/orders',
                lineStart: 1,
                lineEnd: 1,
                excerpt: 'client.orders.url',
                confidence: 0.89,
                metadata: {
                  kind: 'call',
                  hostHint: 'orders.internal',
                  pathHint: '/api/orders',
                  configKeys: ['client.orders.url'],
                },
              },
            ],
            metadata: { sourceFormat: 'properties' },
          }),
        },
      ],
    };

    const yamlParsed = parseConfigWithPluginParsers(
      '/tmp/application.yml',
      'client:\n  orders:\n    url: http://orders.internal:8080/api/orders\n',
      [plugin],
    );
    const jsonParsed = parseConfigWithPluginParsers(
      '/tmp/application.json',
      '{"client":{"orders":{"url":"http://orders.internal:8080/api/orders"}}}',
      [plugin],
    );
    const propertiesParsed = parseConfigWithPluginParsers(
      '/tmp/application.properties',
      'client.orders.url=http://orders.internal:8080/api/orders',
      [plugin],
    );

    expect(yamlParsed.entries).toEqual([
      {
        key: 'client.orders.url',
        value: 'http://orders.internal:8080/api/orders',
        sourceType: 'yaml',
        filePath: '/tmp/application.yml',
      },
    ]);
    expect(jsonParsed.entries).toEqual([
      {
        key: 'client.orders.url',
        value: 'http://orders.internal:8080/api/orders',
        sourceType: 'json',
        filePath: '/tmp/application.json',
      },
    ]);
    expect(propertiesParsed.entries).toEqual([
      {
        key: 'client.orders.url',
        value: 'http://orders.internal:8080/api/orders',
        sourceType: 'properties',
        filePath: '/tmp/application.properties',
      },
    ]);
    expect(propertiesParsed.derivedSignals).toHaveLength(1);
    expect(propertiesParsed.derivedSignals?.[0]?.metadata).toMatchObject({
      hostHint: 'orders.internal',
      pathHint: '/api/orders',
      configKeys: ['client.orders.url'],
    });
    expect(propertiesParsed.metadata).toEqual({
      'multi-format-binder:properties-binder': {
        sourceFormat: 'properties',
        derivedSignalCount: 1,
        configBindingSummary: {
          total: 1,
          bindingCount: 1,
          unresolvedCount: 0,
          valueKindCounts: {
            url: 1,
            host: 0,
            topic: 0,
            queue: 0,
            port: 0,
            path: 0,
            property: 0,
          },
          bindingKindCounts: {
            base_url: 1,
            gateway_target: 0,
            service_discovery: 0,
            property_alias: 0,
          },
        },
      },
    });
  });

  it('hybrid 경로는 confidenceRules를 merge/dedupe 전에 적용해야 한다', async () => {
    const plugin: FrameworkPlugin = {
      id: 'confidence-rule-runtime',
      displayName: 'Confidence Rule Runtime',
      version: '1.0.0',
      languages: ['java'],
      regexScanner: () => ({
        language: 'java',
        sha256: 'sha',
        signals: [
          {
            kind: 'call',
            symbol: 'http://orders.internal/api/orders',
            lineStart: 1,
            lineEnd: 1,
            excerpt: 'regex',
            confidence: 0.42,
            metadata: { source: 'regex' },
          },
        ],
      }),
      astExtractor: () => ({
        language: 'java',
        sha256: 'sha',
        signals: [
          {
            kind: 'call',
            symbol: 'http://orders.internal/api/orders',
            lineStart: 1,
            lineEnd: 1,
            excerpt: 'ast',
            confidence: 0.4,
            metadata: { source: 'ast' },
          },
        ],
      }),
      confidenceRules: [
        {
          signalKind: 'call',
          condition: (signal) => (signal.metadata as Record<string, unknown>).source === 'ast',
          adjustment: 0.35,
        },
      ],
    };

    const result = await scanFileWithHybridPlugins(
      '/tmp/OrderService.java',
      'class OrderService {}',
      '/tmp',
      [plugin],
    );

    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]?.confidence).toBeCloseTo(0.75, 5);
    expect(result.signals[0]?.metadata).toMatchObject({
      source: 'ast',
      extractionSources: ['regex', 'ast'],
    });
  });
});
