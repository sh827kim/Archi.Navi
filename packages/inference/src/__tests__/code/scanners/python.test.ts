/**
 * Python 스캐너 단위 테스트
 */
import { describe, it, expect } from 'vitest';
import { scanPython } from '../../../code/scanners/python';

describe('scanPython', () => {
    // ─── HTTP 호출 패턴 ───────────────────────────────────────────────────────

    it('requests.get에서 call 신호를 추출해야 한다', () => {
        const content = `
import requests

response = requests.get('http://payment-service/api/pay')
`;
        const result = scanPython('/src/payment_client.py', content);

        const call = result.signals.find((s) => s.kind === 'call');
        expect(call).toBeDefined();
        expect(call?.symbol).toBe('http://payment-service/api/pay');
        expect(call?.confidence).toBeCloseTo(0.7);
        expect(call?.metadata).toMatchObject({ client: 'requests', method: 'GET' });
    });

    it('requests.post에서 call 신호를 추출해야 한다', () => {
        const content = `
response = requests.post('http://notification-service/send', json=payload)
`;
        const result = scanPython('/src/notifier.py', content);

        const call = result.signals.find((s) => s.kind === 'call');
        expect(call?.symbol).toBe('http://notification-service/send');
        expect(call?.metadata).toMatchObject({ method: 'POST' });
    });

    it('requests.head에서 call 신호를 추출해야 한다', () => {
        const content = `
response = requests.head('http://inventory-service/health')
`;
        const result = scanPython('/src/health_client.py', content);
        const call = result.signals.find((s) => s.kind === 'call');
        expect(call?.symbol).toBe('http://inventory-service/health');
        expect(call?.metadata).toMatchObject({ method: 'HEAD' });
    });

    // ─── API 노출 패턴 ────────────────────────────────────────────────────────

    it('@app.route에서 expose 신호를 추출해야 한다', () => {
        const content = `
@app.route('/api/orders', methods=['GET', 'POST'])
def orders():
    return jsonify(data)
`;
        const result = scanPython('/src/order_routes.py', content);

        const expose = result.signals.find((s) => s.kind === 'expose');
        expect(expose).toBeDefined();
        expect(expose?.symbol).toBe('/api/orders');
        expect(expose?.confidence).toBeCloseTo(0.8);
        expect(expose?.metadata).toMatchObject({ framework: 'flask/fastapi', via: 'app' });
    });

    it('@router.get에서 expose 신호를 추출해야 한다', () => {
        const content = `
@router.get('/api/products')
async def get_products():
    return []
`;
        const result = scanPython('/src/product_router.py', content);

        const expose = result.signals.find((s) => s.kind === 'expose');
        expect(expose?.symbol).toBe('/api/products');
        expect(expose?.metadata).toMatchObject({ method: 'GET', via: 'router' });
    });

    it('@app.post/@router.delete 등 다양한 메서드도 추출해야 한다', () => {
        const content = `
@app.post('/api/orders')
def create_order(): pass

@router.delete('/api/orders/{id}')
async def delete_order(id: str): pass
`;
        const result = scanPython('/src/routes.py', content);
        const exposeSignals = result.signals.filter((s) => s.kind === 'expose');

        expect(exposeSignals).toHaveLength(2);
        const methods = exposeSignals.map((s) => s.metadata['method']);
        expect(methods).toContain('POST');
        expect(methods).toContain('DELETE');
    });

    // ─── Kafka 패턴 ───────────────────────────────────────────────────────────

    it('producer.send에서 produce 신호를 추출해야 한다', () => {
        const content = `
producer = KafkaProducer()
producer.send('order.created', value=event)
`;
        const result = scanPython('/src/order_producer.py', content);

        const produce = result.signals.find((s) => s.kind === 'produce');
        expect(produce).toBeDefined();
        expect(produce?.symbol).toBe('order.created');
        expect(produce?.confidence).toBeCloseTo(0.7);
    });

    it('@kafka_consumer(topic=...)에서 consume 신호를 추출해야 한다', () => {
        const content = `
@kafka_consumer(topic="payment.completed", group_id="order-group")
def handle_payment(message):
    pass
`;
        const result = scanPython('/src/payment_consumer.py', content);

        const consume = result.signals.find((s) => s.kind === 'consume');
        expect(consume).toBeDefined();
        expect(consume?.symbol).toBe('payment.completed');
        expect(consume?.confidence).toBeCloseTo(0.8);
        expect(consume?.metadata).toMatchObject({ annotation: '@kafka_consumer' });
    });

    // ─── 엣지 케이스 ─────────────────────────────────────────────────────────

    it('빈 파일은 빈 signals 배열을 반환해야 한다', () => {
        const result = scanPython('/src/empty.py', '');
        expect(result.signals).toHaveLength(0);
        expect(result.language).toBe('python');
    });

    it('lineStart가 올바른 라인 번호를 가리켜야 한다', () => {
        const content = `# 파이썬 서비스
# 2번 라인
response = requests.get('http://service/api')
# 4번 라인
`;
        const result = scanPython('/src/client.py', content);
        const call = result.signals.find((s) => s.kind === 'call');
        expect(call?.lineStart).toBe(3);
    });
});
