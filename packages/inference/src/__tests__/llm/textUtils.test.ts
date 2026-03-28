import { describe, expect, it } from 'vitest';
import { truncateOptionalText, truncateText } from '@/llm/textUtils';

describe('textUtils', () => {
  it('길이가 충분히 짧으면 원문을 유지해야 한다', () => {
    expect(truncateText('hello', 10, '...')).toBe('hello');
  });

  it('길이를 초과하면 suffix를 붙여 잘라야 한다', () => {
    expect(truncateText('abcdefghij', 5, '...')).toBe('abcde...');
  });

  it('옵셔널 텍스트가 없으면 fallback을 반환해야 한다', () => {
    expect(truncateOptionalText(null, 10, '(없음)', '...')).toBe('(없음)');
  });

  it('옵셔널 텍스트가 있으면 truncateText와 동일하게 처리해야 한다', () => {
    expect(truncateOptionalText('abcdefghij', 5, '(없음)', '...')).toBe('abcde...');
  });
});
