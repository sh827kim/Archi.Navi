/**
 * Java/Kotlin 스캐너 단위 테스트
 */
import { describe, it, expect } from 'vitest';
import { scanJavaKotlin, scanMyBatisXml } from '@/code/scanners/javaKotlin';

describe('scanJavaKotlin', () => {
    // ─── API 노출 패턴 ────────────────────────────────────────────────────────

    it('@GetMapping에서 expose 신호를 추출해야 한다', () => {
        const content = `
package com.example.order;

@RestController
@GetMapping("/api/orders")
public class OrderController {
}`;
        const result = scanJavaKotlin('/src/OrderController.java', content);
        expect(result.language).toBe('java');
        expect(result.packageName).toBe('com.example.order');

        const expose = result.signals.find((s) => s.kind === 'expose');
        expect(expose).toBeDefined();
        expect(expose?.symbol).toBe('/api/orders');
        expect(expose?.confidence).toBeCloseTo(0.8);
        expect(expose?.metadata).toMatchObject({ method: 'GET', annotation: '@GetMapping' });
    });

    it('@PostMapping/@PutMapping/@DeleteMapping/@PatchMapping에서 expose 신호를 추출해야 한다', () => {
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
        const result = scanJavaKotlin('/src/OrderController.java', content);
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
        const result = scanJavaKotlin('/src/ProductController.java', content);

        const expose = result.signals.find((s) => s.kind === 'expose');
        expect(expose?.symbol).toBe('/api/v1/products');
        expect(expose?.metadata).toMatchObject({ method: 'ANY', annotation: '@RequestMapping' });
    });

    // ─── HTTP 호출 패턴 ───────────────────────────────────────────────────────

    it('restTemplate.getForObject에서 call 신호를 추출해야 한다', () => {
        const content = `
String response = restTemplate.getForObject("http://payment-service/pay", String.class);
`;
        const result = scanJavaKotlin('/src/OrderService.java', content);

        const call = result.signals.find((s) => s.kind === 'call');
        expect(call?.symbol).toBe('http://payment-service/pay');
        expect(call?.confidence).toBeCloseTo(0.7);
        expect(call?.metadata).toMatchObject({ client: 'RestTemplate' });
    });

    it('webClient.get().uri에서 call 신호를 추출해야 한다', () => {
        const content = `
webClient.get().uri("http://inventory-service/stock").retrieve();
`;
        const result = scanJavaKotlin('/src/InventoryClient.java', content);

        const call = result.signals.find((s) => s.kind === 'call');
        expect(call?.symbol).toBe('http://inventory-service/stock');
        expect(call?.metadata).toMatchObject({ client: 'WebClient' });
    });

    it('@FeignClient(name = "service")에서 call 신호를 추출해야 한다', () => {
        const content = `
@FeignClient(name = "payment-service", url = "http://payment:8080")
public interface PaymentClient {}
`;
        const result = scanJavaKotlin('/src/PaymentClient.java', content);

        const call = result.signals.find((s) => s.kind === 'call');
        expect(call?.symbol).toBe('payment-service');
        expect(call?.metadata).toMatchObject({ client: 'FeignClient' });
    });

    it('restClient.get().uri에서 call 신호를 추출해야 한다 (RestClient, Spring 6.1+)', () => {
        const content = `
restClient.get().uri("http://inventory-service/stock").retrieve();
`;
        const result = scanJavaKotlin('/src/InventoryClient.java', content);

        const call = result.signals.find((s) => s.kind === 'call');
        expect(call?.symbol).toBe('http://inventory-service/stock');
        expect(call?.metadata).toMatchObject({ client: 'RestClient' });
    });

    it('RestClient.create("baseUrl")에서 call 신호를 추출해야 한다', () => {
        const content = `
RestClient restClient = RestClient.create("http://payment-service");
`;
        const result = scanJavaKotlin('/src/PaymentClient.java', content);

        const call = result.signals.find((s) => s.kind === 'call');
        expect(call?.symbol).toBe('http://payment-service');
        expect(call?.metadata).toMatchObject({ client: 'RestClient' });
    });

    it('@GetExchange에서 call 신호를 추출해야 한다 (HttpInterface, Spring 6+)', () => {
        const content = `
@GetExchange("/api/orders/{id}")
Order findById(@PathVariable Long id);
`;
        const result = scanJavaKotlin('/src/OrderClient.java', content);

        const call = result.signals.find((s) => s.kind === 'call');
        expect(call?.symbol).toBe('/api/orders/{id}');
        expect(call?.confidence).toBeCloseTo(0.8);
        expect(call?.metadata).toMatchObject({ client: 'HttpInterface', method: 'GET', annotation: '@GetExchange' });
    });

    it('@PostExchange/@PutExchange/@DeleteExchange/@PatchExchange에서 call 신호를 추출해야 한다', () => {
        const content = `
@PostExchange("/api/orders")
Order create(@RequestBody Order order);

@PutExchange("/api/orders/{id}")
Order update(@PathVariable Long id, @RequestBody Order order);

@DeleteExchange("/api/orders/{id}")
void delete(@PathVariable Long id);

@PatchExchange("/api/orders/{id}/status")
Order patch(@PathVariable Long id);
`;
        const result = scanJavaKotlin('/src/OrderClient.java', content);
        const callSignals = result.signals.filter((s) => s.kind === 'call');

        expect(callSignals).toHaveLength(4);
        const methods = callSignals.map((s) => s.metadata['method']);
        expect(methods).toContain('POST');
        expect(methods).toContain('PUT');
        expect(methods).toContain('DELETE');
        expect(methods).toContain('PATCH');
    });

    // ─── Kafka 패턴 ───────────────────────────────────────────────────────────

    it('kafkaTemplate.send에서 produce 신호를 추출해야 한다', () => {
        const content = `
kafkaTemplate.send("order.created", orderEvent);
`;
        const result = scanJavaKotlin('/src/OrderEventPublisher.java', content);

        const produce = result.signals.find((s) => s.kind === 'produce');
        expect(produce?.symbol).toBe('order.created');
        expect(produce?.confidence).toBeCloseTo(0.7);
        expect(produce?.metadata).toMatchObject({ client: 'KafkaTemplate' });
    });

    it('@KafkaListener(topics = "topic")에서 consume 신호를 추출해야 한다', () => {
        const content = `
@KafkaListener(topics = "payment.completed", groupId = "order-group")
public void handlePayment(String message) {}
`;
        const result = scanJavaKotlin('/src/PaymentListener.java', content);

        const consume = result.signals.find((s) => s.kind === 'consume');
        expect(consume?.symbol).toBe('payment.completed');
        expect(consume?.confidence).toBeCloseTo(0.8);
        expect(consume?.metadata).toMatchObject({ annotation: '@KafkaListener' });
    });

    it('@KafkaListener 다중 토픽 배열에서 consume 신호를 모두 추출해야 한다', () => {
        const content = `
@KafkaListener(topics = {"order.created", "payment.completed"})
public void handle(String message) {}
`;
        const result = scanJavaKotlin('/src/PaymentListener.java', content);
        const consume = result.signals.filter((s) => s.kind === 'consume');
        expect(consume).toHaveLength(2);
        expect(consume.map((s) => s.symbol)).toContain('order.created');
        expect(consume.map((s) => s.symbol)).toContain('payment.completed');
    });

    // ─── RabbitMQ 패턴 ───────────────────────────────────────────────────────

    it('@RabbitListener(queues = \"queue\")에서 consume 신호를 추출해야 한다', () => {
        const content = `
@RabbitListener(queues = "email.queue")
public void handle(String message) {}
`;
        const result = scanJavaKotlin('/src/EmailListener.java', content);
        const consume = result.signals.find((s) => s.kind === 'consume');
        expect(consume?.symbol).toBe('email.queue');
        expect(consume?.confidence).toBeCloseTo(0.8);
        expect(consume?.metadata).toMatchObject({ annotation: '@RabbitListener', broker: 'rabbitmq', channelType: 'queue' });
    });

    it('@RabbitListener 다중 큐 배열에서 consume 신호를 모두 추출해야 한다', () => {
        const content = `
@RabbitListener(queues = {"q1", "q2"})
public void handle(String message) {}
`;
        const result = scanJavaKotlin('/src/EmailListener.java', content);
        const consume = result.signals.filter((s) => s.kind === 'consume');
        expect(consume).toHaveLength(2);
        expect(consume.map((s) => s.symbol)).toContain('q1');
        expect(consume.map((s) => s.symbol)).toContain('q2');
    });

    it('rabbitTemplate.convertAndSend에서 produce 신호를 추출해야 한다', () => {
        const content = `
rabbitTemplate.convertAndSend("email.queue", payload);
`;
        const result = scanJavaKotlin('/src/EmailPublisher.java', content);
        const produce = result.signals.find((s) => s.kind === 'produce');
        expect(produce?.symbol).toBe('email.queue');
        expect(produce?.confidence).toBeCloseTo(0.7);
        expect(produce?.metadata).toMatchObject({ client: 'RabbitTemplate', broker: 'rabbitmq', channelType: 'queue' });
    });

    // ─── JPA 패턴 ─────────────────────────────────────────────────────────────

    it('@Table(name = "table_name")에서 db_mapping 신호를 추출해야 한다', () => {
        const content = `
@Entity
@Table(name = "orders")
public class Order {}
`;
        const result = scanJavaKotlin('/src/Order.java', content);

        const mapping = result.signals.find((s) => s.kind === 'db_mapping');
        expect(mapping?.symbol).toBe('orders');
        expect(mapping?.confidence).toBeCloseTo(0.7);
        expect(mapping?.metadata).toMatchObject({ annotation: '@Table' });
    });

    // ─── 복합 패턴 / 엣지 케이스 ─────────────────────────────────────────────

    it('여러 신호가 있는 파일에서 모두 추출해야 한다', () => {
        const content = `
package com.example.order;
@GetMapping("/api/orders")
public class OrderController {
    String result = restTemplate.getForObject("http://payment/pay", String.class);
    @Table(name = "orders") class Order {}
}
`;
        const result = scanJavaKotlin('/src/OrderController.java', content);
        expect(result.signals.length).toBeGreaterThanOrEqual(3);

        const kinds = result.signals.map((s) => s.kind);
        expect(kinds).toContain('expose');
        expect(kinds).toContain('call');
        expect(kinds).toContain('db_mapping');
    });

    it('빈 파일은 빈 signals 배열을 반환해야 한다', () => {
        const result = scanJavaKotlin('/src/Empty.java', '');
        expect(result.signals).toHaveLength(0);
        expect(result.packageName).toBeUndefined();
    });

    it('Kotlin 파일은 language가 kotlin이어야 한다', () => {
        const content = `package com.example\n@GetMapping("/api")\nfun handle() {}`;
        const result = scanJavaKotlin('/src/Controller.kt', content);
        expect(result.language).toBe('kotlin');
    });
});

