import {
  RULES,
  type Arms,
  type Civilization,
  type ColorId,
  type GameEvent,
  type Snapshot,
} from '@darkforest/contracts';
import {
  broadcastCopy,
  clearingCopy,
  eliminationCopy,
  qqCopy,
  shipDestroyedCopy,
  techBurstCopy,
} from '../../../../packages/contracts/src/message_copy';
import {DEFAULT_SITE} from '../config';

/** 独立开发预览可模拟的角色，不构成正式服务端身份。 */
export const PREVIEW_ROLES = [
  {id: 'player', label: '玩家'},
  {id: 'observer', label: '四维观察者'},
  {id: 'chief', label: '总裁判'},
  {id: 'communication', label: '通讯裁判'},
  {id: 'event', label: '事件裁判'},
  {id: 'display', label: '观战大屏'},
] as const;

/** 开发预览的固定状态场景，只用于本机演示和交互验证。 */
export const SCENARIOS = [
  {id: 'active', label: '正常出航，有广播和光粒'},
  {id: 'limited', label: '正常出航，无剩余资源'},
  {id: 'locked', label: '个人禁止目击，其他行动可用'},
  {id: 'returning', label: '被击毁，返回母星'},
  {id: 'preparing', label: '重生，离开母星领码'},
  {id: 'issued', label: '重生，佩戴新配置'},
  {id: 'nickname', label: '首次设置昵称'},
  {id: 'registration', label: '登记母星'},
  {id: 'pending', label: '母星等待审核'},
  {id: 'rejected', label: '母星退回修改'},
  {id: 'verified', label: '首航，准备材料'},
  {id: 'staged', label: '首航，等待发码'},
  {id: 'release', label: '首航，可以领取配置'},
  {id: 'outfitting', label: '首航，确认穿戴'},
  {id: 'ready', label: '首航，等待开赛'},
  {id: 'last-life', label: '母星已毁，仍在第一阶段'},
  {id: 'apocalypse', label: '宇宙末日，最后一命'},
  {id: 'transfer', label: '转场，步行前往终局圈'},
  {id: 'verification', label: '98分钟资格核验'},
  {id: 'hunt', label: '最后狩猎'},
  {id: 'paused', label: '全场暂停'},
  {id: 'eliminated', label: '淘汰，等待开放观战'},
  {id: 'observer', label: '已获得观战权限'},
  {id: 'ended', label: '比赛结束，完整复盘'},
  {id: 'no-champion', label: '全体淘汰，无存活冠军'},
] as const;

/** 开发预览可选的模拟角色键，与生产认证角色隔离。 */
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
  communication: [
    'overview',
    'homeworlds',
    'preflight',
    'notices',
    'players',
    'events',
    'account',
  ],
  event: [
    'overview',
    'events',
    'notices',
    'players',
    'attacks',
    'equipment',
    'account',
  ],
};

const preflightFlights: Record<string, Civilization['flight']> = {
  nickname: 'nickname',
  registration: 'unregistered',
  pending: 'pending',
  rejected: 'rejected',
  verified: 'verified',
  staged: 'staged',
  release: 'staged',
  outfitting: 'outfitting',
  ready: 'ready',
};

/** 为开发场景生成可重复的合法颜色分组，不参与正式发码。 */
export function buildArms(i: number): Arms {
  const a = i % 7;
  const b = (a + 1) % 7;
  let c = (a + 2 + Math.floor(i / 7)) % 7;
  while (c === a || c === b) {
    c = (c + 1) % 7;
  }
  return [[colorIds[a]!, colorIds[b]!], [colorIds[c]!]];
}

