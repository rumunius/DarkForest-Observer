import {
  RULES,
  type DataSource,
  type Operation,
  type OperationResult,
  type Snapshot,
} from '@darkforest/contracts';
import {
  eventBody,
  gameTimeCopy,
  qqCopy,
} from '../../../../packages/contracts/src/message_copy';
import {ApiError} from '../data/http';
import type {
  PreviewActionContext,
  PreviewFeedback,
  SavedPreview,
} from './preview_action_context';
import type {PreviewRole} from './preview_fixtures';
import {createPreviewSnapshot} from './preview_fixtures';
import {applyPreviewJudgeAction} from './preview_judge_actions';
import {applyPreviewPlayerAction} from './preview_player_actions';

function delay() {
  return new Promise<void>(resolve => setTimeout(resolve, 180));
}

/** Local fixtures only. This module is reachable exclusively from preview.tsx. */
export class MockSource implements DataSource {
  private state!: Snapshot;
  private origin = performance.now();
  private readonly results = new Map<string, OperationResult>();
  private readonly previews = new Map<string, SavedPreview>();
  private sightingResult = 'hit';
  private fault = 'none';
  private pendingOperation: Operation | null = null;

  constructor() {
    this.reset('player', 'active');
  }

  setFault(fault: string) {
    this.fault = fault;
  }

  setSightingResult(value: string) {
    this.sightingResult = value;
  }

  reset(role: PreviewRole, scenario: string) {
    this.results.clear();

    this.previews.clear();

    this.fault = 'none';

    this.pendingOperation = null;

    this.origin = performance.now();
    this.state = createPreviewSnapshot(role, scenario);
  }

  private reconcile() {
    const match = this.state.match!;
    const now = Date.now();
    const elapsed = performance.now() - this.origin;
    this.origin = performance.now();
    match.serverUtcMs = now;
    if (match.running && !match.paused) {
      match.gameMs += elapsed;
    }
    const playerState = this.state.player;
    if (
      playerState?.flight === 'eliminated' &&
      playerState.eliminatedAt &&
      now >= playerState.eliminatedAt + RULES.observerWaitMs
    ) {
      playerState.observerAllowed = true;
    }
    if (
      playerState?.flight === 'active' &&
      playerState.attackLockedUntil &&
      now >= playerState.attackLockedUntil &&
      !match.paused &&
      ['forest', 'apocalypse', 'hunt'].includes(match.stage)
    ) {
      playerState.attackLockedUntil = 0;
      if (!playerState.actions.includes('sighting')) {
        playerState.actions.unshift('sighting');
      }
    }
    if (
      playerState?.flight === 'staged' &&
      match.releaseAt &&
      now >= match.releaseAt &&
      !playerState.actions.includes('preflight-issue-code')
    ) {
      match.stage = 'outfitting';
      playerState.actions = ['preflight-issue-code'];
      match.revision++;
    }
    if (
      playerState?.flight === 'ready' &&
      match.startAt &&
      now >= match.startAt
    ) {
      match.stage = 'forest';
      match.running = true;
      playerState.flight = 'active';
      playerState.actions = ['sighting', 'broadcast', 'withdraw'];
      match.revision++;
    }
    if (
      playerState &&
      ['returning', 'preparing', 'issued'].includes(playerState.flight) &&
      playerState.respawnDeadline !== null &&
      match.gameMs >= playerState.respawnDeadline
    ) {
      playerState.flight = 'eliminated';
      playerState.actions = [];
      playerState.arms = null;
      playerState.eliminatedAt = now;
      playerState.eliminationReason = '未在统一截止前完成重生';
      match.revision++;
    }
  }

