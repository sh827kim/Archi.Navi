import { readFileSync } from 'fs';
import { extname } from 'path';
import type { SyntaxNode } from 'web-tree-sitter';
import { extractStringValue, findChildByType, findNodes, getChildren } from './astScanner';
import { getWasmParser, type SupportedLanguage } from './wasmParser';
import type { AstPropertyMap, AstPropertyResolver } from './propertyResolver';
import { resolveValueExpression } from './propertyResolver';
import { findFiles } from '../../utils/fileDiscovery';

const IDENTIFIER_NODE_TYPES = new Set(['identifier', 'simple_identifier', 'type_identifier']);
const CALL_NODE_TYPES = ['method_invocation', 'call_expression'];
const METHOD_DECLARATION_NODE_TYPES = ['method_declaration', 'function_declaration'];
const FIELD_DECLARATION_NODE_TYPES = ['field_declaration', 'property_declaration'];
const VALUE_ANNOTATION_REGEX = /@(?:field:)?Value\s*\(\s*"([^"]+)"\s*\)/;

type AstProjectLanguage = SupportedLanguage | 'javascript';

export interface AstTypeSymbol {
  kind: 'class' | 'interface';
  name: string;
  fqcn: string;
  packageName?: string;
  filePath: string;
  language: AstProjectLanguage;
  extendsTypes: string[];
  implementsTypes: string[];
}

export interface AstDirectHttpCall {
  symbol: string;
  confidence: number;
  metadata: Record<string, unknown>;
}

export interface AstMethodCallTarget {
  typeName: string;
  methodName: string;
}

export interface AstProjectSymbolTable {
  symbolsByFqcn: Map<string, AstTypeSymbol>;
  simpleNameIndex: Map<string, string[]>;
  implementationMap: Map<string, string[]>;
  methodCallsByType: Map<string, Map<string, AstDirectHttpCall[]>>;
  methodCallTargetsByType: Map<string, Map<string, AstMethodCallTarget[]>>;
}

function findAstCandidateFiles(repoRoot: string): string[] {
  return findFiles(repoRoot, (filePath) => {
    const ext = extname(filePath).toLowerCase();
    return ['.java', '.kt', '.ts', '.tsx', '.js', '.jsx', '.py'].includes(ext);
  });
}

function normalizeTargetFiles(targetFilePaths?: string[]): Set<string> | null {
  if (!targetFilePaths || targetFilePaths.length === 0) return null;
  return new Set(targetFilePaths.map((filePath) => filePath.replace(/\\/g, '/')));
}

function detectLanguage(filePath: string): AstProjectLanguage | null {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.java') return 'java';
  if (ext === '.kt') return 'kotlin';
  if (ext === '.ts' || ext === '.tsx') return 'typescript';
  if (ext === '.js' || ext === '.jsx') return 'javascript';
  if (ext === '.py') return 'python';
  return null;
}

function parserLanguageOf(language: AstProjectLanguage): SupportedLanguage {
  if (language === 'javascript') return 'typescript';
  return language;
}

function firstNamedChild(node: SyntaxNode, types: string[]): SyntaxNode | null {
  return getChildren(node).find((child) => types.includes(child.type)) ?? null;
}

function isIdentifierNode(node: SyntaxNode): boolean {
  return IDENTIFIER_NODE_TYPES.has(node.type);
}

function firstIdentifier(node: SyntaxNode): SyntaxNode | null {
  return firstNamedChild(node, ['identifier', 'type_identifier', 'simple_identifier']);
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

function packageNameOfJavaLike(root: SyntaxNode): string | undefined {
  const packageNode = findNodes(root, 'package_declaration')[0];
  if (!packageNode) {
    const match = root.text.match(/^\s*package\s+([\w.]+)/m);
    return match?.[1];
  }

  const match = packageNode.text.match(/package\s+([\w.]+)/);
  return match?.[1];
}

function headerOf(nodeText: string): string {
  return nodeText.split('{', 1)[0]?.trim() ?? nodeText.trim();
}

function splitTypeList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => part.replace(/<.*?>/g, '').trim())
    .map((part) => part.replace(/^\w+\s+/, '').trim())
    .map((part) => part.split(/\s+/)[0] ?? '')
    .filter((part) => part.length > 0)
    .map((part) => part.replace(/[():]/g, '').trim());
}

