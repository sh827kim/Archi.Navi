import { describe, expect, it } from 'vitest';
import { isAbsoluteScanPathPrefix } from '@/lib/scanPathPrefix';

describe('isAbsoluteScanPathPrefix', () => {
  it('POSIX 절대 경로를 허용해야 한다', () => {
    expect(isAbsoluteScanPathPrefix('/repo')).toBe(true);
  });

  it('Windows 드라이브 절대 경로를 허용해야 한다', () => {
    expect(isAbsoluteScanPathPrefix('C:\\repo')).toBe(true);
    expect(isAbsoluteScanPathPrefix('D:/repo')).toBe(true);
  });

  it('Windows UNC 경로를 허용해야 한다', () => {
    expect(isAbsoluteScanPathPrefix('\\\\server\\share')).toBe(true);
  });

  it('상대 경로는 허용하지 않아야 한다', () => {
    expect(isAbsoluteScanPathPrefix('repo')).toBe(false);
    expect(isAbsoluteScanPathPrefix('./repo')).toBe(false);
  });
});
