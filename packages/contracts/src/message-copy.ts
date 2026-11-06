// Player-facing copy follows 完整策划案 §§3.2, 4.2, 5.1, 7.4, 8.2–8.3.
export const PREPARE_COPY =
  '请打开本人官网领取首航两臂手环颜色配置。\n在安全位置按图示戴好3—4条手环，其余收入口袋，点击「穿戴就绪」。\n现在不允许目击攻击，请等待统一正式开赛。';
export const START_COUNTDOWN_COPY =
  '全体文明穿戴已经就绪，官网倒计时归零后开战。\n正式开赛后，必须本人在现场重新亲眼观察对手两臂手环才可攻击。';
export const APOCALYPSE_COPY =
  '一场灾难降临到了整个宇宙。\n所有人的母星已于刚刚同时毁灭，所有人将无法重生！\n如果你现在尚未正常出航，你已经被淘汰了！';
export const TRANSFER_COPY =
  '目击攻击暂停。\n请加入比赛QQ群的「共享实时位置」，正常步行进入终局圈。\n请在比赛时间98:00前入圈，并持续共享位置。';
export const HUNT_REVIEW_COPY =
  '终局资格确认中，比赛计时已暂停。\n请保持QQ群位置共享，等待裁判完成核验。';
export const HUNT_START_COPY =
  '最后狩猎开始，目击攻击恢复。\n请在终局圈内正常步行，持续共享位置，亲眼观察对手两臂手环后发动攻击。';
export const OBSERVER_AGREEMENT_COPY = '四维世界的信息不得传递给仍然存活的三维文明。';

export function messageDuration(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60}分钟` : `${seconds}秒`;
}
export function gameTimeCopy(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
export function dimensionCopy(waitSeconds: number): string {
  return `你的三维文明已经永久毁灭，但意识仍残留在更高的维度。\n请在安全位置摘下全部比赛手环，尽快步行返回中控室。\n宇宙观测将在永久淘汰满${messageDuration(waitSeconds)}后开放。\n你可以观察宇宙、与其他四维文明交流，并向裁判提出高维干涉建议。\n${OBSERVER_AGREEMENT_COPY}`;
}
export function eliminationCopy(identity: string, waitSeconds: number, directOut = false): string {
  return `文明${identity}，${directOut ? '本次提交的手环颜色有误，你已永久淘汰。' : '你已永久淘汰。'}\n${dimensionCopy(waitSeconds)}`;
}
export function shipDestroyedCopy(identity: string): string {
  return `文明${identity}，你的当前飞船刚刚被击毁，本航次手环配置已失效。\n请在安全位置立即摘下全部比赛手环，打开本人官网查看状态和后续行动。`;
}
export function homeDestroyedCopy(identity: string, code: string): string {
  return `文明${identity}，你的母星${code}已被摧毁，你将无法重生。\n请打开本人官网查看状态和后续行动。`;
}
export function techBurstCopy(identity: string): string {
  return `文明${identity}，你的文明刚刚发生了技术爆炸，已升级为高级文明，获得1枚舰载光粒，正常出航时可以秘密发射。`;
}
export function broadcastCopy(identity: string, code: string): string {
  return `文明${identity}发送了一条坐标广播${code}，该坐标已暴露给全宇宙。`;
}
export function reverseListeningCopy(
  recipient: string,
  code: string,
  broadcaster: string,
  broadcasterHome: string,
): string {
  return `文明${recipient}，你的母星坐标${code}已被正式广播给全宇宙。\n广播你的文明是${broadcaster}。\n你的反向监听系统截获了它的母星坐标${broadcasterHome}。`;
}
export function clearingCopy(kind: 'singer' | 'photon', code: string, identity?: string): string {
  const action = kind === 'singer' ? '歌者刚才清理了' : '观测到一颗光粒命中了';
  return `${action}坐标${code}，${identity ? `文明${identity}的母星已毁灭。` : '未摧毁任何现存母星。'}`;
}
export function qqCopy(title: string, body: string): string {
  return `【${title}】\n${body}`;
}

export function eventBody(
  event: { title: string; body: string; audience: string },
  ownerName: string,
  own: boolean,
  attackerName?: string,
) {
  if (event.audience !== 'personal') return event.body;
  if (event.title === '飞船被击毁') {
    if (own)
      return event.body.startsWith(`文明${ownerName}，`)
        ? event.body.slice(`文明${ownerName}，`.length)
        : shipDestroyedCopy('').slice('文明，'.length);
    return attackerName
      ? `${attackerName}击毁了${ownerName}的飞船。`
      : `${ownerName}的飞船已被击毁。`;
  }
  if (['本次目击未产生击毁', '禁止攻击', '直接出局'].includes(event.title) && !own)
    return `${ownerName}提交了一次目击，本次未产生击毁。`;
  if (event.title === '永久淘汰' && !own) return `${ownerName}已永久淘汰，成为四维观察者。`;
  if (event.title === '赛事通知' && !own) return `${ownerName}收到裁判通知：“${event.body}”`;
  const salutation = `文明${ownerName}，`;
  if (ownerName && event.body.startsWith(salutation)) {
    const body = event.body.slice(salutation.length);
    if (own) return body;
    if (event.title === '技术爆炸')
      return `文明${ownerName}刚刚发生了技术爆炸，已升级为高级文明，获得1枚舰载光粒。`;
    return `${ownerName}收到消息：“${body}”`;
  }
  if (ownerName && event.body.startsWith(ownerName))
    return own ? `你${event.body.slice(ownerName.length)}` : event.body;
  if (!own && ownerName && !event.body.includes(ownerName))
    return `${ownerName}收到消息：“${event.body}”`;
  return event.body;
}
