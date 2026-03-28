import { describe, expect, it } from 'vitest';
import { getBuiltInPlugins } from '@/code';

describe('builtInPlugins', () => {
  it('4-4 핵심 built-in plugin들이 모두 등록되어 있어야 한다', () => {
    const pluginIds = getBuiltInPlugins().map((plugin) => plugin.id);

    expect(pluginIds).toEqual(
      expect.arrayContaining([
        'spring-boot',
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
});
