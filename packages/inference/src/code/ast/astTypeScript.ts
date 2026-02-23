/**
 * TypeScript/JavaScript AST 스캐너 (Phase 2)
 * tree-sitter 기반 정밀 추출로 Phase 1 대비 다음을 개선:
 *  - 변수/상수로 지정된 URL 추적 (data-flow analysis)
 *  - Express/NestJS 라우트 패턴 정확 추출
 *  - confidence +0.1~0.2 상향
 *
 * 설계 참조: docs/03-inference-engine.md §6.2 Phase 2
 */
import { createHash } from 'crypto';
import type { SyntaxNode } from 'web-tree-sitter';
import type { ExtractedSignal, FileScanResult } from '../codeSignalExtractor';
import {
    findNodes,
    getChildren,
    extractStringValue,
    makeSignal,
    type VariableMap,
} from './astScanner';
import { getWasmParser } from './wasmParser';

// ─── 변수 추적 (Data-Flow) ─────────────────────────────────────────────────────

/**
 * AST에서 문자열 변수 선언 맵 구축
 * const/let/var URL = "..." 또는 const URL: string = "..." 형태 추적
 */
function buildVariableMap(root: SyntaxNode): VariableMap {
    const map: VariableMap = new Map();

    const varDeclarators = findNodes(root, 'variable_declarator');
    for (const decl of varDeclarators) {
        const children = getChildren(decl);
        const nameNode = children.find((c) => c.type === 'identifier');
        const valueNode = children.find(
            (c) => c.type === 'string' || c.type === 'string_literal',
        );

        if (nameNode && valueNode) {
            const strValue = extractStringValue(valueNode);
            if (strValue !== null) {
                map.set(nameNode.text, strValue);
            }
        }
    }

    return map;
}

/**
 * 인수 노드에서 URL 문자열 추출
 * - string/string_literal: 직접 값 반환
 * - identifier: 변수 맵에서 조회
 * - template_string: 정적 부분만 추출 (보간 없는 경우)
 */
function resolveStringArg(argNode: SyntaxNode, varMap: VariableMap): string | null {
    if (argNode.type === 'string' || argNode.type === 'string_literal') {
        return extractStringValue(argNode);
    }
    if (argNode.type === 'identifier') {
        return varMap.get(argNode.text) ?? null;
    }
    if (argNode.type === 'template_string') {
        return extractStringValue(argNode);
    }
    return null;
}

/**
 * arguments 노드에서 첫 번째 실질적인 인수 반환
 */
function getFirstArg(argsNode: SyntaxNode): SyntaxNode | null {
    return (
        getChildren(argsNode).find(
            (c) => c.type !== '(' && c.type !== ')' && c.type !== ',' && c.type !== ' ',
        ) ?? null
    );
}

// ─── Express 라우트 처리 ──────────────────────────────────────────────────────

const EXPRESS_HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'all']);

/**
 * call_expression 노드가 Express 라우터 메서드인지 확인하고 신호 생성
 * app.get("/path", handler) / router.post("/path", handler)
 */
