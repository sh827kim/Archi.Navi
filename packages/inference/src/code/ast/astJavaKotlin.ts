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
import type { AstProjectSymbolTable } from './symbolTable';
import { resolveJavaCallTargets } from './symbolTable';
import type { AstPropertyMap } from './propertyResolver';
import { resolveValueExpression } from './propertyResolver';

interface ScanJavaKotlinAstOptions {
    interProcedural?: {
        symbolTable: AstProjectSymbolTable;
        maxCallChainDepth: number;
    };
    propertyMap?: AstPropertyMap;
}

const IDENTIFIER_NODE_TYPES = new Set(['identifier', 'simple_identifier', 'type_identifier']);
const CALL_NODE_TYPES = ['method_invocation', 'call_expression'];
const METHOD_DECLARATION_NODE_TYPES = ['method_declaration', 'function_declaration'];
const FIELD_DECLARATION_NODE_TYPES = ['field_declaration', 'property_declaration'];
const VALUE_ANNOTATION_REGEX = /@(?:field:)?Value\s*\(\s*"([^"]+)"\s*\)/;

interface ResolvedVariableMap {
    values: VariableMap;
    propertyBackedVariables: Set<string>;
}

interface SpringRequestMappingInfo {
    paths: string[];
    methods: string[] | null;
    annotation: string;
}

interface SpringMappingExtraction {
    info: SpringRequestMappingInfo;
    annotationNode: SyntaxNode;
}

// ─── 변수 추적 (Data-Flow) ─────────────────────────────────────────────────────

/**
 * AST에서 문자열 변수 선언 맵 구축
 * String URL = "..." 또는 private static final String URL = "..." 형태 추적
 */
function buildVariableMap(root: SyntaxNode, propertyMap?: AstPropertyMap): ResolvedVariableMap {
    const values: VariableMap = new Map();
    const propertyBackedVariables = new Set<string>();

    // local_variable_declaration과 field_declaration 모두 처리
    const varDecls = [
        ...findNodes(root, 'local_variable_declaration'),
        ...findNodes(root, 'field_declaration'),
        ...findNodes(root, 'property_declaration'),
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
                values.set(nameNode.text, strValue);
            }
        }
    }

    if (propertyMap) {
        const propertyDecls = [
            ...findNodes(root, 'field_declaration'),
            ...findNodes(root, 'property_declaration'),
        ];

        for (const decl of propertyDecls) {
            const valueExpression = decl.text.match(VALUE_ANNOTATION_REGEX)?.[1];
            if (!valueExpression) continue;

            const resolvedValue = resolveValueExpression(valueExpression, propertyMap);
            if (!resolvedValue) continue;

            for (const declarator of [
                ...findNodes(decl, 'variable_declarator'),
                ...findNodes(decl, 'variable_declaration'),
            ]) {
                const nameNode = getChildren(declarator).find(isIdentifierNode);
                if (nameNode) {
                    values.set(nameNode.text, resolvedValue);
                    propertyBackedVariables.add(nameNode.text);
                }
            }
        }
    }

    return { values, propertyBackedVariables };
}

/**
 * 인수 노드에서 URL/토픽 문자열 추출
 * - string_literal: 직접 값 반환
 * - identifier: 변수 맵에서 조회
 */
function resolveStringArg(
    argNode: SyntaxNode,
    varMap: ResolvedVariableMap,
): { value: string; resolvedVia: 'literal' | 'variable' | 'property' } | null {
    if (argNode.type === 'string_literal') {
        const value = extractStringValue(argNode);
        if (!value || value.includes('${')) {
            return null;
        }
        return { value, resolvedVia: 'literal' };
    }
    if (argNode.type === 'identifier') {
        const value = varMap.values.get(argNode.text);
        if (!value) return null;
        return {
            value,
            resolvedVia: varMap.propertyBackedVariables.has(argNode.text) ? 'property' : 'variable',
        };
    }
    return null;
}

