/**
 * Java/Kotlin AST 스캐너 단위 테스트 (Phase 2)
 * Phase 1 대비 개선사항:
 *  - 변수/상수 URL 추적
 *  - 멀티라인 어노테이션 처리
 *  - confidence +0.1~0.2 상향
 */
import { describe, it, expect } from 'vitest';
import { scanJavaKotlinAst } from '../../../code/ast/astJavaKotlin';

describe('scanJavaKotlinAst — Java/Kotlin AST 스캐너 (Phase 2)', () => {
    // ─── API 노출 (@Mapping 어노테이션) ──────────────────────────────────────

    it('@GetMapping에서 expose 신호를 추출해야 한다 (Phase 2: confidence 0.95)', () => {
        const content = `
package com.example.order;

@RestController
@GetMapping("/api/orders")
public class OrderController {}
`;
        const result = scanJavaKotlinAst('/src/OrderController.java', content);

        expect(result.language).toBe('java');
        expect(result.packageName).toBe('com.example.order');

        const expose = result.signals.find((s) => s.kind === 'expose');
        expect(expose).toBeDefined();
        expect(expose?.symbol).toBe('/api/orders');
        expect(expose?.confidence).toBeCloseTo(0.95); // Phase 1: 0.8 → Phase 2: 0.95
        expect(expose?.metadata).toMatchObject({ method: 'GET', annotation: '@GetMapping' });
        expect(expose?.metadata['phase']).toBe(2);
    });

    it('@PostMapping/@PutMapping/@DeleteMapping/@PatchMapping 모두 추출해야 한다', () => {
        const content = `
@PostMapping("/api/orders")
public Order createOrder() {}

@PutMapping("/api/orders/{id}")
public Order updateOrder() {}

@DeleteMapping("/api/orders/{id}")
public void deleteOrder() {}

@PatchMapping("/api/orders/{id}/status")
public Order patchOrder() {}
`;
        const result = scanJavaKotlinAst('/src/OrderController.java', content);
        const exposeSignals = result.signals.filter((s) => s.kind === 'expose');

        expect(exposeSignals).toHaveLength(4);
        const methods = exposeSignals.map((s) => s.metadata['method']);
        expect(methods).toContain('POST');
        expect(methods).toContain('PUT');
        expect(methods).toContain('DELETE');
        expect(methods).toContain('PATCH');
    });

    it('@RequestMapping에서 expose 신호를 추출해야 한다', () => {
        const content = `@RequestMapping("/api/v1/products")
public class ProductController {}`;
        const result = scanJavaKotlinAst('/src/ProductController.java', content);

        const expose = result.signals.find((s) => s.kind === 'expose');
        expect(expose?.symbol).toBe('/api/v1/products');
        expect(expose?.metadata).toMatchObject({ method: 'ANY', annotation: '@RequestMapping' });
    });

    // ─── 멀티라인 어노테이션 처리 (Phase 2 핵심 개선) ────────────────────────

    it('멀티라인 @GetMapping 어노테이션을 정확히 추출해야 한다', () => {
        const content = `
@GetMapping(
    "/api/orders"
)
public class OrderController {}
`;
        const result = scanJavaKotlinAst('/src/OrderController.java', content);
        const expose = result.signals.find((s) => s.kind === 'expose');
        expect(expose?.symbol).toBe('/api/orders');
    });

    // ─── 변수 추적 (Phase 2 핵심 개선: data-flow) ────────────────────────────

    it('상수로 선언된 URL을 추적하여 call 신호를 추출해야 한다', () => {
        const content = `
private static final String PAYMENT_URL = "http://payment-service/pay";
String result = restTemplate.getForObject(PAYMENT_URL, String.class);
`;
        const result = scanJavaKotlinAst('/src/OrderService.java', content);
        const call = result.signals.find((s) => s.kind === 'call');

        // Phase 1은 변수 URL을 감지하지 못하지만 Phase 2는 추적 가능
        expect(call).toBeDefined();
        expect(call?.symbol).toBe('http://payment-service/pay');
        expect(call?.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('지역 변수로 선언된 URL을 추적하여 call 신호를 추출해야 한다', () => {
        const content = `
String url = "/api/inventory/stock";
String result = restTemplate.getForObject(url, String.class);
`;
        const result = scanJavaKotlinAst('/src/InventoryClient.java', content);
        const call = result.signals.find((s) => s.kind === 'call');

        expect(call).toBeDefined();
        expect(call?.symbol).toBe('/api/inventory/stock');
    });

    // ─── HTTP 호출 패턴 ───────────────────────────────────────────────────────

    it('restTemplate.getForObject에서 call 신호를 추출해야 한다', () => {
        const content = `
String response = restTemplate.getForObject("http://payment-service/pay", String.class);
`;
        const result = scanJavaKotlinAst('/src/OrderService.java', content);

        const call = result.signals.find((s) => s.kind === 'call');
        expect(call?.symbol).toBe('http://payment-service/pay');
        expect(call?.confidence).toBeCloseTo(0.9); // Phase 1: 0.7 → Phase 2: 0.9
        expect(call?.metadata).toMatchObject({ client: 'RestTemplate' });
    });

    it('@FeignClient(name = "service")에서 call 신호를 추출해야 한다', () => {
        const content = `
@FeignClient(name = "payment-service", url = "http://payment:8080")
public interface PaymentClient {}
`;
        const result = scanJavaKotlinAst('/src/PaymentClient.java', content);

        const call = result.signals.find((s) => s.kind === 'call');
        expect(call?.symbol).toBe('payment-service');
        expect(call?.confidence).toBeCloseTo(0.9); // Phase 1: 0.7 → Phase 2: 0.9
        expect(call?.metadata).toMatchObject({ client: 'FeignClient' });
    });

    it('@GetExchange에서 call 신호를 추출해야 한다 (HttpInterface, Phase 2: confidence 0.9)', () => {
        const content = `
@GetExchange("/api/orders/{id}")
Order findById(@PathVariable Long id);
`;
        const result = scanJavaKotlinAst('/src/OrderClient.java', content);

        const call = result.signals.find((s) => s.kind === 'call');
        expect(call?.symbol).toBe('/api/orders/{id}');
        expect(call?.confidence).toBeCloseTo(0.9); // Phase 1: 0.8 → Phase 2: 0.9
        expect(call?.metadata).toMatchObject({ client: 'HttpInterface', method: 'GET', annotation: '@GetExchange' });
    });

    it('@PostExchange/@PutExchange/@DeleteExchange/@PatchExchange 모두 추출해야 한다', () => {
        const content = `
@PostExchange("/api/orders")
Order create(@RequestBody Order order);

@PutExchange("/api/orders/{id}")
Order update(@PathVariable Long id);

@DeleteExchange("/api/orders/{id}")
void delete(@PathVariable Long id);

@PatchExchange("/api/orders/{id}/status")
Order patch(@PathVariable Long id);
`;
        const result = scanJavaKotlinAst('/src/OrderClient.java', content);
        const callSignals = result.signals.filter((s) => s.kind === 'call');

        expect(callSignals).toHaveLength(4);
        const methods = callSignals.map((s) => s.metadata['method']);
        expect(methods).toContain('POST');
        expect(methods).toContain('PUT');
        expect(methods).toContain('DELETE');
        expect(methods).toContain('PATCH');
    });

    // ─── Kafka 패턴 ───────────────────────────────────────────────────────────

    it('kafkaTemplate.send에서 produce 신호를 추출해야 한다 (Phase 2: confidence 0.9)', () => {
        const content = `
kafkaTemplate.send("order.created", orderEvent);
`;
        const result = scanJavaKotlinAst('/src/OrderEventPublisher.java', content);

        const produce = result.signals.find((s) => s.kind === 'produce');
        expect(produce?.symbol).toBe('order.created');
        expect(produce?.confidence).toBeCloseTo(0.9); // Phase 1: 0.7 → Phase 2: 0.9
        expect(produce?.metadata).toMatchObject({ client: 'KafkaTemplate' });
    });

    it('상수로 선언된 토픽을 추적하여 produce 신호를 추출해야 한다', () => {
        const content = `
private static final String ORDER_TOPIC = "order.created";
kafkaTemplate.send(ORDER_TOPIC, event);
`;
        const result = scanJavaKotlinAst('/src/OrderPublisher.java', content);

        const produce = result.signals.find((s) => s.kind === 'produce');
        expect(produce).toBeDefined();
        expect(produce?.symbol).toBe('order.created');
    });

    it('@KafkaListener(topics = "topic")에서 consume 신호를 추출해야 한다 (Phase 2: confidence 0.95)', () => {
        const content = `
@KafkaListener(topics = "payment.completed", groupId = "order-group")
public void handlePayment(String message) {}
`;
        const result = scanJavaKotlinAst('/src/PaymentListener.java', content);

        const consume = result.signals.find((s) => s.kind === 'consume');
        expect(consume?.symbol).toBe('payment.completed');
        expect(consume?.confidence).toBeCloseTo(0.95); // Phase 1: 0.8 → Phase 2: 0.95
        expect(consume?.metadata).toMatchObject({ annotation: '@KafkaListener' });
    });

    it('@KafkaListener(topics = {"topic1", "topic2"}) 배열 형태를 처리해야 한다', () => {
        const content = `
@KafkaListener(topics = {"payment.completed", "order.created"})
public void handleMultipleTopics(String message) {}
`;
        const result = scanJavaKotlinAst('/src/MultiTopicListener.java', content);

        const consume = result.signals.find((s) => s.kind === 'consume');
        expect(consume).toBeDefined();
        // 첫 번째 토픽을 추출
        expect(consume?.symbol).toBe('payment.completed');
    });

    // ─── JPA 패턴 ─────────────────────────────────────────────────────────────

    it('@Table(name = "table_name")에서 db_mapping 신호를 추출해야 한다 (Phase 2: confidence 0.9)', () => {
        const content = `
@Entity
@Table(name = "orders")
public class Order {}
`;
        const result = scanJavaKotlinAst('/src/Order.java', content);

        const mapping = result.signals.find((s) => s.kind === 'db_mapping');
        expect(mapping?.symbol).toBe('orders');
        expect(mapping?.confidence).toBeCloseTo(0.9); // Phase 1: 0.7 → Phase 2: 0.9
        expect(mapping?.metadata).toMatchObject({ annotation: '@Table' });
    });

    // ─── 복합 / 엣지 케이스 ──────────────────────────────────────────────────

    it('여러 신호가 있는 파일에서 모두 추출해야 한다', () => {
        const content = `
package com.example.order;

@GetMapping("/api/orders")
public class OrderController {
    String result = restTemplate.getForObject("http://payment/pay", String.class);
    @Table(name = "orders") class Order {}
}
`;
        const result = scanJavaKotlinAst('/src/OrderController.java', content);
        expect(result.signals.length).toBeGreaterThanOrEqual(3);

        const kinds = result.signals.map((s) => s.kind);
        expect(kinds).toContain('expose');
        expect(kinds).toContain('call');
        expect(kinds).toContain('db_mapping');
    });

    it('빈 파일은 빈 signals 배열을 반환해야 한다', () => {
        const result = scanJavaKotlinAst('/src/Empty.java', '');
        expect(result.signals).toHaveLength(0);
        expect(result.packageName).toBeUndefined();
    });

    it('Kotlin 파일은 language가 kotlin이어야 한다', () => {
        const content = `package com.example\n@GetMapping("/api")\nfun handle() {}`;
        const result = scanJavaKotlinAst('/src/Controller.kt', content);
        expect(result.language).toBe('kotlin');
    });

    it('RestClient.create("baseUrl")에서 call 신호를 추출해야 한다', () => {
        const content = `RestClient restClient = RestClient.create("http://payment-service");`;
        const result = scanJavaKotlinAst('/src/PaymentClient.java', content);

        const call = result.signals.find((s) => s.kind === 'call');
        expect(call?.symbol).toBe('http://payment-service');
        expect(call?.metadata).toMatchObject({ client: 'RestClient' });
    });

    it('lineStart/lineEnd 정보가 정확해야 한다', () => {
        const content = `package com.example;

// Line 3
@GetMapping("/api/orders")
public class OrderController {}`;
        const result = scanJavaKotlinAst('/src/OrderController.java', content);

        const expose = result.signals.find((s) => s.kind === 'expose');
        expect(expose?.lineStart).toBe(4); // @GetMapping이 4번째 줄
    });

    it('모든 신호에 phase: 2 메타데이터가 있어야 한다', () => {
        const content = `
@GetMapping("/api/orders")
kafkaTemplate.send("order.topic", event);
`;
        const result = scanJavaKotlinAst('/src/Test.java', content);
        expect(result.signals.every((s) => s.metadata['phase'] === 2)).toBe(true);
    });
});
