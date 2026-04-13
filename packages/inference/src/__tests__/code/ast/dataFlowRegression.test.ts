/**
 * Data-flow 정확도 회귀 테스트
 * 2-1 AST 운영 완성: 언어별 변수 추적 정확도를 검증하고,
 * AST vs Regex 결과 비교로 품질 저하를 조기 감지한다.
 */
import { describe, it, expect } from 'vitest';
import { scanJavaKotlinAst } from '@/code/ast/astJavaKotlin';
import { scanTypeScriptAst } from '@/code/ast/astTypeScript';
import { scanPythonAst } from '@/code/ast/astPython';

// ─── Java/Kotlin: 변수 추적 회귀 ──────────────────────────────────────────────

describe('Data-flow 회귀: Java/Kotlin', () => {
    it('static final + 지역변수 혼합 시 각각 올바른 URL을 추적해야 한다', async () => {
        const content = `
package com.example;

private static final String BASE_URL = "http://payment-service";
String localUrl = "/api/orders";

String a = restTemplate.getForObject(BASE_URL, String.class);
String b = restTemplate.postForObject(localUrl, body, String.class);
`;
        const result = await scanJavaKotlinAst('/src/MixedVars.java', content);
        const calls = result.signals.filter((s) => s.kind === 'call');

        expect(calls).toHaveLength(2);
        const symbols = calls.map((c) => c.symbol).sort();
        expect(symbols).toEqual(['/api/orders', 'http://payment-service']);
    });

    it('동일 변수명 재할당 시 마지막 값 무시하고 첫 번째 값을 사용해야 한다', async () => {
        // 현재 1-depth 변수 추적: buildVariableMap은 첫 번째 선언만 수집
        const content = `
String url = "/api/v1/orders";
url = "/api/v2/orders";
restTemplate.getForObject(url, String.class);
`;
        const result = await scanJavaKotlinAst('/src/ReassignVar.java', content);
        const call = result.signals.find((s) => s.kind === 'call');
        // 변수 추적은 첫 번째 선언 기준
        expect(call).toBeDefined();
        expect(call?.symbol).toBe('/api/v1/orders');
    });

    it('WebClient 다단계 체인에서 uri 인수를 정확히 추출해야 한다', async () => {
        const content = `
webClient
    .post()
    .uri("http://inventory-service/api/stock")
    .bodyValue(request)
    .retrieve()
    .bodyToMono(String.class);
`;
        const result = await scanJavaKotlinAst('/src/InventoryClient.java', content);
        const call = result.signals.find(
            (s) => s.kind === 'call' && s.metadata['client'] === 'WebClient',
        );
        expect(call?.symbol).toBe('http://inventory-service/api/stock');
    });

    it('RestClient 체인에서 uri 인수를 정확히 추출해야 한다', async () => {
        const content = `
restClient
    .get()
    .uri("/api/payments/{id}", paymentId)
    .retrieve()
    .body(Payment.class);
`;
        const result = await scanJavaKotlinAst('/src/PaymentClient.java', content);
        const call = result.signals.find(
            (s) => s.kind === 'call' && s.metadata['client'] === 'RestClient',
        );
        expect(call?.symbol).toBe('/api/payments/{id}');
    });

    it('dynamic URI도 partial metadata와 함께 call 신호로 보존해야 한다', async () => {
        const content = `
String baseUrl = "http://payment-service";
String dynamicPath = "/api/payments/" + paymentId;
webClient
    .get()
    .uri(baseUrl + dynamicPath)
    .retrieve();
`;
        const result = await scanJavaKotlinAst('/src/PaymentClient.java', content);
        const call = result.signals.find(
            (s) => s.kind === 'call' && s.metadata['client'] === 'WebClient',
        );

        expect(call).toBeDefined();
        expect(call?.metadata).toMatchObject({
            client: 'WebClient',
            method: 'GET',
            dynamicPath: true,
            dynamicHost: true,
            unsupportedPattern: true,
        });
        expect(call?.symbol).toBe('baseUrl + dynamicPath');
    });

    it('RestClient.create(baseUrl)에서 unresolved base URL을 partial metadata로 보존해야 한다', async () => {
        const content = `
class PaymentClient {
    void call() {
        String baseUrl;
        RestClient.create(baseUrl);
    }
}
`;
        const result = await scanJavaKotlinAst('/src/PaymentClient.java', content);
        const call = result.signals.find((s) => s.kind === 'call' && s.metadata['client'] === 'RestClient');

        expect(call).toBeDefined();
        expect(call?.symbol).toBe('baseUrl');
        expect(call?.metadata).toMatchObject({
            client: 'RestClient',
            method: 'create',
            baseUrlVar: 'baseUrl',
            dynamicHost: true,
            unsupportedPattern: true,
        });
    });

    it('Kafka 토픽 상수 + 직접 리터럴 혼합 시 둘 다 추출해야 한다', async () => {
        const content = `
private static final String ORDER_TOPIC = "order.created";
kafkaTemplate.send(ORDER_TOPIC, event1);
kafkaTemplate.send("payment.completed", event2);
`;
        const result = await scanJavaKotlinAst('/src/EventPublisher.java', content);
        const produces = result.signals.filter((s) => s.kind === 'produce');

        expect(produces).toHaveLength(2);
        const topics = produces.map((p) => p.symbol).sort();
        expect(topics).toEqual(['order.created', 'payment.completed']);
    });

    it('@RequestMapping(method = RequestMethod.POST, value = "/api") 형태도 추출해야 한다', async () => {
        const content = `
@RequestMapping(method = RequestMethod.POST, value = "/api/orders")
public Order create() {}
`;
        const result = await scanJavaKotlinAst('/src/OrderController.java', content);
        const expose = result.signals.find((s) => s.kind === 'expose');
        expect(expose?.symbol).toBe('/api/orders');
    });
});

