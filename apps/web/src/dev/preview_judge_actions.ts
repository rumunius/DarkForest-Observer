import {RULES, type OperationResult} from '@darkforest/contracts';
import {scalarText} from '../../../../packages/contracts/src/backend';
import {ApiError} from '../data/http';
import type {
  PreviewActionContext,
  PreviewFeedback,
} from './preview_action_context';
import {buildArms} from './preview_fixtures';
import {previewEliminations, previewSite} from './preview_input';
/** Simulate judge forms after role checks; previews return before mutation and audit. */
export function applyPreviewJudgeAction(
  context: PreviewActionContext,
  feedback: PreviewFeedback,
): OperationResult | undefined {
  const {state, match, operation, previews} = context;
  const {path, payload} = operation;
  let title: string;
  let {message} = feedback;
  if (state.session?.role !== 'judge') {
    throw new ApiError('当前账号不能执行这项操作。', 403);
  }
  const permitted = state.session.permissions;
  const area = path.includes('/notices/')
    ? 'notices'
    : path.includes('/homeworld/')
      ? 'homeworlds'
      : path.includes('equipment')
        ? 'equipment'
        : '*';
  if (!permitted.includes('*') && !permitted.includes(area)) {
    throw new ApiError('当前职责不能执行这项操作。', 403);
  }
  if (path.endsWith('/preview')) {
    return createManagementPreview(context);
  }
  if (payload.preview_token) {
    const preview = previews.get(scalarText(payload.preview_token));
    if (!preview || preview.revision !== match.revision) {
      throw new ApiError('记录已更新，请重新预览并核对。', 409);
    }
    Object.assign(payload, preview.payload);
    previews.delete(scalarText(payload.preview_token));
  }
  if (path.includes('/homeworld/')) {
    verifyPreviewHomeworld(context, feedback);
    title = feedback.title;
  } else if (path.includes('/notices/')) {
    recordPreviewNotice(context, feedback, state.session.name);
    title = feedback.title;
  } else if (path === '/judge/pause' || path === '/judge/resume') {
    if (match.verification) {
      throw new ApiError('请先完成终局资格核验。', 409);
    }
    match.paused = path.endsWith('/pause');
    match.pauseReason = scalarText(payload.reason ?? '');
    title = match.paused ? '比赛已暂停' : '比赛已恢复';
  } else if (path === '/judge/hunt-finalize') {
    finalizePreviewHunt(context, feedback);
    title = feedback.title;
  } else if (path === '/judge/hunt-eliminate') {
    const target = state.civilizations.find(c => c.id === payload.target);
    if (!target || target.flight === 'eliminated') {
      throw new ApiError('该文明状态已更新，请重新核对。', 409);
    }
    target.flight = 'eliminated';
    target.arms = null;
    target.eliminatedAt = Date.now();
    target.eliminationReason = String(payload.reason_code);
    match.survivors--;
    title = '终局裁决已记录';
  } else if (path === '/judge/correction') {
    correctPreviewCivilization(context, feedback);
    title = feedback.title;
  } else if (/\/roster\/.+\/withdraw$/.test(path)) {
    const target = state.civilizations.find(c => c.id === path.split('/')[3]);
    if (
      !target ||
      !['setup', 'outfitting', 'countdown'].includes(match.stage)
    ) {
      throw new ApiError('当前不能登记赛前缺席。', 409);
    }
    target.flight = 'absent';
    target.arms = null;
    match.total--;
    title = '已登记赛前缺席';
  } else if (path === '/judge/equipment-correction') {
    correctPreviewEquipment(context, feedback);
    title = feedback.title;
  } else if (path === '/judge/site-config') {
    state.site = {
      ...state.site,
      ...previewSite(payload.site),
      version: state.site.version + 1,
    };
    title = '活动设置已保存';
  } else if (path.includes('/effects') && payload.revoke) {
    const effect = state.judge!.effects.find(e => e.id === payload.revoke);
    if (effect) {
      effect.active = false;
    }
    title = '临时效果已撤销';
  } else if (path.includes('/effects')) {
    state.judge!.effects.unshift({
      id: crypto.randomUUID(),
      target: String(payload.target),
      reason: String(payload.reason),
      untilUtcMs: Date.now() + Number(payload.seconds ?? 60) * 1000,
      operator: state.session.name,
      active: true,
    });
    title = '临时效果已建立';
  } else if (path.includes('/command/execute')) {
    title = '指令已执行';
    message = scalarText(payload.command ?? '查询完成');
  } else if (path.includes('/scheduler') || path.includes('/settle-due')) {
    state.judge!.scheduler.backlog = 0;
    state.judge!.scheduler.lastSuccessUtcMs = Date.now();
    title = '调度处理已完成';
  } else if (path.includes('arm-code-release')) {
    match.releaseAt = Date.parse(String(payload.time));
    title = '发码时间已安排';
  } else if (path.includes('arm-start')) {
    match.startAt = Date.parse(String(payload.time));
    title = '开赛时间已安排';
  } else {
    title = '管理操作已记录';
    message = '已保存本次变更原因及影响。';
  }
  state.judge!.audits.unshift({
    id: `AUD-${crypto.randomUUID()}`,
    title,
    operator: state.session.name,
    reason: scalarText(payload.reason ?? '按流程确认'),
    before: '操作前状态',
    after: message,
    gameMs: match.gameMs,
  });
  Object.assign(feedback, {title, message});
  return undefined;
}
/** Build a local form preview without advancing the simulated match revision. */
function createManagementPreview(
  context: PreviewActionContext,
): OperationResult {
  const {state, match, operation, previews} = context;
  const payload = operation.payload;
  const token = crypto.randomUUID();
  previews.set(token, {
    revision: match.revision,
    path: scalarText(payload.path ?? '/judge/command/execute'),
    payload,
  });
  const preview = {
    token,
    revision: match.revision,
    title: '操作影响预览',
    changes: [
      {
        target: scalarText(payload.target ?? payload.command ?? '本场比赛'),
        before: '当前已保存状态',
        after: scalarText(
          payload.change ?? payload.command ?? '按本次表单变更',
        ),
      },
    ],
    consequences: [
      '执行时将再次核验权限与记录版本。',
      '相关操作保留原因和审计记录。',
    ],
  };
  if (Array.isArray(payload.eliminations)) {
    preview.changes = previewEliminations(payload.eliminations).map(item => {
      const c = state.civilizations.find(c => c.id === item.id);
      return {
        target: `${item.id}（${c?.nickname ?? ''}）`,
        before: '存活文明',
        after:
          item.reason === 'outside_at_cutoff'
            ? '截止时未进入终局圈，永久淘汰'
            : '未按时加入位置共享，永久淘汰',
      };
    });
    if (!preview.changes.length) {
      preview.changes.push({
        target: '全部存活文明',
        before: '资格核验等待',
        after: '保留资格并结束核验暂停',
      });
    }
  }
  return {
    requestId: operation.requestId,
    status: 'complete',
    title: '请核对操作影响',
    message: '预览尚未改变比赛。',
    preview,
  };
}

