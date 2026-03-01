import { describe, it, expect } from 'vitest';
import { cn } from '../../lib/utils';

describe('ui/lib/utils', () => {
  it('cn은 클래스명을 결합해야 한다', () => {
    expect(cn('px-2', 'py-1')).toBe('px-2 py-1');
  });

  it('cn은 falsey 값을 제거해야 한다', () => {
    expect(cn('px-2', undefined, null, false && 'hidden', 'py-1')).toBe('px-2 py-1');
  });

  it('cn은 tailwind 충돌 클래스를 병합해야 한다', () => {
    expect(cn('px-2', 'px-4', 'text-sm', 'text-lg')).toBe('px-4 text-lg');
  });
});
