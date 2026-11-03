/** Explicit DEV-only fixtures. Never imported by the production build. */
import {
  COLORS,
  type Action,
  type Civilization,
  type EventRecord,
  type OperationResult,
  type PageData,
  type SessionState,
  type SiteConfig,
} from '@darkforest/contracts';
import { ApiError, type Transport } from '../core/api';
import { judgePages } from '../pages/judge';

export const scenarios = [
  'active',
  'nickname',
  'homeworld',
  'pending',
  'prepare',
  'materials',
  'release',
  'wear',
  'ready',
  'returning',
  'preparing',
  'issued',
  'locked',
  'paused',
  'apocalypse',
  'transfer',
  'review',
  'hunt',
  'eliminated',
  'observer',
  'ended',
  'judge',
  'judge-review',
  'judge-comms',
] as const;
export function createPreviewState(scenario: string): SessionState {
  const utc = Date.now();
  const me: Civilization = {
    id: 'C07',
    nickname: '归零者',
    flight_status: 'active',
    home_status: 'alive',
    home_code: '001234',
    home_version: 2,
    unique_sight_kills: 3,
    wrong_count: 0,
    broadcast_remaining: 1,
    photon_remaining: 1,
    bracelet: { flight: 2, arms: [['WH', 'SB'], ['OR']], status: 'active' },
    flights: [
      {
        flight: 1,
        arms: [['BK', 'YL'], ['PU']],
        status: 'retired',
        activated_at: '00:00',
        retired_at: '18:42',
      },
    ],
  };
  const state: SessionState = {
    version: 1,
    account_id: 'preview-player',
    role: 'player',
    role_label: '参赛玩家',
    csrf_token: 'preview-only',
    match: {
      id: 'preview',
      phase: 'forest',
      paused: false,
      hunt_review: false,
      clock: {
        server_utc_ms: utc,
        game_ms: 24 * 60000 + 38000,
        running: true,
        phase_end_game_ms: 65 * 60000,
      },
      survivors: 18,
    },
    me,
    allowed_actions: ['sighting', 'broadcast', 'photon', 'withdraw'],
    permissions: [],
    observer_allowed: false,
    results_allowed: false,
    status_message: '观察现场的两臂手环，确认后再发起目击。',
  };
  const setup: Record<string, Action[]> = {
    nickname: ['nickname'],
    homeworld: ['homeworld-submit'],
    pending: ['homeworld-submit'],
    prepare: ['preflight-depart'],
    materials: ['preflight-stage'],
    release: ['preflight-issue-code'],
    wear: ['preflight-ready'],
    ready: [],
  };
  if (scenario in setup) {
    state.match.phase = 'setup';
    state.match.clock.running = false;
    delete state.match.clock.phase_end_game_ms;
    state.match.clock.game_ms = 0;
    me.flight_status = 'prelaunch';
    delete me.bracelet;
    state.allowed_actions = setup[scenario]!;
  }
  if (scenario === 'nickname') {
    me.nickname = '';
    me.home_status = 'unregistered';
    delete me.home_code;
  }
  if (scenario === 'homeworld') {
    me.home_status = 'unregistered';
    delete me.home_code;
  }
  if (scenario === 'pending') me.home_status = 'pending';
  if (scenario === 'release') {
    state.match.phase = 'outfitting';
    me.flight_status = 'staged';
  }
  if (scenario === 'wear' || scenario === 'ready') {
    state.match.phase = 'outfitting';
    me.flight_status = scenario === 'wear' ? 'outfitting' : 'ready';
    me.bracelet = { flight: 1, arms: [['BK', 'SB'], ['YL']], status: 'reserved' };
  }
  if (scenario === 'ready') me.started_at_utc_ms = utc + 90000;
  if (['returning', 'preparing', 'issued'].includes(scenario)) {
    me.flight_status = scenario as 'returning' | 'preparing' | 'issued';
    me.respawn_deadline_game_ms = state.match.clock.game_ms + 8 * 60000 + 12000;
    state.allowed_actions = [
      scenario === 'returning'
        ? 'return-confirm'
        : scenario === 'preparing'
          ? 'issue-code'
          : 'launch',
    ];
    if (scenario === 'issued')
      me.bracelet = { flight: 3, arms: [['GY', 'YL'], ['SB']], status: 'reserved' };
    else delete me.bracelet;
    state.status_message = '飞船已被击毁，请完成当前重生步骤。';
  }
  if (scenario === 'locked') {
    state.allowed_actions = ['broadcast', 'photon', 'withdraw'];
    me.wrong_count = 1;
    me.sighting_locked_until_utc_ms = utc + 135000;
    state.status_message = '暂时禁止目击攻击。你仍在出航，可以被其他玩家击毁。';
  }
  if (scenario === 'paused') {
    state.match.paused = true;
    state.match.pause_reason = '现场通行情况核对中';
    state.allowed_actions = [];
    state.status_message = '比赛已暂停，等待裁判恢复。';
  }
  if (scenario === 'apocalypse') {
    state.match.phase = 'apocalypse';
    state.match.clock.game_ms = 70 * 60000;
    state.match.clock.phase_end_game_ms = 90 * 60000;
    me.home_status = 'destroyed';
    state.allowed_actions = ['sighting', 'withdraw'];
  }
  if (scenario === 'transfer') {
    state.match.phase = 'transfer';
    state.match.clock.game_ms = 93 * 60000;
    state.match.clock.phase_end_game_ms = 98 * 60000;
    state.allowed_actions = [];
    state.status_message = '已进入转场，目击攻击暂停。请加入QQ群实时位置共享。';
  }
  if (scenario === 'hunt' || scenario.includes('review')) {
    state.match.phase = 'hunt';
    state.match.clock.game_ms = 98 * 60000;
    state.match.hunt_review = scenario !== 'hunt';
    state.match.paused = scenario !== 'hunt';
    state.match.clock.running = scenario === 'hunt';
    state.match.clock.phase_end_game_ms = 120 * 60000;
    state.allowed_actions = scenario === 'hunt' ? ['sighting', 'withdraw'] : [];
    state.status_message =
      scenario === 'hunt' ? '请持续共享位置。' : '终局资格确认中，等待裁判完成核验。';
  }
  if (scenario === 'eliminated' || scenario === 'observer') {
    me.flight_status = 'eliminated';
    delete me.bracelet;
    me.eliminated_at = '14:24:38';
    me.elimination_reason = '最后一命被目击击毁';
    me.observer_unlock_at_utc_ms = utc + (scenario === 'observer' ? -1000 : 120000);
    state.allowed_actions = [];
    state.observer_allowed = scenario === 'observer';
  }
  if (scenario === 'ended') {
    state.match.phase = 'ended';
    state.match.clock.running = false;
    state.match.clock.game_ms = 120 * 60000;
    delete state.match.clock.phase_end_game_ms;
    state.results_allowed = true;
    state.allowed_actions = [];
  }
  if (scenario.startsWith('judge')) {
    state.account_id = 'preview-judge';
    state.role = 'judge';
    state.role_label = '总裁判';
    delete state.me;
    state.allowed_actions = [];
    state.permissions = [
      ...judgePages.map((p) => p[0]),
      'display',
      'pause',
      'resume',
      'homeworld-verify',
      'arm-code-release',
      'arm-start',
      'notice-write',
      'hunt-finalize',
      'hunt-eliminate',
      'correction',
      'roster-withdraw',
      'equipment-correction',
      'scheduler-write',
      'effect-write',
      'site-config',
      'export',
      'audit-export',
      'attack-correction',
    ];
  }
  if (scenario === 'judge-comms') {
    state.role_label = '通讯裁判';
    state.permissions = [
      'overview',
      'homeworlds',
      'notices',
      'homeworld-verify',
      'notice-write',
      'account',
    ];
  }
  return state;
}
export function createPreviewTransport(scenario: string): Transport {
  let state = createPreviewState(scenario);
  let config: SiteConfig = {
    version: 1,
    name: '黑暗森林：观察者效应',
    description: '一场以现场观察、文明生存与信息博弈为核心的实景游戏。请使用独立参赛口令进入比赛。',
    timezone: 'Asia/Shanghai',
    qq_group: '黑暗森林赛事群',
    judge_contact: '赛事群内联系值班裁判',
    endgame_file: '终局圈图片',
    room_file: '裁判室说明',
    colors: Object.fromEntries(COLORS.map((c) => [c.id, c.hex])) as SiteConfig['colors'],
  };
  const people: Civilization[] = [
    state.me ?? createPreviewState('active').me!,
    {
      ...createPreviewState('active').me!,
      id: 'C12',
      nickname: '漂流者',
      home_code: '739216',
      unique_sight_kills: 2,
      bracelet: {
        flight: 1,
        arms: [
          ['BK', 'PU'],
          ['YL', 'SB'],
        ],
        status: 'active',
      },
    },
    {
      ...createPreviewState('returning').me!,
      id: 'C03',
      nickname: '远航者',
      home_code: '083529',
      unique_sight_kills: 1,
    },
    {
      ...createPreviewState('pending').me!,
      id: 'C19',
      nickname: '观星者',
      home_code: '608172',
      unique_sight_kills: 0,
    },
  ];
  const events: EventRecord[] = [
    {
      id: 'EVT-104',
      title: '正式广播已发布',
      body: 'C12（漂流者）广播了六位口令739216。',
      kind: 'broadcast',
      occurred_at: '14:23:12',
      game_ms: 1392000,
      source: '正式广播',
      civilization_id: 'C12',
      code: '739216',
      version: 1,
      status: '待发送',
      recipient: '比赛QQ群',
    },
    {
      id: 'EVT-103',
      title: '已获得光粒1枚',
      body: '技术爆炸已完成。正常出航且第一阶段尚未结束时，可以发射光粒。',
      kind: 'tech',
      occurred_at: '14:21:04',
      game_ms: 1264000,
      source: '本人消息',
      civilization_id: 'C07',
      version: 1,
      status: '已发送',
      recipient: 'C07（归零者）',
    },
    {
      id: 'EVT-102',
      title: '飞船被击毁',
      body: 'C03（远航者）的飞船已被目击击毁，正在返回母星。',
      kind: 'sighting',
      occurred_at: '14:18:42',
      game_ms: 1122000,
      source: '赛事记录',
      civilization_id: 'C03',
      version: 1,
      status: '需要处理',
      recipient: 'C03（远航者）',
    },
  ];
  const results = new Map<string, OperationResult>();
  let signedIn = true;
  const started = performance.now();
  return async <T>(raw: string, init?: RequestInit): Promise<T> => {
    const url = new URL(raw, 'http://preview.local');
    const path = url.pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (path === '/api/public/site-config') return structuredClone(config) as T;
    if (path === '/api/auth/logout') {
      signedIn = false;
      return {} as T;
    }
    if (path === '/api/auth/exchange') {
      signedIn = true;
      return {} as T;
    }
    if (!signedIn) throw new ApiError(401, '请重新登录');
    if (path === '/api/auth/session') {
      const s = structuredClone(state);
      const elapsed = performance.now() - started;
      s.match.clock.server_utc_ms += elapsed;
      if (s.match.clock.running && !s.match.paused) s.match.clock.game_ms += elapsed;
      return s as T;
    }
    if (path.startsWith('/api/operations/'))
      return (results.get(path.split('/').at(-1)!) ?? { status: 'not_found' }) as T;
    if (path.endsWith('/preview'))
      return {
        token: 'preview-confirmation',
        version: state.version,
        summary: '请核对本次操作对象及影响。',
        changes: [{ label: '操作对象', before: '当前已保存记录', after: JSON.stringify(body) }],
        consequences: ['执行前将重新检查版本和权限。', '结果将写入对应赛事记录。'],
      } as T;
    if (init?.method === 'POST') {
      const id = String(body.request_id ?? '');
      if (results.has(id)) return structuredClone(results.get(id)) as T;
      const action = path.split('/').at(-1)!;
      const transitions: Record<string, string> = {
        nickname: 'homeworld',
        'homeworld-submit': 'pending',
        'preflight-depart': 'materials',
        'preflight-stage': 'release',
        'preflight-issue-code': 'wear',
        'preflight-ready': 'ready',
        'return-confirm': 'preparing',
        'issue-code': 'issued',
        launch: 'active',
        withdraw: 'eliminated',
      };
      const version = state.version + 1;
      if (transitions[action]) {
        const old = state.me;
        state = createPreviewState(transitions[action]);
        state.version = version;
        if (old?.nickname && state.me) state.me.nickname = old.nickname;
      }
      if (action === 'nickname' && state.me) state.me.nickname = String(body.nickname);
      if (action === 'homeworld-submit' && state.me) state.me.home_code = String(body.code);
      if (action === 'broadcast' && state.me) {
        state.me.broadcast_remaining = Math.max(0, state.me.broadcast_remaining - 1);
        state.allowed_actions = state.allowed_actions.filter((a) => a !== 'broadcast');
      }
      if (action === 'photon' && state.me) {
        state.me.photon_remaining = 0;
        state.allowed_actions = state.allowed_actions.filter((a) => a !== 'photon');
      }
      if (action === 'pause') {
        state.match.paused = true;
        state.match.pause_reason = String(body.reason);
      }
      if (action === 'resume') {
        state.match.paused = false;
      }
      if (action === 'hunt-finalize') {
        state.match.hunt_review = false;
        state.match.paused = false;
      }
      if (action === 'site-config') {
        config = { ...config, ...body, version: config.version + 1 } as SiteConfig;
      }
      if (action === 'copied' || action === 'sent' || action === 'error') {
        const ev = events.find((v) => v.id === path.split('/').at(-2));
        if (ev) {
          ev.status = action === 'copied' ? '已复制' : action === 'sent' ? '已发送' : '需要处理';
          ev.version++;
        }
      }
      if (action === 'verify') {
        const c = people.find((c) => c.id === path.split('/').at(-2));
        if (c) c.home_status = body.decision === 'verify' ? 'alive' : 'rejected';
      }
      state.version++;
      const result: OperationResult = {
        status: 'completed',
        accepted: true,
        message:
          action === 'broadcast'
            ? '广播已发布'
            : action === 'photon'
              ? '光粒已发射'
              : '操作已完成。',
        state: structuredClone(state),
      };
      if (action === 'sighting') {
        result.result = 'no_hit';
        result.wrong_count = state.me?.wrong_count ?? 0;
      }
      results.set(id, result);
      return structuredClone(result) as T;
    }
    const overview = path.endsWith('/overview') || path === '/api/judge/display';
    let visibleEvents = events;
    if (path === '/api/public/events' || path === '/api/public/broadcasts')
      visibleEvents = events.filter((ev) => ev.kind === 'broadcast');
    if (path === '/api/player/messages')
      visibleEvents = events.filter((ev) => ev.civilization_id === 'C07');
    const kind = url.searchParams.get('kind');
    if (kind) visibleEvents = visibleEvents.filter((ev) => ev.kind === kind);
    const civilization = url.searchParams.get('civilization');
    if (civilization)
      visibleEvents = visibleEvents.filter((ev) => ev.civilization_id === civilization);
    const status = url.searchParams.get('status');
    if (status) visibleEvents = visibleEvents.filter((ev) => ev.status === status);
    const data: PageData = { version: state.version, events: visibleEvents };
    if (
      path.includes('civilizations') ||
      path.includes('roster') ||
      path.includes('homeworld') ||
      overview
    )
      data.civilizations = people;
    if (path === '/api/judge/homeworld-pending')
      data.civilizations = people.filter((c) => c.home_status === 'pending');
    const last = path.split('/').at(-1)!;
    const c = people.find((c) => c.id === last);
    if (c) data.civilization = c;
    const ev = events.find((ev) => ev.id === last);
    if (ev) data.event = ev;
    if (path.includes('/templates/'))
      data.template = `${state.me?.id ?? 'C07'}（${state.me?.nickname ?? '归零者'}）${path.endsWith('homeworld') ? `提交母星登记，口令${state.me?.home_code}，版本${state.me?.home_version}。口令有效期24小时，请核对现场时间水印照片。` : path.endsWith('respawn') ? '已返回母星，以下是本航次的现场时间水印照片。' : '申请异常复核，请核对本人当前记录。'}`;
    if (path === '/api/player/intel')
      data.events = [
        { ...events[0]!, title: '已获得母星情报', body: '来自已完成的现场目击，获知时母星尚存。' },
      ];
    if (overview)
      data.stats = [
        { label: '存活文明', value: 18 },
        { label: '已淘汰文明', value: 6 },
        { label: '尚存母星', value: 13 },
        ...(state.role === 'judge'
          ? [
              { label: '待审核母星', value: 1, href: '/judge/homeworlds' },
              { label: '通知待办', value: 2, href: '/judge/notices' },
              { label: '尚可发行手环配置', value: 308, href: '/judge/equipment' },
            ]
          : []),
      ];
    if (path === '/api/judge/codebook-status')
      data.stats = [
        { label: '已发行配置', value: 42 },
        { label: '尚可发行配置', value: 308 },
      ];
    if (path === '/api/judge/scheduler/health')
      data.fields = [
        { label: '最近成功调度', value: '14:24:00' },
        { label: '到期积压', value: '0项' },
        { label: '最近错误', value: '无' },
        { label: '下次唤醒', value: '14:25:00' },
      ];
    if (path === '/api/judge/clock')
      data.fields = [{ label: '暂停状态', value: state.match.paused ? '已暂停' : '未暂停' }];
    if (path === '/api/judge/command/help')
      data.commands = [
        { syntax: '/inspect C07', description: '查询指定文明', read_only: true },
        { syntax: '/clock pause', description: '暂停比赛有效时钟', read_only: false },
        { syntax: '/pause_attack @a 60', description: '暂停全场目击60秒', read_only: false },
        { syntax: '/events list', description: '查询赛事事件', read_only: true },
      ];
    if (path.includes('/results/') || (path === '/api/judge/display' && state.results_allowed)) {
      data.finish_reason = '比赛有效时间结束';
      data.report_version = 1;
      data.rankings = people.map((c, i) => ({
        id: c.id,
        nickname: c.nickname,
        rank: i + 1,
        tied: false,
        champion: i === 0,
        kills: c.unique_sight_kills,
        status: i < 2 ? '存活' : '已淘汰',
      }));
    }
    if (path === '/api/judge/export')
      return {
        filename: '赛事报告.txt',
        content: '前端开发预览报告\n' + events.map((ev) => ev.title).join('\n'),
      } as T;
    return structuredClone(data) as T;
  };
}
