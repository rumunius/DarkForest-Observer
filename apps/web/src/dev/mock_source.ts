import {
  RULES,
  validArms,
  validCode,
  type Action,
  type ColorId,
  type DataSource,
  type Operation,
  type OperationResult,
  type Snapshot,
} from '@darkforest/contracts';
import {scalarText} from '../../../../packages/contracts/src/backend';
import {
  broadcastCopy,
  clearingCopy,
  eliminationCopy,
  eventBody,
  gameTimeCopy,
  qqCopy,
} from '../../../../packages/contracts/src/message_copy';
import {ApiError} from '../data/http';
import type {PreviewRole} from './preview_fixtures';
import {buildArms, createPreviewSnapshot} from './preview_fixtures';

function delay() {
  return new Promise<void>(resolve => setTimeout(resolve, 180));
}

/** Local fixtures only. This module is reachable exclusively from preview.tsx. */
export class MockSource implements DataSource {
  private state!: Snapshot;
  private origin = performance.now();
  private readonly results = new Map<string, OperationResult>();
  private readonly previews = new Map<
    string,
    {revision: number; path: string; payload: Record<string, unknown>}
  >();
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
    const me = this.state.player;
    if (
      me?.flight === 'eliminated' &&
      me.eliminatedAt &&
      now >= me.eliminatedAt + RULES.observerWaitMs
    ) {
      me.observerAllowed = true;
    }
    if (
      me?.flight === 'active' &&
      me.attackLockedUntil &&
      now >= me.attackLockedUntil &&
      !match.paused &&
      ['forest', 'apocalypse', 'hunt'].includes(match.stage)
    ) {
      me.attackLockedUntil = 0;
      if (!me.actions.includes('sighting')) {
        me.actions.unshift('sighting');
      }
    }
    if (
      me?.flight === 'staged' &&
      match.releaseAt &&
      now >= match.releaseAt &&
      !me.actions.includes('preflight-issue-code')
    ) {
      match.stage = 'outfitting';
      me.actions = ['preflight-issue-code'];
      match.revision++;
    }
    if (me?.flight === 'ready' && match.startAt && now >= match.startAt) {
      match.stage = 'forest';
      match.running = true;
      me.flight = 'active';
      me.actions = ['sighting', 'broadcast', 'withdraw'];
      match.revision++;
    }
    if (
      me &&
      ['returning', 'preparing', 'issued'].includes(me.flight) &&
      me.respawnDeadline !== null &&
      match.gameMs >= me.respawnDeadline
    ) {
      me.flight = 'eliminated';
      me.actions = [];
      me.arms = null;
      me.eliminatedAt = now;
      me.eliminationReason = '未在统一截止前完成重生';
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
    const me = this.state.player!;
    if (!me) {
      throw new ApiError('当前账号不能获取此消息。', 403);
    }
    return kind === 'homeworld'
      ? qqCopy(
          '母星登记',
          `文明${me.id}（${me.nickname}）请求在${me.homeworld}登记母星（提交版本：${me.homeVersion}），以下是我的母星现场时间水印照片：`,
        )
      : kind === 'respawn'
        ? qqCopy(
            '重生',
            `文明${me.id}（${me.nickname}）已返回母星，请求重生，以下是我的母星现场时间水印照片：`,
          )
        : qqCopy(
            '异常申报',
            `文明${me.id}（${me.nickname}）请求裁判协助。\n比赛时间：${gameTimeCopy(this.state.match!.gameMs)}。\n现场情况：`,
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

  private apply(op: Operation): OperationResult {
    this.reconcile();
    const me = this.state.player;
    const match = this.state.match!;
    const path = op.path;
    const payload = op.payload;
    let title = '操作已完成';
    let message = '比赛状态已更新。';
    let code: string | undefined;
    const action = path.split('/').pop() as Action;
    if (path.startsWith('/action/') || path === '/player/nickname') {
      if (
        !me ||
        !me.actions.includes(action === 'nickname' ? 'nickname' : action)
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
          me.nickname = name;
          me.flight = 'unregistered';
          me.actions = ['homeworld-submit'];
          title = '昵称已确认';
          break;
        }
        case 'homeworld-submit':
          me.homeworld = String(payload.code);
          me.homeVersion++;
          me.flight = 'pending';
          title = '母星口令已保存';
          message = '请复制登记消息，发送给裁判并附上现场照片。';
          break;
        case 'preflight-depart':
          me.flight = 'departed';
          me.actions = ['preflight-stage'];
          title = '已确认离开母星';
          break;
        case 'preflight-stage':
          me.flight = 'staged';
          me.actions = [];
          match.releaseAt = Date.now() + 30000;
          title = '准备完成，等待发码';
          break;
        case 'preflight-issue-code':
          me.flight = 'outfitting';
          me.arms = [['BK', 'OR'], ['WH']];
          me.actions = ['preflight-ready'];
          title = '手环配置已领取';
          break;
        case 'preflight-ready':
          me.flight = 'ready';
          me.actions = [];
          match.startAt = Date.now() + 30000;
          title = '已确认穿戴就绪';
          break;
        case 'return-confirm':
          me.flight = 'preparing';
          me.actions = ['issue-code'];
          title = '照片发送情况已确认';
          break;
        case 'issue-code':
          me.flight = 'issued';
          me.arms = [['BK', 'OR', 'SB'], ['GY']];
          me.actions = ['launch'];
          title = '新手环配置已领取';
          break;
        case 'launch':
          me.flight = 'active';
          me.flightNumber++;
          me.respawnDeadline = null;
          me.actions = [
            'sighting',
            ...(me.broadcasts > 0 ? ['broadcast' as const] : []),
            ...(me.photons > 0 ? ['photon' as const] : []),
            'withdraw',
          ];
          title = '出航完成';
          break;
        case 'withdraw':
          me.flight = 'eliminated';
          me.homeAlive = false;
          me.actions = [];
          me.arms = null;
          me.eliminatedAt = Date.now();
          me.eliminationReason = '主动退出比赛';
          title = '已退出比赛';
          break;
        case 'broadcast': {
          code = String(payload.code);
          if (
            this.state.events.some(
              e => e.kind === 'broadcast' && e.code === code,
            )
          ) {
            throw new ApiError('这组六位口令已被广播。', 409);
          }
          me.broadcasts--;
          if (!me.broadcasts) {
            me.actions = me.actions.filter(a => a !== 'broadcast');
          }
          title = '广播已发布';
          message = `广播剩余${me.broadcasts}次。`;
          this.state.events.unshift({
            id: `EVT-${crypto.randomUUID()}`,
            kind: 'broadcast',
            title: '坐标广播',
            body: broadcastCopy(`${me.id}（${me.nickname}）`, code),
            code,
            audience: 'public',
            gameMs: match.gameMs,
            utcMs: Date.now(),
            civilizationIds: [me.id],
          });
          break;
        }
        case 'photon':
          me.photons--;
          me.actions = me.actions.filter(a => a !== 'photon');
          title = '光粒已发射';
          code = String(payload.code);
          message = clearingCopy('photon', code);
          break;
        case 'sighting': {
          if (
            !validArms([payload.arm_a as ColorId[], payload.arm_b as ColorId[]])
          ) {
            throw new ApiError('手环颜色组合不完整。', 422);
          }
          if (this.sightingResult === 'hit') {
            title = '已击毁目标飞船';
            message = 'C12（漂流者）的母星情报已加入你的记录。';
            code = '739216';
          } else {
            title = '本次目击未产生击毁';
            message = '本次目击未产生击毁。';
            if (this.sightingResult === 'wrong') {
              me.wrongCount++;
              if (me.wrongCount >= 3) {
                me.flight = 'eliminated';
                me.homeAlive = false;
                me.arms = null;
                me.actions = [];
                me.eliminatedAt = Date.now();
                me.eliminationReason = '第三次提交错误的手环颜色';
                title = '直接出局';
                message = eliminationCopy(
                  `${me.id}（${me.nickname}）`,
                  180,
                  true,
                );
              } else {
                const minutes = me.wrongCount === 1 ? 5 : 15;
                me.attackLockedUntil = Date.now() + minutes * 60000;
                me.actions = me.actions.filter(a => a !== 'sighting');
                title = '禁止攻击';
                message = `本次提交的手环颜色有误。\n累计错误：${me.wrongCount}次。禁止目击攻击：${minutes}分钟。\n恢复攻击时间：${new Date(me.attackLockedUntil).toLocaleTimeString('zh-CN', {timeZone: 'Asia/Shanghai', hour12: false})}。`;
              }
            }
          }
          break;
        }

        default:
          // Validated actions outside this preview switch retain the existing no-op.
          break;
      }
    } else {
      if (this.state.session?.role !== 'judge') {
        throw new ApiError('当前账号不能执行这项操作。', 403);
      }
      const permitted = this.state.session.permissions;
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
        const token = crypto.randomUUID();
        this.previews.set(token, {
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
              target: scalarText(
                payload.target ?? payload.command ?? '本场比赛',
              ),
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
          preview.changes = (
            payload.eliminations as Array<{id: string; reason: string}>
          ).map(item => {
            const c = this.state.civilizations.find(c => c.id === item.id);
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
          requestId: op.requestId,
          status: 'complete',
          title: '请核对操作影响',
          message: '预览尚未改变比赛。',
          preview,
        };
      }
      if (payload.preview_token) {
        const preview = this.previews.get(scalarText(payload.preview_token));
        if (!preview || preview.revision !== match.revision) {
          throw new ApiError('记录已更新，请重新预览并核对。', 409);
        }
        Object.assign(payload, preview.payload);
        this.previews.delete(scalarText(payload.preview_token));
      }
      if (path.includes('/homeworld/')) {
        const target = this.state.civilizations.find(
          c => c.id === path.split('/')[3],
        );
        if (
          !target ||
          target.homeVersion !== payload.expected_version ||
          target.homeworld !== payload.expected_code ||
          target.flight !== 'pending'
        ) {
          throw new ApiError('这条登记已更新，请核对最新版本。', 409);
        }
        target.flight =
          payload.decision === 'approve' ? 'verified' : 'rejected';
        target.rejection = scalarText(payload.reason ?? '');
        title = payload.decision === 'approve' ? '母星审核通过' : '已退回修改';
      } else if (path.includes('/notices/')) {
        const notice = this.state.judge!.notices.find(
          n => n.id === path.split('/')[3],
        );
        if (!notice || notice.version !== payload.expected_version) {
          throw new ApiError('通知已更新，请核对最新状态。', 409);
        }
        notice.status = path.endsWith('/sent')
          ? 'sent'
          : path.endsWith('/error')
            ? 'error'
            : 'copied';
        notice.version++;
        notice.operator = this.state.session.name;
        title =
          notice.status === 'sent'
            ? '已标记发送'
            : notice.status === 'copied'
              ? '已记录复制'
              : '已记录发送异常';
      } else if (path === '/judge/pause' || path === '/judge/resume') {
        if (match.verification) {
          throw new ApiError('请先完成终局资格核验。', 409);
        }
        match.paused = path.endsWith('/pause');
        match.pauseReason = scalarText(payload.reason ?? '');
        title = match.paused ? '比赛已暂停' : '比赛已恢复';
      } else if (path === '/judge/hunt-finalize') {
        const eliminations = payload.eliminations as Array<{
          id: string;
          reason: string;
        }>;
        for (const item of eliminations ?? []) {
          const c = this.state.civilizations.find(c => c.id === item.id);
          if (c) {
            c.flight = 'eliminated';
            c.arms = null;
            c.eliminationReason = item.reason;
          }
        }
        match.verification = false;
        match.paused = false;
        match.pauseReason = '';
        title = '终局资格核验已完成';
        match.survivors = this.state.civilizations.filter(
          c => c.flight !== 'eliminated',
        ).length;
        if (match.survivors <= 1) {
          match.stage = 'ended';
          match.running = false;
          const living = this.state.civilizations.filter(
            c => c.flight !== 'eliminated',
          );
          const standings = [
            ...living,
            ...this.state.civilizations.filter(c => c.flight === 'eliminated'),
          ].map((c, i) => ({...c, rank: i + 1, tied: false}));
          this.state.results = {
            version: 1,
            reason: living.length
              ? '本场仅余一个存活文明，提前完赛'
              : '全部文明已永久淘汰',
            champions: living.map(c => c.id),
            standings,
          };
        }
      } else if (path === '/judge/hunt-eliminate') {
        const target = this.state.civilizations.find(
          c => c.id === payload.target,
        );
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
        const target = this.state.civilizations.find(
          c => c.id === payload.target,
        );
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
        title = '文明信息已修正';
      } else if (/\/roster\/.+\/withdraw$/.test(path)) {
        const target = this.state.civilizations.find(
          c => c.id === path.split('/')[3],
        );
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
        const target = this.state.civilizations.find(
          c => c.id === payload.target,
        );
        if (!target) {
          throw new ApiError('请选择需要处理的文明。', 422);
        }
        if (payload.mode === 'reissue') {
          if (!match.paused) {
            throw new ApiError('请先暂停比赛。', 409);
          }
          target.arms = buildArms(this.state.judge!.issuedCodes);
          target.flight = 'issued';
          this.state.judge!.issuedCodes++;
          title = '旧配置已注销，新配置待核对佩戴';
        } else {
          title = '同色同款手环替换已记录';
        }
      } else if (path === '/judge/site-config') {
        this.state.site = {
          ...this.state.site,
          ...(payload.site as Snapshot['site']),
          version: this.state.site.version + 1,
        };
        title = '活动设置已保存';
      } else if (path.includes('/effects') && payload.revoke) {
        const effect = this.state.judge!.effects.find(
          e => e.id === payload.revoke,
        );
        if (effect) {
          effect.active = false;
        }
        title = '临时效果已撤销';
      } else if (path.includes('/effects')) {
        this.state.judge!.effects.unshift({
          id: crypto.randomUUID(),
          target: String(payload.target),
          reason: String(payload.reason),
          untilUtcMs: Date.now() + Number(payload.seconds ?? 60) * 1000,
          operator: this.state.session.name,
          active: true,
        });
        title = '临时效果已建立';
      } else if (path.includes('/command/execute')) {
        title = '指令已执行';
        message = scalarText(payload.command ?? '查询完成');
      } else if (path.includes('/scheduler') || path.includes('/settle-due')) {
        this.state.judge!.scheduler.backlog = 0;
        this.state.judge!.scheduler.lastSuccessUtcMs = Date.now();
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
      this.state.judge!.audits.unshift({
        id: `AUD-${crypto.randomUUID()}`,
        title,
        operator: this.state.session.name,
        reason: scalarText(payload.reason ?? '按流程确认'),
        before: '操作前状态',
        after: message,
        gameMs: match.gameMs,
      });
    }
    match.revision++;
    const result: OperationResult = {
      requestId: op.requestId,
      status: 'complete',
      title,
      message,
      ...(code ? {code} : {}),
    };
    this.results.set(op.requestId, result);
    return result;
  }
}
export {PREVIEW_ROLES, type PreviewRole, SCENARIOS} from './preview_fixtures';
