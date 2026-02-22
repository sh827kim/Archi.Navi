/**
 * Python AST 스캐너 (Phase 2)
 * tree-sitter 기반 정밀 추출로 Phase 1 대비 다음을 개선:
 *  - 변수/상수로 지정된 URL/토픽 추적 (data-flow analysis)
 *  - 데코레이터 인수 정밀 파싱 (keyword_argument 포함)
 *  - confidence +0.1~0.2 상향
 *
 * 설계 참조: docs/03-inference-engine.md §6.2 Phase 2
 */
import { createHash } from 'crypto';
import Parser from 'tree-sitter';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PythonGrammar = require('tree-sitter-python') as Parser.Language;
import type { SyntaxNode } from 'tree-sitter';
import type { ExtractedSignal, FileScanResult } from '../codeSignalExtractor';
import {
    findNodes,
    extractStringValue,
    makeSignal,
    type VariableMap,
} from './astScanner';

// ─── 파서 인스턴스 (재사용) ────────────────────────────────────────────────────

let _parser: Parser | null = null;

function getParser(): Parser {
    if (!_parser) {
        _parser = new Parser();
        _parser.setLanguage(PythonGrammar);
    }
    return _parser;
}

// ─── 변수 추적 (Data-Flow) ─────────────────────────────────────────────────────

/**
 * AST에서 문자열 변수 선언 맵 구축
 * BASE_URL = 'http://...' 또는 TOPIC = 'order.created' 형태 추적
 */
function buildVariableMap(root: SyntaxNode): VariableMap {
    const map: VariableMap = new Map();

    const assignments = findNodes(root, 'assignment');
    for (const assign of assignments) {
        const nameNode = assign.children.find((c) => c.type === 'identifier');
        const valueNode = assign.children.find((c) => c.type === 'string');

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
 * 인수 노드에서 URL/토픽 문자열 추출
 */
function resolveStringArg(argNode: SyntaxNode, varMap: VariableMap): string | null {
    if (argNode.type === 'string') {
        return extractStringValue(argNode);
    }
    if (argNode.type === 'identifier') {
        return varMap.get(argNode.text) ?? null;
    }
    // f-string은 동적 → 추적 불가
    if (argNode.type === 'f_string' || argNode.type === 'concatenated_string') {
        return null;
    }
    return null;
}

/**
 * argument_list에서 첫 번째 실질적인 인수 반환 (keyword_argument 제외)
 */
function getFirstPositionalArg(argList: SyntaxNode): SyntaxNode | null {
    return (
        argList.children.find(
            (c) =>
                c.type !== '(' &&
                c.type !== ')' &&
                c.type !== ',' &&
                c.type !== 'keyword_argument',
        ) ?? null
    );
}

/**
 * argument_list에서 특정 키워드 인수 값 반환
 * topic='value' 형태
 * keyword_argument 구조: [identifier(key), '=', string/identifier(value)]
 */
function getKeywordArg(argList: SyntaxNode, key: string): SyntaxNode | null {
    for (const child of argList.children) {
        if (child.type === 'keyword_argument') {
            const keyNode = child.children.find((c) => c.type === 'identifier');
            // 값 노드는 '=' 이후에 위치한 노드
            const eqIndex = child.children.findIndex((c) => c.type === '=');
            const valueNode =
                eqIndex >= 0
                    ? child.children[eqIndex + 1]
                    : child.children.find((c) => c.type !== 'identifier' && c.type !== '=');
            if (keyNode?.text === key && valueNode) {
                return valueNode;
            }
        }
    }
    return null;
}

// ─── 데코레이터 처리 ──────────────────────────────────────────────────────────

const FLASK_FASTAPI_HTTP_METHODS = new Set([
    'route', 'get', 'post', 'put', 'delete', 'patch', 'options',
]);

function processDecorators(
    root: SyntaxNode,
    varMap: VariableMap,
    signals: ExtractedSignal[],
): void {
    const decorators = findNodes(root, 'decorator');

    for (const dec of decorators) {
        // @app.route("/path") 또는 @app.get("/path") 형태
        const callNode = dec.children.find((c) => c.type === 'call');
        if (!callNode) continue;

        const funcNode = callNode.children[0];
        const argList = callNode.children.find((c) => c.type === 'argument_list');

        if (!funcNode || !argList) continue;

        // Flask/FastAPI: attribute = app.route 또는 app.get
        if (funcNode.type === 'attribute') {
            const attrChildren = funcNode.children;
            const attrMethod = attrChildren[attrChildren.length - 1];
            if (!attrMethod) continue;

            const methodName = attrMethod.text;

            if (FLASK_FASTAPI_HTTP_METHODS.has(methodName)) {
                const firstArg = getFirstPositionalArg(argList);
                if (firstArg) {
                    const path = resolveStringArg(firstArg, varMap);
                    if (path) {
                        // methods 키워드 인수에서 HTTP 메서드 추출
                        const methodsArg = argList.children.find(
                            (c) =>
                                c.type === 'keyword_argument' &&
                                c.children.some((gc) => gc.text === 'methods'),
                        );

                        let httpMethod: string;
                        if (methodName === 'route') {
                            httpMethod = methodsArg ? 'MULTI' : 'ANY';
                        } else {
                            httpMethod = methodName.toUpperCase();
                        }

                        signals.push(
                            makeSignal({
                                kind: 'expose',
                                symbol: path,
                                lineStart: dec.startPosition.row + 1,
                                lineEnd: dec.endPosition.row + 1,
                                excerpt: dec.text.split('\n')[0] ?? dec.text,
                                confidence: 0.9, // Phase 1: 0.8 → Phase 2: 0.9
                                metadata: {
                                    method: httpMethod,
                                    framework: 'flask/fastapi',
                                    via: attrChildren[0]?.text ?? '',
                                },
                            }),
                        );
                    }
                }
            }
        }

        // @kafka_consumer(topic='topic') 형태
        if (funcNode.type === 'identifier' && funcNode.text === 'kafka_consumer') {
            const topicNode = getKeywordArg(argList, 'topic');
            if (topicNode) {
                const topic = resolveStringArg(topicNode, varMap);
                if (topic) {
                    signals.push(
                        makeSignal({
                            kind: 'consume',
                            symbol: topic,
                            lineStart: dec.startPosition.row + 1,
                            lineEnd: dec.endPosition.row + 1,
                            excerpt: dec.text.split('\n')[0] ?? dec.text,
                            confidence: 0.9, // Phase 1: 0.8 → Phase 2: 0.9
                            metadata: { annotation: '@kafka_consumer' },
                        }),
                    );
                }
            }
        }
    }
}

// ─── 함수 호출 처리 ──────────────────────────────────────────────────────────

const REQUESTS_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'head', 'request']);

