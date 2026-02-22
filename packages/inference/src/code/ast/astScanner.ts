/**
 * AST 스캐너 공통 유틸리티
 * Phase 2: tree-sitter 기반 정밀 추출
 *
 * 설계 참조: docs/03-inference-engine.md §6.2 Phase 2 AST 기반 정밀 추출
 */

import type { SyntaxNode } from 'tree-sitter';
import type { ExtractedSignal } from '../codeSignalExtractor';

// ─── AST 순회 유틸리티 ────────────────────────────────────────────────────────

/**
 * AST 노드를 재귀 순회하여 특정 타입의 노드 목록 반환
 */
export function findNodes(node: SyntaxNode, type: string): SyntaxNode[] {
    const results: SyntaxNode[] = [];
    if (node.type === type) results.push(node);
    for (const child of node.children) {
        results.push(...findNodes(child, type));
    }
    return results;
}

/**
 * 여러 타입 중 하나에 해당하는 노드 목록 반환
 */
export function findNodesByTypes(node: SyntaxNode, types: string[]): SyntaxNode[] {
    const typeSet = new Set(types);
    const results: SyntaxNode[] = [];
    if (typeSet.has(node.type)) results.push(node);
    for (const child of node.children) {
        results.push(...findNodesByTypes(child, types));
    }
    return results;
}

/**
 * 자식 노드 중 특정 타입의 첫 번째 노드 반환
 */
export function findChildByType(node: SyntaxNode, type: string): SyntaxNode | null {
    return node.children.find((c) => c.type === type) ?? null;
}

/**
 * 문자열 리터럴 노드에서 실제 문자열 값 추출
 * (따옴표, 백틱 제거)
 */
export function extractStringValue(node: SyntaxNode): string | null {
    const text = node.text;
    if (!text) return null;

    // Java: "value" 또는 'value'
    if (
        (text.startsWith('"') && text.endsWith('"')) ||
        (text.startsWith("'") && text.endsWith("'"))
    ) {
        return text.slice(1, -1);
    }

    // TypeScript/JS: template literal `value`
    if (text.startsWith('`') && text.endsWith('`')) {
        // 간단한 템플릿 리터럴 (보간 없는 경우만)
        const inner = text.slice(1, -1);
        if (!inner.includes('${')) return inner;
        return null; // 동적 보간이 있으면 null (추적 불가)
    }

    return null;
}

// ─── 변수 추적 (Data-Flow Analysis) ──────────────────────────────────────────

/**
 * 단순 변수-값 맵 (스코프 미고려 버전)
 * Phase 2: URL/topic이 상수로 선언된 경우를 추적
 */
export type VariableMap = Map<string, string>;

// ─── 신호 생성 헬퍼 ──────────────────────────────────────────────────────────

export interface AstSignalInput {
    kind: ExtractedSignal['kind'];
    symbol: string;
    lineStart: number;
    lineEnd: number;
    excerpt: string;
    /** Phase 2 기본 confidence (Phase 1 대비 +0.1~0.2 상향) */
    confidence: number;
    metadata: Record<string, unknown>;
}

/**
 * AST 기반 신호 생성 (Phase 1 대비 confidence +0.1~0.2 적용됨)
 */
export function makeSignal(input: AstSignalInput): ExtractedSignal {
    return {
        kind: input.kind,
        symbol: input.symbol,
        lineStart: input.lineStart,
        lineEnd: input.lineEnd,
        excerpt: input.excerpt,
        confidence: input.confidence,
        metadata: { ...input.metadata, phase: 2 },
    };
}

// ─── Spring 어노테이션 관련 헬퍼 (Java/Kotlin 공통) ─────────────────────────

/** HTTP 메서드 매핑 어노테이션 이름 → HTTP 메서드 */
export const MAPPING_ANNOTATIONS: Record<string, string> = {
    GetMapping: 'GET',
    PostMapping: 'POST',
    PutMapping: 'PUT',
    DeleteMapping: 'DELETE',
    PatchMapping: 'PATCH',
    RequestMapping: 'ANY',
};

/** Spring HttpInterface Exchange 어노테이션 이름 → HTTP 메서드 */
export const EXCHANGE_ANNOTATIONS: Record<string, string> = {
    GetExchange: 'GET',
    PostExchange: 'POST',
    PutExchange: 'PUT',
    DeleteExchange: 'DELETE',
    PatchExchange: 'PATCH',
};
