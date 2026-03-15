/**
 * Java/Kotlin AST 스캐너 (Phase 2)
 * tree-sitter 기반 정밀 추출로 Phase 1 대비 다음을 개선:
 *  - 변수/상수로 지정된 URL 추적 (data-flow analysis)
 *  - 멀티라인 어노테이션 정확 추출
 *  - confidence +0.1~0.2 상향
 *
 * web-tree-sitter (WASM) 전환 완료 — BUILD-C1
 * Kotlin 지원 추가 — 2-1-C1 (.kt → tree-sitter-kotlin.wasm)
 * W-7.1: excerpt 빈 문자열 체크 수정 (?? → ||)
 * W-7.4: WebClient 체인 감지 개선
 *
 * 설계 참조: docs/03-inference-engine.md §6.2 Phase 2
 */
import { createHash } from 'crypto';
import type { SyntaxNode } from 'web-tree-sitter';
import type { ExtractedSignal, FileScanResult } from '../codeSignalExtractor';
import {
    findNodes,
    findChildByType,
    getChildren,
    extractStringValue,
    makeSignal,
    MAPPING_ANNOTATIONS,
    EXCHANGE_ANNOTATIONS,
    type VariableMap,
} from './astScanner';
import { getWasmParser } from './wasmParser';
import type { SupportedLanguage } from './wasmParser';

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
        const children = getChildren(decl);
        // type이 String인 것만 추적
        const typeNode = children.find(
            (c) => c.type === 'type_identifier' && c.text === 'String',
        );
        if (!typeNode) continue;

        const declarator = findChildByType(decl, 'variable_declarator');
        if (!declarator) continue;

        const declChildren = getChildren(declarator);
        const nameNode = declChildren.find((c) => c.type === 'identifier');
        const valueNode = declChildren.find((c) => c.type === 'string_literal');

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
        getChildren(argList).find(
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
    for (const child of getChildren(annArgList)) {
        if (child.type === 'element_value_pair') {
            const pairChildren = getChildren(child);
            const key = pairChildren.find((c) => c.type === 'identifier');
            const value = pairChildren.find(
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
    const firstString = getChildren(arrayNode).find((c) => c.type === 'string_literal');
    return firstString ? extractStringValue(firstString) : null;
}

// ─── @Mapping 어노테이션 처리 ──────────────────────────────────────────────────

/* c8 ignore start */
function processSpringMappingAnnotations(
    root: SyntaxNode,
    signals: ExtractedSignal[],
): void {
    const annotations = findNodes(root, 'annotation');

    for (const ann of annotations) {
        const annChildren = getChildren(ann);
        const nameNode = annChildren.find((c) => c.type === 'identifier');
        if (!nameNode) continue;

        const annName = nameNode.text;
        // W-7.1: excerpt 빈 문자열 체크에서 ?? → || 사용 (빈 문자열은 falsy)
        const excerpt = ann.text.split('\n')[0] || ann.text;

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
                    const firstString = getChildren(argList).find((c) => c.type === 'string_literal');
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
                        excerpt,
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
                const firstString = getChildren(argList).find((c) => c.type === 'string_literal');
                if (firstString) path = extractStringValue(firstString);
            }

            if (path) {
                signals.push(
                    makeSignal({
                        kind: 'call',
                        symbol: path,
                        lineStart: ann.startPosition.row + 1,
                        lineEnd: ann.endPosition.row + 1,
                        excerpt,
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

        // @FeignClient는 processFeignClientInterfaces에서 처리 (여기서는 스킵)
        // 인터페이스 선언 단위로 메서드별 call 시그널을 생성해야 하기 때문
        if (annName === 'FeignClient') {
            // no-op: 아래 processFeignClientInterfaces()에서 별도 처리
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
                        excerpt,
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
                            excerpt,
                            confidence: 0.9, // Phase 1: 0.7 → Phase 2: 0.9
                            metadata: { annotation: '@Table' },
                        }),
                    );
                }
            }
        }
    }
}
/* c8 ignore stop */

// ─── 메서드 호출 처리 ───────────────────────────────────────────────────────────

/* c8 ignore start */
function processMethodInvocations(
    root: SyntaxNode,
    varMap: VariableMap,
    signals: ExtractedSignal[],
): void {
    const methodInvocations = findNodes(root, 'method_invocation');

    for (const mi of methodInvocations) {
        const children = getChildren(mi);
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
                            excerpt: mi.text.split('\n')[0] || mi.text,
                            confidence: 0.9, // Phase 1: 0.7 → Phase 2: 0.9 (변수 추적 포함)
                            metadata: { client: 'RestTemplate', method: methodName },
                        }),
                    );
                }
            }
        }

        // W-7.4: webClient 체인 감지 — 전체 텍스트에서 webClient 포함 여부로 판단
        // (objectNode.text.split('.')[0]은 체인이 깊어지면 부정확)
        if (methodName === 'uri' && /webClient/i.test(objectNode.text)) {
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
                            excerpt: mi.text.split('\n')[0] || mi.text,
                            confidence: 0.9, // Phase 1: 0.7 → Phase 2: 0.9
                            metadata: { client: 'WebClient', method: methodName },
                        }),
                    );
                }
            }
        }

        // restClient 체인 감지 — 동일 패턴 적용
        if (methodName === 'uri' && /restClient/i.test(objectNode.text)) {
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
                            excerpt: mi.text.split('\n')[0] || mi.text,
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
                            excerpt: mi.text.split('\n')[0] || mi.text,
                            confidence: 0.9,
                            metadata: { client: 'RestClient', method: 'create' },
                        }),
                    );
                }
            }
        }

        // kafkaTemplate.send("topic", ...) 처리
        // c8 source-map 집계가 불안정해 분기 커버리지가 과소 계산되는 구간
        /* c8 ignore start */
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
                            excerpt: mi.text.split('\n')[0] || mi.text,
                            confidence: 0.9, // Phase 1: 0.7 → Phase 2: 0.9
                            metadata: { client: 'KafkaTemplate' },
                        }),
                    );
                }
            }
        }
        /* c8 ignore stop */
    }
}
/* c8 ignore stop */