  async read(route: string): Promise<Snapshot> {
    await delay();
    if (this.fault === 'offline') {
      throw new ApiError('连接已中断，正在重新连接。', 503);
    }
    if (this.fault === 'expired') {
      throw new ApiError('请重新登录。', 401);
    }
    this.reconcile();
    const out = structuredClone(this.state);
    const judge = out.session?.role === 'judge';
    const global =
      (route.startsWith('/observer') && !!out.player?.observerAllowed) ||
      (route.startsWith('/results') && out.match?.stage === 'ended') ||
      (route.startsWith('/display') && judge) ||
      (route.startsWith('/judge') && judge);
    if (!global) {
      out.civilizations = [];
      out.results = null;
      out.events = out.events
        .filter(e => e.audience !== 'global')
        .map(e => {
          const projected = {...e};
          if (e.kind === 'photon') {
            delete projected.actor;
          }
          return projected;
        });
    }
    out.events = out.events.map(event => {
      const owner = event.recipient ?? event.civilizationIds[0];
      const civilization =
        out.civilizations.find(c => c.id === owner) ??
        this.state.civilizations.find(c => c.id === owner);
      const identity = civilization
        ? `${civilization.id}（${civilization.nickname}）`
        : (owner ?? '');
      return {
        ...event,
        body: eventBody(event, identity, !judge && owner === out.player?.id),
      };
    });
    if (!route.startsWith('/judge') || !judge) {
      out.judge = null;
    }
    if (judge) {
      out.player = null;
      out.intel = [];
    }
    return out;
  }

  async login(credential: string, judge: boolean) {
    await delay();
    if (!credential.trim()) {
      throw new ApiError('请输入参赛口令。', 400);
    }
    this.reset(judge ? 'chief' : 'player', 'active');
  }

  async logout() {
    await delay();
    this.state.session = null;
    this.state.player = null;
  }

  async template(kind: string) {
    await delay();
    const playerState = this.state.player!;
    if (!playerState) {
      throw new ApiError('当前账号不能获取此消息。', 403);
    }
    return kind === 'homeworld'
      ? qqCopy(
          '母星登记',
          `文明${playerState.id}（${playerState.nickname}）请求在${playerState.homeworld}登记母星（提交版本：${playerState.homeVersion}），以下是我的母星现场时间水印照片：`,
        )
      : kind === 'respawn'
        ? qqCopy(
            '重生',
            `文明${playerState.id}（${playerState.nickname}）已返回母星，请求重生，以下是我的母星现场时间水印照片：`,
          )
        : qqCopy(
            '异常申报',
            `文明${playerState.id}（${playerState.nickname}）请求裁判协助。\n比赛时间：${gameTimeCopy(this.state.match!.gameMs)}。\n现场情况：`,
          );
  }

  async result(requestId: string) {
    await delay();
    if (this.pendingOperation?.requestId === requestId) {
      const op = this.pendingOperation;
      this.pendingOperation = null;
      return this.apply(op);
    }
    return (
      this.results.get(requestId) ?? {
        requestId,
        status: 'pending' as const,
        title: '正在确认上一次操作结果',
        message: '正在确认上一次操作的结果。',
      }
    );
  }

  async submit(operation: Operation): Promise<OperationResult> {
    await delay();
    if (this.fault === 'offline') {
      throw new ApiError('连接已中断，正在重新连接。', 503);
    }
    if (this.results.has(operation.requestId)) {
      return this.results.get(operation.requestId)!;
    }
    if (this.fault === 'unknown') {
      this.pendingOperation = operation;
      this.fault = 'none';
      return {
        requestId: operation.requestId,
        status: 'pending',
        title: '正在确认上一次操作结果',
        message: '请求已受理，正在等待结算结果。',
      };
    }
    return this.apply(operation);
  }

  private apply(operation: Operation): OperationResult {
    this.reconcile();
    const match = this.state.match!;
    const path = operation.path;
    const feedback: PreviewFeedback = {
      title: '操作已完成',
      message: '比赛状态已更新。',
      code: undefined,
    };
    const context: PreviewActionContext = {
      state: this.state,
      match,
      operation,
      previews: this.previews,
      sightingResult: this.sightingResult,
    };
    if (path.startsWith('/action/') || path === '/player/nickname') {
      applyPreviewPlayerAction(context, feedback);
    } else {
      const preview = applyPreviewJudgeAction(context, feedback);
      if (preview) {
        return preview;
      }
    }
    const {title, message, code} = feedback;
    match.revision++;
    const result: OperationResult = {
      requestId: operation.requestId,
      status: 'complete',
      title,
      message,
      ...(code ? {code} : {}),
    };
    this.results.set(operation.requestId, result);
    return result;
  }
}
export {PREVIEW_ROLES, SCENARIOS, type PreviewRole} from './preview_fixtures';
