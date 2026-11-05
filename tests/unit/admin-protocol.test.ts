import { describe, expect, it } from 'vitest';
import {
  checksum,
  siteUrl,
  nextRecoveryAction,
  assertReleaseSafe,
} from '../../scripts/admin-protocol.mjs';
describe('中文运维向导的恢复协议', () => {
  it('摘要不受JSON属性顺序影响，内容变化可检测', () => {
    expect(checksum({ b: 2, a: 1 })).toBe(checksum({ a: 1, b: 2 }));
    expect(checksum({ a: 1 })).not.toBe(checksum({ a: 2 }));
  });
  it('恢复请求结果未知时只建议查状态，不重复启动', () => {
    expect(nextRecoveryAction('saved')).toBe('launch');
    expect(nextRecoveryAction('launch-unknown')).toBe('status');
    expect(nextRecoveryAction('complete')).toBe('website-review');
  });
  it('站点核验拒绝远端HTTP、URL凭据及混入路径', () => {
    expect(siteUrl('http://127.0.0.1:8788').origin).toBe('http://127.0.0.1:8788');
    for (const url of [
      'http://game.test',
      'https://user:secret@game.test',
      'https://game.test/api/recovery',
    ])
      expect(() => siteUrl(url)).toThrow();
  });
  it('进行中的正式比赛阻止发布检查，试玩与完赛不混淆', () => {
    expect(() =>
      assertReleaseSafe({ matches: [{ kind: 'official', summary: '{"phase":"forest"}' }] }),
    ).toThrow('正式比赛尚未完赛');
    expect(() =>
      assertReleaseSafe({
        matches: [
          { kind: 'official', summary: '{"phase":"ended"}' },
          { kind: 'trial', summary: '{"phase":"forest"}' },
        ],
      }),
    ).not.toThrow();
  });
});
