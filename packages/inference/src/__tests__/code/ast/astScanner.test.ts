import { describe, it, expect } from 'vitest';
import type { SyntaxNode } from 'web-tree-sitter';
import { findChildByType, getChildren, extractStringValue } from '@/code/ast/astScanner';

interface FakeNodeInput {
  type: string;
  text?: string;
  children?: Array<FakeNode | null>;
}

interface FakeNode {
  type: string;
  text: string;
  childCount: number;
  child: (index: number) => FakeNode | null;
}

function makeNode(input: FakeNodeInput): SyntaxNode {
  const children = input.children ?? [];
  const node: FakeNode = {
    type: input.type,
    text: input.text ?? '',
    childCount: children.length,
    child: (index) => children[index] ?? null,
  };
  return node as unknown as SyntaxNode;
}

describe('astScanner helpers', () => {
  it('findChildByType는 자식이 없으면 null을 반환해야 한다', () => {
    const root = makeNode({ type: 'root', children: [makeNode({ type: 'a' })] });
    expect(findChildByType(root, 'missing')).toBeNull();
  });

  it('getChildren는 null 자식을 제외하고 반환해야 한다', () => {
    const childA = makeNode({ type: 'a' });
    const childB = makeNode({ type: 'b' });
    const root = makeNode({ type: 'root', children: [childA as unknown as FakeNode, null, childB as unknown as FakeNode] });
    const children = getChildren(root);
    expect(children).toHaveLength(2);
    expect(children.map((n) => n.type)).toEqual(['a', 'b']);
  });

  it('extractStringValue는 text가 비어있으면 null을 반환해야 한다', () => {
    const empty = makeNode({ type: 'string', text: '' });
    expect(extractStringValue(empty)).toBeNull();
  });

  it('extractStringValue는 Python triple double quote를 파싱해야 한다', () => {
    const triple = makeNode({ type: 'string', text: '"""hello"""' });
    expect(extractStringValue(triple)).toBe('hello');
  });

  it('extractStringValue는 Python triple single quote를 파싱해야 한다', () => {
    const triple = makeNode({ type: 'string', text: "'''world'''" });
    expect(extractStringValue(triple)).toBe('world');
  });

  it('extractStringValue는 보간 없는 template literal을 반환해야 한다', () => {
    const tmpl = makeNode({ type: 'template_string', text: '`https://api.local`' });
    expect(extractStringValue(tmpl)).toBe('https://api.local');
  });

  it('extractStringValue는 보간이 있는 template literal이면 null을 반환해야 한다', () => {
    const tmpl = makeNode({ type: 'template_string', text: '`https://${host}`' });
    expect(extractStringValue(tmpl)).toBeNull();
  });

  it('extractStringValue는 지원하지 않는 형식이면 null을 반환해야 한다', () => {
    const raw = makeNode({ type: 'identifier', text: 'SOME_CONST' });
    expect(extractStringValue(raw)).toBeNull();
  });
});

