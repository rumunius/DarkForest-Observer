import type {DomainPhase} from './backend';

/** Public frontend contracts. Server implementations must enforce every permission. */
export const COLORS = [
  {id: 'BK', name: '黑色'},
  {id: 'WH', name: '白色'},
  {id: 'GY', name: '灰色'},
  {id: 'YL', name: '黄色'},
  {id: 'OR', name: '桔色'},
  {id: 'SB', name: '天蓝色'},
  {id: 'PU', name: '紫色'},
] as const;
/** 共享七色标识的联合类型，顺序与位映射由固定色盘定义。 */
export type ColorId = (typeof COLORS)[number]['id'];
/** 两臂的颜色集合；同臂顺序和两臂交换不改变手环码身份。 */
export type Arms = [ColorId[], ColorId[]];
/** 前端显示阶段，部分服务器准备阶段合并显示。 */
export type Stage =
  | 'setup'
  | 'outfitting'
  | 'countdown'
  | 'forest'
  | 'apocalypse'
  | 'transfer'
  | 'hunt'
  | 'ended';
/** 客户端可见的当前航次或身份准备状态，权威变更仍在服务器进行。 */
export type Flight =
  | 'nickname'
  | 'unregistered'
  | 'pending'
  | 'rejected'
  | 'verified'
  | 'departed'
  | 'staged'
  | 'outfitting'
  | 'ready'
  | 'active'
  | 'returning'
  | 'preparing'
  | 'issued'
  | 'eliminated'
  | 'absent';
/** 玩家正式动作键，页面与后端许可矩阵共同引用。 */
export type Action =
  | 'nickname'
  | 'homeworld-submit'
  | 'preflight-depart'
  | 'preflight-stage'
  | 'preflight-issue-code'
  | 'preflight-ready'
  | 'sighting'
  | 'broadcast'
  | 'photon'
  | 'return-confirm'
  | 'issue-code'
  | 'launch'
  | 'withdraw';