function processCallExpression(
    ce: SyntaxNode,
    varMap: VariableMap,
    signals: ExtractedSignal[],
): void {
    const ceChildren = getChildren(ce);
    const funcNode = ceChildren[0];
    const argsNode = ceChildren.find((c) => c.type === 'arguments');

    if (!funcNode || !argsNode) return;

    // member_expression: obj.method
    if (funcNode.type === 'member_expression') {
        const memberChildren = getChildren(funcNode);
        const memberObj = memberChildren[0]; // app, router, etc.
        const dot = memberChildren[1];
        const memberMethod = memberChildren[2]; // get, post, etc.

        if (!memberObj || !dot || !memberMethod) return;

        const objName = memberObj.text;
        const methodName = memberMethod.text;

        // Express: (app|router).(get|post|put|delete|patch)("/path", ...)
        if (
            EXPRESS_HTTP_METHODS.has(methodName) &&
            /^(app|router|server)$/i.test(objName)
        ) {
            const firstArg = getFirstArg(argsNode);
            if (firstArg) {
                const path = resolveStringArg(firstArg, varMap);
                if (path) {
                    signals.push(
                        makeSignal({
                            kind: 'expose',
                            symbol: path,
                            lineStart: ce.startPosition.row + 1,
                            lineEnd: ce.endPosition.row + 1,
                            excerpt: ce.text.split('\n')[0] || ce.text,
                            confidence: 0.9, // Phase 1: 0.8 → Phase 2: 0.9
                            metadata: {
                                method: methodName.toUpperCase(),
                                framework: 'express',
                                via: objName,
                            },
                        }),
                    );
                    return;
                }
            }
        }

        // axios.get/post/put/delete("url")
        if (
            /^axios$/i.test(objName) &&
            (EXPRESS_HTTP_METHODS.has(methodName) || methodName === 'request')
        ) {
            const firstArg = getFirstArg(argsNode);
            if (firstArg) {
                const url = resolveStringArg(firstArg, varMap);
                if (url) {
                    signals.push(
                        makeSignal({
                            kind: 'call',
                            symbol: url,
                            lineStart: ce.startPosition.row + 1,
                            lineEnd: ce.endPosition.row + 1,
                            excerpt: ce.text.split('\n')[0] || ce.text,
                            confidence: 0.85, // Phase 1: 0.7 → Phase 2: 0.85
                            metadata: {
                                client: 'axios',
                                method: methodName.toUpperCase(),
                            },
                        }),
                    );
                    return;
                }
            }
        }

        // .get/.post/.put/.delete("url") 체인 (일반 HTTP 클라이언트)
        if (EXPRESS_HTTP_METHODS.has(methodName)) {
            const firstArg = getFirstArg(argsNode);
            if (firstArg) {
                const url = resolveStringArg(firstArg, varMap);
                if (url && (url.startsWith('/') || url.startsWith('http'))) {
                    // Express route는 이미 위에서 처리됨 → 중복 방지
                    const alreadyExpose = signals.some(
                        (s) =>
                            s.lineStart === ce.startPosition.row + 1 && s.kind === 'expose',
                    );
                    if (!alreadyExpose) {
                        signals.push(
                            makeSignal({
                                kind: 'call',
                                symbol: url,
                                lineStart: ce.startPosition.row + 1,
                                lineEnd: ce.endPosition.row + 1,
                                excerpt: ce.text.split('\n')[0] || ce.text,
                                confidence: 0.75, // Phase 1: 0.6 → Phase 2: 0.75
                                metadata: {
                                    method: methodName.toUpperCase(),
                                    client: 'http-chain',
                                },
                            }),
                        );
                    }
                    return;
                }
            }
        }

        return;
    }

    // 단순 함수 호출: fetch("url")
    if (funcNode.type === 'identifier') {
        const funcName = funcNode.text;

        if (funcName === 'fetch') {
            const firstArg = getFirstArg(argsNode);
            if (firstArg) {
                const url = resolveStringArg(firstArg, varMap);
                if (url) {
                    signals.push(
                        makeSignal({
                            kind: 'call',
                            symbol: url,
                            lineStart: ce.startPosition.row + 1,
                            lineEnd: ce.endPosition.row + 1,
                            excerpt: ce.text.split('\n')[0] || ce.text,
                            confidence: 0.85, // Phase 1: 0.7 → Phase 2: 0.85
                            metadata: { client: 'fetch' },
                        }),
                    );
                }
            }
        }
    }
}

// ─── 공개 스캐너 함수 ────────────────────────────────────────────────────────

/**
 * TypeScript/JavaScript 소스 파일에서 AST 기반 신호 추출 (Phase 2)
 * @param filePath - 파일 절대 경로 (.ts, .tsx, .js, .jsx)
 * @param content - 파일 내용
 */
export async function scanTypeScriptAst(filePath: string, content: string): Promise<FileScanResult> {
    const sha256 = createHash('sha256').update(content).digest('hex');

    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const language = ext === 'ts' || ext === 'tsx' ? 'typescript' : 'javascript';

    // web-tree-sitter: typescript grammar으로 TS/JS 모두 파싱
    const parser = await getWasmParser('typescript');

    let tree;
    try {
        tree = parser.parse(content);
    } catch {
        // 파싱 실패 시 빈 결과 반환
        return { language, sha256, signals: [] };
    }

    const root = tree.rootNode;
    const varMap = buildVariableMap(root);
    const signals: ExtractedSignal[] = [];

    const callExpressions = findNodes(root, 'call_expression');
    for (const ce of callExpressions) {
        processCallExpression(ce, varMap, signals);
    }

    return { language, sha256, signals };
}