/** 构造独立开发预览场景，不访问服务器或改变正式赛事状态。 */
export function createPreviewSnapshot(
  role: PreviewRole,
  scenario: string,
): Snapshot {
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
      {number: 1, arms: buildArms(i + 8), startMs: 0, endMs: 12 * 60000},
      {
        number: 2,
        arms: buildArms(i),
        startMs: 17 * 60000,
        endMs: i > 17 ? 25 * 60000 : null,
      },
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
      title: '光粒命中',
      body: clearingCopy('photon', '028416', 'C03（星尘）'),
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
      title: '坐标广播',
      body: broadcastCopy('C12（漂流者）', '001234'),
      gameMs: 30 * 60000 + 12000,
      utcMs: now - 288000,
      audience: 'public',
      civilizationIds: ['C12'],
      code: '001234',
    },
    {
      id: 'EVT-105',
      kind: 'tech',
      title: '技术爆炸',
      body: techBurstCopy('C07（归零者）'),
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
    role === 'chief' ||
    role === 'communication' ||
    role === 'event' ||
    role === 'display';

  const state: Snapshot = {
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
          body: qqCopy(
            '飞船击毁',
            `${shipDestroyedCopy('C04（星尘）')}\n请在比赛时间40:00前完成重生。`,
          ),
          status: 'pending',
          version: 1,
          gameMs: 25 * 60000,
          operator: '',
        },
        {
          id: 'N2',
          target: '比赛QQ群',
          channel: 'group',
          title: '广播公告',
          body: qqCopy('坐标广播', broadcastCopy('C12（漂流者）', '001234')),
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
          body: qqCopy('维度跃迁', eliminationCopy('C19（微光）', 180)),
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

  const match = state.match!;

  const preflightFlight = Object.hasOwn(preflightFlights, scenario)
    ? preflightFlights[scenario]
    : undefined;
  if (preflightFlight !== undefined) {
    match.stage =
      scenario === 'ready'
        ? 'countdown'
        : ['release', 'outfitting'].includes(scenario)
          ? 'outfitting'
          : 'setup';
    match.gameMs = 0;
    match.running = false;
    me.flight = preflightFlight;
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
        scenario === 'rejected'
          ? '请核对最新照片中的六位口令，确保与登记版本一致。'
          : '';
    }
    if (scenario === 'pending') {
      me.actions = ['homeworld-submit'];
      civilizations[2]!.flight = 'pending';
    }
    if (scenario === 'verified') {
      me.actions = ['preflight-depart'];
    }
    if (scenario === 'staged') {
      match.releaseAt = now + 90000;
    }
    if (scenario === 'release') {
      me.actions = ['preflight-issue-code'];
    }
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

  if (
    scenario === 'returning' ||
    scenario === 'preparing' ||
    scenario === 'issued'
  ) {
    me.flight = scenario;
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

  if (scenario === 'last-life') {
    me.homeAlive = false;
  }

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
    me.eliminatedAt =
      now - (scenario === 'eliminated' && role !== 'observer' ? 45000 : 240000);
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
      if (c.flight === 'eliminated') {
        c.arms = null;
      }
    });
    state.results = {
      version: 1,
      reason:
        scenario === 'no-champion'
          ? '全部文明已永久淘汰'
          : '本场仅余一个存活文明，提前完赛',
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
    me.flight =
      scenario === 'ready'
        ? 'ready'
        : scenario === 'release'
          ? 'staged'
          : 'verified';
  }

  civilizations[6] = {
    ...structuredClone(me),
    voyages: civilizations[6]!.voyages,
    rank: state.results ? 1 : null,
    tied: false,
  };

  if (
    [
      'apocalypse',
      'transfer',
      'verification',
      'hunt',
      'ended',
      'no-champion',
    ].includes(scenario)
  ) {
    civilizations.forEach(c => {
      c.homeAlive = false;
      if (c.flight === 'returning') {
        c.flight = 'eliminated';
        c.arms = null;
      }
    });
  }

  const currentVoyage = civilizations[6].voyages.at(-1);

  if (currentVoyage && me.arms) {
    currentVoyage.arms = structuredClone(me.arms);
    currentVoyage.number = me.flightNumber;
  }

  match.survivors = civilizations.filter(c => c.flight !== 'eliminated').length;

  match.homeworldsAlive = civilizations.filter(c => c.homeAlive).length;

  if (state.results) {
    state.results.standings = [...civilizations].sort(
      (a, b) => a.rank! - b.rank!,
    );
  }
  return state;
}