/** 可公开的站点、联系与七色色值配置，不包含密钥或权限开关。 */
export interface SiteConfig {
  version: number;
  title: string;
  description: string;
  timezone: string;
  qqGroup: string;
  judgeContact: string;
  endgameFile: string;
  colors: Record<ColorId, string>;
}
/** 本场公开会话投影，仅包含页面所需身份、职责与CSRF令牌。 */
export interface Session {
  id: string;
  matchId: string;
  role: 'player' | 'judge';
  name: string;
  permissions: string[];
  csrfToken: string;
}
/** 本场可见的阶段、双时钟及暂停快照，不能用于客户端独立结算。 */
export interface MatchState {
  recoveryReview?: boolean;
  id: string;
  revision: number;
  stage: Stage;
  phase?: DomainPhase;
  gameMs: number;
  serverUtcMs: number;
  running: boolean;
  paused: boolean;
  pauseReason: string;
  verification: boolean;
  total: number;
  survivors: number;
  homeworldsAlive: number;
  releaseAt: number | null;
  startAt: number | null;
}
/** 本人可见的资源、航次和可用动作，隐藏他人的未授权秘密。 */
export interface PlayerState {
  id: string;
  nickname: string;
  flight: Flight;
  homeworld: string | null;
  homeAlive: boolean;
  homeVersion: number;
  rejection: string;
  arms: Arms | null;
  flightNumber: number;
  kills: number;
  wrongCount: number;
  broadcasts: number;
  photons: number;
  attackLockedUntil: number;
  respawnDeadline: number | null;
  eliminatedAt: number | null;
  eliminationReason: string;
  observerAllowed: boolean;
  actions: Action[];
}
/** 已发生赛事事实的客户端投影，保留受众、来源及事件时间。 */
export interface GameEvent {
  id: string;
  kind:
    | 'sighting'
    | 'broadcast'
    | 'photon'
    | 'singer'
    | 'respawn'
    | 'stage'
    | 'notice'
    | 'review'
    | 'tech';
  title: string;
  body: string;
  gameMs: number;
  utcMs: number;
  audience: 'public' | 'personal' | 'global';
  civilizationIds: string[];
  recipient?: string;
  code?: string;
  actor?: string;
}
/** 已获准情报的内容和来源，不包含未来计划或服务器密钥。 */
export interface Intel {
  id: string;
  civilization: string;
  nickname: string;
  code: string;
  gameMs: number;
  source: string;
}
/** 历史航次投影，保留配置与生效时间以解释本人行动记录。 */
export interface Voyage {
  number: number;
  arms: Arms;
  startMs: number;
  endMs: number | null;
}
/** 按角色授权裁剪的文明态势投影，不能直接等同存储行。 */
export interface Civilization extends PlayerState {
  voyages: Voyage[];
  rank: number | null;
  tied: boolean;
}
/** 裁判QQ通知待办，复制与实际发送分别记录版本、操作者和UTC。 */
export interface Notice {
  id: string;
  target: string;
  channel: 'group' | 'private';
  title: string;
  body: string;
  status: 'pending' | 'copied' | 'sent' | 'error';
  version: number;
  gameMs: number;
  operator: string;
  priority?: number;
  copiedBy?: string | null;
  copiedUtcMs?: number | null;
  sentBy?: string | null;
  sentUtcMs?: number | null;
  error?: string;
}
/** 管理操作的公开审计投影，包含前后变化和原因而不包含登录秘密。 */
export interface AuditEntry {
  id: string;
  title: string;
  operator: string;
  reason: string;
  before: string;
  after: string;
  gameMs: number;
  utcMs?: number;
  target?: string;
  status?: string;
}
/** 带真实UTC期限的临时管理效果，与有效比赛时钟暂停分开。 */
export interface Effect {
  id: string;
  target: string;
  reason: string;
  untilUtcMs: number;
  operator: string;
  active: boolean;
}
/** 按裁判职责裁剪的后台快照，分页历史与游标保持独立。 */
export interface JudgeState {
  noticePendingCount?: number;
  noticeTasks?: Notice[];
  scheduledEvents?: ScheduledEvent[];
  cursors?: Partial<Record<'notices' | 'audits' | 'attacks', string | null>>;
  accounts?: AccountSummary[];
  attacks?: Array<{
    id: string;
    actor: string;
    target: string | null;
    classification: string;
    roll: number | null;
    wrongIndex: number | null;
    utcMs: number;
    valid: boolean;
  }>;
  roster?: {
    members: string[];
    accounts: Array<{id: string; nickname: string; eligible: boolean}>;
    locked: boolean;
  };
  parameters?: {version: number; locked: boolean; values: RuleParameters};
  notices: Notice[];
  audits: AuditEntry[];
  effects: Effect[];
  issuedCodes: number;
  scheduler: {
    lastSuccessUtcMs: number;
    nextWakeUtcMs: number | null;
    backlog: number;
    error: string;
  };
}
/** 裁判可见的持久事件及故障状态，重试沿用原事件ID。 */
export interface ScheduledEvent {
  id: string;
  kind: string;
  clock: 'game' | 'utc';
  due: number;
  status: string;
  attempts: number;
  lastAttemptUtcMs: number | null;
  lastError: string;
  lastErrorUtcMs: number | null;
  committedUtcMs: number | null;
  payload: Record<string, unknown>;
}
/** 封存战报版本与排名，支持后续更正但不覆盖旧版本。 */
export interface ResultsState {
  correctionReason?: string;
  versions?: Array<{version: number; reason: string; createdUtc: number}>;
  version: number;
  reason: string;
  champions: string[];
  standings: Civilization[];
}
/** 单次授权页面读取的整体投影，不是可写入的权威比赛状态。 */
export interface Snapshot {
  eventCursor?: string | null;
  parameters?: RuleParameters;
  site: SiteConfig;
  session: Session | null;
  match: MatchState | null;
  player: PlayerState | null;
  events: GameEvent[];
  intel: Intel[];
  civilizations: Civilization[];
  judge: JudgeState | null;
  results: ResultsState | null;
}
/** 公开的赛前规则参数，单位与服务器参数约束保持一致。 */
export interface RuleParameters {
  singerPercent: number;
  firstLockSeconds: number;
  secondLockSeconds: number;
  secondOutPercent: number;
  respawnSeconds: number;
  observerWaitSeconds: number;
  sightingIntervalMs: number;
  sightingsPerMinute: number;
}
/** 本场写操作的确定或待确认结果，可能附带管理影响预览。 */
export interface OperationResult {
  scheduler?: {settledEvents: string[]; remaining: number};
  credentialDeliveryId?: string;
  requestId: string;
  status: 'complete' | 'pending';
  title: string;
  message: string;
  code?: string;
  preview?: ManagementPreview;
  revision?: number;
  outcome?: {
    accepted?: boolean;
    eventId?: string;
    target?: string;
    intel?: Intel;
    remaining?: number;
    wrongCount?: number;
    lockedUntilUtcMs?: number;
    eliminated?: boolean;
  };
}
/** 本场账号管理所需的脱敏摘要，不包含原始凭据。 */
export interface AccountSummary {
  id: string;
  name: string;
  role: 'player' | 'judge';
  enabled: boolean;
  version: number;
  permissions: string[];
}
/** 绑定版本、令牌、前后变化及后果的确认材料，不能跨操作复用。 */
export interface ManagementPreview {
  token: string;
  revision: number;
  title: string;
  changes: Array<{target: string; before: string; after: string}>;
  consequences: string[];
}
/** 前端提交的原始操作草稿及稳定请求ID，重试应查询同一操作。 */
export interface Operation {
  path: string;
  payload: Record<string, unknown>;
  requestId: string;
}
/** 母星提交的唯一公开wire正文，六位口令始终作为字符串。 */
export interface HomeworldSubmission {
  code: string;
}
/** 页面数据与操作接口，正式HTTP适配和独立预览适配共享该契约。 */
export interface DataSource {
  judgePage?(
    kind: 'notices' | 'audits' | 'attacks',
    cursor: string,
  ): Promise<{
    items: Notice[] | AuditEntry[] | NonNullable<JudgeState['attacks']>;
    nextCursor: string | null;
  }>;
  credential?(id: string): Promise<{accountId: string; credential: string}>;
  exportData?(kind: string): Promise<{fileName: string; text: string}>;
  eventsPage?(
    route: string,
    cursor: string,
  ): Promise<{items: GameEvent[]; nextCursor: string | null}>;
  read(route: string): Promise<Snapshot>;
  login(credential: string, judge: boolean): Promise<void>;
  logout(): Promise<void>;
  submit(operation: Operation): Promise<OperationResult>;
  result(requestId: string): Promise<OperationResult>;
  template(kind: string): Promise<string>;
}
/** 显示阶段的中文标签，不能代替阶段许可矩阵。 */
export const STAGE_NAMES: Record<Stage, string> = {
  setup: '赛前准备',
  outfitting: '首航装备',
  countdown: '等待开赛',
  forest: '黑暗森林',
  apocalypse: '宇宙末日',
  transfer: '转场',
  hunt: '最后狩猎',
  ended: '比赛结束',
};
/** 航次和准备状态的中文标签，业务分支仍使用稳定状态键。 */
export const FLIGHT_NAMES: Record<Flight, string> = {
  nickname: '等待设置昵称',
  unregistered: '等待登记母星',
  pending: '母星待审核',
  rejected: '母星需要修改',
  verified: '母星审核通过',
  departed: '核对手环材料',
  staged: '等待发码',
  outfitting: '等待穿戴就绪',
  ready: '等待正式开赛',
  active: '正常出航',
  returning: '正在返回母星',
  preparing: '准备重新出航',
  issued: '等待完成出航',
  eliminated: '永久淘汰',
  absent: '未参加本场比赛',
};
/** 共享规则显示条目及锚点，供玩家页面和说明入口复用。 */
export const RULES = {
  regulationMs: 120 * 60000,
  apocalypseMs: 65 * 60000,
  transferMs: 90 * 60000,
  cutoffMs: 98 * 60000,
  observerWaitMs: 180000,
} as const;
/** 检查颜色唯一性及合法分组数量，不推断目标文明或攻击结果。 */
export function validArms(arms: Arms): boolean {
  const all = arms.flat();
  const shape = arms
    .map(a => a.length)
    .sort()
    .join('+');
  return (
    ['1+2', '2+2', '1+3'].includes(shape) &&
    new Set(all).size === all.length &&
    all.every(id => COLORS.some(c => c.id === id))
  );
}
/** 检查六位十进制口令的前端格式，真实目标和行动资格在服务端验证。 */
export function validCode(value: string): boolean {
  return /^\d{6}$/.test(value);
}
export type * from './platform';