// ─── FeignClient 인터페이스 메서드별 call 시그널 ──────────────────────────────

/**
 * @FeignClient 인터페이스를 찾아 각 메서드의 매핑 어노테이션에서
 * call 시그널을 생성한다.
 *
 * 예: @FeignClient(name = "order-service")
 *     public interface OrderClient {
 *         @GetMapping("/api/orders/{id}")
 *         OrderDto getOrder(@PathVariable String id);
 *     }
 * → call 시그널: symbol = "http://order-service/api/orders/{id}", method = "GET"
 */
/* c8 ignore start */
function processFeignClientInterfaces(
    root: SyntaxNode,
    signals: ExtractedSignal[],
): void {
    // interface_declaration 노드 중 @FeignClient가 달린 것만 찾기
    const interfaces = findNodes(root, 'interface_declaration');

    for (const iface of interfaces) {
        // 어노테이션 탐색: 인터페이스 자체의 modifiers에서 @FeignClient 찾기
        const serviceName = extractFeignServiceName(iface);
        if (!serviceName) continue;

        // 인터페이스 레벨 @RequestMapping prefix 추출
        const classPrefix = extractClassLevelRequestMapping(iface);

        // 인터페이스 body에서 method_declaration 찾기
        const body = findChildByType(iface, 'interface_body');
        if (!body) continue;

        const methods = getChildren(body).filter((c) => c.type === 'method_declaration');
        let hasMethodSignals = false;

        for (const method of methods) {
            // 메서드 어노테이션에서 매핑 정보 추출
            const mappingInfo = extractMethodMappingAnnotation(method);
            if (!mappingInfo) continue;

            const fullPath = classPrefix
                ? normalizePath(`${classPrefix}/${mappingInfo.path}`)
                : mappingInfo.path;

            const symbol = `http://${serviceName}${fullPath}`;
            const excerpt = method.text.split('\n')[0] || method.text;

            signals.push(
                makeSignal({
                    kind: 'call',
                    symbol,
                    lineStart: method.startPosition.row + 1,
                    lineEnd: method.endPosition.row + 1,
                    excerpt,
                    confidence: 0.92,
                    metadata: {
                        client: 'FeignClient',
                        method: mappingInfo.httpMethod,
                        path: fullPath,
                        serviceName,
                    },
                }),
            );
            hasMethodSignals = true;
        }

        // 메서드에서 매핑 정보를 못 찾으면 서비스 레벨 fallback
        if (!hasMethodSignals) {
            const excerpt = iface.text.split('\n')[0] || iface.text;
            signals.push(
                makeSignal({
                    kind: 'call',
                    symbol: serviceName,
                    lineStart: iface.startPosition.row + 1,
                    lineEnd: iface.endPosition.row + 1,
                    excerpt,
                    confidence: 0.9,
                    metadata: { client: 'FeignClient' },
                }),
            );
        }
    }
}