/** Apply the current saved homeworld version decision in the simulator. */
function verifyPreviewHomeworld(
  context: PreviewActionContext,
  feedback: PreviewFeedback,
): void {
  const {state, operation} = context;
  const {path, payload} = operation;
  const target = state.civilizations.find(c => c.id === path.split('/')[3]);
  if (
    !target ||
    target.homeVersion !== payload.expected_version ||
    target.homeworld !== payload.expected_code ||
    target.flight !== 'pending'
  ) {
    throw new ApiError('这条登记已更新，请核对最新版本。', 409);
  }
  target.flight = payload.decision === 'approve' ? 'verified' : 'rejected';
  target.rejection = scalarText(payload.reason ?? '');
  feedback.title =
    payload.decision === 'approve' ? '母星审核通过' : '已退回修改';
}

/** Record a simulated notice action while keeping copy and send states distinct. */
function recordPreviewNotice(
  context: PreviewActionContext,
  feedback: PreviewFeedback,
  operator: string,
): void {
  const {state, operation} = context;
  const {path, payload} = operation;
  const notice = state.judge!.notices.find(n => n.id === path.split('/')[3]);
  if (!notice || notice.version !== payload.expected_version) {
    throw new ApiError('通知已更新，请核对最新状态。', 409);
  }
  notice.status = path.endsWith('/sent')
    ? 'sent'
    : path.endsWith('/error')
      ? 'error'
      : 'copied';
  notice.version++;
  notice.operator = operator;
  feedback.title =
    notice.status === 'sent'
      ? '已标记发送'
      : notice.status === 'copied'
        ? '已记录复制'
        : '已记录发送异常';
}

