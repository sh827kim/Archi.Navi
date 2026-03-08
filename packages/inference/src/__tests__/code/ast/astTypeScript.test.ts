/**
 * TypeScript/JavaScript AST 스캐너 단위 테스트 (Phase 2)
 * Phase 1 대비 개선사항:
 *  - 변수/상수 URL 추적
 *  - confidence +0.1~0.2 상향
 */
import { describe, it, expect } from 'vitest';
import { scanTypeScriptAst } from '@/code/ast/astTypeScript';

describe('scanTypeScriptAst — TypeScript/JavaScript AST 스캐너 (Phase 2)', () => {
    // ─── API 노출 (Express 라우트) ────────────────────────────────────────────

    it('app.get에서 expose 신호를 추출해야 한다 (Phase 2: confidence 0.9)', async () => {
        const content = `app.get('/api/orders', async (req, res) => { res.json({}); });`;
        const result = await scanTypeScriptAst('/src/routes.ts', content);

        const expose = result.signals.find((s) => s.kind === 'expose');
        expect(expose).toBeDefined();
        expect(expose?.symbol).toBe('/api/orders');
        expect(expose?.confidence).toBeCloseTo(0.9); // Phase 1: 0.8 → Phase 2: 0.9
        expect(expose?.metadata).toMatchObject({ method: 'GET', framework: 'express' });
    });

    it('app.post/put/delete/patch 라우트를 모두 추출해야 한다', async () => {
        const content = `
app.post('/api/orders', handler);
app.put('/api/orders/:id', handler);
app.delete('/api/orders/:id', handler);
app.patch('/api/orders/:id/status', handler);
`;
        const result = await scanTypeScriptAst('/src/routes.ts', content);
        const exposeSignals = result.signals.filter((s) => s.kind === 'expose');

        expect(exposeSignals).toHaveLength(4);
        const methods = exposeSignals.map((s) => s.metadata['method']);
        expect(methods).toContain('POST');
        expect(methods).toContain('PUT');
        expect(methods).toContain('DELETE');
        expect(methods).toContain('PATCH');
    });

    it('router.get에서 expose 신호를 추출해야 한다', async () => {
        const content = `router.get('/api/items', handler);`;
        const result = await scanTypeScriptAst('/src/routes.ts', content);

        const expose = result.signals.find((s) => s.kind === 'expose');
        expect(expose?.symbol).toBe('/api/items');
        expect(expose?.metadata).toMatchObject({ via: 'router' });
    });

    // ─── 변수 추적 (Phase 2 핵심 개선: data-flow) ────────────────────────────

    it('상수로 선언된 URL을 추적하여 call 신호를 추출해야 한다', async () => {
        const content = `
const PAYMENT_URL = 'http://payment-service/pay';
const response = await fetch(PAYMENT_URL);
`;
        const result = await scanTypeScriptAst('/src/paymentClient.ts', content);

        const call = result.signals.find((s) => s.kind === 'call');
        expect(call).toBeDefined();
        expect(call?.symbol).toBe('http://payment-service/pay');
    });

    it('변수로 선언된 경로를 추적하여 Express 라우트를 추출해야 한다', async () => {
        const content = `
const ORDER_PATH = '/api/orders';
app.get(ORDER_PATH, handler);
`;
        const result = await scanTypeScriptAst('/src/routes.ts', content);

        const expose = result.signals.find((s) => s.kind === 'expose');
        expect(expose).toBeDefined();
        expect(expose?.symbol).toBe('/api/orders');
    });

    it('axios 호출에서 변수 URL을 추적해야 한다', async () => {
        const content = `
const API_BASE = 'http://inventory-service';
const response = await axios.get(API_BASE);
`;
        const result = await scanTypeScriptAst('/src/inventoryClient.ts', content);

        const call = result.signals.find((s) => s.kind === 'call');
        expect(call).toBeDefined();
        expect(call?.symbol).toBe('http://inventory-service');
    });

    // ─── HTTP 호출 패턴 ───────────────────────────────────────────────────────

    it('fetch("url")에서 call 신호를 추출해야 한다 (Phase 2: confidence 0.85)', async () => {
        const content = `const data = await fetch('http://payment/pay');`;
        const result = await scanTypeScriptAst('/src/client.ts', content);

        const call = result.signals.find((s) => s.kind === 'call');
        expect(call?.symbol).toBe('http://payment/pay');
        expect(call?.confidence).toBeCloseTo(0.85); // Phase 1: 0.7 → Phase 2: 0.85
        expect(call?.metadata).toMatchObject({ client: 'fetch' });
    });

    it('axios.get에서 call 신호를 추출해야 한다 (Phase 2: confidence 0.85)', async () => {
        const content = `const response = await axios.get('http://inventory/stock');`;
        const result = await scanTypeScriptAst('/src/client.ts', content);

        const call = result.signals.find((s) => s.kind === 'call');
        expect(call?.symbol).toBe('http://inventory/stock');
        expect(call?.confidence).toBeCloseTo(0.85); // Phase 1: 0.7 → Phase 2: 0.85
        expect(call?.metadata).toMatchObject({ client: 'axios' });
    });

    it('axios.post/put/delete도 call 신호를 추출해야 한다', async () => {
        const content = `
await axios.post('http://payment/charge', payload);
await axios.put('http://payment/update', payload);
await axios.delete('http://payment/cancel');
`;
        const result = await scanTypeScriptAst('/src/client.ts', content);
        const calls = result.signals.filter((s) => s.kind === 'call');
        expect(calls.length).toBeGreaterThanOrEqual(3);
    });

    it('axios.request도 call 신호를 추출해야 한다', async () => {
        const content = `await axios.request('http://payment/request', { method: 'GET' });`;
        const result = await scanTypeScriptAst('/src/client.ts', content);
        const call = result.signals.find((s) => s.kind === 'call');
        expect(call?.symbol).toBe('http://payment/request');
        expect(call?.metadata).toMatchObject({ client: 'axios', method: 'REQUEST' });
    });

    // ─── HTTP 체인 패턴 ───────────────────────────────────────────────────────

    it('.get/.post 체인 호출에서 URL 경로가 있는 경우 call 신호를 추출해야 한다', async () => {
        const content = `httpClient.get('/api/orders', config);`;
        const result = await scanTypeScriptAst('/src/client.ts', content);

        const call = result.signals.find((s) => s.kind === 'call');
        expect(call).toBeDefined();
        expect(call?.symbol).toBe('/api/orders');
        expect(call?.metadata).toMatchObject({ client: 'http-chain' });
    });

    it('http-chain에서 URL/경로가 아니면 call 신호를 생성하지 않아야 한다', async () => {
        const content = `cache.get('cache-key');`;
        const result = await scanTypeScriptAst('/src/client.ts', content);
        expect(result.signals).toHaveLength(0);
    });

    it('같은 라인에 route+client.get가 있을 때 expose 중복 기반 call은 건너뛰어야 한다', async () => {
        const content = `app.get('/api/orders', handler); client.get('/api/orders');`;
        const result = await scanTypeScriptAst('/src/routes.ts', content);
        const expose = result.signals.filter((s) => s.kind === 'expose');
        const calls = result.signals.filter((s) => s.kind === 'call');
        expect(expose).toHaveLength(1);
        expect(calls).toHaveLength(0);
    });

    it('템플릿 문자열 URL도 call 신호를 추출해야 한다', async () => {
        const content = 'const res = await fetch(`http://inventory/health`);';
        const result = await scanTypeScriptAst('/src/client.ts', content);
        const call = result.signals.find((s) => s.kind === 'call');
        expect(call?.symbol).toBe('http://inventory/health');
    });

    it('정의되지 않은 식별자 인수는 추적하지 않아야 한다', async () => {
        const content = `await fetch(MISSING_URL);`;
        const result = await scanTypeScriptAst('/src/client.ts', content);
        expect(result.signals).toHaveLength(0);
    });

    it('server.get도 Express expose로 인식해야 한다', async () => {
        const content = `server.get('/api/server', handler);`;
        const result = await scanTypeScriptAst('/src/server.ts', content);
        const expose = result.signals.find((s) => s.kind === 'expose');
        expect(expose?.symbol).toBe('/api/server');
        expect(expose?.metadata).toMatchObject({ via: 'server' });
    });

    it('인수가 없는 fetch 호출은 신호를 생성하지 않아야 한다', async () => {
        const content = `fetch();`;
        const result = await scanTypeScriptAst('/src/client.ts', content);
        expect(result.signals).toHaveLength(0);
    });

    // ─── language 감지 ────────────────────────────────────────────────────────

    it('.ts 파일은 language가 typescript여야 한다', async () => {
        const result = await scanTypeScriptAst('/src/app.ts', `app.get('/api', handler);`);
        expect(result.language).toBe('typescript');
    });

    it('.js 파일은 language가 javascript여야 한다', async () => {
        const result = await scanTypeScriptAst('/src/app.js', `app.get('/api', handler);`);
        expect(result.language).toBe('javascript');
    });

    it('.tsx 파일은 language가 typescript여야 한다', async () => {
        const result = await scanTypeScriptAst('/src/app.tsx', `app.get('/api', handler);`);
        expect(result.language).toBe('typescript');
    });

    // ─── 엣지 케이스 ─────────────────────────────────────────────────────────

    it('빈 파일은 빈 signals 배열을 반환해야 한다', async () => {
        const result = await scanTypeScriptAst('/src/empty.ts', '');
        expect(result.signals).toHaveLength(0);
    });

    it('모든 신호에 phase: 2 메타데이터가 있어야 한다', async () => {
        const content = `
app.get('/api/orders', handler);
fetch('http://payment/pay');
`;
        const result = await scanTypeScriptAst('/src/app.ts', content);
        expect(result.signals.every((s) => s.metadata['phase'] === 2)).toBe(true);
    });

    it('lineStart 정보가 정확해야 한다', async () => {
        const content = `// Line 1
// Line 2
app.get('/api/orders', handler);`;
        const result = await scanTypeScriptAst('/src/routes.ts', content);

        const expose = result.signals.find((s) => s.kind === 'expose');
        expect(expose?.lineStart).toBe(3);
    });

    it('파싱 실패 시 빈 결과를 반환해야 한다', async () => {
        const content = `const broken = ;`;
        const result = await scanTypeScriptAst('/src/broken.ts', content);
        expect(result.signals).toEqual([]);
    });
});
