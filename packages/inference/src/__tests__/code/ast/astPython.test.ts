/**
 * Python AST 스캐너 단위 테스트 (Phase 2)
 * Phase 1 대비 개선사항:
 *  - 변수/상수 URL/토픽 추적
 *  - keyword_argument 정밀 파싱
 *  - confidence +0.1~0.2 상향
 */
import { describe, it, expect } from 'vitest';
import { scanPythonAst } from '../../../code/ast/astPython';

describe('scanPythonAst — Python AST 스캐너 (Phase 2)', () => {
    // ─── API 노출 (Flask/FastAPI 데코레이터) ──────────────────────────────────

    it('@app.route에서 expose 신호를 추출해야 한다 (Phase 2: confidence 0.9)', () => {
        const content = `
@app.route('/api/orders')
def get_orders():
    return jsonify([])
`;
        const result = scanPythonAst('/src/app.py', content);

        const expose = result.signals.find((s) => s.kind === 'expose');
        expect(expose).toBeDefined();
        expect(expose?.symbol).toBe('/api/orders');
        expect(expose?.confidence).toBeCloseTo(0.9); // Phase 1: 0.8 → Phase 2: 0.9
        expect(expose?.metadata).toMatchObject({ method: 'ANY', framework: 'flask/fastapi' });
    });

    it('@app.get/@app.post/@app.put/@app.delete 모두 추출해야 한다', () => {
        const content = `
@app.get('/api/orders')
def get_orders(): pass

@app.post('/api/orders')
def create_order(): pass

@app.put('/api/orders/{id}')
def update_order(): pass

@app.delete('/api/orders/{id}')
def delete_order(): pass
`;
        const result = scanPythonAst('/src/app.py', content);
        const exposeSignals = result.signals.filter((s) => s.kind === 'expose');

        expect(exposeSignals).toHaveLength(4);
        const methods = exposeSignals.map((s) => s.metadata['method']);
        expect(methods).toContain('GET');
        expect(methods).toContain('POST');
        expect(methods).toContain('PUT');
        expect(methods).toContain('DELETE');
    });

    it('@router.get 형태도 expose 신호를 추출해야 한다', () => {
        const content = `
@router.get('/api/items')
def get_items(): pass
`;
        const result = scanPythonAst('/src/routes.py', content);

        const expose = result.signals.find((s) => s.kind === 'expose');
        expect(expose?.symbol).toBe('/api/items');
        expect(expose?.metadata['via']).toBe('router');
    });

    // ─── 변수 추적 (Phase 2 핵심 개선) ───────────────────────────────────────

    it('상수로 선언된 URL을 추적하여 call 신호를 추출해야 한다', () => {
        const content = `
BASE_URL = 'http://payment-service'
response = requests.get(BASE_URL)
`;
        const result = scanPythonAst('/src/client.py', content);

        const call = result.signals.find((s) => s.kind === 'call');
        expect(call).toBeDefined();
        expect(call?.symbol).toBe('http://payment-service');
    });

    it('상수 토픽을 추적하여 produce 신호를 추출해야 한다', () => {
        const content = `
ORDER_TOPIC = 'order.created'
producer.send(ORDER_TOPIC, value=event)
`;
        const result = scanPythonAst('/src/publisher.py', content);

        const produce = result.signals.find((s) => s.kind === 'produce');
        expect(produce).toBeDefined();
        expect(produce?.symbol).toBe('order.created');
    });

    // ─── HTTP 호출 패턴 ───────────────────────────────────────────────────────

    it('requests.get에서 call 신호를 추출해야 한다 (Phase 2: confidence 0.85)', () => {
        const content = `response = requests.get('http://inventory/stock')`;
        const result = scanPythonAst('/src/client.py', content);

        const call = result.signals.find((s) => s.kind === 'call');
        expect(call?.symbol).toBe('http://inventory/stock');
        expect(call?.confidence).toBeCloseTo(0.85); // Phase 1: 0.7 → Phase 2: 0.85
        expect(call?.metadata).toMatchObject({ client: 'requests', method: 'GET' });
    });

    it('requests.post/put/delete도 call 신호를 추출해야 한다', () => {
        const content = `
requests.post('http://payment/charge', json=payload)
requests.put('http://payment/update', json=payload)
requests.delete('http://payment/cancel')
`;
        const result = scanPythonAst('/src/client.py', content);
        const calls = result.signals.filter((s) => s.kind === 'call');
        expect(calls.length).toBeGreaterThanOrEqual(3);
    });

    // ─── Kafka 패턴 ───────────────────────────────────────────────────────────

    it('@kafka_consumer(topic="topic")에서 consume 신호를 추출해야 한다 (Phase 2: confidence 0.9)', () => {
        const content = `
@kafka_consumer(topic='payment.completed')
def handle_payment(msg):
    pass
`;
        const result = scanPythonAst('/src/consumer.py', content);

        const consume = result.signals.find((s) => s.kind === 'consume');
        expect(consume?.symbol).toBe('payment.completed');
        expect(consume?.confidence).toBeCloseTo(0.9); // Phase 1: 0.8 → Phase 2: 0.9
        expect(consume?.metadata).toMatchObject({ annotation: '@kafka_consumer' });
    });

    it('producer.send("topic", ...)에서 produce 신호를 추출해야 한다 (Phase 2: confidence 0.85)', () => {
        const content = `producer.send('order.created', value=event)`;
        const result = scanPythonAst('/src/publisher.py', content);

        const produce = result.signals.find((s) => s.kind === 'produce');
        expect(produce?.symbol).toBe('order.created');
        expect(produce?.confidence).toBeCloseTo(0.85); // Phase 1: 0.7 → Phase 2: 0.85
        expect(produce?.metadata).toMatchObject({ client: 'KafkaProducer' });
    });

    // ─── 엣지 케이스 ─────────────────────────────────────────────────────────

    it('빈 파일은 빈 signals 배열을 반환해야 한다', () => {
        const result = scanPythonAst('/src/empty.py', '');
        expect(result.signals).toHaveLength(0);
    });

    it('language는 항상 python이어야 한다', () => {
        const result = scanPythonAst('/src/app.py', `requests.get('http://api/v1')`);
        expect(result.language).toBe('python');
    });

    it('모든 신호에 phase: 2 메타데이터가 있어야 한다', () => {
        const content = `
@app.route('/api/orders')
def get_orders():
    requests.get('http://payment/pay')
`;
        const result = scanPythonAst('/src/app.py', content);
        expect(result.signals.every((s) => s.metadata['phase'] === 2)).toBe(true);
    });

    it('lineStart 정보가 정확해야 한다', () => {
        const content = `# Line 1
# Line 2
@app.route('/api/orders')
def get_orders(): pass`;
        const result = scanPythonAst('/src/app.py', content);

        const expose = result.signals.find((s) => s.kind === 'expose');
        expect(expose?.lineStart).toBe(3);
    });
});
