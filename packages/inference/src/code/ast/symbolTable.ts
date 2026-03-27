import { readFileSync, readdirSync, statSync } from 'fs';
import { extname, join } from 'path';
import type { SyntaxNode } from 'web-tree-sitter';
import { extractStringValue, findChildByType, findNodes, getChildren } from './astScanner';
import { getWasmParser, type SupportedLanguage } from './wasmParser';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'target',
  '__pycache__',
  '.gradle',
  'out',
  'coverage',
]);

const IDENTIFIER_NODE_TYPES = new Set(['identifier', 'simple_identifier', 'type_identifier']);
const CALL_NODE_TYPES = ['method_invocation', 'call_expression'];
const METHOD_DECLARATION_NODE_TYPES = ['method_declaration', 'function_declaration'];
const FIELD_DECLARATION_NODE_TYPES = ['field_declaration', 'property_declaration'];

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

export interface AstProjectSymbolTable {
  symbolsByFqcn: Map<string, AstTypeSymbol>;
  simpleNameIndex: Map<string, string[]>;
  implementationMap: Map<string, string[]>;
  methodCallsByType: Map<string, Map<string, AstDirectHttpCall[]>>;
}

function findFiles(dir: string, predicate: (path: string) => boolean): string[] {
  const results: string[] = [];

  function walk(current: string) {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const fullPath = join(current, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile() && predicate(fullPath)) {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
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

function packageNameOfJavaLike(root: SyntaxNode): string | undefined {
  const packageNode = findNodes(root, 'package_declaration')[0];
  if (!packageNode) return undefined;

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

function buildStringVariableMap(root: SyntaxNode): Map<string, string> {
  const map = new Map<string, string>();
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
        map.set(nameNode.text, value);
      }
    }
  }

  return map;
}

function resolveStringArg(argNode: SyntaxNode, valueMap: Map<string, string>): string | null {
  if (argNode.type === 'string_literal') {
    return extractStringValue(argNode);
  }
  if (argNode.type === 'identifier') {
    return valueMap.get(argNode.text) ?? null;
  }
  return null;
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
  valueMap: Map<string, string>,
): AstDirectHttpCall[] {
  const calls: AstDirectHttpCall[] = [];
  const methodInvocations = CALL_NODE_TYPES.flatMap((nodeType) => findNodes(methodNode, nodeType));

  for (const invocation of methodInvocations) {
    const parsed = parseMethodInvocation(invocation);
    if (!parsed || !parsed.receiverName || !parsed.argList) continue;

    const objectName = parsed.receiverName;
    const methodName = parsed.methodName;
    const firstArg = getFirstArg(parsed.argList);
    const url = firstArg ? resolveStringArg(firstArg, valueMap) : null;

    if (/^restTemplate$/i.test(objectName) && url) {
      calls.push({
        symbol: url,
        confidence: 0.9,
        metadata: { client: 'RestTemplate', method: methodName },
      });
      continue;
    }

    if (methodName === 'uri' && /webClient/i.test(objectName) && url) {
      calls.push({
        symbol: url,
        confidence: 0.9,
        metadata: { client: 'WebClient', method: methodName },
      });
      continue;
    }

    if (methodName === 'uri' && /restClient/i.test(objectName) && url) {
      calls.push({
        symbol: url,
        confidence: 0.9,
        metadata: { client: 'RestClient', method: methodName },
      });
      continue;
    }

    if (objectName === 'RestClient' && methodName === 'create' && url) {
      calls.push({
        symbol: url,
        confidence: 0.9,
        metadata: { client: 'RestClient', method: 'create' },
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

function collectJavaLikeMethodCalls(
  table: AstProjectSymbolTable,
  root: SyntaxNode,
) {
  const packageName = packageNameOfJavaLike(root);
  const valueMap = buildStringVariableMap(root);
  const declarationNodes = [
    ...findNodes(root, 'class_declaration'),
    ...findNodes(root, 'interface_declaration'),
  ];

  for (const declarationNode of declarationNodes) {
    const ownerNameNode = firstIdentifier(declarationNode);
    if (!ownerNameNode) continue;

    const ownerFqcn = buildFqcn(ownerNameNode.text, packageName);
    const body = findChildByType(
      declarationNode,
      declarationNode.type === 'interface_declaration' ? 'interface_body' : 'class_body',
    );
    if (!body) continue;

    const methodNodes = getChildren(body).filter((child) => METHOD_DECLARATION_NODE_TYPES.includes(child.type));
    for (const methodNode of methodNodes) {
      const methodNameNode = extractJavaLikeMethodNameNode(methodNode);
      if (!methodNameNode) continue;
      registerMethodCalls(
        table,
        ownerFqcn,
        methodNameNode.text,
        collectJavaMethodDirectHttpCalls(methodNode, valueMap),
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

    const kind = node.type === 'interface_declaration' ? 'interface' : 'class';
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
}): Promise<AstProjectSymbolTable> {
  const targetFiles = normalizeTargetFiles(input.targetFilePaths);
  const filePaths = findAstCandidateFiles(input.repoRoot).filter((filePath) =>
    targetFiles === null || targetFiles.has(filePath.replace(/\\/g, '/')));

  const table: AstProjectSymbolTable = {
    symbolsByFqcn: new Map(),
    simpleNameIndex: new Map(),
    implementationMap: new Map(),
    methodCallsByType: new Map(),
  };

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
      const symbols = collectSymbolsFromTree(tree.rootNode, filePath, language);
      for (const symbol of symbols) {
        registerSymbol(table, symbol);
      }
      if (language === 'java' || language === 'kotlin') {
        collectJavaLikeMethodCalls(table, tree.rootNode);
      }
    } catch {
      continue;
    }
  }

  buildImplementationMap(table);
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
