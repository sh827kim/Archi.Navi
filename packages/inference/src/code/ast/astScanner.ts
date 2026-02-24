/**
 * AST 스캐너 공통 유틸리티
 * Phase 2: tree-sitter 기반 정밀 추출
 *
 * web-tree-sitter (WASM) 전환 완료 — BUILD-C1
 * W-7.2: findNodes 재귀+spread → 반복(iterative) 방식으로 스택오버플로우 해소
 * W-7.3: Python triple-quote 문자열 처리 수정
 *
 * 설계 참조: docs/03-inference-engine.md §6.2 Phase 2 AST 기반 정밀 추출
 */

import type { SyntaxNode } from 'web-tree-sitter';
import type { ExtractedSignal } from '../codeSignalExtractor';

// ─── AST 순회 유틸리티 ────────────────────────────────────────────────────────

/**
 * AST 노드를 반복(iterative) 순회하여 특정 타입의 노드 목록 반환.
 * W-7.2: 재귀 + spread 방식에서 스택 기반 반복으로 전환하여
 * 대형 파일에서 스택 오버플로우 위험 해소.
 */
export function findNodes(node: SyntaxNode, type: string): SyntaxNode[] {
    const results: SyntaxNode[] = [];
    const stack: SyntaxNode[] = [node];

    while (stack.length > 0) {
        const current = stack.pop()!;
        if (current.type === type) results.push(current);
        // 자식을 역순으로 push하여 원래 순회 순서 유지 (DFS pre-order)
        for (let i = current.childCount - 1; i >= 0; i--) {
            const child = current.child(i);
            if (child) stack.push(child);
        }
    }

    return results;
}

/**
 * 자식 노드 중 특정 타입의 첫 번째 노드 반환
 * web-tree-sitter는 children 배열 대신 child(i) 인덱스 접근 사용
 */
export function findChildByType(node: SyntaxNode, type: string): SyntaxNode | null {
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === type) return child;
    }
    return null;
}

/**
 * 노드의 모든 자식을 배열로 반환 (web-tree-sitter 호환 헬퍼)
 */
export function getChildren(node: SyntaxNode): SyntaxNode[] {
    const children: SyntaxNode[] = [];
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) children.push(child);
    }
    return children;
}

/**
 * 문자열 리터럴 노드에서 실제 문자열 값 추출
 * (따옴표, 백틱 제거)
 */
export function extractStringValue(node: SyntaxNode): string | null {
    const text = node.text;
    if (!text) return null;

    // W-7.3: Python triple-quote 우선 체크 ("""...""" 또는 '''...''')
    if (
        (text.startsWith('"""') && text.endsWith('"""')) ||
        (text.startsWith("'''") && text.endsWith("'''"))
    ) {
        return text.slice(3, -3);
    }

    // Java/Python: "value" 또는 'value'
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
