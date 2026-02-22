/**
 * Java/Kotlin AST 스캐너 (Phase 2)
 * tree-sitter 기반 정밀 추출로 Phase 1 대비 다음을 개선:
 *  - 변수/상수로 지정된 URL 추적 (data-flow analysis)
 *  - 멀티라인 어노테이션 정확 추출
 *  - confidence +0.1~0.2 상향
 *
 * 설계 참조: docs/03-inference-engine.md §6.2 Phase 2
 */
import { createHash } from 'crypto';
import Parser from 'tree-sitter';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const JavaGrammar = require('tree-sitter-java') as Parser.Language;
import type { SyntaxNode } from 'tree-sitter';
import type { ExtractedSignal, FileScanResult } from '../codeSignalExtractor';
import {
    findNodes,
    findChildByType,
    extractStringValue,
    makeSignal,
    MAPPING_ANNOTATIONS,
    EXCHANGE_ANNOTATIONS,
    type VariableMap,
} from './astScanner';

// ─── 파서 인스턴스 (재사용) ────────────────────────────────────────────────────

let _parser: Parser | null = null;

function getParser(): Parser {
    if (!_parser) {
        _parser = new Parser();
        _parser.setLanguage(JavaGrammar);
    }
    return _parser;
}

// ─── 변수 추적 (Data-Flow) ─────────────────────────────────────────────────────

/**
 * AST에서 문자열 변수 선언 맵 구축
 * String URL = "..." 또는 private static final String URL = "..." 형태 추적
 */
