export function eventBody(
  event: {
    title: string;
    body: string;
    audience: string;
  },
  ownerName: string,
  own: boolean,
  attackerName?: string,
) {
  if (event.audience !== 'personal') return event.body;
  if (event.title === '飞船被击毁') {
    if (own) return '你的飞船已被击毁，请在当前页查看返航或淘汰安排。';
    return attackerName
      ? `${attackerName}击毁了${ownerName}的飞船。`
      : `${ownerName}的飞船已被击毁。`;
  }
  if (event.title === '本次目击未产生击毁' && !own)
    return `${ownerName}提交了一次目击，本次未产生击毁。`;
  if (event.title === '永久淘汰' && !own)
    return `${ownerName}已永久淘汰。${event.body.match(/观战等待\d+秒。/)?.[0] ?? ''}`;
  if (event.title === '赛事通知' && !own) return `${ownerName}收到裁判通知：“${event.body}”`;
  if (ownerName && event.body.startsWith(ownerName))
    return own ? `你${event.body.slice(ownerName.length)}` : event.body;
  if (!own && ownerName && !event.body.includes(ownerName))
    return `${ownerName}收到消息：“${event.body}”`;
  return event.body;
}
