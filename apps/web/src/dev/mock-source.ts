import {
  RULES,
  validArms,
  validCode,
  type Action,
  type Arms,
  type Civilization,
  type ColorId,
  type DataSource,
  type GameEvent,
  type Operation,
  type OperationResult,
  type Snapshot,
} from '@darkforest/contracts';
import { DEFAULT_SITE } from '../config';
import { ApiError } from '../data/http';

export const PREVIEW_ROLES = [
  { id: 'player', label: '玩家' },
  { id: 'observer', label: '四维观察者' },
  { id: 'chief', label: '总裁判' },
  { id: 'communication', label: '通讯裁判' },
  { id: 'event', label: '事件裁判' },
  { id: 'display', label: '观战大屏' },
] as const;
export const SCENARIOS = [
  { id: 'active', label: '正常出航，有广播和光粒' },
  { id: 'limited', label: '正常出航，无剩余资源' },
  { id: 'locked', label: '个人禁止目击，其他行动可用' },
  { id: 'returning', label: '被击毁，返回母星' },
  { id: 'preparing', label: '重生，离开母星领码' },
  { id: 'issued', label: '重生，佩戴新配置' },
  { id: 'nickname', label: '首次设置昵称' },
  { id: 'registration', label: '登记母星' },
  { id: 'pending', label: '母星等待审核' },
  { id: 'rejected', label: '母星退回修改' },
  { id: 'verified', label: '首航，准备材料' },
  { id: 'staged', label: '首航，等待发码' },
  { id: 'release', label: '首航，可以领取配置' },
  { id: 'outfitting', label: '首航，确认穿戴' },
  { id: 'ready', label: '首航，等待开赛' },
  { id: 'last-life', label: '母星已毁，仍在第一阶段' },
  { id: 'apocalypse', label: '宇宙末日，最后一命' },
  { id: 'transfer', label: '转场，步行前往终局圈' },
  { id: 'verification', label: '98分钟资格核验' },
  { id: 'hunt', label: '最后狩猎' },
  { id: 'paused', label: '全场暂停' },
  { id: 'eliminated', label: '淘汰，等待开放观战' },
  { id: 'observer', label: '已获得观战权限' },
  { id: 'ended', label: '比赛结束，完整复盘' },
  { id: 'no-champion', label: '全体淘汰，无存活冠军' },
] as const;
export type PreviewRole = (typeof PREVIEW_ROLES)[number]['id'];
const colorIds: ColorId[] = ['BK', 'WH', 'GY', 'YL', 'OR', 'SB', 'PU'];
const nicknames = [
  '静默海',
  '远行者',
  '回声',
  '星尘',
  '三体',
  '深蓝',
  '归零者',
  '长夜',
  '白矮星',
  '启明',
  '边界',
  '漂流者',
  '无声',
  '引力',
  '尘埃',
  '苍穹',
  '冬眠',
  '未明',
  '微光',
  '余烬',
  '独行',
  '星潮',
  '黑域',
  '群星',
];
const PERMISSIONS: Record<string, string[]> = {
  chief: ['*'],
  communication: ['overview', 'homeworlds', 'preflight', 'notices', 'players', 'events', 'account'],
  event: ['overview', 'events', 'notices', 'players', 'attacks', 'equipment', 'account'],
};
function buildArms(i: number): Arms {
  const a = i % 7,
    b = (a + 1) % 7;
  let c = (a + 2 + Math.floor(i / 7)) % 7;
  while (c === a || c === b) c = (c + 1) % 7;
  return [[colorIds[a]!, colorIds[b]!], [colorIds[c]!]];
}
const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 180));