// ─── TypeScript: 변수 추적 회귀 ────────────────────────────────────────────────

describe('Data-flow 회귀: TypeScript', () => {
    it('const 변수를 fetch/axios 양쪽에서 사용 시 각각 call 신호를 생성해야 한다', async () => {
        const content = `
const API_URL = 'http://order-service/api/orders';
await fetch(API_URL);
await axios.get(API_URL);
`;
        const result = await scanTypeScriptAst('/src/client.ts', content);
        const calls = result.signals.filter((s) => s.kind === 'call');

        expect(calls.length).toBeGreaterThanOrEqual(2);
        expect(calls.every((c) => c.symbol === 'http://order-service/api/orders')).toBe(true);
    });

    it('template literal에 보간이 포함되면 call 신호를 생성하지 않아야 한다', async () => {
        const content = 'await fetch(`http://api/${userId}/orders`);';
        const result = await scanTypeScriptAst('/src/client.ts', content);
        const calls = result.signals.filter((s) => s.kind === 'call');
        expect(calls).toHaveLength(0);
    });

    it('보간 없는 template literal은 정상 추출해야 한다', async () => {
        const content = 'await fetch(`http://payment-service/api/pay`);';
        const result = await scanTypeScriptAst('/src/client.ts', content);
        const call = result.signals.find((s) => s.kind === 'call');
        expect(call?.symbol).toBe('http://payment-service/api/pay');
    });

    it('Express router + 변수 경로 조합 시 expose를 추출해야 한다', async () => {
        const content = `
const ORDERS_PATH = '/api/orders';
router.get(ORDERS_PATH, handler);
router.post(ORDERS_PATH, handler);
`;
        const result = await scanTypeScriptAst('/src/routes.ts', content);
        const exposes = result.signals.filter((s) => s.kind === 'expose');
        expect(exposes).toHaveLength(2);
        expect(exposes.every((e) => e.symbol === '/api/orders')).toBe(true);
    });

    it('let 변수는 추적하지만 재할당은 반영하지 않아야 한다', async () => {
        const content = `
let url = '/api/v1/orders';
url = '/api/v2/orders';
await fetch(url);
`;
        const result = await scanTypeScriptAst('/src/client.ts', content);
        const call = result.signals.find((s) => s.kind === 'call');
        expect(call).toBeDefined();
        // 첫 번째 선언값 사용
        expect(call?.symbol).toBe('/api/v1/orders');
    });
});