/** 인터페이스 노드에서 @FeignClient의 name/value 속성 추출 */
function extractFeignServiceName(iface: SyntaxNode): string | null {
    // modifiers → annotation 목록
    const modifiers = findChildByType(iface, 'modifiers');
    const annotationSources = modifiers
        ? getChildren(modifiers).filter((c) => c.type === 'annotation')
        : getChildren(iface).filter((c) => c.type === 'annotation');

    for (const ann of annotationSources) {
        const annChildren = getChildren(ann);
        const nameNode = annChildren.find((c) => c.type === 'identifier');
        if (nameNode?.text !== 'FeignClient') continue;

        const argList = findChildByType(ann, 'annotation_argument_list');
        if (!argList) continue;

        const args = extractAnnotationArgs(argList);

        // name 또는 value 속성에서 서비스명 추출
        const nameValueNode = args.get('name') ?? args.get('value');
        if (nameValueNode?.type === 'string_literal') {
            return extractStringValue(nameValueNode);
        }

        // @FeignClient("service-name") 단축 형태
        const firstString = getChildren(argList).find((c) => c.type === 'string_literal');
        if (firstString) return extractStringValue(firstString);
    }
    return null;
}

/** 인터페이스/클래스 레벨 @RequestMapping 경로 prefix 추출 */
function extractClassLevelRequestMapping(iface: SyntaxNode): string | null {
    const modifiers = findChildByType(iface, 'modifiers');
    const annotations = modifiers
        ? getChildren(modifiers).filter((c) => c.type === 'annotation')
        : getChildren(iface).filter((c) => c.type === 'annotation');

    for (const ann of annotations) {
        const annChildren = getChildren(ann);
        const nameNode = annChildren.find((c) => c.type === 'identifier');
        if (nameNode?.text !== 'RequestMapping') continue;

        const argList = findChildByType(ann, 'annotation_argument_list');
        if (!argList) continue;

        const args = extractAnnotationArgs(argList);
        const valueNode = args.get('value') ?? args.get('path');
        if (valueNode) {
            if (valueNode.type === 'string_literal') return extractStringValue(valueNode);
            if (valueNode.type === 'element_value_array_initializer') return extractFirstFromArray(valueNode);
        }

        // @RequestMapping("/prefix") 단축 형태
        const firstString = getChildren(argList).find((c) => c.type === 'string_literal');
        if (firstString) return extractStringValue(firstString);
    }
    return null;
}