// ─── MyBatis XML 스캐너 ───────────────────────────────────────────────────────

describe('scanMyBatisXml', () => {
    it('SELECT SQL에서 db_read 신호를 추출해야 한다', () => {
        const content = `
<?xml version="1.0" encoding="UTF-8"?>
<mapper namespace="com.example.mapper.OrderMapper">
    <select id="findById" resultType="Order">
        SELECT * FROM orders WHERE id = #{id}
    </select>
</mapper>
`;
        const result = scanMyBatisXml('/mapper/OrderMapper.xml', content);

        expect(result.packageName).toBe('com.example.mapper.OrderMapper');
        const dbRead = result.signals.find((s) => s.kind === 'db_read');
        expect(dbRead).toBeDefined();
        expect(dbRead?.symbol).toBe('orders');
        expect(dbRead?.confidence).toBeCloseTo(0.8);
    });

    it('INSERT SQL에서 db_write 신호를 추출해야 한다', () => {
        const content = `
<mapper namespace="com.example.mapper.OrderMapper">
    <insert id="insert">
        INSERT INTO order_items (id, name, qty) VALUES (#{id}, #{name}, #{qty})
    </insert>
    <update id="update">
        UPDATE order_items SET status = #{status} WHERE id = #{id}
    </update>
    <delete id="delete">
        DELETE FROM order_items WHERE id = #{id}
    </delete>
</mapper>
`;
        const result = scanMyBatisXml('/mapper/OrderMapper.xml', content);
        const dbWriteSignals = result.signals.filter((s) => s.kind === 'db_write');

        expect(dbWriteSignals.length).toBeGreaterThanOrEqual(1);
        const symbols = dbWriteSignals.map((s) => s.symbol);
        expect(symbols).toContain('order_items');
    });

    it('JOIN이 있는 SELECT에서 여러 테이블을 추출해야 한다', () => {
        const content = `
<mapper namespace="com.example.mapper.OrderMapper">
    <select id="findWithItems">
        SELECT o.*, i.name
        FROM orders o
        JOIN order_items i ON o.id = i.order_id
        WHERE o.id = #{id}
    </select>
</mapper>
`;
        const result = scanMyBatisXml('/mapper/OrderMapper.xml', content);
        const dbReadSignals = result.signals.filter((s) => s.kind === 'db_read');

        const symbols = dbReadSignals.map((s) => s.symbol);
        expect(symbols).toContain('orders');
        expect(symbols).toContain('order_items');
    });

    it('한 줄 태그(select/insert)가 닫히는 경우도 신호를 추출해야 한다', () => {
        const content = `
<mapper namespace="com.example.mapper.InlineMapper">
  <select id="find">SELECT * FROM users</select>
  <insert id="insert">INSERT INTO users (id, name) VALUES (#{id}, #{name})</insert>
</mapper>
`;
        const result = scanMyBatisXml('/mapper/InlineMapper.xml', content);
        const read = result.signals.filter((s) => s.kind === 'db_read');
        const write = result.signals.filter((s) => s.kind === 'db_write');
        expect(read.map((s) => s.symbol)).toContain('users');
        expect(write.map((s) => s.symbol)).toContain('users');
    });

    it('namespace가 없으면 packageName 없이 결과를 반환해야 한다', () => {
        const content = `
<mapper>
  <select id="find">SELECT * FROM users</select>
</mapper>
`;
        const result = scanMyBatisXml('/mapper/NoNamespace.xml', content);
        expect(result.packageName).toBeUndefined();
        expect(result.signals.length).toBeGreaterThan(0);
    });
});
