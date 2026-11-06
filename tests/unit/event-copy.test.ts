import { describe, expect, it } from 'vitest';
import { eventBody } from '../../apps/match-worker/src/projections/event-copy';
import { shipDestroyedCopy, techBurstCopy } from '../../packages/contracts/src/message-copy';

describe('消息按收件人与查看者显示', () => {
  const owner = 'C07（你好）';
  it('自然技术爆炸和资源消息保留昵称原文，本人显示第二人称', () => {
    const event = { title: '技术爆炸', audience: 'personal', body: techBurstCopy(owner) };
    expect(eventBody(event, owner, false)).toBe(
      `文明${owner}刚刚发生了技术爆炸，已升级为高级文明，获得1枚舰载光粒。`,
    );
    expect(eventBody(event, owner, true)).toBe(
      '你的文明刚刚发生了技术爆炸，已升级为高级文明，获得1枚舰载光粒，正常出航时可以秘密发射。',
    );
    expect(eventBody({ ...event, body: `${owner}获得一枚光粒。` }, owner, true)).toBe(
      '你获得一枚光粒。',
    );
  });
  it('裁判查看私人通知时注明实际收件人并保留原文', () => {
    const event = { title: '赛事通知', audience: 'personal', body: '请摘下你的手环并联系裁判。' };
    expect(eventBody(event, owner, false)).toBe(`${owner}收到裁判通知：“${event.body}”`);
    expect(eventBody(event, owner, true)).toBe(event.body);
  });
  it('全局查看击毁事件显示双方，本人不读取隐藏的击毁者', () => {
    const event = { title: '飞船被击毁', audience: 'personal', body: shipDestroyedCopy(owner) };
    expect(eventBody(event, owner, false, 'C01（猎人）')).toBe(`C01（猎人）击毁了${owner}的飞船。`);
    expect(eventBody(event, owner, true, 'C01（猎人）')).not.toContain('猎人');
  });
});
