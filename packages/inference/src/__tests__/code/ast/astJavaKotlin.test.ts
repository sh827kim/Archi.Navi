/**
 * Java/Kotlin AST 스캐너 단위 테스트 (Phase 2)
 * Phase 1 대비 개선사항:
 *  - 변수/상수 URL 추적
 *  - 멀티라인 어노테이션 처리
 *  - confidence +0.1~0.2 상향
 */
import { describe, it, expect } from 'vitest';
import { scanJavaKotlinAst } from '@/code/ast/astJavaKotlin';

describe('scanJavaKotlinAst — Java/Kotlin AST 스캐너 (Phase 2)', () => {
    // ─── API 노출 (@Mapping 어노테이션) ──────────────────────────────────────

    it('@GetMapping에서 expose 신호를 추출해야 한다 (Phase 2: confidence 0.95)', async () => {
        const content = `
package com.example.order;

@RestController
@GetMapping("/api/orders")
public class OrderController {}
`;
        const result = await scanJavaKotlinAst('/src/OrderController.java', content);

        expect(result.language).toBe('java');
        expect(result.packageName).toBe('com.example.order');

        const expose = result.signals.find((s) => s.kind === 'expose');
        expect(expose).toBeDefined();
        expect(expose?.symbol).toBe('/api/orders');
        expect(expose?.confidence).toBeCloseTo(0.95); // Phase 1: 0.8 → Phase 2: 0.95
        expect(expose?.metadata).toMatchObject({ method: 'GET', annotation: '@GetMapping' });
        expect(expose?.metadata['phase']).toBe(2);
    });

    it('@PostMapping/@PutMapping/@DeleteMapping/@PatchMapping 모두 추출해야 한다', async () => {
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
        const result = await scanJavaKotlinAst('/src/OrderController.java', content);
        const exposeSignals = result.signals.filter((s) => s.kind === 'expose');

        expect(exposeSignals).toHaveLength(4);
        const methods = exposeSignals.map((s) => s.metadata['method']);
        expect(methods).toContain('POST');
        expect(methods).toContain('PUT');
        expect(methods).toContain('DELETE');
        expect(methods).toContain('PATCH');
    });

    it('@RequestMapping에서 expose 신호를 추출해야 한다', async () => {
        const content = `@RequestMapping("/api/v1/products")
public class ProductController {}`;
        const result = await scanJavaKotlinAst('/src/ProductController.java', content);

        const expose = result.signals.find((s) => s.kind === 'expose');
        expect(expose?.symbol).toBe('/api/v1/products');
        expect(expose?.metadata).toMatchObject({ method: 'ANY', annotation: '@RequestMapping' });
    });

    it('@GetMapping(value = "...") 형태도 expose 신호를 추출해야 한다', async () => {
        const content = `@GetMapping(value = "/api/v2/orders")
public class OrderController {}`;
        const result = await scanJavaKotlinAst('/src/OrderController.java', content);
        const expose = result.signals.find((s) => s.kind === 'expose');
        expect(expose?.symbol).toBe('/api/v2/orders');
    });

    it('@RequestMapping(path = {"...", "..."}) 배열 형태도 expose를 추출해야 한다', async () => {
        const content = `@RequestMapping(path = {"/api/v1/products", "/api/v1/items"})
public class ProductController {}`;
        const result = await scanJavaKotlinAst('/src/ProductController.java', content);
        const expose = result.signals.find((s) => s.kind === 'expose');
        expect(expose?.symbol).toBe('/api/v1/products');
    });

    it('클래스 prefix + 메서드 매핑을 조합한 최종 endpoint를 생성해야 한다', async () => {
        const content = `
@RestController
@RequestMapping("/api/orders")
public class OrderController {
    @GetMapping("/{id}")
    public Order getOrder() { return null; }
}
`;
        const result = await scanJavaKotlinAst('/src/OrderController.java', content);
        const exposeSignals = result.signals.filter((signal) => signal.kind === 'expose');

        expect(exposeSignals).toHaveLength(1);
        expect(exposeSignals[0]?.symbol).toBe('/api/orders/{id}');
        expect(exposeSignals[0]?.metadata).toMatchObject({
            method: 'GET',
            path: '/api/orders/{id}',
            framework: 'spring',
            mappingSource: 'controller_composed',
        });
    });

    it('타입/메서드 method restriction 교집합이 없으면 endpoint를 생성하지 않아야 한다', async () => {
        const content = `
@RestController
@RequestMapping(path = "/api/orders", method = RequestMethod.POST)
public class OrderController {
    @RequestMapping(path = "/{id}", method = RequestMethod.GET)
    public Order getOrder() { return null; }
}
`;
        const result = await scanJavaKotlinAst('/src/OrderController.java', content);
        const exposeSignals = result.signals.filter((signal) => signal.kind === 'expose');
        expect(exposeSignals).toHaveLength(0);
    });

    it('메서드 mapping만 있는 클래스는 type-level prefix로 오인하지 않아야 한다', async () => {
        const content = `
@RestController
public class OrderController {
    @GetMapping("/orders")
    public Order getOrder() { return null; }
}
`;
        const result = await scanJavaKotlinAst('/src/OrderController.java', content);
        const exposeSignals = result.signals.filter((signal) => signal.kind === 'expose');

        expect(exposeSignals).toHaveLength(1);
        expect(exposeSignals[0]?.symbol).toBe('/orders');
        expect(exposeSignals[0]?.metadata).toMatchObject({
            method: 'GET',
            path: '/orders',
            mappingSource: 'controller_composed',
        });
    });

    // ─── 멀티라인 어노테이션 처리 (Phase 2 핵심 개선) ────────────────────────

    it('멀티라인 @GetMapping 어노테이션을 정확히 추출해야 한다', async () => {
        const content = `
@GetMapping(
    "/api/orders"
)
public class OrderController {}
`;
        const result = await scanJavaKotlinAst('/src/OrderController.java', content);
        const expose = result.signals.find((s) => s.kind === 'expose');
        expect(expose?.symbol).toBe('/api/orders');
    });

    // ─── 변수 추적 (Phase 2 핵심 개선: data-flow) ────────────────────────────

    it('상수로 선언된 URL을 추적하여 call 신호를 추출해야 한다', async () => {
        const content = `
private static final String PAYMENT_URL = "http://payment-service/pay";
String result = restTemplate.getForObject(PAYMENT_URL, String.class);
`;
        const result = await scanJavaKotlinAst('/src/OrderService.java', content);
        const call = result.signals.find((s) => s.kind === 'call');

        // Phase 1은 변수 URL을 감지하지 못하지만 Phase 2는 추적 가능
        expect(call).toBeDefined();
        expect(call?.symbol).toBe('http://payment-service/pay');
        expect(call?.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('지역 변수로 선언된 URL을 추적하여 call 신호를 추출해야 한다', async () => {
        const content = `
String url = "/api/inventory/stock";
String result = restTemplate.getForObject(url, String.class);
`;
        const result = await scanJavaKotlinAst('/src/InventoryClient.java', content);
        const call = result.signals.find((s) => s.kind === 'call');

        expect(call).toBeDefined();
        expect(call?.symbol).toBe('/api/inventory/stock');
    });

    // ─── HTTP 호출 패턴 ───────────────────────────────────────────────────────

    it('restTemplate.getForObject에서 call 신호를 추출해야 한다', async () => {
        const content = `
String response = restTemplate.getForObject("http://payment-service/pay", String.class);
`;
        const result = await scanJavaKotlinAst('/src/OrderService.java', content);

        const call = result.signals.find((s) => s.kind === 'call');
        expect(call?.symbol).toBe('http://payment-service/pay');
        expect(call?.confidence).toBeCloseTo(0.9); // Phase 1: 0.7 → Phase 2: 0.9
        expect(call?.metadata).toMatchObject({ client: 'RestTemplate' });
    });

    it('RestTemplate.exchange(baseUrl + "/mission", HttpMethod.POST, ...)에서 method/path/host를 복원해야 한다', async () => {
        const content = `
private static final String BASE_URL = "http://mission-service";
restTemplate.exchange(BASE_URL + "/mission", HttpMethod.POST, requestEntity, String.class);
`;
        const result = await scanJavaKotlinAst('/src/MissionClient.java', content);
        const call = result.signals.find(
            (signal) => signal.kind === 'call' && signal.metadata['client'] === 'RestTemplate',
        );

        expect(call).toBeDefined();
        expect(call?.symbol).toBe('http://mission-service/mission');
        expect(call?.metadata).toMatchObject({
            method: 'POST',
            hostHint: 'mission-service',
            pathHint: '/mission',
        });
    });

    it('webClient 체인(uri)에서 call 신호를 추출해야 한다', async () => {
        const content = `
webClient.get().uri("http://inventory-service/stock").retrieve();
`;
        const result = await scanJavaKotlinAst('/src/InventoryClient.java', content);
        const call = result.signals.find(
            (s) => s.kind === 'call' && s.metadata['client'] === 'WebClient',
        );
        expect(call?.symbol).toBe('http://inventory-service/stock');
    });

    it('restClient 체인(uri)에서 call 신호를 추출해야 한다', async () => {
        const content = `
restClient.get().uri("http://payment-service/pay").retrieve();
`;
        const result = await scanJavaKotlinAst('/src/PaymentClient.java', content);
        const call = result.signals.find(
            (s) => s.kind === 'call' && s.metadata['client'] === 'RestClient',
        );
        expect(call?.symbol).toBe('http://payment-service/pay');
    });

    it('webClient uri 동적 getter 호출에서 serviceNameHint/configKeys를 보존해야 한다', async () => {
        const content = `
webClient.get().uri(apiConfig.getSubscriptionManager() + "/v1/subscriptions").retrieve();
`;
        const result = await scanJavaKotlinAst('/src/SubscriptionClient.java', content);
        const call = result.signals.find(
            (s) => s.kind === 'call' && s.metadata['client'] === 'WebClient',
        );

        expect(call).toBeDefined();
        expect(call?.metadata).toMatchObject({
            serviceNameHint: 'SubscriptionManager',
            configKeys: ['apiConfig.subscriptionManager'],
        });
        expect(call?.symbol).toBe('/v1/subscriptions');
    });

    it('webClient.uri(baseUrl, uriBuilder -> ...) 패턴에서도 path/config 힌트를 보존해야 한다', async () => {
        const content = `
webClient.get()
  .uri("\${orders.base-url}", uriBuilder -> uriBuilder.path("/v1/orders/{id}").build(orderId))
  .retrieve();
`;
        const result = await scanJavaKotlinAst('/src/OrderClient.java', content);
        const call = result.signals.find(
            (s) => s.kind === 'call' && s.metadata['client'] === 'WebClient',
        );

        expect(call).toBeDefined();
        expect(call?.symbol).toBe('/v1/orders/{id}');
        expect(call?.metadata).toMatchObject({
            client: 'WebClient',
            method: 'GET',
            configKeys: ['orders.base-url'],
            pathHint: '/v1/orders/{id}',
            dynamicPath: true,
            dynamicHost: true,
            unsupportedPattern: true,
        });
        expect(call?.metadata['resolvedUrl']).toBeUndefined();
    });

    it('UriComponentsBuilder.pathSegment(id).buildAndExpand(id) 패턴에서 path template를 보존해야 한다', async () => {
        const content = `
String endpoint = UriComponentsBuilder.fromUriString(apiProperties.getFoo())
  .path("/v1/orders")
  .pathSegment(orderId)
  .buildAndExpand(orderId)
  .toUriString();
webClient.get().uri(endpoint).retrieve();
`;
        const result = await scanJavaKotlinAst('/src/OrderClient.java', content);
        const call = result.signals.find(
            (signal) => signal.kind === 'call' && signal.metadata['client'] === 'WebClient',
        );

        expect(call).toBeDefined();
        expect(call?.metadata).toMatchObject({
            pathHint: '/v1/orders/{id}',
            pathSource: 'expression',
            dynamicPath: false,
        });
    });

    it('@FeignClient 인터페이스에서 메서드별 call 신호를 추출해야 한다', async () => {
        const content = `
@FeignClient(name = "payment-service")
public interface PaymentClient {
    @GetMapping("/api/payments/{id}")
    Payment getPayment(String id);

    @PostMapping("/api/payments")
    Payment createPayment(PaymentRequest req);
}
`;
        const result = await scanJavaKotlinAst('/src/PaymentClient.java', content);
        const feignCalls = result.signals.filter(
            (s) => s.kind === 'call' && s.metadata['client'] === 'FeignClient',
        );

        expect(feignCalls).toHaveLength(2);
        expect(feignCalls[0]?.symbol).toBe('http://payment-service/api/payments/{id}');
        expect(feignCalls[0]?.metadata).toMatchObject({ method: 'GET', path: '/api/payments/{id}' });
        expect(feignCalls[1]?.symbol).toBe('http://payment-service/api/payments');
        expect(feignCalls[1]?.metadata).toMatchObject({ method: 'POST', path: '/api/payments' });
        expect(feignCalls[0]?.confidence).toBeCloseTo(0.92);
    });

    it('@FeignClient + @RequestMapping prefix를 결합해야 한다', async () => {
        const content = `
@FeignClient(name = "order-service")
@RequestMapping("/api/v1")
public interface OrderClient {
    @GetMapping("/orders")
    List<Order> listOrders();
}
`;
        const result = await scanJavaKotlinAst('/src/OrderClient.java', content);
        const feignCalls = result.signals.filter(
            (s) => s.kind === 'call' && s.metadata['client'] === 'FeignClient',
        );

        expect(feignCalls).toHaveLength(1);
        expect(feignCalls[0]?.symbol).toBe('http://order-service/api/v1/orders');
    });

    it('@FeignClient에 매핑 메서드가 없으면 서비스 레벨 fallback', async () => {
        const content = `
@FeignClient(name = "payment-service", url = "http://payment:8080")
public interface PaymentClient {}
`;
        const result = await scanJavaKotlinAst('/src/PaymentClient.java', content);

        const call = result.signals.find((s) => s.kind === 'call');
        expect(call?.symbol).toBe('payment-service');
        expect(call?.confidence).toBeCloseTo(0.9);
        expect(call?.metadata).toMatchObject({ client: 'FeignClient' });
    });

    it('@FeignClient("service") 단축 형태도 지원해야 한다', async () => {
        const content = `
@FeignClient("inventory-service")
public interface InventoryClient {
    @GetMapping("/api/stock")
    Stock getStock();
}
`;
        const result = await scanJavaKotlinAst('/src/InventoryClient.java', content);
        const feignCalls = result.signals.filter(
            (s) => s.kind === 'call' && s.metadata['client'] === 'FeignClient',
        );

        expect(feignCalls).toHaveLength(1);
        expect(feignCalls[0]?.symbol).toBe('http://inventory-service/api/stock');
    });

    it('@FeignClient에 name이 없으면 call 신호를 생성하지 않아야 한다', async () => {
        const content = `
@FeignClient(url = "http://payment:8080")
public interface PaymentClient {}
`;
        const result = await scanJavaKotlinAst('/src/PaymentClient.java', content);
        const feignCalls = result.signals.filter(
            (s) => s.kind === 'call' && s.metadata['client'] === 'FeignClient',
        );
        expect(feignCalls).toHaveLength(0);
    });

    it('@GetExchange에서 call 신호를 추출해야 한다 (HttpInterface, Phase 2: confidence 0.9)', async () => {
        const content = `
@GetExchange("/api/orders/{id}")
Order findById(@PathVariable Long id);
`;
        const result = await scanJavaKotlinAst('/src/OrderClient.java', content);

        const call = result.signals.find((s) => s.kind === 'call');
        expect(call?.symbol).toBe('/api/orders/{id}');
        expect(call?.confidence).toBeCloseTo(0.9); // Phase 1: 0.8 → Phase 2: 0.9
        expect(call?.metadata).toMatchObject({ client: 'HttpInterface', method: 'GET', annotation: '@GetExchange' });
    });

    it('@PostExchange/@PutExchange/@DeleteExchange/@PatchExchange 모두 추출해야 한다', async () => {
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
        const result = await scanJavaKotlinAst('/src/OrderClient.java', content);
        const callSignals = result.signals.filter((s) => s.kind === 'call');

        expect(callSignals).toHaveLength(4);
        const methods = callSignals.map((s) => s.metadata['method']);
        expect(methods).toContain('POST');
        expect(methods).toContain('PUT');
        expect(methods).toContain('DELETE');
        expect(methods).toContain('PATCH');
    });

    // ─── Kafka 패턴 ───────────────────────────────────────────────────────────

    it('kafkaTemplate.send에서 produce 신호를 추출해야 한다 (Phase 2: confidence 0.9)', async () => {
        const content = `
kafkaTemplate.send("order.created", orderEvent);
`;
        const result = await scanJavaKotlinAst('/src/OrderEventPublisher.java', content);

        const produce = result.signals.find((s) => s.kind === 'produce');
        expect(produce?.symbol).toBe('order.created');
        expect(produce?.confidence).toBeCloseTo(0.9); // Phase 1: 0.7 → Phase 2: 0.9
        expect(produce?.metadata).toMatchObject({ client: 'KafkaTemplate' });
    });

    it('상수로 선언된 토픽을 추적하여 produce 신호를 추출해야 한다', async () => {
        const content = `
private static final String ORDER_TOPIC = "order.created";
kafkaTemplate.send(ORDER_TOPIC, event);
`;
        const result = await scanJavaKotlinAst('/src/OrderPublisher.java', content);

        const produce = result.signals.find((s) => s.kind === 'produce');
        expect(produce).toBeDefined();
        expect(produce?.symbol).toBe('order.created');
    });

    it('rabbitTemplate.convertAndSend("queue", payload)에서 queue produce 신호를 추출해야 한다', async () => {
        const content = `
rabbitTemplate.convertAndSend("email.queue", payload);
`;
        const result = await scanJavaKotlinAst('/src/EmailPublisher.java', content);

        const produce = result.signals.find((s) => s.kind === 'produce');
        expect(produce?.symbol).toBe('email.queue');
        expect(produce?.metadata).toMatchObject({
            client: 'RabbitTemplate',
            broker: 'rabbitmq',
            channelType: 'queue',
        });
    });

    it('rabbitTemplate.convertAndSend(exchange, routingKey, payload)는 queue 신호를 생성하지 않아야 한다', async () => {
        const content = `
rabbitTemplate.convertAndSend("orders.exchange", "orders.created", payload);
`;
        const result = await scanJavaKotlinAst('/src/OrderPublisher.java', content);

        const produces = result.signals.filter((s) => s.kind === 'produce');
        expect(produces).toHaveLength(0);
    });

    it('@KafkaListener(topics = "topic")에서 consume 신호를 추출해야 한다 (Phase 2: confidence 0.95)', async () => {
        const content = `
@KafkaListener(topics = "payment.completed", groupId = "order-group")
public void handlePayment(String message) {}
`;
        const result = await scanJavaKotlinAst('/src/PaymentListener.java', content);

        const consume = result.signals.find((s) => s.kind === 'consume');
        expect(consume?.symbol).toBe('payment.completed');
        expect(consume?.confidence).toBeCloseTo(0.95); // Phase 1: 0.8 → Phase 2: 0.95
        expect(consume?.metadata).toMatchObject({ annotation: '@KafkaListener' });
    });

    it('@KafkaListener에 topics가 없으면 consume 신호를 생성하지 않아야 한다', async () => {
        const content = `
@KafkaListener(groupId = "order-group")
public void handlePayment(String message) {}
`;
        const result = await scanJavaKotlinAst('/src/PaymentListener.java', content);
        const consume = result.signals.filter((s) => s.kind === 'consume');
        expect(consume).toHaveLength(0);
    });

    it('@KafkaListener(topics = {"topic1", "topic2"}) 배열 형태를 처리해야 한다', async () => {
        const content = `
@KafkaListener(topics = {"payment.completed", "order.created"})
public void handleMultipleTopics(String message) {}
`;
        const result = await scanJavaKotlinAst('/src/MultiTopicListener.java', content);

        const consume = result.signals.find((s) => s.kind === 'consume');
        expect(consume).toBeDefined();
        // 첫 번째 토픽을 추출
        expect(consume?.symbol).toBe('payment.completed');
    });

    // ─── JPA 패턴 ─────────────────────────────────────────────────────────────

    it('@Table(name = "table_name")에서 db_mapping 신호를 추출해야 한다 (Phase 2: confidence 0.9)', async () => {
        const content = `
@Entity
@Table(name = "orders")
public class Order {}
`;
        const result = await scanJavaKotlinAst('/src/Order.java', content);

        const mapping = result.signals.find((s) => s.kind === 'db_mapping');
        expect(mapping?.symbol).toBe('orders');
        expect(mapping?.confidence).toBeCloseTo(0.9); // Phase 1: 0.7 → Phase 2: 0.9
        expect(mapping?.metadata).toMatchObject({ annotation: '@Table' });
    });

    // ─── 복합 / 엣지 케이스 ──────────────────────────────────────────────────

    it('여러 신호가 있는 파일에서 모두 추출해야 한다', async () => {
        const content = `
package com.example.order;

@GetMapping("/api/orders")
public class OrderController {
    String result = restTemplate.getForObject("http://payment/pay", String.class);
    @Table(name = "orders") class Order {}
}
`;
        const result = await scanJavaKotlinAst('/src/OrderController.java', content);
        expect(result.signals.length).toBeGreaterThanOrEqual(3);

        const kinds = result.signals.map((s) => s.kind);
        expect(kinds).toContain('expose');
        expect(kinds).toContain('call');
        expect(kinds).toContain('db_mapping');
    });

    it('문자열/식별자가 아닌 첫 번째 인수는 call 신호를 생성하지 않아야 한다', async () => {
        const content = `
String response = restTemplate.getForObject(buildPaymentUrl(), String.class);
`;
        const result = await scanJavaKotlinAst('/src/OrderService.java', content);
        const calls = result.signals.filter((s) => s.kind === 'call');
        expect(calls).toHaveLength(0);
    });

    it('인수 없는 어노테이션(Feign/Kafka/Table)은 신호를 생성하지 않아야 한다', async () => {
        const content = `
@FeignClient
interface NoArgsFeign {}

@KafkaListener
void listen(String m) {}

@Table
class NoTableName {}
`;
        const result = await scanJavaKotlinAst('/src/NoArgsAnnotations.java', content);
        expect(result.signals).toHaveLength(0);
    });

    it('경로 인자가 없는 Mapping/Exchange 어노테이션은 신호를 생성하지 않아야 한다', async () => {
        const content = `
@GetMapping
class C1 {}

@GetExchange
interface C2 {}
`;
        const result = await scanJavaKotlinAst('/src/NoPathAnnotations.java', content);
        expect(result.signals).toHaveLength(0);
    });

    it('package_declaration이 없으면 packageName은 undefined여야 한다', async () => {
        const content = `
@GetMapping("/health")
class HealthController {}
`;
        const result = await scanJavaKotlinAst('/src/HealthController.java', content);
        expect(result.packageName).toBeUndefined();
    });

    it('빈 파일은 빈 signals 배열을 반환해야 한다', async () => {
        const result = await scanJavaKotlinAst('/src/Empty.java', '');
        expect(result.signals).toHaveLength(0);
        expect(result.packageName).toBeUndefined();
    });

    it('Kotlin 파일은 language가 kotlin이어야 한다', async () => {
        const content = `package com.example\n@GetMapping("/api")\nfun handle() {}`;
        const result = await scanJavaKotlinAst('/src/Controller.kt', content);
        expect(result.language).toBe('kotlin');
    });

    it('.kts 파일도 language가 kotlin이어야 한다', async () => {
        const content = `println("hello")`;
        const result = await scanJavaKotlinAst('/src/build.kts', content);
        expect(result.language).toBe('kotlin');
    });

    it('RestClient.create("baseUrl")에서 call 신호를 추출해야 한다', async () => {
        const content = `RestClient restClient = RestClient.create("http://payment-service");`;
        const result = await scanJavaKotlinAst('/src/PaymentClient.java', content);

        const call = result.signals.find((s) => s.kind === 'call');
        expect(call?.symbol).toBe('http://payment-service');
        expect(call?.metadata).toMatchObject({ client: 'RestClient' });
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

    it('RestClient.create("${...}")는 config-binding 힌트를 partial metadata로 보존해야 한다', async () => {
        const content = 'RestClient restClient = RestClient.create("${payment.base-url}");';
        const result = await scanJavaKotlinAst('/src/PaymentClient.java', content);

        const call = result.signals.find((s) => s.kind === 'call' && s.metadata['client'] === 'RestClient');
        expect(call).toBeDefined();
        expect(call?.symbol).toBe('${payment.base-url}');
        expect(call?.metadata).toMatchObject({
            client: 'RestClient',
            method: 'create',
            configKeys: ['payment.base-url'],
            dynamicHost: true,
            unsupportedPattern: true,
        });
    });

    it('lineStart/lineEnd 정보가 정확해야 한다', async () => {
        const content = `package com.example;

// Line 3
@GetMapping("/api/orders")
public class OrderController {}`;
        const result = await scanJavaKotlinAst('/src/OrderController.java', content);

        const expose = result.signals.find((s) => s.kind === 'expose');
        expect(expose?.lineStart).toBe(4); // @GetMapping이 4번째 줄
    });

    it('모든 신호에 phase: 2 메타데이터가 있어야 한다', async () => {
        const content = `
@GetMapping("/api/orders")
kafkaTemplate.send("order.topic", event);
`;
        const result = await scanJavaKotlinAst('/src/Test.java', content);
        expect(result.signals.every((s) => s.metadata['phase'] === 2)).toBe(true);
    });
});
