import { test, expect } from '@playwright/test';

const WORKSPACE_ID = '55555555-5555-5555-5555-555555555555';

test('S1-3: mapping-graph는 두 번째 rollup-change에서 현재 뷰를 다시 조회한다', async ({ page }) => {
  let serviceToServiceRollupRequestCount = 0;

  await page.addInitScript((workspaceId) => {
    window.localStorage.setItem(
      'archi-navi:workspace',
      JSON.stringify({ state: { workspaceId }, version: 0 }),
    );
    window.localStorage.setItem('archi-navi:e2e-node-actions', '1');

    class FakeEventSource {
      static instances: FakeEventSource[] = [];
      url: string;
      listeners: Record<string, Array<(event: Event) => void>> = {};
      closed = false;

      constructor(url: string) {
        this.url = url;
        FakeEventSource.instances.push(this);
      }

      addEventListener(type: string, listener: (event: Event) => void) {
        const next = this.listeners[type] ?? [];
        next.push(listener);
        this.listeners[type] = next;
      }

      removeEventListener(type: string, listener: (event: Event) => void) {
        this.listeners[type] = (this.listeners[type] ?? []).filter((item) => item !== listener);
      }

      close() {
        this.closed = true;
      }

      emit(type: string) {
        for (const listener of this.listeners[type] ?? []) {
          listener(new Event(type));
        }
      }
    }

    const eventSourceWindow = window as Window & {
      __fakeEventSources?: typeof FakeEventSource.instances;
      EventSource: typeof EventSource;
    };
    eventSourceWindow.__fakeEventSources = FakeEventSource.instances;
    Object.defineProperty(eventSourceWindow, 'EventSource', {
      configurable: true,
      writable: true,
      value: FakeEventSource as unknown as typeof EventSource,
    });
  }, WORKSPACE_ID);

  await page.route('**/api/workspaces', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { id: WORKSPACE_ID, name: 'sse-e2e-workspace', createdAt: new Date().toISOString() },
      ]),
    });
  });

  await page.route('**/api/objects?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { id: 'dom-order', name: 'dom-order', displayName: 'Order Domain', objectType: 'domain', granularity: 'COMPOUND', parentId: null, depth: 0 },
        { id: 'dom-payment', name: 'dom-payment', displayName: 'Payment Domain', objectType: 'domain', granularity: 'COMPOUND', parentId: null, depth: 0 },
        { id: 'svc-order', name: 'svc-order', displayName: 'Order Service', objectType: 'service', granularity: 'COMPOUND', parentId: null, depth: 0 },
        { id: 'svc-payment', name: 'svc-payment', displayName: 'Payment Service', objectType: 'service', granularity: 'COMPOUND', parentId: null, depth: 0 },
      ]),
    });
  });

  await page.route('**/api/domain-affinities?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        { objectId: 'svc-order', domainId: 'dom-order', affinity: 0.91 },
        { objectId: 'svc-payment', domainId: 'dom-payment', affinity: 0.95 },
      ]),
    });
  });

  await page.route('**/api/relations?*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });

  await page.route('**/api/rollups?*', async (route) => {
    const url = new URL(route.request().url());
    const level = url.searchParams.get('level');

    if (level === 'SERVICE_TO_SERVICE') {
      serviceToServiceRollupRequestCount += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          nodes: [],
          edges: [{ id: 's2s-1', source: 'svc-order', target: 'svc-payment', relationType: 'call' }],
          graphStats: [
            { objectId: 'svc-order', inDegree: 1, outDegree: 1 },
            { objectId: 'svc-payment', inDegree: 1, outDegree: 1 },
          ],
        }),
      });
      return;
    }

    if (level === 'DOMAIN_TO_DOMAIN') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          nodes: [],
          edges: [{ id: 'd2d-1', source: 'dom-order', target: 'dom-payment', relationType: 'call' }],
          graphStats: [
            { objectId: 'dom-order', inDegree: 1, outDegree: 1 },
            { objectId: 'dom-payment', inDegree: 1, outDegree: 1 },
          ],
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ nodes: [], edges: [], graphStats: [] }),
    });
  });

  await page.goto('/mapping-graph');

  await expect(page.getByRole('button', { name: '도메인 ↔ 도메인' })).toBeVisible();
  await expect(page.getByTestId('mapping-graph-e2e-node-actions')).toBeVisible();
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const sources = (window as Window & {
            __fakeEventSources?: Array<{
              listeners?: Record<string, Array<(event: Event) => void>>;
            }>;
          }).__fakeEventSources;
          const source = sources?.[sources.length - 1];
          return source?.listeners?.['rollup-change']?.length ?? 0;
        }),
      { timeout: 15000 },
    )
    .toBe(1);

  const readyBaseline = serviceToServiceRollupRequestCount;
  await expect
    .poll(() => serviceToServiceRollupRequestCount - readyBaseline + 1, { timeout: 15000 })
    .toBe(1);

  await page.evaluate(() => {
    const sources = (window as Window & {
      __fakeEventSources?: Array<{ emit: (type: string) => void }>;
    }).__fakeEventSources;
    sources?.[sources.length - 1]?.emit('rollup-change');
  });

  await expect
    .poll(() => serviceToServiceRollupRequestCount - readyBaseline + 1, { timeout: 15000 })
    .toBe(1);

  await page.evaluate(() => {
    const sources = (window as Window & {
      __fakeEventSources?: Array<{ emit: (type: string) => void }>;
    }).__fakeEventSources;
    sources?.[sources.length - 1]?.emit('rollup-change');
  });

  await expect
    .poll(() => serviceToServiceRollupRequestCount - readyBaseline + 1, { timeout: 15000 })
    .toBe(2);
  await expect(page.getByTestId('mapping-graph-e2e-node-action')).toHaveCount(2);
});