function buildVariableMap(root: SyntaxNode): VariableMap {
    const map: VariableMap = new Map();

    // local_variable_declaration과 field_declaration 모두 처리
    const varDecls = [
        ...findNodes(root, 'local_variable_declaration'),
        ...findNodes(root, 'field_declaration'),
    ];

    for (const decl of varDecls) {
        // type이 String인 것만 추적
        const typeNode = decl.children.find(
            (c) => c.type === 'type_identifier' && c.text === 'String',
        );
        if (!typeNode) continue;

        const declarator = findChildByType(decl, 'variable_declarator');
        if (!declarator) continue;

        const nameNode = declarator.children.find((c) => c.type === 'identifier');
        const valueNode = declarator.children.find((c) => c.type === 'string_literal');

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
 * - string_literal: 직접 값 반환
 * - identifier: 변수 맵에서 조회
 */
function resolveStringArg(argNode: SyntaxNode, varMap: VariableMap): string | null {
    if (argNode.type === 'string_literal') {
        return extractStringValue(argNode);
    }
    if (argNode.type === 'identifier') {
        return varMap.get(argNode.text) ?? null;
    }
    return null;
}

/**
 * argument_list에서 첫 번째 실질적인 인수 노드 반환
 */
function getFirstArg(argList: SyntaxNode): SyntaxNode | null {
    return (
        argList.children.find(
            (c) => c.type !== '(' && c.type !== ')' && c.type !== ',' && c.type !== ' ',
        ) ?? null
    );
}

// ─── 어노테이션 분석 ───────────────────────────────────────────────────────────

/**
 * annotation 노드에서 element_value_pair(key=value) 맵 추출
 */
function extractAnnotationArgs(annArgList: SyntaxNode): Map<string, SyntaxNode> {
    const result = new Map<string, SyntaxNode>();
    for (const child of annArgList.children) {
        if (child.type === 'element_value_pair') {
            const key = child.children.find((c) => c.type === 'identifier');
            const value = child.children.find(
                (c) => c.type !== 'identifier' && c.type !== '=' && c.type.trim() !== '',
            );
            if (key && value) {
                result.set(key.text, value);
            }
        }
    }
    return result;
}

/**
 * element_value_array_initializer에서 첫 번째 string_literal 추출
 */
function extractFirstFromArray(arrayNode: SyntaxNode): string | null {
    const firstString = arrayNode.children.find((c) => c.type === 'string_literal');
    return firstString ? extractStringValue(firstString) : null;
}

// ─── @Mapping 어노테이션 처리 ──────────────────────────────────────────────────

function processSpringMappingAnnotations(
    root: SyntaxNode,
    signals: ExtractedSignal[],
): void {
    const annotations = findNodes(root, 'annotation');

    for (const ann of annotations) {
        const nameNode = ann.children.find((c) => c.type === 'identifier');
        if (!nameNode) continue;

        const annName = nameNode.text;

        // @GetMapping/@PostMapping/... 처리
        if (annName in MAPPING_ANNOTATIONS) {
            const method = MAPPING_ANNOTATIONS[annName] ?? 'ANY';
            const argList = findChildByType(ann, 'annotation_argument_list');

            let path: string | null = null;

            if (argList) {
                // @RequestMapping(value = "/path") 또는 @GetMapping("/path")
                const args = extractAnnotationArgs(argList);
                const valueNode = args.get('value') ?? args.get('path');
                if (valueNode) {
                    if (valueNode.type === 'string_literal') {
                        path = extractStringValue(valueNode);
                    } else if (valueNode.type === 'element_value_array_initializer') {
                        path = extractFirstFromArray(valueNode);
                    }
                } else {
                    // 단순 @GetMapping("/path") 형태
                    const firstString = argList.children.find((c) => c.type === 'string_literal');
                    if (firstString) path = extractStringValue(firstString);
                }
            }

            if (path) {
                signals.push(
                    makeSignal({
                        kind: 'expose',
                        symbol: path,
                        lineStart: ann.startPosition.row + 1,
                        lineEnd: ann.endPosition.row + 1,
                        excerpt: ann.text.split('\n')[0] ?? ann.text,
                        confidence: 0.95, // Phase 1: 0.8 → Phase 2: 0.95
                        metadata: { method, annotation: `@${annName}` },
                    }),
                );
            }
        }

        // @GetExchange/@PostExchange/... (Spring HttpInterface) 처리
        if (annName in EXCHANGE_ANNOTATIONS) {
            const method = EXCHANGE_ANNOTATIONS[annName] ?? 'ANY';
            const argList = findChildByType(ann, 'annotation_argument_list');

            let path: string | null = null;
            if (argList) {
                const firstString = argList.children.find((c) => c.type === 'string_literal');
                if (firstString) path = extractStringValue(firstString);
            }

            if (path) {
                signals.push(
                    makeSignal({
                        kind: 'call',
                        symbol: path,
                        lineStart: ann.startPosition.row + 1,
                        lineEnd: ann.endPosition.row + 1,
                        excerpt: ann.text.split('\n')[0] ?? ann.text,
                        confidence: 0.9, // Phase 1: 0.8 → Phase 2: 0.9
                        metadata: {
                            client: 'HttpInterface',
                            method,
                            annotation: `@${annName}`,
                        },
                    }),
                );
            }
        }

        // @FeignClient(name = "service") 처리
        if (annName === 'FeignClient') {
            const argList = findChildByType(ann, 'annotation_argument_list');
            if (!argList) continue;

            const args = extractAnnotationArgs(argList);
            const nameValueNode = args.get('name');

            if (nameValueNode?.type === 'string_literal') {
                const serviceName = extractStringValue(nameValueNode);
                if (serviceName) {
                    signals.push(
                        makeSignal({
                            kind: 'call',
                            symbol: serviceName,
                            lineStart: ann.startPosition.row + 1,
                            lineEnd: ann.endPosition.row + 1,
                            excerpt: ann.text.split('\n')[0] ?? ann.text,
                            confidence: 0.9, // Phase 1: 0.7 → Phase 2: 0.9
                            metadata: { client: 'FeignClient' },
                        }),
                    );
                }
            }
        }

        // @KafkaListener(topics = "topic") 처리
        if (annName === 'KafkaListener') {
            const argList = findChildByType(ann, 'annotation_argument_list');
            if (!argList) continue;

            const args = extractAnnotationArgs(argList);
            const topicsNode = args.get('topics');
            if (!topicsNode) continue;

            let topic: string | null = null;
            if (topicsNode.type === 'string_literal') {
                topic = extractStringValue(topicsNode);
            } else if (topicsNode.type === 'element_value_array_initializer') {
                topic = extractFirstFromArray(topicsNode);
            }

            if (topic) {
                signals.push(
                    makeSignal({
                        kind: 'consume',
                        symbol: topic,
                        lineStart: ann.startPosition.row + 1,
                        lineEnd: ann.endPosition.row + 1,
                        excerpt: ann.text.split('\n')[0] ?? ann.text,
                        confidence: 0.95, // Phase 1: 0.8 → Phase 2: 0.95
                        metadata: { annotation: '@KafkaListener' },
                    }),
                );
            }
        }

        // @Table(name = "table_name") 처리
        if (annName === 'Table') {
            const argList = findChildByType(ann, 'annotation_argument_list');
            if (!argList) continue;

            const args = extractAnnotationArgs(argList);
            const nameNode2 = args.get('name');
            if (nameNode2?.type === 'string_literal') {
                const tableName = extractStringValue(nameNode2);
                if (tableName) {
                    signals.push(
                        makeSignal({
                            kind: 'db_mapping',
                            symbol: tableName,
                            lineStart: ann.startPosition.row + 1,
                            lineEnd: ann.endPosition.row + 1,
                            excerpt: ann.text.split('\n')[0] ?? ann.text,
                            confidence: 0.9, // Phase 1: 0.7 → Phase 2: 0.9
                            metadata: { annotation: '@Table' },
                        }),
                    );
                }
            }
        }
    }
}

// ─── 메서드 호출 처리 ───────────────────────────────────────────────────────────

function processMethodInvocations(
    root: SyntaxNode,
    varMap: VariableMap,
    signals: ExtractedSignal[],
): void {
    const methodInvocations = findNodes(root, 'method_invocation');

    for (const mi of methodInvocations) {
        const children = mi.children;
        // 구조: [identifier|member_access, ., identifier, argument_list]
        // 또는 [object, ., method, argument_list]
        const objectNode = children[0];
        const methodNameNode = children.find((c, i) => i > 0 && c.type === 'identifier');
        const argList = findChildByType(mi, 'argument_list');

        if (!objectNode || !methodNameNode || !argList) continue;

        const objectName = objectNode.text;
        const methodName = methodNameNode.text;

        // restTemplate.*(url, ...) 처리
        if (/^restTemplate$/i.test(objectName)) {
            const firstArg = getFirstArg(argList);
            if (firstArg) {
                const url = resolveStringArg(firstArg, varMap);
                if (url) {
                    signals.push(
                        makeSignal({
                            kind: 'call',
                            symbol: url,
                            lineStart: mi.startPosition.row + 1,
                            lineEnd: mi.endPosition.row + 1,
                            excerpt: mi.text.split('\n')[0] ?? mi.text,
                            confidence: 0.9, // Phase 1: 0.7 → Phase 2: 0.9 (변수 추적 포함)
                            metadata: { client: 'RestTemplate', method: methodName },
                        }),
                    );
                }
            }
        }

        // webClient.*(). uri(url) 처리 - 체인 메서드 중 uri() 호출 탐색
        if (methodName === 'uri' && /^webClient$/i.test(objectNode.text.split('.')[0] ?? '')) {
            const firstArg = getFirstArg(argList);
            if (firstArg) {
                const url = resolveStringArg(firstArg, varMap);
                if (url) {
                    signals.push(
                        makeSignal({
                            kind: 'call',
                            symbol: url,
                            lineStart: mi.startPosition.row + 1,
                            lineEnd: mi.endPosition.row + 1,
                            excerpt: mi.text.split('\n')[0] ?? mi.text,
                            confidence: 0.9, // Phase 1: 0.7 → Phase 2: 0.9
                            metadata: { client: 'WebClient', method: methodName },
                        }),
                    );
                }
            }
        }

        // restClient.*(). uri(url) 처리
        if (methodName === 'uri' && /^restClient$/i.test(objectNode.text.split('.')[0] ?? '')) {
            const firstArg = getFirstArg(argList);
            if (firstArg) {
                const url = resolveStringArg(firstArg, varMap);
                if (url) {
                    signals.push(
                        makeSignal({
                            kind: 'call',
                            symbol: url,
                            lineStart: mi.startPosition.row + 1,
                            lineEnd: mi.endPosition.row + 1,
                            excerpt: mi.text.split('\n')[0] ?? mi.text,
                            confidence: 0.9, // Phase 1: 0.7 → Phase 2: 0.9
                            metadata: { client: 'RestClient', method: methodName },
                        }),
                    );
                }
            }
        }

        // RestClient.create("baseUrl") 처리
        if (objectName === 'RestClient' && methodName === 'create') {
            const firstArg = getFirstArg(argList);
            if (firstArg) {
                const url = resolveStringArg(firstArg, varMap);
                if (url) {
                    signals.push(
                        makeSignal({
                            kind: 'call',
                            symbol: url,
                            lineStart: mi.startPosition.row + 1,
                            lineEnd: mi.endPosition.row + 1,
                            excerpt: mi.text.split('\n')[0] ?? mi.text,
                            confidence: 0.9,
                            metadata: { client: 'RestClient', method: 'create' },
                        }),
                    );
                }
            }
        }

        // kafkaTemplate.send("topic", ...) 처리
        if (/^kafkaTemplate$/i.test(objectName) && methodName === 'send') {
            const firstArg = getFirstArg(argList);
            if (firstArg) {
                const topic = resolveStringArg(firstArg, varMap);
                if (topic) {
                    signals.push(
                        makeSignal({
                            kind: 'produce',
                            symbol: topic,
                            lineStart: mi.startPosition.row + 1,
                            lineEnd: mi.endPosition.row + 1,
                            excerpt: mi.text.split('\n')[0] ?? mi.text,
                            confidence: 0.9, // Phase 1: 0.7 → Phase 2: 0.9
                            metadata: { client: 'KafkaTemplate' },
                        }),
                    );
                }
            }
        }
    }
}

// ─── 패키지명 추출 ────────────────────────────────────────────────────────────

function extractPackageName(root: SyntaxNode): string | undefined {
    const packageDecls = findNodes(root, 'package_declaration');
    if (packageDecls.length === 0) return undefined;
    const decl = packageDecls[0];
    // package_declaration: [package, identifier|scoped_identifier, ;]
    const nameNode = decl?.children.find(
        (c) => c.type === 'scoped_identifier' || (c.type === 'identifier' && c.text !== 'package'),
    );
    return nameNode?.text;
}

// ─── 공개 스캐너 함수 ────────────────────────────────────────────────────────

/**
 * Java/Kotlin 소스 파일에서 AST 기반 신호 추출 (Phase 2)
 * @param filePath - 파일 절대 경로
 * @param content - 파일 내용
 */
export function scanJavaKotlinAst(filePath: string, content: string): FileScanResult {
    const sha256 = createHash('sha256').update(content).digest('hex');
    const language = filePath.endsWith('.kt') ? 'kotlin' : 'java';

    const parser = getParser();
    const tree = parser.parse(content);
    const root = tree.rootNode;

    const packageName = extractPackageName(root);
    const varMap = buildVariableMap(root);
    const signals: ExtractedSignal[] = [];

    processSpringMappingAnnotations(root, signals);
    processMethodInvocations(root, varMap, signals);

    const result: FileScanResult = packageName
        ? { language, sha256, packageName, signals }
        : { language, sha256, signals };

    return result;
}
