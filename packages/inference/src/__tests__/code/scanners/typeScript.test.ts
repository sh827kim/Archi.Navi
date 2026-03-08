/**
 * TypeScript/JavaScript 스캐너 단위 테스트
 */
import { describe, it, expect } from 'vitest';
import { scanTypeScript } from '@/code/scanners/typeScript';

describe('scanTypeScript', () => {
    // ─── API 노출 패턴 ────────────────────────────────────────────────────────

    it('app.get에서 expose 신호를 추출해야 한다', () => {
        const content = `
app.get('/api/orders', async (req, res) => {
    res.json(orders);
});
`;
        const result = scanTypeScript('/src/routes.ts', content);

        const expose = result.signals.find((s) => s.kind === 'expose');
        expect(expose).toBeDefined();
        expect(expose?.symbol).toBe('/api/orders');
        expect(expose?.confidence).toBeCloseTo(0.8);
        expect(expose?.metadata).toMatchObject({ method: 'GET', framework: 'express', via: 'app' });
    });

    it('router.post에서 expose 신호를 추출해야 한다', () => {
        const content = `
router.post('/api/payment', async (req, res) => {
    res.json({ success: true });
});
`;
        const result = scanTypeScript('/src/paymentRouter.ts', content);

        const expose = result.signals.find((s) => s.kind === 'expose');
        expect(expose?.symbol).toBe('/api/payment');
        expect(expose?.metadata).toMatchObject({ method: 'POST', via: 'router' });
    });

    it('router.put/delete/patch에서 expose 신호를 추출해야 한다', () => {
        const content = `
router.put('/api/orders/:id', handler);
router.delete('/api/orders/:id', handler);
router.patch('/api/orders/:id/status', handler);
`;
        const result = scanTypeScript('/src/orderRouter.ts', content);
        const exposeSignals = result.signals.filter((s) => s.kind === 'expose');

        expect(exposeSignals).toHaveLength(3);
        const methods = exposeSignals.map((s) => s.metadata['method']);
        expect(methods).toContain('PUT');
        expect(methods).toContain('DELETE');
        expect(methods).toContain('PATCH');
    });

    // ─── HTTP 호출 패턴 ───────────────────────────────────────────────────────

    it('fetch에서 call 신호를 추출해야 한다', () => {
        const content = `
const response = await fetch('http://payment-service/api/pay');
`;
        const result = scanTypeScript('/src/paymentService.ts', content);

        const call = result.signals.find((s) => s.kind === 'call');
        expect(call?.symbol).toBe('http://payment-service/api/pay');
        expect(call?.confidence).toBeCloseTo(0.7);
        expect(call?.metadata).toMatchObject({ client: 'fetch' });
    });

    it('axios.get에서 call 신호를 추출해야 한다', () => {
        const content = `
const data = await axios.get('http://inventory-service/stock');
`;
        const result = scanTypeScript('/src/inventoryClient.ts', content);

        const call = result.signals.find((s) => s.kind === 'call');
        expect(call?.symbol).toBe('http://inventory-service/stock');
        expect(call?.metadata).toMatchObject({ client: 'axios' });
    });

    it('axios.post에서 call 신호를 추출해야 한다', () => {
        const content = `
await axios.post('http://notification-service/send', payload);
`;
        const result = scanTypeScript('/src/notifier.ts', content);

        const call = result.signals.find((s) => s.kind === 'call');
        expect(call?.symbol).toBe('http://notification-service/send');
    });

    it('http-chain(.get/.post 등) 패턴에서 call 신호를 추출해야 한다', () => {
        const content = `
const res = httpClient.get('/internal/health');
`;
        const result = scanTypeScript('/src/httpChainClient.ts', content);

        const call = result.signals.find((s) => s.kind === 'call');
        expect(call?.symbol).toBe('/internal/health');
        expect(call?.confidence).toBeCloseTo(0.6);
        expect(call?.metadata).toMatchObject({ method: 'GET', client: 'http-chain' });
    });

    it('http-chain 패턴은 URL/경로가 아니면 매칭하지 않아야 한다', () => {
        const content = `
const value = myMap.get('cache-key');
`;
        const result = scanTypeScript('/src/cache.ts', content);
        expect(result.signals).toHaveLength(0);
    });

    // ─── 복합 / 엣지 케이스 ──────────────────────────────────────────────────

    it('여러 신호가 있는 파일에서 모두 추출해야 한다', () => {
        const content = `
app.get('/api/orders', async (req, res) => {
    const payment = await fetch('http://payment/api/pay');
    const inventory = await axios.get('http://inventory/stock');
    res.json({});
});
`;
        const result = scanTypeScript('/src/orderRoutes.ts', content);

        const kinds = result.signals.map((s) => s.kind);
        expect(kinds).toContain('expose');
        expect(kinds).toContain('call');
        expect(result.signals.length).toBeGreaterThanOrEqual(3);
    });

    it('빈 파일은 빈 signals 배열을 반환해야 한다', () => {
        const result = scanTypeScript('/src/empty.ts', '');
        expect(result.signals).toHaveLength(0);
    });

    it('.js 파일은 language가 javascript여야 한다', () => {
        const content = `app.get('/api', (req, res) => {});`;
        const result = scanTypeScript('/src/index.js', content);
        expect(result.language).toBe('javascript');
    });

    it('.ts 파일은 language가 typescript여야 한다', () => {
        const content = `app.get('/api', (req, res) => {});`;
        const result = scanTypeScript('/src/index.ts', content);
        expect(result.language).toBe('typescript');
    });

    it('.tsx 파일은 language가 typescript여야 한다', () => {
        const content = `router.get('/api', () => <div />);`;
        const result = scanTypeScript('/src/page.tsx', content);
        expect(result.language).toBe('typescript');
    });
});