/** Finish the simulated cutoff batch before computing whether anyone survives. */
function finalizePreviewHunt(
  context: PreviewActionContext,
  feedback: PreviewFeedback,
): void {
  const {state, match, operation} = context;
  const {payload} = operation;
  const eliminations = previewEliminations(payload.eliminations);
  for (const item of eliminations) {
    const c = state.civilizations.find(c => c.id === item.id);
    if (c) {
      c.flight = 'eliminated';
      c.arms = null;
      c.eliminationReason = item.reason;
    }
  }
  match.verification = false;
  match.paused = false;
  match.pauseReason = '';
  feedback.title = '终局资格核验已完成';
  match.survivors = state.civilizations.filter(
    c => c.flight !== 'eliminated',
  ).length;
  if (match.survivors <= 1) {
    match.stage = 'ended';
    match.running = false;
    const living = state.civilizations.filter(c => c.flight !== 'eliminated');
    const standings = [
      ...living,
      ...state.civilizations.filter(c => c.flight === 'eliminated'),
    ].map((c, i) => ({...c, rank: i + 1, tied: false}));
    state.results = {
      version: 1,
      reason: living.length
        ? '本场仅余一个存活文明，提前完赛'
        : '全部文明已永久淘汰',
      champions: living.map(c => c.id),
      standings,
    };
  }
}

/** Apply a local nickname, resource or restoration correction to the selected civilization. */
function correctPreviewCivilization(
  context: PreviewActionContext,
  feedback: PreviewFeedback,
): void {
  const {state, match, operation} = context;
  const {payload} = operation;
  const target = state.civilizations.find(c => c.id === payload.target);
  if (!target) {
    throw new ApiError('请选择需要处理的文明。', 422);
  }
  const field = String(payload.field);
  const value = scalarText(payload.value ?? '');
  if (field === 'nickname') {
    if ([...value.trim()].length < 2 || [...value.trim()].length > 8) {
      throw new ApiError('昵称需要2至8个字符。', 422);
    }
    target.nickname = value;
  } else if (field === 'photons' || field === 'broadcasts') {
    if (!/^\d+$/.test(value)) {
      throw new ApiError('资源数量必须是非负整数。', 422);
    }
    if (field === 'photons') {
      target.photons = Number(value);
    } else {
      target.broadcasts = Number(value);
    }
  } else if (field === 'restore') {
    target.flight = 'returning';
    target.observerAllowed = false;
    target.eliminatedAt = null;
    target.respawnDeadline = Math.min(
      match.gameMs + 15 * 60000,
      RULES.apocalypseMs,
    );
    target.arms = null;
  }
  feedback.title = '文明信息已修正';
}

/** Simulate equipment replacement without exposing the production codebook. */
function correctPreviewEquipment(
  context: PreviewActionContext,
  feedback: PreviewFeedback,
): void {
  const {state, match, operation} = context;
  const {payload} = operation;
  const target = state.civilizations.find(c => c.id === payload.target);
  if (!target) {
    throw new ApiError('请选择需要处理的文明。', 422);
  }
  if (payload.mode === 'reissue') {
    if (!match.paused) {
      throw new ApiError('请先暂停比赛。', 409);
    }
    target.arms = buildArms(state.judge!.issuedCodes);
    target.flight = 'issued';
    state.judge!.issuedCodes++;
    feedback.title = '旧配置已注销，新配置待核对佩戴';
  } else {
    feedback.title = '同色同款手环替换已记录';
  }
}
