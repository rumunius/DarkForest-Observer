import {eliminationCopy} from '../../../../packages/contracts/src/message_copy';
import {ApiError} from '../data/http';
import type {
  PreviewActionContext,
  PreviewFeedback,
} from './preview_action_context';
import {validPreviewArms} from './preview_input';

/** Apply the explicitly selected preview outcome; this does not implement server random selection. */
export function applyPreviewSighting(
  context: PreviewActionContext,
  feedback: PreviewFeedback,
): void {
  const {state, sightingResult, operation} = context;
  const playerState = state.player!;
  const payload = operation.payload;
  let title: string;
  let message: string;
  let {code} = feedback;
  if (!validPreviewArms(payload.arm_a, payload.arm_b)) {
    throw new ApiError('手环颜色组合不完整。', 422);
  }
  if (sightingResult === 'hit') {
    title = '已击毁目标飞船';
    message = 'C12（漂流者）的母星情报已加入你的记录。';
    code = '739216';
  } else {
    title = '本次目击未产生击毁';
    message = '本次目击未产生击毁。';
    if (sightingResult === 'wrong') {
      playerState.wrongCount++;
      if (playerState.wrongCount >= 3) {
        playerState.flight = 'eliminated';
        playerState.homeAlive = false;
        playerState.arms = null;
        playerState.actions = [];
        playerState.eliminatedAt = Date.now();
        playerState.eliminationReason = '第三次提交错误的手环颜色';
        title = '直接出局';
        message = eliminationCopy(
          `${playerState.id}（${playerState.nickname}）`,
          180,
          true,
        );
      } else {
        const minutes = playerState.wrongCount === 1 ? 5 : 15;
        playerState.attackLockedUntil = Date.now() + minutes * 60000;
        playerState.actions = playerState.actions.filter(a => a !== 'sighting');
        title = '禁止攻击';
        message = `本次提交的手环颜色有误。\n累计错误：${playerState.wrongCount}次。禁止目击攻击：${minutes}分钟。\n恢复攻击时间：${new Date(playerState.attackLockedUntil).toLocaleTimeString('zh-CN', {timeZone: 'Asia/Shanghai', hour12: false})}。`;
      }
    }
  }
  Object.assign(feedback, {title, message, code});
}