/** Local fixtures only. This module is reachable exclusively from preview.tsx. */
export class MockSource implements DataSource {
  private state!: Snapshot;
  private origin = performance.now();
  private results = new Map<string, OperationResult>();
  private previews = new Map<
    string,
    { revision: number; path: string; payload: Record<string, unknown> }
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
    const now = Date.now();
    const civilizations: Civilization[] = nicknames.map((nickname, i) => ({
      id: `C${String(i + 1).padStart(2, '0')}`,
      nickname,
      flight: i > 17 ? 'eliminated' : i === 3 ? 'returning' : 'active',
      homeworld: String(1234 + i * 30271).padStart(6, '0'),
      homeAlive: i < 16,
      homeVersion: 1,
      rejection: '',
      arms: i > 17 || i === 3 ? null : buildArms(i),
      flightNumber: (i % 3) + 1,
      kills: i === 6 ? 3 : i % 4,
      wrongCount: i % 2,
      broadcasts: i % 3,
      photons: i === 6 || i === 10 ? 1 : 0,
      attackLockedUntil: 0,
      respawnDeadline: i === 3 ? 40 * 60000 : null,
      eliminatedAt: i > 17 ? now - 600000 : null,
      eliminationReason: i > 17 ? '飞船在最后一命时被击毁' : '',
      observerAllowed: i > 17,
      actions: [],
      voyages: [
        { number: 1, arms: buildArms(i + 8), startMs: 0, endMs: 12 * 60000 },
        { number: 2, arms: buildArms(i), startMs: 17 * 60000, endMs: i > 17 ? 25 * 60000 : null },
      ],
      rank: null,
      tied: false,
    }));
    const me = structuredClone(civilizations[6]!);
    me.flightNumber = 2;
    me.arms = [['YL', 'SB'], ['WH']];
    me.photons = 1;
    me.broadcasts = 2;
    me.wrongCount = 0;
    me.actions = ['sighting', 'broadcast', 'photon', 'withdraw'];
    const events: GameEvent[] = [
      {
        id: 'EVT-108',
        kind: 'notice',
        title: '飞船保持正常出航',
        body: '当前可以提交现场目击。请先亲眼观察目标两臂的完整颜色分组。',
        gameMs: 32 * 60000,
        utcMs: now - 180000,
        audience: 'personal',
        civilizationIds: ['C07'],
      },
      {
        id: 'EVT-107',
        kind: 'photon',
        title: '光粒清理完成',
        body: '口令028416的母星已被摧毁。',
        gameMs: 31 * 60000 + 24000,
        utcMs: now - 216000,
        audience: 'public',
        civilizationIds: ['C03'],
        code: '028416',
        actor: 'C11（边界）',
      },
      {
        id: 'EVT-106',
        kind: 'broadcast',
        title: 'C12（漂流者）发布正式广播',
        body: '这组六位口令已公开。',
        gameMs: 30 * 60000 + 12000,
        utcMs: now - 288000,
        audience: 'public',
        civilizationIds: ['C12'],
        code: '001234',
      },
      {
        id: 'EVT-105',
        kind: 'tech',
        title: '已获得光粒1枚',
        body: '你已成为高级文明。正常出航时可以发射光粒。',
        gameMs: 28 * 60000,
        utcMs: now - 420000,
        audience: 'personal',
        civilizationIds: ['C07'],
        actor: 'C07（归零者）',
      },
      {
        id: 'EVT-104',
        kind: 'sighting',
        title: '已击毁目标飞船',
        body: 'C12（漂流者）的母星口令已加入你的情报记录。',
        gameMs: 25 * 60000 + 10000,
        utcMs: now - 590000,
        audience: 'personal',
        civilizationIds: ['C07', 'C12'],
        code: '739216',
      },
      {
        id: 'EVT-103',
        kind: 'respawn',
        title: 'C04（星尘）开始返航',
        body: '飞船被击毁，仍可在截止前完成重生。',
        gameMs: 25 * 60000,
        utcMs: now - 600000,
        audience: 'global',
        civilizationIds: ['C04'],
      },
      {
        id: 'EVT-102',
        kind: 'stage',
        title: '比赛正式开始',
        body: '所有已就绪飞船统一出航，进入黑暗森林阶段。',
        gameMs: 0,
        utcMs: now - 35 * 60000,
        audience: 'public',
        civilizationIds: [],
      },
    ];
    const judgeRole =
      role === 'chief' || role === 'communication' || role === 'event' || role === 'display';
    this.state = {
      site: {
        ...structuredClone(DEFAULT_SITE),
        qqGroup: '黑暗森林活动群（预览）',
        judgeContact: '通讯裁判，QQ 10000001（模拟）',
      },
      session: {
        id: judgeRole ? `judge-${role}` : 'player-C07',
        matchId: 'preview-match',
        role: judgeRole ? 'judge' : 'player',
        name: judgeRole
          ? role === 'communication'
            ? '通讯裁判'
            : role === 'event'
              ? '事件裁判'
              : '总裁判'
          : '归零者',
        permissions: PERMISSIONS[role] ?? [],
        csrfToken: 'preview-only',
      },
      match: {
        id: 'preview-match',
        revision: 1,
        stage: 'forest',
        gameMs: 35 * 60000,
        serverUtcMs: now,
        running: true,
        paused: false,
        pauseReason: '',
        verification: false,
        total: 24,
        survivors: 18,
        homeworldsAlive: 16,
        releaseAt: null,
        startAt: null,
      },
      player: judgeRole ? null : me,
      events,
      intel: [
        {
          id: 'INT-1',
          civilization: 'C12',
          nickname: '漂流者',
          code: '739216',
          gameMs: 25 * 60000 + 10000,
          source: '成功目击获得',
          statusAtDiscovery: '获知时母星尚存',
        },
      ],
      civilizations,
      judge: {
        issuedCodes: 46,
        effects: [
          {
            id: 'FX-1',
            target: '全场目击攻击',
            reason: '四维观察者提案',
            untilUtcMs: now - 60000,
            operator: '总裁判',
            active: false,
          },
        ],
        notices: [
          {
            id: 'N1',
            target: 'C04（星尘）',
            channel: 'private',
            title: '飞船被击毁通知',
            body: '【飞船失联】\nC04（星尘），你的飞船已被击毁。请在安全位置摘下全部比赛手环，正常步行返回母星。请在比赛有效时间40:00前完成重生。',
            status: 'pending',
            version: 1,
            gameMs: 25 * 60000,
            operator: '',
          },
          {
            id: 'N2',
            target: '比赛QQ群',
            channel: 'group',
            title: '正式广播公告',
            body: '【坐标广播】\nC12（漂流者）发送了一条坐标广播001234，该坐标已公开。',
            status: 'copied',
            version: 2,
            gameMs: 30 * 60000,
            operator: '通讯裁判',
          },
          {
            id: 'N3',
            target: 'C19（微光）',
            channel: 'private',
            title: '永久淘汰通知',
            body: 'C19（微光），你已永久淘汰。请摘下全部比赛手环，步行返回裁判室。',
            status: 'sent',
            version: 3,
            gameMs: 24 * 60000,
            operator: '通讯裁判',
          },
        ],
        audits: [
          {
            id: 'AUD-1',
            title: '恢复比赛计时',
            operator: '总裁判',
            reason: '现场材料核对完成',
            before: '比赛暂停',
            after: '恢复黑暗森林阶段',
            gameMs: 23 * 60000,
          },
        ],
        scheduler: {
          lastSuccessUtcMs: now - 1500,
          nextWakeUtcMs: now + 60000,
          backlog: 0,
          error: '',
        },
      },
      results: null,
    };
    const match = this.state.match!;
    if (
      [
        'nickname',
        'registration',
        'pending',
        'rejected',
        'verified',
        'staged',
        'release',
        'outfitting',
        'ready',
      ].includes(scenario)
    ) {
      match.stage =
        scenario === 'ready'
          ? 'countdown'
          : ['release', 'outfitting'].includes(scenario)
            ? 'outfitting'
            : 'setup';
      match.gameMs = 0;
      match.running = false;
      me.flight =
        ({ registration: 'unregistered', release: 'staged' } as Record<string, typeof me.flight>)[
          scenario
        ] ?? (scenario as typeof me.flight);
      me.actions = [];
      me.arms = null;
      me.kills = 0;
      me.photons = 0;
      if (scenario === 'nickname') {
        me.nickname = '';
        me.actions = ['nickname'];
        me.homeworld = null;
      }
      if (scenario === 'registration' || scenario === 'rejected') {
        me.homeworld = null;
        me.actions = ['homeworld-submit'];
        me.rejection =
          scenario === 'rejected' ? '请核对最新照片中的六位口令，确保与登记版本一致。' : '';
      }
      if (scenario === 'pending') {
        me.actions = ['homeworld-submit'];
        civilizations[2]!.flight = 'pending';
      }
      if (scenario === 'verified') me.actions = ['preflight-depart'];
      if (scenario === 'staged') match.releaseAt = now + 90000;
      if (scenario === 'release') me.actions = ['preflight-issue-code'];
      if (scenario === 'outfitting') {
        me.arms = [['BK', 'OR'], ['WH']];
        me.actions = ['preflight-ready'];
      }
      if (scenario === 'ready') {
        me.arms = [['BK', 'OR'], ['WH']];
        match.startAt = now + 90000;
      }
    }
    if (scenario === 'limited') {
      me.photons = 0;
      me.broadcasts = 0;
      me.actions = ['sighting', 'withdraw'];
    }
    if (scenario === 'locked') {
      me.wrongCount = 1;
      me.attackLockedUntil = now + 135000;
      me.actions = ['broadcast', 'photon', 'withdraw'];
    }
    if (['returning', 'preparing', 'issued'].includes(scenario)) {
      me.flight = scenario as typeof me.flight;
      me.respawnDeadline = match.gameMs + 9 * 60000 + 24000;
      me.arms = scenario === 'issued' ? [['BK', 'OR', 'SB'], ['GY']] : null;
      me.actions = [
        scenario === 'returning'
          ? 'return-confirm'
          : scenario === 'preparing'
            ? 'issue-code'
            : 'launch',
      ];
    }
    if (scenario === 'last-life') me.homeAlive = false;
    if (scenario === 'apocalypse') {
      match.stage = 'apocalypse';
      match.gameMs = 72 * 60000;
      me.homeAlive = false;
      me.actions = ['sighting', 'withdraw'];
    }
    if (scenario === 'transfer') {
      match.stage = 'transfer';
      match.gameMs = 93 * 60000;
      me.homeAlive = false;
      me.actions = [];
    }
    if (scenario === 'verification') {
      match.stage = 'hunt';
      match.gameMs = RULES.cutoffMs;
      match.paused = true;
      match.verification = true;
      match.pauseReason = '裁判正在核验终局资格';
      me.actions = [];
    }
    if (scenario === 'hunt') {
      match.stage = 'hunt';
      match.gameMs = 102 * 60000;
      me.homeAlive = false;
      me.actions = ['sighting', 'withdraw'];
    }
    if (scenario === 'paused') {
      match.paused = true;
      match.pauseReason = '现场安全检查，等待裁判通知';
      me.actions = [];
    }
    if (['eliminated', 'observer'].includes(scenario) || role === 'observer') {
      me.flight = 'eliminated';
      me.arms = null;
      me.actions = [];
      me.homeAlive = false;
      me.eliminatedAt = now - (scenario === 'eliminated' && role !== 'observer' ? 45000 : 240000);
      me.eliminationReason = '最后一命的飞船被目击击毁';
      me.observerAllowed = role === 'observer' || scenario === 'observer';
    }
    if (['ended', 'no-champion'].includes(scenario)) {
      match.stage = 'ended';
      match.running = false;
      match.gameMs = 114 * 60000;
      match.survivors = scenario === 'no-champion' ? 0 : 1;
      me.actions = [];
      me.flight = scenario === 'no-champion' ? 'eliminated' : 'active';
      me.homeAlive = false;
      if (scenario === 'no-champion') {
        me.arms = null;
        me.eliminatedAt = now;
        me.eliminationReason = '终局资格核验未通过';
      }
      civilizations.forEach((c, i) => {
        c.flight = i === 6 && scenario === 'ended' ? 'active' : 'eliminated';
        c.homeAlive = false;
        c.rank = i === 6 ? 1 : i < 6 ? i + 2 : i + 1;
        c.tied = false;
        if (c.flight === 'eliminated') c.arms = null;
      });
      this.state.results = {
        version: 1,
        reason:
          scenario === 'no-champion' ? '全部文明已永久淘汰' : '本场仅余一个存活文明，提前完赛',
        champions: scenario === 'no-champion' ? [] : ['C07'],
        standings: [...civilizations].sort((a, b) => a.rank! - b.rank!),
      };
    }
    if (judgeRole && ['setup', 'outfitting', 'countdown'].includes(match.stage)) {
      civilizations.forEach((c, index) => {
        c.flight =
          scenario === 'ready'
            ? 'ready'
            : scenario === 'release'
              ? 'staged'
              : index < 4
                ? 'pending'
                : 'verified';
        c.actions = [];
      });
      me.flight = scenario === 'ready' ? 'ready' : scenario === 'release' ? 'staged' : 'verified';
    }
    civilizations[6] = {
      ...structuredClone(me),
      voyages: civilizations[6]!.voyages,
      rank: this.state.results ? 1 : null,
      tied: false,
    };
    if (
      ['apocalypse', 'transfer', 'verification', 'hunt', 'ended', 'no-champion'].includes(scenario)
    ) {
      civilizations.forEach((c) => {
        c.homeAlive = false;
        if (c.flight === 'returning') {
          c.flight = 'eliminated';
          c.arms = null;
        }
      });
    }
    const currentVoyage = civilizations[6]!.voyages.at(-1);
    if (currentVoyage && me.arms) {
      currentVoyage.arms = structuredClone(me.arms);
      currentVoyage.number = me.flightNumber;
    }
    match.survivors = civilizations.filter((c) => c.flight !== 'eliminated').length;
    match.homeworldsAlive = civilizations.filter((c) => c.homeAlive).length;
    if (this.state.results)
      this.state.results.standings = [...civilizations].sort((a, b) => a.rank! - b.rank!);
  }
  private reconcile() {
    const match = this.state.match!;
    const now = Date.now();
    const elapsed = performance.now() - this.origin;
    this.origin = performance.now();
    match.serverUtcMs = now;
    if (match.running && !match.paused) match.gameMs += elapsed;
    const me = this.state.player;
    if (
      me?.flight === 'eliminated' &&
      me.eliminatedAt &&
      now >= me.eliminatedAt + RULES.observerWaitMs
    )
      me.observerAllowed = true;
    if (
      me?.flight === 'active' &&
      me.attackLockedUntil &&
      now >= me.attackLockedUntil &&
      !match.paused &&
      ['forest', 'apocalypse', 'hunt'].includes(match.stage)
    ) {
      me.attackLockedUntil = 0;
      if (!me.actions.includes('sighting')) me.actions.unshift('sighting');
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
    if (this.fault === 'offline') throw new ApiError('连接已中断，正在重新连接。', 503);
    if (this.fault === 'expired') throw new ApiError('请重新登录。', 401);
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
        .filter((e) => e.audience !== 'global')
        .map((e) => {
          const projected = { ...e };
          if (e.kind === 'photon') delete projected.actor;
          return projected;
        });
    }
    if (!route.startsWith('/judge') || !judge) out.judge = null;
    if (judge) {
      out.player = null;
      out.intel = [];
    }
    return out;
  }
  async login(credential: string, judge: boolean) {
    await delay();
    if (!credential.trim()) throw new ApiError('请输入参赛口令。', 400);
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
    if (!me) throw new ApiError('当前账号不能获取此消息。', 403);
    return kind === 'homeworld'
      ? `【母星登记】\n${me.id}（${me.nickname}）\n母星口令：${me.homeworld}\n登记版本：第${me.homeVersion}次\n口令有效期应不少于24小时。请附上当前口令对应的现场照片。`
      : kind === 'respawn'
        ? `【重生】\n${me.id}（${me.nickname}）已返回母星，第${me.flightNumber + 1}航次准备重生。以下是我的母星现场时间水印照片：`
        : `【异常申报】\n${me.id}（${me.nickname}）\n当前航次：${me.flightNumber}\n请说明现场情况并附上有关截图。`;
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
        message: '尚未取得原请求记录，请继续查询。',
      }
    );
  }
  async submit(operation: Operation): Promise<OperationResult> {
    await delay();
    if (this.fault === 'offline') throw new ApiError('连接已中断，正在重新连接。', 503);
    if (this.results.has(operation.requestId)) return this.results.get(operation.requestId)!;
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
    let title = '操作已完成',
      message = '比赛状态已更新。';
    let code: string | undefined;
    const action = path.split('/').pop() as Action;
    if (path.startsWith('/action/') || path === '/player/nickname') {
      if (!me || !me.actions.includes(action === 'nickname' ? 'nickname' : action))
        throw new ApiError('比赛状态已更新，请查看当前可用行动。', 409);
      if (
        ['homeworld-submit', 'broadcast', 'photon'].includes(action) &&
        !validCode(String(payload.code ?? ''))
      )
        throw new ApiError('请输入6位数字，开头的0也需要保留。', 422);
      switch (action) {
        case 'nickname': {
          const name = String(payload.nickname ?? '').trim();
          if ([...name].length < 2 || [...name].length > 8)
            throw new ApiError('昵称需要2至8个字符。', 422);
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
          if (this.state.events.some((e) => e.kind === 'broadcast' && e.code === code))
            throw new ApiError('这组六位口令已被广播。', 409);
          me.broadcasts--;
          if (!me.broadcasts) me.actions = me.actions.filter((a) => a !== 'broadcast');
          title = '广播已发布';
          message = `广播剩余${me.broadcasts}次。`;
          this.state.events.unshift({
            id: `EVT-${crypto.randomUUID()}`,
            kind: 'broadcast',
            title: `${me.id}（${me.nickname}）发布正式广播`,
            body: '这组六位口令已公开。',
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
          me.actions = me.actions.filter((a) => a !== 'photon');
          title = '光粒已发射';
          code = String(payload.code);
          message = '清理已完成，未摧毁现存母星。';
          break;
        case 'sighting': {
          if (!validArms([payload.arm_a as ColorId[], payload.arm_b as ColorId[]]))
            throw new ApiError('手环颜色组合不完整。', 422);
          if (this.sightingResult === 'hit') {
            title = '已击毁目标飞船';
            message = 'C12（漂流者）的母星情报已加入你的记录。';
            code = '739216';
          } else {
            title = '本次目击未产生击毁';
            message = `提交错误目击码的次数：${me.wrongCount}。`;
            if (this.sightingResult === 'wrong') {
              me.wrongCount++;
              if (me.wrongCount >= 3) {
                me.flight = 'eliminated';
                me.homeAlive = false;
                me.arms = null;
                me.actions = [];
                me.eliminatedAt = Date.now();
                me.eliminationReason = '第三次提交错误目击码';
                message = '你已永久淘汰。请摘下全部比赛手环，步行返回裁判室。';
              } else {
                const minutes = me.wrongCount === 1 ? 5 : 15;
                me.attackLockedUntil = Date.now() + minutes * 60000;
                me.actions = me.actions.filter((a) => a !== 'sighting');
                message = `你仍在出航，可以被其他玩家击毁。距离恢复目击攻击${minutes}分钟。`;
              }
            }
          }
          break;
        }
      }
    } else {
      if (this.state.session?.role !== 'judge')
        throw new ApiError('当前账号不能执行这项操作。', 403);
      const permitted = this.state.session.permissions;
      const area = path.includes('/notices/')
        ? 'notices'
        : path.includes('/homeworld/')
          ? 'homeworlds'
          : path.includes('equipment')
            ? 'equipment'
            : '*';
      if (!permitted.includes('*') && !permitted.includes(area))
        throw new ApiError('当前职责不能执行这项操作。', 403);
      if (path.endsWith('/preview')) {
        const token = crypto.randomUUID();
        this.previews.set(token, {
          revision: match.revision,
          path: String(payload.path ?? '/judge/command/execute'),
          payload,
        });
        const preview = {
          token,
          revision: match.revision,
          title: '操作影响预览',
          changes: [
            {
              target: String(payload.target ?? payload.command ?? '本场比赛'),
              before: '当前已保存状态',
              after: String(payload.change ?? payload.command ?? '按本次表单变更'),
            },
          ],
          consequences: ['执行时将再次核验权限与记录版本。', '相关操作保留原因和审计记录。'],
        };
        if (Array.isArray(payload.eliminations)) {
          preview.changes = (payload.eliminations as { id: string; reason: string }[]).map(
            (item) => {
              const c = this.state.civilizations.find((c) => c.id === item.id);
              return {
                target: `${item.id}（${c?.nickname ?? ''}）`,
                before: '存活文明',
                after:
                  item.reason === 'outside_at_cutoff'
                    ? '截止时未进入终局圈，永久淘汰'
                    : '未按时加入位置共享，永久淘汰',
              };
            },
          );
          if (!preview.changes.length)
            preview.changes.push({
              target: '全部存活文明',
              before: '资格核验等待',
              after: '保留资格并结束核验暂停',
            });
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
        const preview = this.previews.get(String(payload.preview_token));
        if (!preview || preview.revision !== match.revision)
          throw new ApiError('记录已更新，请重新预览并核对。', 409);
        Object.assign(payload, preview.payload);
        this.previews.delete(String(payload.preview_token));
      }
      if (path.includes('/homeworld/')) {
        const target = this.state.civilizations.find((c) => c.id === path.split('/')[3]);
        if (
          !target ||
          target.homeVersion !== payload.expected_version ||
          target.homeworld !== payload.expected_code ||
          target.flight !== 'pending'
        )
          throw new ApiError('这条登记已更新，请核对最新版本。', 409);
        target.flight = payload.decision === 'approve' ? 'verified' : 'rejected';
        target.rejection = String(payload.reason ?? '');
        title = payload.decision === 'approve' ? '母星审核通过' : '已退回修改';
      } else if (path.includes('/notices/')) {
        const notice = this.state.judge!.notices.find((n) => n.id === path.split('/')[3]);
        if (!notice || notice.version !== payload.expected_version)
          throw new ApiError('通知已更新，请核对最新状态。', 409);
        notice.status = path.endsWith('/sent')
          ? 'sent'
          : path.endsWith('/error')
            ? 'error'
            : 'copied';
        notice.version++;
        notice.operator = this.state.session!.name;
        title =
          notice.status === 'sent'
            ? '已标记发送'
            : notice.status === 'copied'
              ? '已记录复制'
              : '已记录发送异常';
      } else if (path === '/judge/pause' || path === '/judge/resume') {
        if (match.verification) throw new ApiError('请先完成终局资格核验。', 409);
        match.paused = path.endsWith('/pause');
        match.pauseReason = String(payload.reason ?? '');
        title = match.paused ? '比赛已暂停' : '比赛已恢复';
      } else if (path === '/judge/hunt-finalize') {
        const eliminations = payload.eliminations as { id: string; reason: string }[];
        for (const item of eliminations ?? []) {
          const c = this.state.civilizations.find((c) => c.id === item.id);
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
        match.survivors = this.state.civilizations.filter((c) => c.flight !== 'eliminated').length;
        if (match.survivors <= 1) {
          match.stage = 'ended';
          match.running = false;
          const living = this.state.civilizations.filter((c) => c.flight !== 'eliminated');
          const standings = [
            ...living,
            ...this.state.civilizations.filter((c) => c.flight === 'eliminated'),
          ].map((c, i) => ({ ...c, rank: i + 1, tied: false }));
          this.state.results = {
            version: 1,
            reason: living.length ? '本场仅余一个存活文明，提前完赛' : '全部文明已永久淘汰',
            champions: living.map((c) => c.id),
            standings,
          };
        }
      } else if (path === '/judge/hunt-eliminate') {
        const target = this.state.civilizations.find((c) => c.id === payload.target);
        if (!target || target.flight === 'eliminated')
          throw new ApiError('该文明状态已更新，请重新核对。', 409);
        target.flight = 'eliminated';
        target.arms = null;
        target.eliminatedAt = Date.now();
        target.eliminationReason = String(payload.reason_code);
        match.survivors--;
        title = '终局裁决已记录';
      } else if (path === '/judge/correction') {
        const target = this.state.civilizations.find((c) => c.id === payload.target);
        if (!target) throw new ApiError('请选择需要处理的文明。', 422);
        const field = String(payload.field);
        const value = String(payload.value ?? '');
        if (field === 'nickname') {
          if ([...value.trim()].length < 2 || [...value.trim()].length > 8)
            throw new ApiError('昵称需要2至8个字符。', 422);
          target.nickname = value;
        } else if (field === 'photons' || field === 'broadcasts') {
          if (!/^\d+$/.test(value)) throw new ApiError('资源数量必须是非负整数。', 422);
          if (field === 'photons') target.photons = Number(value);
          else target.broadcasts = Number(value);
        } else if (field === 'restore') {
          target.flight = 'returning';
          target.observerAllowed = false;
          target.eliminatedAt = null;
          target.respawnDeadline = Math.min(match.gameMs + 15 * 60000, RULES.apocalypseMs);
          target.arms = null;
        }
        title = '文明信息已修正';
      } else if (/\/roster\/.+\/withdraw$/.test(path)) {
        const target = this.state.civilizations.find((c) => c.id === path.split('/')[3]);
        if (!target || !['setup', 'outfitting', 'countdown'].includes(match.stage))
          throw new ApiError('当前不能登记赛前缺席。', 409);
        target.flight = 'absent';
        target.arms = null;
        match.total--;
        title = '已登记赛前缺席';
      } else if (path === '/judge/equipment-correction') {
        const target = this.state.civilizations.find((c) => c.id === payload.target);
        if (!target) throw new ApiError('请选择需要处理的文明。', 422);
        if (payload.mode === 'reissue') {
          if (!match.paused) throw new ApiError('请先暂停比赛。', 409);
          target.arms = buildArms(this.state.judge!.issuedCodes);
          target.flight = 'issued';
          this.state.judge!.issuedCodes++;
          title = '旧配置已注销，新配置待核对佩戴';
        } else title = '同色同款手环替换已记录';
      } else if (path === '/judge/site-config') {
        this.state.site = {
          ...this.state.site,
          ...(payload.site as Snapshot['site']),
          version: this.state.site.version + 1,
        };
        title = '活动设置已保存';
      } else if (path.includes('/effects') && payload.revoke) {
        const effect = this.state.judge!.effects.find((e) => e.id === payload.revoke);
        if (effect) effect.active = false;
        title = '临时效果已撤销';
      } else if (path.includes('/effects')) {
        this.state.judge!.effects.unshift({
          id: crypto.randomUUID(),
          target: String(payload.target),
          reason: String(payload.reason),
          untilUtcMs: Date.now() + Number(payload.seconds ?? 60) * 1000,
          operator: this.state.session!.name,
          active: true,
        });
        title = '临时效果已建立';
      } else if (path.includes('/command/execute')) {
        title = '指令已执行';
        message = String(payload.command ?? '查询完成');
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
        operator: this.state.session!.name,
        reason: String(payload.reason ?? '按流程确认'),
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
      ...(code ? { code } : {}),
    };
    this.results.set(op.requestId, result);
    return result;
  }
}
