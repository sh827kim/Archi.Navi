import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execFileSyncMock = vi.fn();

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

// vi.mock은 호이스팅되어 정적 import보다 먼저 적용됨
import {
  checkGhAuth,
  listOrgRepos,
  cloneRepo,
  createTempDir,
  cleanupClone,
} from '@/utils/github-helper';

describe('github-helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('checkGhAuth: gh auth status 성공 시 통과해야 한다', () => {
    execFileSyncMock.mockReturnValueOnce('');
    expect(() => checkGhAuth()).not.toThrow();
    expect(execFileSyncMock).toHaveBeenCalledWith('gh', ['auth', 'status'], { stdio: 'pipe' });
  });

  it('checkGhAuth: 실패 시 안내 메시지 에러를 던져야 한다', () => {
    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error('not logged in');
    });
    expect(() => checkGhAuth()).toThrow('gh CLI 인증이 필요합니다.');
  });

  it('listOrgRepos: JSON 파싱 결과를 반환해야 한다', () => {
    execFileSyncMock
      .mockReturnValueOnce('') // checkGhAuth
      .mockReturnValueOnce(JSON.stringify([{ name: 'repo-a', url: 'https://example/repo-a' }]));
    const repos = listOrgRepos('my-org');
    expect(repos).toEqual([{ name: 'repo-a', url: 'https://example/repo-a' }]);
  });

  it('listOrgRepos: 실패 시 org 포함 에러를 던져야 한다', () => {
    execFileSyncMock
      .mockReturnValueOnce('') // checkGhAuth
      .mockImplementationOnce(() => {
        throw new Error('api error');
      });
    expect(() => listOrgRepos('my-org')).toThrow("Org 'my-org' 레포 목록 조회 실패");
  });

  it('listOrgRepos: Error가 아닌 예외도 문자열로 변환해 에러를 던져야 한다', () => {
    execFileSyncMock
      .mockReturnValueOnce('') // checkGhAuth
      .mockImplementationOnce(() => {
        throw 'api failed as string';
      });
    expect(() => listOrgRepos('my-org')).toThrow('api failed as string');
  });

  it('cloneRepo: gh clone 명령을 호출해야 한다', () => {
    execFileSyncMock
      .mockReturnValueOnce('') // checkGhAuth
      .mockReturnValueOnce('');
    cloneRepo('owner/repo', '/tmp/owner-repo');
    expect(execFileSyncMock).toHaveBeenLastCalledWith(
      'gh',
      ['repo', 'clone', 'owner/repo', '/tmp/owner-repo', '--', '--depth', '1'],
      { stdio: 'pipe' },
    );
  });

  it('cloneRepo: 실패 시 레포명을 포함한 에러를 던져야 한다', () => {
    execFileSyncMock
      .mockReturnValueOnce('') // checkGhAuth
      .mockImplementationOnce(() => {
        throw new Error('clone failed');
      });
    expect(() => cloneRepo('owner/repo', '/tmp/owner-repo')).toThrow("'owner/repo' 클론 실패");
  });

  it('cloneRepo: Error가 아닌 예외도 문자열로 변환해 에러를 던져야 한다', () => {
    execFileSyncMock
      .mockReturnValueOnce('') // checkGhAuth
      .mockImplementationOnce(() => {
        throw 42;
      });
    expect(() => cloneRepo('owner/repo', '/tmp/owner-repo')).toThrow('42');
  });

  it('createTempDir/cleanupClone 동작을 확인해야 한다', () => {
    const dir = createTempDir('test');
    expect(existsSync(dir)).toBe(true);
    cleanupClone(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('cleanupClone: 없는 경로여도 예외 없이 종료해야 한다', () => {
    const path = join(tmpdir(), 'anavi-cleanup-not-exists');
    rmSync(path, { recursive: true, force: true });
    expect(() => cleanupClone(path)).not.toThrow();
  });

  it('createTempDir는 prefix를 포함한 디렉터리를 생성해야 한다', () => {
    const dir = createTempDir('prefix');
    expect(dir).toContain('archi-navi-prefix-');
    expect(existsSync(dir)).toBe(true);
    mkdirSync(dir, { recursive: true });
    rmSync(dir, { recursive: true, force: true });
  });
});