function inferHttpMethodFromReceiver(receiverName: string): string | null {
    const match = receiverName.match(/\.(get|post|put|delete|patch)\s*\(/i);
    return match ? match[1]!.toUpperCase() : null;
}

function buildPartialHttpMetadata(
    receiverName: string,
    argText: string,
): Record<string, unknown> {
  const decapitalize = (value: string): string => (value.length > 0 ? `${value[0]!.toLowerCase()}${value.slice(1)}` : value);
  const stringLiterals = [...argText.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]!.trim());
  const placeholderConfigKeys = [...new Set(
    [...argText.matchAll(/\$\{([^}:]+)(?::[^}]*)?\}/g)].map((match) => match[1]!.trim()).filter(Boolean),
  )];
  const getterConfigKeys = [...argText.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*get([A-Z][A-Za-z0-9_]*)\s*\(/g)]
    .map((match) => `${match[1]}.${decapitalize(match[2] ?? '')}`)
    .filter((key) => key.length > 0);
  const configKeys = [...new Set([...placeholderConfigKeys, ...getterConfigKeys])];
  const expressionText = argText
    .replace(/"(?:\\.|[^"\\])*"/g, ' ')
    .replace(/'(?:\\.|[^'\\])*'/g, ' ')
    .replace(/\$\{[^}]+\}/g, ' ');
  const pathParts = stringLiterals.filter((value) => value.startsWith('/'));
  const pathHint = pathParts.length > 0 ? pathParts.join('') : null;
  const hostLiteral = stringLiterals.find((value) => /^[a-z][a-z0-9+.-]*:\/\//i.test(value))
    ?? stringLiterals.find((value) => /^[a-z0-9][a-z0-9._-]*$/i.test(value) && !value.startsWith('/'))
    ?? null;
  const baseUrlVarMatch = expressionText.match(/\b([A-Za-z_][A-Za-z0-9_]*)\b/);
  const serviceNameHintMatch = expressionText.match(/\b([A-Za-z_][A-Za-z0-9_-]*service[A-Za-z0-9_-]*)\b/i);
  const getterServiceHintMatch = [...argText.matchAll(/\bget([A-Z][A-Za-z0-9]*(?:Service|Manager|Client|Api|Gateway|Mgt)[A-Za-z0-9]*)\s*\(/g)][0]?.[1];
  const serviceNameHint = getterServiceHintMatch ?? serviceNameHintMatch?.[1] ?? null;
  const hasConfigPlaceholder = placeholderConfigKeys.length > 0;

  return {
    methodHint: inferHttpMethodFromReceiver(receiverName),
    ...(pathHint ? { pathHint } : {}),
    ...(hostLiteral ? { hostHint: hostLiteral } : {}),
    ...(serviceNameHint ? { serviceNameHint } : {}),
    ...(baseUrlVarMatch ? { baseUrlVar: baseUrlVarMatch[1] } : {}),
    ...(configKeys.length > 0 ? { configKeys } : {}),
    dynamicPath: pathHint !== null
      || /[+{]|UriComponentsBuilder|toUriString\s*\(/.test(expressionText)
      || hasConfigPlaceholder,
    dynamicHost: /[+{]|baseUrl|host|uriBuilder/i.test(expressionText) || hasConfigPlaceholder,
    unsupportedPattern: true,
  };
}

/**
 * argument_list에서 첫 번째 실질적인 인수 노드 반환
 */
function getFirstArg(argList: SyntaxNode): SyntaxNode | null {
    return (
        getArgs(argList)[0] ?? null
    );
}

function unwrapArgumentNode(argNode: SyntaxNode): SyntaxNode {
    if (argNode.type !== 'value_argument') return argNode;
    return (
        getChildren(argNode).find(
            (child) => child.type !== '(' && child.type !== ')' && child.type !== ',' && child.type !== ' ',
        ) ?? argNode
    );
}

function getArgs(argList: SyntaxNode): SyntaxNode[] {
    return getChildren(argList).filter(
        (c) => c.type !== '(' && c.type !== ')' && c.type !== ',' && c.type !== ' ',
    ).map(unwrapArgumentNode);
}

function buildHttpCallFromUriArgs(input: {
    argNodes: SyntaxNode[];
    objectName: string;
    methodName: string;
    client: 'WebClient' | 'RestClient';
}): { symbol: string; metadata: Record<string, unknown> } | null {
    const { argNodes, objectName, methodName, client } = input;
    const firstArg = argNodes[0];
    if (!firstArg) return null;

    const argExpression = argNodes.map((node) => node.text).join(', ');
    const firstArgIsLiteral = firstArg.type === 'string_literal';
    const firstArgValue = firstArgIsLiteral ? extractStringValue(firstArg) : null;
    const hasMultipleArgs = argNodes.length > 1;
    const firstArgLooksCompleteUrl = typeof firstArgValue === 'string' && /^[a-z][a-z0-9+.-]*:\/\//i.test(firstArgValue);

    const metadata: Record<string, unknown> = {
        client,
        method: inferHttpMethodFromReceiver(objectName) ?? methodName,
        ...buildPartialHttpMetadata(objectName, argExpression),
    };

    if (!hasMultipleArgs && firstArgLooksCompleteUrl) {
        metadata['resolvedUrl'] = firstArgValue;
        metadata['resolvedVia'] = 'literal';
    }

    const fallbackSymbol = firstArgIsLiteral
        ? firstArgValue ?? firstArg.text
        : firstArg.text;
    const symbol = (typeof metadata['pathHint'] === 'string'
        ? metadata['pathHint']
        : (typeof metadata['hostHint'] === 'string' ? metadata['hostHint'] : fallbackSymbol)) as string;

    return { symbol, metadata };
}

function isIdentifierNode(node: SyntaxNode): boolean {
    return IDENTIFIER_NODE_TYPES.has(node.type);
}

function findIdentifierChildren(node: SyntaxNode): SyntaxNode[] {
    return getChildren(node).filter(isIdentifierNode);
}

function normalizeTypeName(typeText: string): string {
    return typeText
        .replace(/<.*?>/g, '')
        .replace(/\[\]/g, '')
        .trim()
        .split(/\s+/)
        .pop() ?? typeText.trim();
}

function extractDeclaredTypeName(node: SyntaxNode): string | null {
    const typeNode = findNodes(node, 'type_identifier')[0]
        ?? findNodes(node, 'generic_type')[0]
        ?? findNodes(node, 'scoped_type_identifier')[0]
        ?? findNodes(node, 'user_type')[0];
    if (!typeNode) return null;
    return normalizeTypeName(typeNode.text);
}

function buildFieldTypeMap(typeNode: SyntaxNode): Map<string, string> {
    const fieldTypeMap = new Map<string, string>();
    const body = findChildByType(typeNode, 'class_body') ?? findChildByType(typeNode, 'interface_body');
    if (!body) return fieldTypeMap;

    const fieldDecls = getChildren(body).filter((child) => FIELD_DECLARATION_NODE_TYPES.includes(child.type));
    for (const fieldDecl of fieldDecls) {
        const typeName = extractDeclaredTypeName(fieldDecl);
        if (!typeName) continue;

        for (const declarator of [
            ...findNodes(fieldDecl, 'variable_declarator'),
            ...findNodes(fieldDecl, 'variable_declaration'),
        ]) {
            const nameNode = getChildren(declarator).find(isIdentifierNode);
            if (nameNode) {
                fieldTypeMap.set(nameNode.text, typeName);
            }
        }
    }

    return fieldTypeMap;
}

function buildMethodTypeMap(methodNode: SyntaxNode): Map<string, string> {
    const typeMap = new Map<string, string>();

    for (const parameter of [
        ...findNodes(methodNode, 'formal_parameter'),
        ...findNodes(methodNode, 'parameter'),
    ]) {
        const typeName = extractDeclaredTypeName(parameter);
        const nameNode = findNodes(parameter, 'identifier')[0]
            ?? findNodes(parameter, 'simple_identifier')[0];
        if (typeName && nameNode) {
            typeMap.set(nameNode.text, typeName);
        }
    }

    for (const localDecl of [
        ...findNodes(methodNode, 'local_variable_declaration'),
        ...findNodes(methodNode, 'property_declaration'),
    ]) {
        const typeName = extractDeclaredTypeName(localDecl);
        if (!typeName) continue;

        for (const declarator of [
            ...findNodes(localDecl, 'variable_declarator'),
            ...findNodes(localDecl, 'variable_declaration'),
        ]) {
            const nameNode = getChildren(declarator).find(isIdentifierNode);
            if (nameNode) {
                typeMap.set(nameNode.text, typeName);
            }
        }
    }

    return typeMap;
}

function extractMethodName(methodNode: SyntaxNode): string | null {
    return getChildren(methodNode).find(isIdentifierNode)?.text ?? null;
}

function extractTypeName(typeNode: SyntaxNode): string | null {
    return getChildren(typeNode).find(isIdentifierNode)?.text ?? null;
}

interface ParsedMethodInvocation {
    receiverName: string | null;
    methodName: string;
}

function parseMethodInvocation(node: SyntaxNode): ParsedMethodInvocation | null {
    const children = getChildren(node);
    const argList = findChildByType(node, 'argument_list') ?? findChildByType(node, 'value_arguments');
    if (!argList) return null;

    const objectNode = children[0];
    if (!objectNode) return null;
    const methodNameNode = children.find((child, index) => index > 0 && isIdentifierNode(child));
    if (methodNameNode) {
        return {
            receiverName: objectNode.text,
            methodName: methodNameNode.text,
        };
    }

    if (node.type === 'call_expression') {
        if (objectNode.type === 'navigation_expression') {
            const identifierNodes = findIdentifierChildren(objectNode);
            if (identifierNodes.length >= 2) {
                return {
                    receiverName: identifierNodes[0]?.text ?? null,
                    methodName: identifierNodes.at(-1)?.text ?? '',
                };
            }
        }

        const callableNode = children.find(isIdentifierNode);
        if (callableNode) {
            return {
                receiverName: null,
                methodName: callableNode.text,
            };
        }
    }

    const identifierNode = children.find(isIdentifierNode);
    if (!identifierNode) return null;
    return {
        receiverName: null,
        methodName: identifierNode.text,
    };
}

function isDirectClientInvocation(parsed: ParsedMethodInvocation): boolean {
    if (/^(restTemplate|kafkaTemplate|rabbitTemplate|amqpTemplate)$/i.test(parsed.receiverName ?? '')) {
        return true;
    }
    if (parsed.receiverName === 'RestClient' && parsed.methodName === 'create') {
        return true;
    }
    if (
        parsed.methodName === 'uri'
        && /(webClient|restClient)/i.test(parsed.receiverName ?? '')
    ) {
        return true;
    }
    return false;
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

const SUPPORTED_ENDPOINT_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ANY']);
const CONTROLLER_ANNOTATIONS = new Set(['Controller', 'RestController']);

function toArrayLiteralValues(node: SyntaxNode | null): string[] {
    if (!node) return [];
    if (node.type === 'string_literal') {
        const value = extractStringValue(node);
        return value ? [value] : [];
    }
    if (node.type !== 'element_value_array_initializer') return [];
    return getChildren(node)
        .filter((child) => child.type === 'string_literal')
        .map((child) => extractStringValue(child))
        .filter((value): value is string => value !== null);
}

function normalizeHttpMethod(method: string): string {
    const upper = method.toUpperCase();
    return SUPPORTED_ENDPOINT_METHODS.has(upper) ? upper : 'ANY';
}

function toMethodValues(node: SyntaxNode | null): string[] {
    if (!node) return [];
    const extractRequestMethod = (text: string): string | null => {
        const lastToken = text.split('.').pop()?.trim();
        return lastToken ? normalizeHttpMethod(lastToken) : null;
    };

    if (node.type === 'field_access') {
        const value = extractRequestMethod(node.text);
        return value ? [value] : [];
    }
    if (node.type === 'identifier') {
        return [normalizeHttpMethod(node.text)];
    }
    if (node.type !== 'element_value_array_initializer') return [];

    return getChildren(node)
        .filter((child) => child.type === 'field_access' || child.type === 'identifier')
        .map((child) => extractRequestMethod(child.text))
        .filter((value): value is string => value !== null);
}

function normalizeSpringPath(path: string): string {
    const trimmed = path.trim();
    if (trimmed.length === 0 || trimmed === '/') return '/';
    const prefixed = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    return prefixed.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

function combineSpringPaths(typePath: string, methodPath: string): string {
    const normalizedType = normalizeSpringPath(typePath);
    const normalizedMethod = normalizeSpringPath(methodPath);
    if (normalizedType === '/') return normalizedMethod;
    if (normalizedMethod === '/') return normalizedType;
    return normalizeSpringPath(`${normalizedType}/${normalizedMethod}`);
}

function findAnnotationsWithNames(node: SyntaxNode, names: Set<string>): SyntaxNode[] {
    return findNodes(node, 'annotation').filter((ann) => {
        const annName = getChildren(ann).find((child) => child.type === 'identifier')?.text;
        return annName ? names.has(annName) : false;
    });
}

function extractRequestMappingInfo(annotation: SyntaxNode): SpringRequestMappingInfo | null {
    const annName = getChildren(annotation).find((child) => child.type === 'identifier')?.text;
    if (!annName) return null;

    const shortcutMethod = MAPPING_ANNOTATIONS[annName];
    if (!shortcutMethod && annName !== 'RequestMapping') return null;

    const argList = findChildByType(annotation, 'annotation_argument_list');
    const args = argList ? extractAnnotationArgs(argList) : new Map<string, SyntaxNode>();
    const pathNode = args.get('path') ?? args.get('value') ?? null;
    const firstString = argList
        ? getChildren(argList).find((child) => child.type === 'string_literal') ?? null
        : null;
    const rawPaths = toArrayLiteralValues(pathNode).length > 0
        ? toArrayLiteralValues(pathNode)
        : toArrayLiteralValues(firstString);
    const paths = rawPaths.length > 0 ? rawPaths.map(normalizeSpringPath) : ['/'];

    const methods = annName === 'RequestMapping'
        ? (() => {
            const parsedMethods = toMethodValues(args.get('method') ?? null);
            return parsedMethods.length > 0 ? parsedMethods : null;
          })()
        : [normalizeHttpMethod(shortcutMethod ?? 'ANY')];

    return {
        annotation: annName,
        paths,
        methods,
    };
}

function extractTypeLevelSpringMapping(typeDecl: SyntaxNode): SpringMappingExtraction | null {
    const annotations = findAnnotationsWithNames(typeDecl, new Set(['RequestMapping']));
    if (annotations.length === 0) return null;
    const first = annotations[0]!;
    const info = extractRequestMappingInfo(first);
    return info ? { info, annotationNode: first } : null;
}

function extractMethodLevelSpringMappings(methodDecl: SyntaxNode): SpringMappingExtraction[] {
    return findAnnotationsWithNames(methodDecl, new Set(Object.keys(MAPPING_ANNOTATIONS)))
        .map((annotationNode) => {
            const info = extractRequestMappingInfo(annotationNode);
            return info ? { info, annotationNode } : null;
        })
        .filter((value): value is SpringMappingExtraction => value !== null);
}

function isSpringControllerType(typeDecl: SyntaxNode, methodMappings: SpringMappingExtraction[]): boolean {
    if (methodMappings.length > 0) return true;
    return findAnnotationsWithNames(typeDecl, CONTROLLER_ANNOTATIONS).length > 0;
}

function combineSpringMappings(
    typeInfo: SpringRequestMappingInfo,
    methodInfo: SpringRequestMappingInfo,
): Array<{ method: string; path: string }> {
    const paths: string[] = [];
    for (const typePath of typeInfo.paths) {
        for (const methodPath of methodInfo.paths) {
            paths.push(combineSpringPaths(typePath, methodPath));
        }
    }
    const uniquePaths = [...new Set(paths)];

    const mergedMethods = typeInfo.methods && methodInfo.methods
        ? methodInfo.methods.filter((method) => typeInfo.methods?.includes(method))
        : (methodInfo.methods ?? typeInfo.methods ?? ['ANY']);
    const methods = [...new Set(mergedMethods.length > 0 ? mergedMethods : [])];
    if (methods.length === 0) return [];

    return methods.flatMap((method) => uniquePaths.map((path) => ({ method, path })));
}

/* c8 ignore start */
function processSpringControllerMappings(
    root: SyntaxNode,
    signals: ExtractedSignal[],
): void {
    const typeDeclarations = [
        ...findNodes(root, 'class_declaration'),
        ...findNodes(root, 'interface_declaration'),
    ];

    for (const typeDecl of typeDeclarations) {
        const methodMappings = findNodes(typeDecl, 'method_declaration')
            .flatMap((methodDecl) =>
                extractMethodLevelSpringMappings(methodDecl).map((mapping) => ({ methodDecl, mapping })),
            );
        if (!isSpringControllerType(typeDecl, methodMappings.map((entry) => entry.mapping))) continue;

        const typeMapping = extractTypeLevelSpringMapping(typeDecl);
        const typeInfo = typeMapping?.info ?? {
            paths: ['/'],
            methods: null,
            annotation: 'RequestMapping',
        };
        const ownerTypeName = extractTypeName(typeDecl);

        if (methodMappings.length === 0) {
            if (!typeMapping) continue;
            const methods = typeInfo.methods ?? ['ANY'];
            for (const method of methods) {
                for (const path of typeInfo.paths) {
                    signals.push(
                        makeSignal({
                            kind: 'expose',
                            symbol: path,
                            lineStart: typeMapping.annotationNode.startPosition.row + 1,
                            lineEnd: typeMapping.annotationNode.endPosition.row + 1,
                            excerpt: typeMapping.annotationNode.text.split('\n')[0] || typeMapping.annotationNode.text,
                            confidence: 0.95,
                            metadata: {
                                method,
                                path,
                                annotation: `@${typeInfo.annotation}`,
                                framework: 'spring',
                                mappingSource: 'controller_composed',
                                typeLevelPath: path,
                                methodLevelPath: null,
                                ...(ownerTypeName ? { ownerTypeName } : {}),
                            },
                        }),
                    );
                }
            }
            continue;
        }

        for (const { methodDecl, mapping } of methodMappings) {
            const combined = combineSpringMappings(typeInfo, mapping.info);
            for (const endpoint of combined) {
                signals.push(
                    makeSignal({
                        kind: 'expose',
                        symbol: endpoint.path,
                        lineStart: mapping.annotationNode.startPosition.row + 1,
                        lineEnd: mapping.annotationNode.endPosition.row + 1,
                        excerpt: mapping.annotationNode.text.split('\n')[0] || mapping.annotationNode.text,
                        confidence: 0.95,
                        metadata: {
                            method: endpoint.method,
                            path: endpoint.path,
                            annotation: `@${mapping.info.annotation}`,
                            framework: 'spring',
                            mappingSource: 'controller_composed',
                            typeLevelPath: typeInfo.paths[0] ?? null,
                            methodLevelPath: mapping.info.paths[0] ?? null,
                            ...(ownerTypeName ? { ownerTypeName } : {}),
                        },
                    }),
                );
            }
        }
    }
}
/* c8 ignore stop */

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

        // @RabbitListener(queues = "queue") 처리
        if (annName === 'RabbitListener') {
            const argList = findChildByType(ann, 'annotation_argument_list');
            if (!argList) continue;

            const args = extractAnnotationArgs(argList);
            const queuesNode = args.get('queues');
            if (!queuesNode) continue;

            // 단일 큐 또는 배열에서 모든 큐 이름 추출
            const queueNames: string[] = [];
            if (queuesNode.type === 'string_literal') {
                const q = extractStringValue(queuesNode);
                if (q) queueNames.push(q);
            } else if (queuesNode.type === 'element_value_array_initializer') {
                for (const child of getChildren(queuesNode)) {
                    if (child.type === 'string_literal') {
                        const q = extractStringValue(child);
                        if (q) queueNames.push(q);
                    }
                }
            }

            for (const queueName of queueNames) {
                signals.push(
                    makeSignal({
                        kind: 'consume',
                        symbol: queueName,
                        lineStart: ann.startPosition.row + 1,
                        lineEnd: ann.endPosition.row + 1,
                        excerpt,
                        confidence: 0.95,
                        metadata: {
                            annotation: '@RabbitListener',
                            broker: 'rabbitmq',
                            channelType: 'queue',
                        },
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

function processMethodInvocations(
    root: SyntaxNode,
    varMap: ResolvedVariableMap,
    signals: ExtractedSignal[],
): void {
    const methodInvocations = CALL_NODE_TYPES.flatMap((nodeType) => findNodes(root, nodeType));

    for (const mi of methodInvocations) {
        const parsed = parseMethodInvocation(mi);
        const argList = findChildByType(mi, 'argument_list') ?? findChildByType(mi, 'value_arguments');
        if (!parsed || !parsed.receiverName || !argList) continue;

        const objectName = parsed.receiverName;
        const methodName = parsed.methodName;

        // restTemplate.*(url, ...) 처리
        if (/^restTemplate$/i.test(objectName)) {
            const firstArg = getFirstArg(argList);
            if (firstArg) {
                const resolvedArg = resolveStringArg(firstArg, varMap);
                const url = resolvedArg?.value;
                if (url) {
                    signals.push(
                        makeSignal({
                            kind: 'call',
                            symbol: url,
                            lineStart: mi.startPosition.row + 1,
                            lineEnd: mi.endPosition.row + 1,
                            excerpt: mi.text.split('\n')[0] || mi.text,
                            confidence: 0.9, // Phase 1: 0.7 → Phase 2: 0.9 (변수 추적 포함)
                            metadata: {
                                client: 'RestTemplate',
                                method: methodName,
                                resolvedUrl: url,
                                resolvedVia: resolvedArg?.resolvedVia ?? 'literal',
                            },
                        }),
                    );
                }
            }
        }

        // W-7.4: webClient 체인 감지 — 전체 텍스트에서 webClient 포함 여부로 판단
        // (objectNode.text.split('.')[0]은 체인이 깊어지면 부정확)
        if (methodName === 'uri' && /webClient/i.test(objectName)) {
            const argNodes = getArgs(argList);
            const call = buildHttpCallFromUriArgs({
                argNodes,
                objectName,
                methodName,
                client: 'WebClient',
            });
            if (call) {
                signals.push(
                    makeSignal({
                        kind: 'call',
                        symbol: call.symbol,
                        lineStart: mi.startPosition.row + 1,
                        lineEnd: mi.endPosition.row + 1,
                        excerpt: mi.text.split('\n')[0] || mi.text,
                        confidence: 0.9,
                        metadata: call.metadata,
                    }),
                );
            }
        }

        // restClient 체인 감지 — 동일 패턴 적용
        if (methodName === 'uri' && /restClient/i.test(objectName)) {
            const argNodes = getArgs(argList);
            const call = buildHttpCallFromUriArgs({
                argNodes,
                objectName,
                methodName,
                client: 'RestClient',
            });
            if (call) {
                signals.push(
                    makeSignal({
                        kind: 'call',
                        symbol: call.symbol,
                        lineStart: mi.startPosition.row + 1,
                        lineEnd: mi.endPosition.row + 1,
                        excerpt: mi.text.split('\n')[0] || mi.text,
                        confidence: 0.9,
                        metadata: call.metadata,
                    }),
                );
            }
        }

        // RestClient.create("baseUrl") 처리
        if (objectName === 'RestClient' && methodName === 'create') {
            const firstArg = getFirstArg(argList);
            if (firstArg) {
                const resolvedArg = resolveStringArg(firstArg, varMap);
                const url = resolvedArg?.value;
                const metadata: Record<string, unknown> = url
                    ? {
                        client: 'RestClient',
                        method: 'create',
                        resolvedUrl: url,
                        resolvedVia: resolvedArg?.resolvedVia ?? 'literal',
                      }
                    : {
                        client: 'RestClient',
                        method: 'create',
                        ...buildPartialHttpMetadata(objectName, firstArg.text),
                      };
                const fallbackSymbol = firstArg.type === 'string_literal'
                    ? extractStringValue(firstArg) ?? firstArg.text
                    : firstArg.text;
                const symbol = url
                    ?? (typeof metadata['pathHint'] === 'string'
                        ? metadata['pathHint'] as string
                        : (typeof metadata['hostHint'] === 'string' ? metadata['hostHint'] as string : fallbackSymbol));
                signals.push(
                    makeSignal({
                        kind: 'call',
                        symbol,
                        lineStart: mi.startPosition.row + 1,
                        lineEnd: mi.endPosition.row + 1,
                        excerpt: mi.text.split('\n')[0] || mi.text,
                        confidence: 0.9,
                        metadata,
                    }),
                );
            }
        }

        // kafkaTemplate.send("topic", ...) 처리
        // c8 source-map 집계가 불안정해 분기 커버리지가 과소 계산되는 구간
        /* c8 ignore start */
        if (/^kafkaTemplate$/i.test(objectName) && methodName === 'send') {
            const firstArg = getFirstArg(argList);
            if (firstArg) {
                const topic = resolveStringArg(firstArg, varMap)?.value;
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

        // rabbitTemplate.convertAndSend("queue", ...) / rabbitTemplate.send("queue", ...) 처리
        if (
            /^(?:rabbitTemplate|amqpTemplate)$/i.test(objectName) &&
            (methodName === 'convertAndSend' || methodName === 'send')
        ) {
            const args = getArgs(argList);
            // convertAndSend(exchange, routingKey, payload) / send(exchange, routingKey, message)
            // 형태는 queue 목적지로 단정할 수 없어 보수적으로 스킵한다.
            if (args.length === 2) {
                const queueName = resolveStringArg(args[0]!, varMap)?.value;
                if (queueName) {
                    signals.push(
                        makeSignal({
                            kind: 'produce',
                            symbol: queueName,
                            lineStart: mi.startPosition.row + 1,
                            lineEnd: mi.endPosition.row + 1,
                            excerpt: mi.text.split('\n')[0] || mi.text,
                            confidence: 0.9,
                            metadata: {
                                client: 'RabbitTemplate',
                                broker: 'rabbitmq',
                                channelType: 'queue',
                            },
                        }),
                    );
                }
            }
        }

        /* c8 ignore stop */
    }
}
/* c8 ignore stop */

async function resolveInterProceduralCallSignals(
    input: {
        invocationNode: SyntaxNode;
        currentTypeName: string;
        packageName?: string;
        fieldTypeMap: Map<string, string>;
        methodTypeMap: Map<string, string>;
        symbolTable: AstProjectSymbolTable;
        maxCallChainDepth: number;
    },
): Promise<ExtractedSignal[]> {
    const parsed = parseMethodInvocation(input.invocationNode);
    if (!parsed || isDirectClientInvocation(parsed)) return [];

    const targetTypeName = parsed.receiverName === null
        ? input.currentTypeName
        : (
            input.methodTypeMap.get(parsed.receiverName)
            ?? input.fieldTypeMap.get(parsed.receiverName)
        );
    if (!targetTypeName) return [];

    const resolvedCalls = resolveJavaCallTargets(input.symbolTable, {
        typeName: targetTypeName,
        methodName: parsed.methodName,
        maxDepth: input.maxCallChainDepth,
        ...(input.packageName ? { packageName: input.packageName } : {}),
    }).map((call) => makeSignal({
        kind: 'call',
        symbol: call.symbol,
        lineStart: input.invocationNode.startPosition.row + 1,
        lineEnd: input.invocationNode.endPosition.row + 1,
        excerpt: input.invocationNode.text.split('\n')[0] || input.invocationNode.text,
        confidence: call.confidence,
        metadata: call.metadata,
    }));

    return resolvedCalls;
}

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

async function processInterProceduralMethodInvocations(
    root: SyntaxNode,
    packageName: string | undefined,
    symbolTable: AstProjectSymbolTable,
    maxCallChainDepth: number,
    signals: ExtractedSignal[],
): Promise<void> {
    const typeNodes = findNodes(root, 'class_declaration');

    for (const typeNode of typeNodes) {
        const currentTypeName = extractTypeName(typeNode);
        if (!currentTypeName) continue;

        const fieldTypeMap = buildFieldTypeMap(typeNode);
        const body = findChildByType(typeNode, 'class_body');
        if (!body) continue;

        const methods = getChildren(body).filter((child) => METHOD_DECLARATION_NODE_TYPES.includes(child.type));

        for (const methodNode of methods) {
            const currentMethodName = extractMethodName(methodNode);
            if (!currentMethodName) continue;

            const methodTypeMap = buildMethodTypeMap(methodNode);
            const invocations = CALL_NODE_TYPES.flatMap((nodeType) => findNodes(methodNode, nodeType));

            for (const invocation of invocations) {
                const resolvedSignals = await resolveInterProceduralCallSignals({
                    invocationNode: invocation,
                    currentTypeName,
                    fieldTypeMap,
                    methodTypeMap,
                    symbolTable,
                    maxCallChainDepth,
                    ...(packageName ? { packageName } : {}),
                });
                signals.push(...resolvedSignals);
            }
        }
    }
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
export async function scanJavaKotlinAst(
    filePath: string,
    content: string,
    options?: ScanJavaKotlinAstOptions,
): Promise<FileScanResult> {
    const sha256 = createHash('sha256').update(content).digest('hex');
    const isKotlin = filePath.endsWith('.kt') || filePath.endsWith('.kts');
    const language = isKotlin ? 'kotlin' : 'java';

    // 2-1-C1: Kotlin 파일에는 kotlin grammar 사용 (이전: Java grammar로 파싱하여 대부분 실패)
    const parserLang: SupportedLanguage = isKotlin ? 'kotlin' : 'java';
    const parser = await getWasmParser(parserLang);
    const tree = parser.parse(content);
    const root = tree.rootNode;

    const packageName = extractPackageName(root);
    const varMap = buildVariableMap(root, options?.propertyMap);
    const signals: ExtractedSignal[] = [];

    processSpringControllerMappings(root, signals);
    processSpringMappingAnnotations(root, signals);
    processFeignClientInterfaces(root, signals);
    processMethodInvocations(root, varMap, signals);
    if (options?.interProcedural?.symbolTable) {
        await processInterProceduralMethodInvocations(
            root,
            packageName,
            options.interProcedural.symbolTable,
            options.interProcedural.maxCallChainDepth,
            signals,
        );
    }

    const result: FileScanResult = packageName
        ? { language, sha256, packageName, signals }
        : { language, sha256, signals };

    return result;
}
