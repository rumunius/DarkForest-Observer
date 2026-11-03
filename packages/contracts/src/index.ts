/** Browser-safe contracts; all game outcomes remain server-authoritative. */
export const COLORS = [
  { id: 'BK', name: '黑色', hex: '#1A1A1A' },
  { id: 'WH', name: '白色', hex: '#F5F5F5' },
  { id: 'GY', name: '灰色', hex: '#858585' },
  { id: 'YL', name: '黄色', hex: '#F4D12B' },
  { id: 'OR', name: '桔色', hex: '#F0802B' },
  { id: 'SB', name: '天蓝色', hex: '#56B7E6' },
  { id: 'PU', name: '紫色', hex: '#884CB5' },
] as const;
export type ColorId = (typeof COLORS)[number]['id'];
export type Arms = [ColorId[], ColorId[]];
export type Phase =
  | 'setup'
  | 'armed'
  | 'outfitting'
  | 'start_countdown'
  | 'forest'
  | 'apocalypse'
  | 'transfer'
  | 'hunt'
  | 'ended';
export type Flight =
  | 'prelaunch'
  | 'staged'
  | 'outfitting'
  | 'ready'
  | 'active'
  | 'returning'
  | 'preparing'
  | 'issued'
  | 'eliminated';
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
  name: string;
  description: string;
  timezone: string;
  qq_group: string;
  judge_contact: string;
  endgame_file: string;
  room_file: string;
  colors: Record<ColorId, string>;
}
export interface Clock {
  server_utc_ms: number;
  game_ms: number;
  running: boolean;
  phase_end_game_ms?: number;
}
export interface Match {
  id: string;
  phase: Phase;
  paused: boolean;
  pause_reason?: string;
  hunt_review: boolean;
  clock: Clock;
  survivors: number;
}
export interface Bracelet {
  flight: number;
  arms: Arms;
  status: 'reserved' | 'active' | 'retired';
  activated_at?: string;
  retired_at?: string;
}
export interface Civilization {
  id: string;
  nickname: string;
  flight_status: Flight;
  home_status: 'unregistered' | 'pending' | 'rejected' | 'alive' | 'destroyed';
  home_code?: string;
  home_version?: number;
  home_reason?: string;
  bracelet?: Bracelet;
  unique_sight_kills: number;
  wrong_count: number;
  broadcast_remaining: number;
  photon_remaining: number;
  respawn_deadline_game_ms?: number;
  sighting_locked_until_utc_ms?: number;
  observer_unlock_at_utc_ms?: number;
  eliminated_at?: string;
  elimination_reason?: string;
  code_release_at_utc_ms?: number;
  started_at_utc_ms?: number;
  flights?: Bracelet[];
}
export interface SessionState {
  version: number;
  account_id: string;
  role: 'player' | 'judge';
  role_label: string;
  csrf_token: string;
  match: Match;
  me?: Civilization;
  allowed_actions: Action[];
  permissions: string[];
  observer_allowed: boolean;
  results_allowed: boolean;
  status_message: string;
}
export interface EventRecord {
  id: string;
  title: string;
  body: string;
  kind: string;
  occurred_at: string;
  game_ms: number;
  source?: string;
  civilization_id?: string;
  code?: string;
  version: number;
  status?: string;
  recipient?: string;
  copied_at?: string;
  sent_at?: string;
}
export interface PageData {
  version: number;
  title?: string;
  description?: string;
  events?: EventRecord[];
  civilizations?: Civilization[];
  civilization?: Civilization;
  event?: EventRecord;
  stats?: { label: string; value: string | number; href?: string }[];
  next_cursor?: string;
  template?: string;
  rankings?: {
    id: string;
    nickname: string;
    rank: number;
    tied: boolean;
    champion: boolean;
    kills: number;
    status: string;
  }[];
  finish_reason?: string;
  report_version?: number;
  commands?: { syntax: string; description: string; read_only: boolean }[];
  fields?: { label: string; value: string }[];
}
export interface OperationResult {
  status: 'completed' | 'pending' | 'not_found';
  accepted?: boolean;
  message?: string;
  result?: 'hit' | 'no_hit';
  target?: { id: string; nickname: string };
  homeworld_intel?: string;
  wrong_count?: number;
  state?: SessionState;
}
export interface Preview {
  token: string;
  version: number;
  summary: string;
  changes: { label: string; before: string; after: string }[];
  consequences: string[];
}
export const isCoordinateCode = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9]{6}$/.test(value);
export function validArms(arms: readonly (readonly string[])[]): boolean {
  if (arms.length !== 2) return false;
  const all = arms.flat();
  const shape = arms
    .map((a) => a.length)
    .sort()
    .join('+');
  return (
    ['1+2', '1+3', '2+2'].includes(shape) &&
    new Set(all).size === all.length &&
    all.every((id) => COLORS.some((c) => c.id === id))
  );
}
export function validNickname(value: string): boolean {
  const length = Array.from(value.normalize('NFC').trim()).length;
  return length >= 2 && length <= 8 && !/[\p{Cc}\p{Cf}]/u.test(value);
}
