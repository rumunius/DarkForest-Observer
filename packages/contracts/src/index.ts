/** Public frontend contracts. Server implementations must enforce every permission. */
export const COLORS = [
  { id: 'BK', name: '黑色' },
  { id: 'WH', name: '白色' },
  { id: 'GY', name: '灰色' },
  { id: 'YL', name: '黄色' },
  { id: 'OR', name: '桔色' },
  { id: 'SB', name: '天蓝色' },
  { id: 'PU', name: '紫色' },
] as const;
export type ColorId = (typeof COLORS)[number]['id'];
export type Arms = [ColorId[], ColorId[]];
export type Stage =
  'setup' | 'outfitting' | 'countdown' | 'forest' | 'apocalypse' | 'transfer' | 'hunt' | 'ended';
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
export interface Session {
  id: string;
  matchId: string;
  role: 'player' | 'judge';
  name: string;
  permissions: string[];
  csrfToken: string;
}
export interface MatchState {
  id: string;
  revision: number;
  stage: Stage;
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
  code?: string;
  actor?: string;
}
export interface Intel {
  id: string;
  civilization: string;
  nickname: string;
  code: string;
  gameMs: number;
  source: string;
}
export interface Voyage {
  number: number;
  arms: Arms;
  startMs: number;
  endMs: number | null;
}
export interface Civilization extends PlayerState {
  voyages: Voyage[];
  rank: number | null;
  tied: boolean;
}
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
}
export interface AuditEntry {
  id: string;
  title: string;
  operator: string;
  reason: string;
  before: string;
  after: string;
  gameMs: number;
}
export interface Effect {
  id: string;
  target: string;
  reason: string;
  untilUtcMs: number;
  operator: string;
  active: boolean;
}
export interface JudgeState {
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
export interface ResultsState {
  version: number;
  reason: string;
  champions: string[];
  standings: Civilization[];
}
export interface Snapshot {
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
export interface OperationResult {
  requestId: string;
  status: 'complete' | 'pending';
  title: string;
  message: string;
  code?: string;
  preview?: ManagementPreview;
}
export interface ManagementPreview {
  token: string;
  revision: number;
  title: string;
  changes: { target: string; before: string; after: string }[];
  consequences: string[];
}
export interface Operation {
  path: string;
  payload: Record<string, unknown>;
  requestId: string;
}
export interface DataSource {
  read(route: string): Promise<Snapshot>;
  login(credential: string, judge: boolean): Promise<void>;
  logout(): Promise<void>;
  submit(operation: Operation): Promise<OperationResult>;
  result(requestId: string): Promise<OperationResult>;
  template(kind: string): Promise<string>;
}
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
export const RULES = {
  regulationMs: 120 * 60000,
  apocalypseMs: 65 * 60000,
  transferMs: 90 * 60000,
  cutoffMs: 98 * 60000,
  observerWaitMs: 180000,
} as const;
export function validArms(arms: Arms): boolean {
  const all = arms.flat();
  const shape = arms
    .map((a) => a.length)
    .sort()
    .join('+');
  return (
    ['1+2', '2+2', '1+3'].includes(shape) &&
    new Set(all).size === all.length &&
    all.every((id) => COLORS.some((c) => c.id === id))
  );
}
export function validCode(value: string): boolean {
  return /^\d{6}$/.test(value);
}