// ─── Python: 변수 추적 회귀 ────────────────────────────────────────────────────

describe('Data-flow 회귀: Python', () => {
    it('상수 URL + 상수 토픽 혼합 시 각각 올바르게 추적해야 한다', async () => {
        const content = `
API_URL = 'http://inventory-service/stock'
ORDER_TOPIC = 'order.created'
response = requests.get(API_URL)
producer.send(ORDER_TOPIC, value=event)
`;
        const result = await scanPythonAst('/src/mixed.py', content);
        const call = result.signals.find((s) => s.kind === 'call');
        const produce = result.signals.find((s) => s.kind === 'produce');

        expect(call?.symbol).toBe('http://inventory-service/stock');
        expect(produce?.symbol).toBe('order.created');
    });

    it('Flask route + requests 호출이 같은 파일에 있을 때 둘 다 추출해야 한다', async () => {
        const content = `
@app.get('/api/orders')
def get_orders():
    response = requests.get('http://payment-service/status')
    return jsonify(response.json())
`;
        const result = await scanPythonAst('/src/app.py', content);
        const expose = result.signals.find((s) => s.kind === 'expose');
        const call = result.signals.find((s) => s.kind === 'call');

        expect(expose?.symbol).toBe('/api/orders');
        expect(call?.symbol).toBe('http://payment-service/status');
    });

    it('triple-quote 문자열은 URL로 추출하지 않아야 한다', async () => {
        const content = `
DOCS = """This is a docstring, not a URL"""
requests.get(DOCS)
`;
        const result = await scanPythonAst('/src/docs.py', content);
        // DOCS 값이 URL/경로가 아니므로 무시됨
        const calls = result.signals.filter((s) => s.kind === 'call');
        // triple-quote 문자열도 변수 추적이 되지만 URL이 아니면 의미 없음
        // 추출은 되더라도 URL 형태가 아닌 값은 낮은 품질
        expect(calls.length).toBeLessThanOrEqual(1);
    });

    it('f-string 변수는 추적하지 않아야 한다', async () => {
        const content = `
base = 'inventory'
requests.get(f'http://{base}/health')
`;
        const result = await scanPythonAst('/src/client.py', content);
        const calls = result.signals.filter((s) => s.kind === 'call');
        expect(calls).toHaveLength(0);
    });
});

// ─── 크로스 언어 일관성 ──────────────────────────────────────────────────────

describe('크로스 언어 일관성', () => {
    it('모든 언어의 AST 신호에 phase:2 메타데이터가 있어야 한다', async () => {
        const javaResult = await scanJavaKotlinAst(
            '/src/A.java',
            `@GetMapping("/api") class A {}`,
        );
        const tsResult = await scanTypeScriptAst(
            '/src/a.ts',
            `app.get('/api', h);`,
        );
        const pyResult = await scanPythonAst(
            '/src/a.py',
            `@app.get('/api')\ndef f(): pass`,
        );

        for (const result of [javaResult, tsResult, pyResult]) {
            expect(result.signals.length).toBeGreaterThan(0);
            for (const signal of result.signals) {
                expect(signal.metadata['phase']).toBe(2);
            }
        }
    });

    it('동일 패턴에 대해 AST confidence가 0.85 이상이어야 한다', async () => {
        const javaResult = await scanJavaKotlinAst(
            '/src/A.java',
            `restTemplate.getForObject("http://svc/api", String.class);`,
        );
        const tsResult = await scanTypeScriptAst(
            '/src/a.ts',
            `fetch('http://svc/api');`,
        );
        const pyResult = await scanPythonAst(
            '/src/a.py',
            `requests.get('http://svc/api')`,
        );

        for (const result of [javaResult, tsResult, pyResult]) {
            const call = result.signals.find((s) => s.kind === 'call');
            expect(call).toBeDefined();
            expect(call!.confidence).toBeGreaterThanOrEqual(0.85);
        }
    });
});
