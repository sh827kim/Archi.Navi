/**
 * labelExtractor 단위 테스트
 * 순수 함수이므로 PGlite 불필요
 */
import { describe, it, expect } from 'vitest';
import { extractLabelCandidates } from '../../domain/labelExtractor.js';

describe('extractLabelCandidates', () => {
    it('T1: 빈 배열 입력 → 빈 배열 반환', () => {
        expect(extractLabelCandidates([])).toEqual([]);
    });

    it('T2: 단일 이름 "order-service" → "order" 최우선 (service 필터됨)', () => {
        const result = extractLabelCandidates(['order-service']);
        expect(result.length).toBeGreaterThan(0);
        expect(result[0]?.text).toBe('order');
        // "service" 는 STOP_WORDS → 결과에 없어야 함
        expect(result.map((c) => c.text)).not.toContain('service');
    });

    it('T3: 공통 prefix를 가진 여러 이름 → 공통 토큰 최우선', () => {
        const names = ['order-service', 'order-processor', 'order-api'];
        const result = extractLabelCandidates(names);
        expect(result[0]?.text).toBe('order');
    });

    it('T4: PascalCase "OrderManagement" → "order", "management" 포함', () => {
        const result = extractLabelCandidates(['OrderManagement']);
        const texts = result.map((c) => c.text);
        expect(texts).toContain('order');
        expect(texts).toContain('management');
    });

    it('T5: DB 테이블명 "order_items", "order_payments" → "order" 최우선', () => {
        const result = extractLabelCandidates(['order_items', 'order_payments']);
        expect(result[0]?.text).toBe('order');
    });

    it('T6: 토픽명 "order.created", "order.cancelled" → "order" 최우선', () => {
        const result = extractLabelCandidates(['order.created', 'order.cancelled']);
        expect(result[0]?.text).toBe('order');
    });

    it('T7: topN 제한 → 최대 3개 반환', () => {
        // 토큰이 5개 이상 등장하도록 구성
        const names = ['alpha-beta-gamma', 'delta-epsilon-alpha', 'beta-gamma-delta', 'alpha-epsilon'];
        const result = extractLabelCandidates(names, 3);
        expect(result.length).toBeLessThanOrEqual(3);
    });

    it('T8: score 정확성 → 총 토큰 대비 빈도 비율 (소수점 2자리)', () => {
        // "order-payment"  → ['order', 'payment'] (2 tokens)
        // "order"          → ['order']            (1 token)
        // totalCount = 3: order(2), payment(1)
        // order score = 2/3 ≈ 0.67, payment score = 1/3 ≈ 0.33
        const result = extractLabelCandidates(['order-payment', 'order']);
        const orderCandidate = result.find((c) => c.text === 'order');
        const paymentCandidate = result.find((c) => c.text === 'payment');

        expect(orderCandidate).toBeDefined();
        expect(orderCandidate?.score).toBeCloseTo(0.67, 2);

        expect(paymentCandidate).toBeDefined();
        expect(paymentCandidate?.score).toBeCloseTo(0.33, 2);
    });
});
