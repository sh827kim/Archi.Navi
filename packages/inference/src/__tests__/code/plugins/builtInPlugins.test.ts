import { describe, expect, it } from 'vitest';
import { getBuiltInPlugins } from '@/code/plugins/builtInPlugins';

describe('builtInPlugins', () => {
  it('4-4 핵심 built-in plugin들이 모두 등록되어 있어야 한다', () => {
    const pluginIds = getBuiltInPlugins().map((plugin) => plugin.id);

    expect(pluginIds).toEqual(
      expect.arrayContaining([
        'spring-boot',
        'vertx',
        'java-common',
        'express',
        'nestjs',
        'typescript-common',
        'fastapi',
        'flask',
        'python-common',
      ]),
    );
  });

  it('모든 built-in plugin은 detector 또는 스캔 계약을 가져야 한다', () => {
    for (const plugin of getBuiltInPlugins()) {
      expect(plugin.displayName.length).toBeGreaterThan(0);
      expect(plugin.version.length).toBeGreaterThan(0);
      expect(plugin.languages.length).toBeGreaterThan(0);
      expect(
        plugin.detector !== undefined || plugin.scanRegex !== undefined || plugin.scanAst !== undefined,
      ).toBe(true);
    }
  });

  it('nestjs plugin은 decorator 기반 expose 신호를 추출할 수 있어야 한다', () => {
    const plugin = getBuiltInPlugins().find((candidate) => candidate.id === 'nestjs');
    expect(plugin).toBeDefined();

    const result = plugin?.scanRegex?.(
      '/tmp/orders.controller.ts',
      `@Controller('/orders')
export class OrdersController {
  @Get(':id')
  findOne() {
    return {};
  }
}`,
    );

    expect(result?.signals.some((signal) => signal.kind === 'expose' && signal.symbol === '/orders/:id')).toBe(true);
  });

  it('spring-boot plugin은 JSON config parser hook으로 flatten entry를 생성해야 한다', () => {
    const plugin = getBuiltInPlugins().find((candidate) => candidate.id === 'spring-boot');
    expect(plugin).toBeDefined();

    const parser = plugin?.configParsers?.find((candidate) =>
      candidate.fileMatchers.some((matcher) => matcher('/tmp/application.json')));
    expect(parser).toBeDefined();

    const result = parser?.parse(
      '/tmp/application.json',
      '{"client":{"orders":{"url":"http://orders"}},"messaging":{"topics":["order.created"]}}',
    );
    expect(result?.entries).toEqual(
      expect.arrayContaining([
        {
          key: 'client.orders.url',
          value: 'http://orders',
          sourceType: 'json',
          filePath: '/tmp/application.json',
        },
        {
          key: 'messaging.topics.0',
          value: 'order.created',
          sourceType: 'json',
          filePath: '/tmp/application.json',
        },
      ]),
    );
  });

  it('vertx plugin은 변수 기반 abs 호출, vertx.eventBus(), producerFactory 패턴을 감지해야 한다', () => {
    const plugin = getBuiltInPlugins().find((candidate) => candidate.id === 'vertx');
    expect(plugin).toBeDefined();

    const result = plugin?.scanRegex?.(
      '/tmp/OrderVertxHandler.java',
      `router.get("/api/orders/:id").handler(this::getOrder);
String uri = "/api/orders";
webClient.getAbs(uri).send();
webClient.requestAbs(HttpMethod.POST, host + uri).send();
vertx.eventBus().request(config.getString("address.produce.system"), payload);
messageProducerFactory.publish(config.getString("address.produce"), body);`,
    );

    expect(result?.signals.some((signal) => signal.kind === 'expose' && signal.symbol === '/api/orders/:id')).toBe(true);
    expect(result?.signals.some((signal) => signal.kind === 'call' && signal.symbol === 'uri')).toBe(true);
    expect(result?.signals.some((signal) => signal.kind === 'call' && signal.symbol === 'host + uri')).toBe(true);
    expect(result?.signals.some((signal) => signal.kind === 'produce' && signal.symbol === 'config.getString("address.produce.system")')).toBe(true);
    expect(result?.signals.some((signal) => signal.kind === 'produce' && signal.symbol === 'config.getString("address.produce")')).toBe(true);
  });
});