function parseKotlinInheritance(header: string): string[] {
  let parenDepth = 0;
  let angleDepth = 0;

  for (let index = 0; index < header.length; index += 1) {
    const char = header[index];

    if (char === '(') {
      parenDepth += 1;
      continue;
    }
    if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }
    if (char === '<') {
      angleDepth += 1;
      continue;
    }
    if (char === '>') {
      angleDepth = Math.max(0, angleDepth - 1);
      continue;
    }
    if (char === ':' && parenDepth === 0 && angleDepth === 0) {
      return splitTypeList(header.slice(index + 1));
    }
  }

  return [];
}

function parseJavaLikeInheritance(
  kind: 'class' | 'interface',
  declarationText: string,
): { extendsTypes: string[]; implementsTypes: string[] } {
  const header = headerOf(declarationText);
  const extendsMatch = header.match(/\bextends\s+([^{]+)/);
  const implementsMatch = header.match(/\bimplements\s+([^{]+)/);

  if (kind === 'interface') {
    return {
      extendsTypes: splitTypeList(extendsMatch?.[1] ?? ''),
      implementsTypes: [],
    };
  }

  const kotlinInheritance = parseKotlinInheritance(header);

  return {
    extendsTypes: splitTypeList(extendsMatch?.[1] ?? ''),
    implementsTypes: implementsMatch
      ? splitTypeList(implementsMatch[1] ?? '')
      : kotlinInheritance,
  };
}

function parseTypeScriptInheritance(
  kind: 'class' | 'interface',
  declarationText: string,
): { extendsTypes: string[]; implementsTypes: string[] } {
  const header = headerOf(declarationText);
  const extendsMatch = header.match(/\bextends\s+([^{]+)/);
  const implementsMatch = header.match(/\bimplements\s+([^{]+)/);

  return {
    extendsTypes: splitTypeList(extendsMatch?.[1] ?? ''),
    implementsTypes: kind === 'class' ? splitTypeList(implementsMatch?.[1] ?? '') : [],
  };
}

function parsePythonInheritance(declarationText: string): string[] {
  const header = declarationText.split(':', 1)[0] ?? declarationText;
  const basesMatch = header.match(/class\s+\w+\(([^)]*)\)/);
  return splitTypeList(basesMatch?.[1] ?? '');
}

function buildFqcn(name: string, packageName?: string): string {
  return packageName ? `${packageName}.${name}` : name;
}

function registerSymbol(
  table: AstProjectSymbolTable,
  symbol: AstTypeSymbol,
) {
  table.symbolsByFqcn.set(symbol.fqcn, symbol);

  const existing = table.simpleNameIndex.get(symbol.name) ?? [];
  if (!existing.includes(symbol.fqcn)) {
    existing.push(symbol.fqcn);
    table.simpleNameIndex.set(symbol.name, existing);
  }
}

function resolveTypeReference(
  table: AstProjectSymbolTable,
  typeName: string,
  packageName?: string,
): string {
  if (table.symbolsByFqcn.has(typeName)) return typeName;

  if (packageName) {
    const packageScoped = `${packageName}.${typeName}`;
    if (table.symbolsByFqcn.has(packageScoped)) return packageScoped;
  }

  const candidates = table.simpleNameIndex.get(typeName) ?? [];
  if (candidates.length === 1) return candidates[0]!;

  return typeName;
}

export function getTypeSymbol(
  table: AstProjectSymbolTable,
  typeName: string,
  packageName?: string,
): AstTypeSymbol | null {
  const resolvedType = resolveTypeReference(table, typeName, packageName);
  return table.symbolsByFqcn.get(resolvedType) ?? null;
}

function buildImplementationMap(table: AstProjectSymbolTable) {
  for (const symbol of table.symbolsByFqcn.values()) {
    if (symbol.kind !== 'class') continue;

    for (const rawInterfaceName of symbol.implementsTypes) {
      const resolvedInterface = resolveTypeReference(table, rawInterfaceName, symbol.packageName);
      const implementations = table.implementationMap.get(resolvedInterface) ?? [];
      if (!implementations.includes(symbol.fqcn)) {
        implementations.push(symbol.fqcn);
        table.implementationMap.set(resolvedInterface, implementations);
      }
    }
  }
}

interface ResolvedStringVariableMap {
  values: Map<string, string>;
  propertyBackedVariables: Set<string>;
}

function buildStringVariableMap(root: SyntaxNode, propertyMap?: AstPropertyMap): ResolvedStringVariableMap {
  const values = new Map<string, string>();
  const propertyBackedVariables = new Set<string>();
  const declarations = [
    ...findNodes(root, 'local_variable_declaration'),
    ...findNodes(root, 'field_declaration'),
    ...findNodes(root, 'property_declaration'),
  ];

  for (const declaration of declarations) {
    const declarators = getChildren(declaration).filter((child) =>
      child.type === 'variable_declarator' || child.type === 'variable_declaration');
    for (const declarator of declarators) {
      const nameNode = getChildren(declarator).find(isIdentifierNode);
      const valueNode = getChildren(declarator).find((child) => child.type === 'string_literal');
      const value = valueNode ? extractStringValue(valueNode) : null;
      if (nameNode && value) {
        values.set(nameNode.text, value);
      }
    }
  }

  if (propertyMap) {
    for (const declaration of declarations) {
      const valueExpression = declaration.text.match(VALUE_ANNOTATION_REGEX)?.[1];
      if (!valueExpression) continue;

      const resolvedValue = resolveValueExpression(valueExpression, propertyMap);
      if (!resolvedValue) continue;

      const declarators = getChildren(declaration).filter((child) =>
        child.type === 'variable_declarator' || child.type === 'variable_declaration');
      for (const declarator of declarators) {
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

function resolveStringArg(
  argNode: SyntaxNode,
  valueMap: ResolvedStringVariableMap,
): { value: string; resolvedVia: 'literal' | 'variable' | 'property' } | null {
  if (argNode.type === 'string_literal') {
    const value = extractStringValue(argNode);
    if (!value || value.includes('${')) {
      return null;
    }
    return { value, resolvedVia: 'literal' };
  }
  if (argNode.type === 'identifier') {
    const value = valueMap.values.get(argNode.text);
    if (!value) return null;
    return {
      value,
      resolvedVia: valueMap.propertyBackedVariables.has(argNode.text) ? 'property' : 'variable',
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
  const stringLiterals = [...argText.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]!.trim());
  const configKeys = [...new Set(
    [...argText.matchAll(/\$\{([^}:]+)(?::[^}]*)?\}/g)].map((match) => match[1]!.trim()).filter(Boolean),
  )];
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
  const hasConfigPlaceholder = configKeys.length > 0;

  return {
    methodHint: inferHttpMethodFromReceiver(receiverName),
    ...(pathHint ? { pathHint } : {}),
    ...(hostLiteral ? { hostHint: hostLiteral } : {}),
    ...(serviceNameHintMatch ? { serviceNameHint: serviceNameHintMatch[1] } : {}),
    ...(baseUrlVarMatch ? { baseUrlVar: baseUrlVarMatch[1] } : {}),
    ...(configKeys.length > 0 ? { configKeys } : {}),
    dynamicPath: pathHint !== null
      || /[+{]|UriComponentsBuilder|toUriString\s*\(/.test(expressionText)
      || hasConfigPlaceholder,
    dynamicHost: /[+{]|baseUrl|host|uriBuilder/i.test(expressionText) || hasConfigPlaceholder,
    unsupportedPattern: true,
  };
}

function getFirstArg(argList: SyntaxNode): SyntaxNode | null {
  const argNode = getChildren(argList).find(
    (child) => child.type !== '(' && child.type !== ')' && child.type !== ',' && child.type !== ' ',
  ) ?? null;
  return argNode ? unwrapArgumentNode(argNode) : null;
}

function unwrapArgumentNode(argNode: SyntaxNode): SyntaxNode {
  if (argNode.type !== 'value_argument') return argNode;
  return getChildren(argNode).find(
    (child) => child.type !== '(' && child.type !== ')' && child.type !== ',' && child.type !== ' ',
  ) ?? argNode;
}

interface ParsedMethodInvocation {
  receiverName: string | null;
  methodName: string;
  argList: SyntaxNode | null;
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
      argList,
    };
  }

  if (node.type === 'call_expression' && objectNode.type === 'navigation_expression') {
    const identifierNodes = getChildren(objectNode).filter(isIdentifierNode);
    if (identifierNodes.length >= 2) {
      return {
        receiverName: identifierNodes[0]?.text ?? null,
        methodName: identifierNodes.at(-1)?.text ?? '',
        argList,
      };
    }
  }

  const identifierNode = children.find(isIdentifierNode);
  if (!identifierNode) return null;
  return {
    receiverName: null,
    methodName: identifierNode.text,
    argList,
  };
}

function collectJavaMethodDirectHttpCalls(
  methodNode: SyntaxNode,
  valueMap: ResolvedStringVariableMap,
): AstDirectHttpCall[] {
  const calls: AstDirectHttpCall[] = [];
  const methodInvocations = CALL_NODE_TYPES.flatMap((nodeType) => findNodes(methodNode, nodeType));

  for (const invocation of methodInvocations) {
    const parsed = parseMethodInvocation(invocation);
    if (!parsed || !parsed.receiverName || !parsed.argList) continue;

    const objectName = parsed.receiverName;
    const methodName = parsed.methodName;
    const firstArg = getFirstArg(parsed.argList);
    const resolvedArg = firstArg ? resolveStringArg(firstArg, valueMap) : null;
    const url = resolvedArg?.value ?? null;

    if (/^restTemplate$/i.test(objectName) && url) {
      calls.push({
        symbol: url,
        confidence: 0.9,
        metadata: {
          client: 'RestTemplate',
          method: methodName,
          resolvedUrl: url,
          resolvedVia: resolvedArg?.resolvedVia ?? 'literal',
        },
      });
      continue;
    }

    if (methodName === 'uri' && /webClient/i.test(objectName) && url) {
      calls.push({
        symbol: url,
        confidence: 0.9,
        metadata: {
          client: 'WebClient',
          method: inferHttpMethodFromReceiver(objectName) ?? methodName,
          resolvedUrl: url,
          resolvedVia: resolvedArg?.resolvedVia ?? 'literal',
        },
      });
      continue;
    }

    if (methodName === 'uri' && /webClient/i.test(objectName) && firstArg) {
      const metadata: Record<string, unknown> = {
        client: 'WebClient',
        method: inferHttpMethodFromReceiver(objectName) ?? methodName,
        ...buildPartialHttpMetadata(objectName, firstArg.text),
      };
      const fallbackSymbol = firstArg.type === 'string_literal'
        ? extractStringValue(firstArg) ?? firstArg.text
        : firstArg.text;
      calls.push({
        symbol: typeof metadata['pathHint'] === 'string'
          ? metadata['pathHint'] as string
          : (typeof metadata['hostHint'] === 'string' ? metadata['hostHint'] as string : fallbackSymbol),
        confidence: 0.9,
        metadata,
      });
      continue;
    }

    if (methodName === 'uri' && /restClient/i.test(objectName) && url) {
      calls.push({
        symbol: url,
        confidence: 0.9,
        metadata: {
          client: 'RestClient',
          method: inferHttpMethodFromReceiver(objectName) ?? methodName,
          resolvedUrl: url,
          resolvedVia: resolvedArg?.resolvedVia ?? 'literal',
        },
      });
      continue;
    }

    if (methodName === 'uri' && /restClient/i.test(objectName) && firstArg) {
      const metadata: Record<string, unknown> = {
        client: 'RestClient',
        method: inferHttpMethodFromReceiver(objectName) ?? methodName,
        ...buildPartialHttpMetadata(objectName, firstArg.text),
      };
      const fallbackSymbol = firstArg.type === 'string_literal'
        ? extractStringValue(firstArg) ?? firstArg.text
        : firstArg.text;
      calls.push({
        symbol: typeof metadata['pathHint'] === 'string'
          ? metadata['pathHint'] as string
          : (typeof metadata['hostHint'] === 'string' ? metadata['hostHint'] as string : fallbackSymbol),
        confidence: 0.9,
        metadata,
      });
      continue;
    }

    if (objectName === 'RestClient' && methodName === 'create' && url) {
      calls.push({
        symbol: url,
        confidence: 0.9,
        metadata: {
          client: 'RestClient',
          method: 'create',
          resolvedUrl: url,
          resolvedVia: resolvedArg?.resolvedVia ?? 'literal',
        },
      });
      continue;
    }

    if (objectName === 'RestClient' && methodName === 'create' && firstArg) {
      const metadata: Record<string, unknown> = {
        client: 'RestClient',
        method: 'create',
        ...buildPartialHttpMetadata(objectName, firstArg.text),
      };
      const fallbackSymbol = firstArg.type === 'string_literal'
        ? extractStringValue(firstArg) ?? firstArg.text
        : firstArg.text;
      calls.push({
        symbol: typeof metadata['pathHint'] === 'string'
          ? metadata['pathHint'] as string
          : (typeof metadata['hostHint'] === 'string' ? metadata['hostHint'] as string : fallbackSymbol),
        confidence: 0.9,
        metadata,
      });
    }
  }

  return calls;
}

function registerMethodCalls(
  table: AstProjectSymbolTable,
  ownerFqcn: string,
  methodName: string,
  directCalls: AstDirectHttpCall[],
) {
  if (directCalls.length === 0) return;

  const methodsForType = table.methodCallsByType.get(ownerFqcn) ?? new Map<string, AstDirectHttpCall[]>();
  const existing = methodsForType.get(methodName) ?? [];
  methodsForType.set(methodName, [...existing, ...directCalls]);
  table.methodCallsByType.set(ownerFqcn, methodsForType);
}

function registerMethodCallTargets(
  table: AstProjectSymbolTable,
  ownerFqcn: string,
  methodName: string,
  targets: AstMethodCallTarget[],
) {
  if (targets.length === 0) return;

  const methodsForType = table.methodCallTargetsByType.get(ownerFqcn) ?? new Map<string, AstMethodCallTarget[]>();
  const existing = methodsForType.get(methodName) ?? [];
  methodsForType.set(methodName, [...existing, ...targets]);
  table.methodCallTargetsByType.set(ownerFqcn, methodsForType);
}

function javaLikeDeclarationKind(
  declarationNode: SyntaxNode,
  language: Extract<AstProjectLanguage, 'java' | 'kotlin'>,
): 'class' | 'interface' {
  if (declarationNode.type === 'interface_declaration') return 'interface';
  if (language === 'kotlin' && declarationNode.text.trimStart().startsWith('interface ')) {
    return 'interface';
  }
  return 'class';
}

function resolveInvocationTargetType(
  table: AstProjectSymbolTable,
  ownerFqcn: string,
  parsed: ParsedMethodInvocation,
  fieldTypeMap: Map<string, string>,
  methodTypeMap: Map<string, string>,
  packageName?: string,
): string | null {
  if (parsed.receiverName === null) return ownerFqcn;

  const rawTypeName = methodTypeMap.get(parsed.receiverName) ?? fieldTypeMap.get(parsed.receiverName);
  if (!rawTypeName) return null;

  return resolveTypeReference(table, rawTypeName, packageName);
}

function collectJavaMethodCallTargets(
  table: AstProjectSymbolTable,
  methodNode: SyntaxNode,
  ownerFqcn: string,
  fieldTypeMap: Map<string, string>,
  methodTypeMap: Map<string, string>,
  packageName?: string,
): AstMethodCallTarget[] {
  const targets: AstMethodCallTarget[] = [];
  const methodInvocations = CALL_NODE_TYPES.flatMap((nodeType) => findNodes(methodNode, nodeType));

  for (const invocation of methodInvocations) {
    const parsed = parseMethodInvocation(invocation);
    if (!parsed || isDirectClientInvocation(parsed)) continue;

    const targetTypeName = resolveInvocationTargetType(
      table,
      ownerFqcn,
      parsed,
      fieldTypeMap,
      methodTypeMap,
      packageName,
    );
    if (!targetTypeName) continue;

    targets.push({
      typeName: targetTypeName,
      methodName: parsed.methodName,
    });
  }

  return targets;
}

function collectJavaLikeMethodCalls(
  table: AstProjectSymbolTable,
  root: SyntaxNode,
  language: Extract<AstProjectLanguage, 'java' | 'kotlin'>,
  propertyMap?: AstPropertyMap,
) {
  const packageName = packageNameOfJavaLike(root);
  const valueMap = buildStringVariableMap(root, propertyMap);
  const declarationNodes = [
    ...findNodes(root, 'class_declaration'),
    ...findNodes(root, 'interface_declaration'),
  ];

  for (const declarationNode of declarationNodes) {
    const ownerNameNode = firstIdentifier(declarationNode);
    if (!ownerNameNode) continue;

    const ownerFqcn = buildFqcn(ownerNameNode.text, packageName);
    const kind = javaLikeDeclarationKind(declarationNode, language);
    const body = findChildByType(
      declarationNode,
      kind === 'interface' ? 'interface_body' : 'class_body',
    ) ?? findChildByType(declarationNode, 'class_body');
    if (!body) continue;

    const fieldTypeMap = buildFieldTypeMap(declarationNode);
    const methodNodes = getChildren(body).filter((child) => METHOD_DECLARATION_NODE_TYPES.includes(child.type));
    for (const methodNode of methodNodes) {
      const methodNameNode = extractJavaLikeMethodNameNode(methodNode);
      if (!methodNameNode) continue;
      const methodTypeMap = buildMethodTypeMap(methodNode);
      registerMethodCalls(
        table,
        ownerFqcn,
        methodNameNode.text,
        collectJavaMethodDirectHttpCalls(methodNode, valueMap),
      );
      registerMethodCallTargets(
        table,
        ownerFqcn,
        methodNameNode.text,
        collectJavaMethodCallTargets(
          table,
          methodNode,
          ownerFqcn,
          fieldTypeMap,
          methodTypeMap,
          packageName,
        ),
      );
    }
  }
}

function extractJavaLikeMethodNameNode(methodNode: SyntaxNode): SyntaxNode | null {
  return getChildren(methodNode).find((child) => child.type === 'identifier' || child.type === 'simple_identifier') ?? null;
}

function collectJavaLikeSymbols(
  root: SyntaxNode,
  filePath: string,
  language: Extract<AstProjectLanguage, 'java' | 'kotlin'>,
): AstTypeSymbol[] {
  const packageName = packageNameOfJavaLike(root);
  const declarationNodes = [
    ...findNodes(root, 'class_declaration'),
    ...findNodes(root, 'interface_declaration'),
  ];

  return declarationNodes.flatMap((node) => {
    const nameNode = firstIdentifier(node);
    if (!nameNode) return [];

    const kind = javaLikeDeclarationKind(node, language);
    const inheritance = parseJavaLikeInheritance(kind, node.text);

    return [{
      kind,
      name: nameNode.text,
      fqcn: buildFqcn(nameNode.text, packageName),
      ...(packageName ? { packageName } : {}),
      filePath,
      language,
      extendsTypes: inheritance.extendsTypes,
      implementsTypes: inheritance.implementsTypes,
    }];
  });
}

function collectTypeScriptSymbols(
  root: SyntaxNode,
  filePath: string,
  language: Extract<AstProjectLanguage, 'typescript' | 'javascript'>,
): AstTypeSymbol[] {
  const declarationNodes = [
    ...findNodes(root, 'class_declaration'),
    ...findNodes(root, 'interface_declaration'),
  ];

  return declarationNodes.flatMap((node) => {
    const nameNode = firstIdentifier(node);
    if (!nameNode) return [];

    const kind = node.type === 'interface_declaration' ? 'interface' : 'class';
    const inheritance = parseTypeScriptInheritance(kind, node.text);

    return [{
      kind,
      name: nameNode.text,
      fqcn: nameNode.text,
      filePath,
      language,
      extendsTypes: inheritance.extendsTypes,
      implementsTypes: inheritance.implementsTypes,
    }];
  });
}

function collectPythonSymbols(root: SyntaxNode, filePath: string): AstTypeSymbol[] {
  const declarationNodes = findNodes(root, 'class_definition');

  return declarationNodes.flatMap((node) => {
    const nameNode = firstIdentifier(node);
    if (!nameNode) return [];

    return [{
      kind: 'class' as const,
      name: nameNode.text,
      fqcn: nameNode.text,
      filePath,
      language: 'python' as const,
      extendsTypes: parsePythonInheritance(node.text),
      implementsTypes: [],
    }];
  });
}

function collectSymbolsFromTree(
  root: SyntaxNode,
  filePath: string,
  language: AstProjectLanguage,
): AstTypeSymbol[] {
  if (language === 'java' || language === 'kotlin') {
    return collectJavaLikeSymbols(root, filePath, language);
  }
  if (language === 'typescript' || language === 'javascript') {
    return collectTypeScriptSymbols(root, filePath, language);
  }
  return collectPythonSymbols(root, filePath);
}

export async function buildProjectSymbolTable(input: {
  repoRoot: string;
  targetFilePaths?: string[];
  propertyResolver?: AstPropertyResolver;
}): Promise<AstProjectSymbolTable> {
  const targetFiles = normalizeTargetFiles(input.targetFilePaths);
  const filePaths = findAstCandidateFiles(input.repoRoot).filter((filePath) =>
    targetFiles === null || targetFiles.has(filePath.replace(/\\/g, '/')));

  const table: AstProjectSymbolTable = {
    symbolsByFqcn: new Map(),
    simpleNameIndex: new Map(),
    implementationMap: new Map(),
    methodCallsByType: new Map(),
    methodCallTargetsByType: new Map(),
  };
  const parsedFiles: Array<{
    filePath: string;
    language: AstProjectLanguage;
    root: SyntaxNode;
  }> = [];

  for (const filePath of filePaths) {
    const language = detectLanguage(filePath);
    if (!language) continue;

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    try {
      const parser = await getWasmParser(parserLanguageOf(language));
      const tree = parser.parse(content);
      parsedFiles.push({ filePath, language, root: tree.rootNode });
      const symbols = collectSymbolsFromTree(tree.rootNode, filePath, language);
      for (const symbol of symbols) {
        registerSymbol(table, symbol);
      }
    } catch {
      continue;
    }
  }

  buildImplementationMap(table);
  for (const parsedFile of parsedFiles) {
    if (parsedFile.language !== 'java' && parsedFile.language !== 'kotlin') continue;
    collectJavaLikeMethodCalls(
      table,
      parsedFile.root,
      parsedFile.language,
      input.propertyResolver?.resolveForFile(parsedFile.filePath),
    );
  }
  return table;
}

export function getImplementationsForInterface(
  table: AstProjectSymbolTable,
  interfaceName: string,
  packageName?: string,
): AstTypeSymbol[] {
  const resolvedInterface = resolveTypeReference(table, interfaceName, packageName);
  const implementationNames = table.implementationMap.get(resolvedInterface) ?? [];
  return implementationNames
    .map((implementationName) => table.symbolsByFqcn.get(implementationName))
    .filter((symbol): symbol is AstTypeSymbol => symbol !== undefined);
}

export function getSingleImplementationForInterface(
  table: AstProjectSymbolTable,
  interfaceName: string,
  packageName?: string,
): AstTypeSymbol | null {
  const implementations = getImplementationsForInterface(table, interfaceName, packageName);
  return implementations.length === 1 ? implementations[0]! : null;
}

export function resolveJavaDepthOneCallTargets(
  table: AstProjectSymbolTable,
  input: { typeName: string; methodName: string; packageName?: string },
): AstDirectHttpCall[] {
  const resolvedTypeName = resolveTypeReference(table, input.typeName, input.packageName);
  const directCalls = table.methodCallsByType.get(resolvedTypeName)?.get(input.methodName) ?? [];
  if (directCalls.length > 0) return directCalls;

  const targetSymbol = table.symbolsByFqcn.get(resolvedTypeName);
  if (targetSymbol?.kind !== 'interface') return [];

  const implementations = table.implementationMap.get(resolvedTypeName) ?? [];
  if (implementations.length !== 1) return [];

  return table.methodCallsByType.get(implementations[0]!)?.get(input.methodName) ?? [];
}

export interface AstResolvedJavaCallTarget extends AstDirectHttpCall {
  callChainDepth: number;
}

function toResolvedJavaCallTarget(
  call: AstDirectHttpCall,
  options: {
    callChainDepth: number;
    interfaceImpl?: string;
    ambiguous?: boolean;
    confidencePenalty?: number;
  },
): AstResolvedJavaCallTarget {
  const baseConfidence = call.confidence * Math.pow(0.9, options.callChainDepth);
  const adjustedConfidence = Math.max(
    0.1,
    Math.min(0.99, baseConfidence - (options.confidencePenalty ?? 0)),
  );
  const metadata: Record<string, unknown> = {
    ...call.metadata,
    resolvedUrl: call.symbol,
    resolvedVia: call.metadata['resolvedVia'] ?? 'call_chain',
    callChainDepth: options.callChainDepth,
  };
  if (options.interfaceImpl !== undefined) {
    metadata['interfaceImpl'] = options.interfaceImpl;
  }
  if (options.ambiguous !== undefined) {
    metadata['ambiguous'] = options.ambiguous;
  }
  return {
    symbol: call.symbol,
    confidence: adjustedConfidence,
    metadata,
    callChainDepth: options.callChainDepth,
  };
}

export function resolveJavaCallTargets(
  table: AstProjectSymbolTable,
  input: { typeName: string; methodName: string; packageName?: string; maxDepth: number },
): AstResolvedJavaCallTarget[] {
  const maxDepth = Math.max(1, input.maxDepth);
  const initialTypeName = resolveTypeReference(table, input.typeName, input.packageName);
  const stack: Array<{
    typeName: string;
    methodName: string;
    depth: number;
    interfaceImpl?: string;
    ambiguous?: boolean;
    confidencePenalty?: number;
    traversalContext: string;
  }> = [{
    typeName: initialTypeName,
    methodName: input.methodName,
    depth: 1,
    traversalContext: `${initialTypeName}::${input.methodName}`,
  }];
  const visited = new Set<string>();
  const results: AstResolvedJavaCallTarget[] = [];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const visitKey =
      `${current.typeName}::${current.methodName}::${current.depth}::${current.traversalContext}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);

    const currentSymbol = table.symbolsByFqcn.get(current.typeName);
    if (currentSymbol?.kind === 'interface') {
      const implementations = table.implementationMap.get(current.typeName) ?? [];
      if (implementations.length === 0) continue;

      if (implementations.length === 1) {
        const implementation = table.symbolsByFqcn.get(implementations[0]!);
        const nextState: typeof current = {
          typeName: implementations[0]!,
          methodName: current.methodName,
          depth: current.depth,
          interfaceImpl: implementation?.name ?? implementations[0]!,
          ambiguous: false,
          traversalContext: `${current.traversalContext}->${implementations[0]}::${current.methodName}`,
        };
        if (current.confidencePenalty !== undefined) {
          nextState.confidencePenalty = current.confidencePenalty;
        }
        stack.push(nextState);
        continue;
      }

      for (const implementationName of implementations) {
        const implementation = table.symbolsByFqcn.get(implementationName);
        stack.push({
          typeName: implementationName,
          methodName: current.methodName,
          depth: current.depth,
          interfaceImpl: implementation?.name ?? implementationName,
          ambiguous: true,
          confidencePenalty: (current.confidencePenalty ?? 0) + 0.1,
          traversalContext: `${current.traversalContext}->${implementationName}::${current.methodName}`,
        });
      }
      continue;
    }

    const directCalls = table.methodCallsByType.get(current.typeName)?.get(current.methodName) ?? [];
    for (const directCall of directCalls) {
      results.push(toResolvedJavaCallTarget(directCall, {
        callChainDepth: current.depth,
        ...(current.interfaceImpl !== undefined ? { interfaceImpl: current.interfaceImpl } : {}),
        ...(current.ambiguous !== undefined ? { ambiguous: current.ambiguous } : {}),
        ...(current.confidencePenalty !== undefined ? { confidencePenalty: current.confidencePenalty } : {}),
      }));
    }

    if (current.depth >= maxDepth) continue;

    const nestedCalls = table.methodCallTargetsByType.get(current.typeName)?.get(current.methodName) ?? [];
    for (const nestedCall of nestedCalls) {
      const nestedTypeName = resolveTypeReference(table, nestedCall.typeName);
      const nestedSymbol = table.symbolsByFqcn.get(nestedTypeName);

      if (nestedSymbol?.kind === 'interface') {
        const implementations = table.implementationMap.get(nestedTypeName) ?? [];
        if (implementations.length === 0) continue;

        if (implementations.length === 1) {
          const implementation = table.symbolsByFqcn.get(implementations[0]!);
          const nextState: typeof current = {
            typeName: implementations[0]!,
            methodName: nestedCall.methodName,
            depth: current.depth + 1,
            interfaceImpl: implementation?.name ?? implementations[0]!,
            ambiguous: false,
            traversalContext:
              `${current.traversalContext}->${implementations[0]}::${nestedCall.methodName}`,
          };
          if (current.confidencePenalty !== undefined) {
            nextState.confidencePenalty = current.confidencePenalty;
          }
          stack.push(nextState);
          continue;
        }

        for (const implementationName of implementations) {
          const implementation = table.symbolsByFqcn.get(implementationName);
          stack.push({
            typeName: implementationName,
            methodName: nestedCall.methodName,
            depth: current.depth + 1,
            interfaceImpl: implementation?.name ?? implementationName,
            ambiguous: true,
            confidencePenalty: (current.confidencePenalty ?? 0) + 0.1,
            traversalContext:
              `${current.traversalContext}->${implementationName}::${nestedCall.methodName}`,
          });
        }
        continue;
      }

      const nextState: typeof current = {
        typeName: nestedTypeName,
        methodName: nestedCall.methodName,
        depth: current.depth + 1,
        traversalContext: `${current.traversalContext}->${nestedTypeName}::${nestedCall.methodName}`,
      };
      if (current.interfaceImpl !== undefined) {
        nextState.interfaceImpl = current.interfaceImpl;
      }
      if (current.ambiguous !== undefined) {
        nextState.ambiguous = current.ambiguous;
      }
      if (current.confidencePenalty !== undefined) {
        nextState.confidencePenalty = current.confidencePenalty;
      }
      stack.push(nextState);
    }
  }

  return results;
}