function processCallStatements(
    root: SyntaxNode,
    varMap: VariableMap,
    signals: ExtractedSignal[],
): void {
    const calls = findNodes(root, 'call');

    for (const call of calls) {
        const funcNode = call.children[0];
        const argList = call.children.find((c) => c.type === 'argument_list');

        if (!funcNode || !argList) continue;

        // requests.get/post/put/delete("url")
        if (funcNode.type === 'attribute') {
            const attrChildren = funcNode.children;
            const attrObj = attrChildren[0];
            const attrMethod = attrChildren[attrChildren.length - 1];

            if (!attrObj || !attrMethod) continue;

            const objName = attrObj.text;
            const methodName = attrMethod.text;

            if (objName === 'requests' && REQUESTS_METHODS.has(methodName)) {
                const firstArg = getFirstPositionalArg(argList);
                if (firstArg) {
                    const url = resolveStringArg(firstArg, varMap);
                    if (url) {
                        signals.push(
                            makeSignal({
                                kind: 'call',
                                symbol: url,
                                lineStart: call.startPosition.row + 1,
                                lineEnd: call.endPosition.row + 1,
                                excerpt: call.text.split('\n')[0] ?? call.text,
                                confidence: 0.85, // Phase 1: 0.7 → Phase 2: 0.85
                                metadata: {
                                    client: 'requests',
                                    method: methodName.toUpperCase(),
                                },
                            }),
                        );
                    }
                }
            }

            // producer.send("topic", ...) / KafkaProducer().send("topic")
            if (methodName === 'send' && /producer/i.test(objName)) {
                const firstArg = getFirstPositionalArg(argList);
                if (firstArg) {
                    const topic = resolveStringArg(firstArg, varMap);
                    if (topic) {
                        signals.push(
                            makeSignal({
                                kind: 'produce',
                                symbol: topic,
                                lineStart: call.startPosition.row + 1,
                                lineEnd: call.endPosition.row + 1,
                                excerpt: call.text.split('\n')[0] ?? call.text,
                                confidence: 0.85, // Phase 1: 0.7 → Phase 2: 0.85
                                metadata: { client: 'KafkaProducer' },
                            }),
                        );
                    }
                }
            }
        }
    }
}

// ─── 공개 스캐너 함수 ────────────────────────────────────────────────────────

/**
 * Python 소스 파일에서 AST 기반 신호 추출 (Phase 2)
 * @param filePath - 파일 절대 경로 (.py)
 * @param content - 파일 내용
 */
export function scanPythonAst(filePath: string, content: string): FileScanResult {
    void filePath; // filePath는 현재 미사용 (language는 항상 python)
    const sha256 = createHash('sha256').update(content).digest('hex');

    const parser = getParser();

    let tree;
    try {
        tree = parser.parse(content);
    } catch {
        return { language: 'python', sha256, signals: [] };
    }

    const root = tree.rootNode;
    const varMap = buildVariableMap(root);
    const signals: ExtractedSignal[] = [];

    processDecorators(root, varMap, signals);
    processCallStatements(root, varMap, signals);

    return { language: 'python', sha256, signals };
}