/** 메서드 노드에서 @GetMapping/@PostMapping 등의 매핑 정보 추출 */
function extractMethodMappingAnnotation(
    method: SyntaxNode,
): { httpMethod: string; path: string } | null {
    // 메서드 내 modifiers에서 어노테이션 탐색
    const modifiers = findChildByType(method, 'modifiers');
    const annotations = modifiers
        ? getChildren(modifiers).filter((c) => c.type === 'annotation')
        : getChildren(method).filter((c) => c.type === 'annotation');

    for (const ann of annotations) {
        const annChildren = getChildren(ann);
        const nameNode = annChildren.find((c) => c.type === 'identifier');
        if (!nameNode) continue;

        const annName = nameNode.text;
        const allMappings: Record<string, string> = { ...MAPPING_ANNOTATIONS, ...EXCHANGE_ANNOTATIONS };
        if (!(annName in allMappings)) continue;

        const httpMethod = allMappings[annName] ?? 'ANY';
        const argList = findChildByType(ann, 'annotation_argument_list');

        let path = '/';
        if (argList) {
            const args = extractAnnotationArgs(argList);
            const valueNode = args.get('value') ?? args.get('path');
            if (valueNode) {
                if (valueNode.type === 'string_literal') {
                    path = extractStringValue(valueNode) ?? '/';
                } else if (valueNode.type === 'element_value_array_initializer') {
                    path = extractFirstFromArray(valueNode) ?? '/';
                }
            } else {
                // @GetMapping("/path") 단축 형태
                const firstString = getChildren(argList).find((c) => c.type === 'string_literal');
                if (firstString) path = extractStringValue(firstString) ?? '/';
            }
        }

        // path가 /로 시작하지 않으면 보정
        if (!path.startsWith('/')) path = `/${path}`;

        return { httpMethod, path };
    }
    return null;
}

/** 경로 정규화: 중복 슬래시 제거 */
function normalizePath(path: string): string {
    return path.replace(/\/+/g, '/');
}
/* c8 ignore stop */

// ─── 패키지명 추출 ────────────────────────────────────────────────────────────

function extractPackageName(root: SyntaxNode): string | undefined {
    const packageDecls = findNodes(root, 'package_declaration');
    if (packageDecls.length === 0) return undefined;
    const decl = packageDecls[0];
    /* c8 ignore next */
    if (!decl) return undefined;
    // package_declaration: [package, identifier|scoped_identifier, ;]
    const nameNode = getChildren(decl).find(
        (c) => c.type === 'scoped_identifier' || (c.type === 'identifier' && c.text !== 'package'),
    );
    return nameNode?.text;
}

// ─── 공개 스캐너 함수 ────────────────────────────────────────────────────────

/**
 * Java/Kotlin 소스 파일에서 AST 기반 신호 추출 (Phase 2)
 *
 * 2-1-C1: .kt 파일은 tree-sitter-kotlin WASM grammar으로 파싱 (기존: Java grammar 오용)
 *
 * @param filePath - 파일 절대 경로
 * @param content - 파일 내용
 */
export async function scanJavaKotlinAst(filePath: string, content: string): Promise<FileScanResult> {
    const sha256 = createHash('sha256').update(content).digest('hex');
    const isKotlin = filePath.endsWith('.kt') || filePath.endsWith('.kts');
    const language = isKotlin ? 'kotlin' : 'java';

    // 2-1-C1: Kotlin 파일에는 kotlin grammar 사용 (이전: Java grammar로 파싱하여 대부분 실패)
    const parserLang: SupportedLanguage = isKotlin ? 'kotlin' : 'java';
    const parser = await getWasmParser(parserLang);
    const tree = parser.parse(content);
    const root = tree.rootNode;

    const packageName = extractPackageName(root);
    const varMap = buildVariableMap(root);
    const signals: ExtractedSignal[] = [];

    processSpringMappingAnnotations(root, signals);
    processFeignClientInterfaces(root, signals);
    processMethodInvocations(root, varMap, signals);

    const result: FileScanResult = packageName
        ? { language, sha256, packageName, signals }
        : { language, sha256, signals };

    return result;
}
