import {validCode, type Action} from '@darkforest/contracts';
import {scalarText} from '../../../../packages/contracts/src/backend';
import {
  broadcastCopy,
  clearingCopy,
} from '../../../../packages/contracts/src/message_copy';
import {ApiError} from '../data/http';
import type {
  PreviewActionContext,
  PreviewFeedback,
} from './preview_action_context';
import {applyPreviewSighting} from './preview_sighting';
/** Simulate the player's next permitted step; the source owns revision and receipt storage. */
export function applyPreviewPlayerAction(
  context: PreviewActionContext,
  feedback: PreviewFeedback,
): void {
  const {state, match, operation} = context;
  const playerState = state.player;
  const {path, payload} = operation;
  const action = path.split('/').pop() as Action;
  let {title, message, code} = feedback;
  if (
    !playerState ||
    !playerState.actions.includes(action === 'nickname' ? 'nickname' : action)
  ) {
    throw new ApiError('比赛状态已更新，请查看当前可用行动。', 409);
  }
  if (
    ['homeworld-submit', 'broadcast', 'photon'].includes(action) &&
    !validCode(scalarText(payload.code ?? ''))
  ) {
    throw new ApiError('请输入6位数字', 422);
  }
  switch (action) {
    case 'nickname': {
      const name = scalarText(payload.nickname ?? '').trim();
      if ([...name].length < 2 || [...name].length > 8) {
        throw new ApiError('昵称需要2至8个字符。', 422);
      }
      playerState.nickname = name;
      playerState.flight = 'unregistered';
      playerState.actions = ['homeworld-submit'];
      title = '昵称已确认';
      break;
    }
    case 'homeworld-submit':
      playerState.homeworld = String(payload.code);
      playerState.homeVersion++;
      playerState.flight = 'pending';
      title = '母星口令已保存';
      message = '请复制登记消息，发送给裁判并附上现场照片。';
      break;
    case 'preflight-depart':
      playerState.flight = 'departed';
      playerState.actions = ['preflight-stage'];
      title = '已确认离开母星';
      break;
    case 'preflight-stage':
      playerState.flight = 'staged';
      playerState.actions = [];
      match.releaseAt = Date.now() + 30000;
      title = '准备完成，等待发码';
      break;
    case 'preflight-issue-code':
      playerState.flight = 'outfitting';
      playerState.arms = [['BK', 'OR'], ['WH']];
      playerState.actions = ['preflight-ready'];
      title = '手环配置已领取';
      break;
    case 'preflight-ready':
      playerState.flight = 'ready';
      playerState.actions = [];
      match.startAt = Date.now() + 30000;
      title = '已确认穿戴就绪';
      break;
    case 'return-confirm':
      playerState.flight = 'preparing';
      playerState.actions = ['issue-code'];
      title = '照片发送情况已确认';
      break;
    case 'issue-code':
      playerState.flight = 'issued';
      playerState.arms = [['BK', 'OR', 'SB'], ['GY']];
      playerState.actions = ['launch'];
      title = '新手环配置已领取';
      break;
    case 'launch':
      playerState.flight = 'active';
      playerState.flightNumber++;
      playerState.respawnDeadline = null;
      playerState.actions = [
        'sighting',
        ...(playerState.broadcasts > 0 ? ['broadcast' as const] : []),
        ...(playerState.photons > 0 ? ['photon' as const] : []),
        'withdraw',
      ];
      title = '出航完成';
      break;
    case 'withdraw':
      playerState.flight = 'eliminated';
      playerState.homeAlive = false;
      playerState.actions = [];
      playerState.arms = null;
      playerState.eliminatedAt = Date.now();
      playerState.eliminationReason = '主动退出比赛';
      title = '已退出比赛';
      break;
    case 'broadcast': {
      code = String(payload.code);
      if (state.events.some(e => e.kind === 'broadcast' && e.code === code)) {
        throw new ApiError('这组六位口令已被广播。', 409);
      }
      playerState.broadcasts--;
      if (!playerState.broadcasts) {
        playerState.actions = playerState.actions.filter(
          a => a !== 'broadcast',
        );
      }
      title = '广播已发布';
      message = `广播剩余${playerState.broadcasts}次。`;
      state.events.unshift({
        id: `EVT-${crypto.randomUUID()}`,
        kind: 'broadcast',
        title: '坐标广播',
        body: broadcastCopy(
          `${playerState.id}（${playerState.nickname}）`,
          code,
        ),
        code,
        audience: 'public',
        gameMs: match.gameMs,
        utcMs: Date.now(),
        civilizationIds: [playerState.id],
      });
      break;
    }
    case 'photon':
      playerState.photons--;
      playerState.actions = playerState.actions.filter(a => a !== 'photon');
      title = '光粒已发射';
      code = String(payload.code);
      message = clearingCopy('photon', code);
      break;
    case 'sighting': {
      applyPreviewSighting(context, feedback);
      ({title, message, code} = feedback);
      break;
    }

    default:
      // Validated actions outside this preview switch retain the existing no-op.
      break;
  }
  Object.assign(feedback, {title, message, code});
}
