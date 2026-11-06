import type {DomainPhase} from '../../../../packages/contracts/src/backend';
import type {SiteConfig} from '@darkforest/contracts';
export interface Match {
  recovery_state: string;
  id: string;
  phase: DomainPhase;
  revision: number;
  scheduler_revision: number;
  release_at: number | null;
  started_at: number | null;
  start_settled: number | null;
  paused_at: number | null;
  paused_total: number;
  pause_reason: string;
  hunt_finalized: number | null;
  ended_game: number | null;
  ended_utc: number | null;
  finish_reason: string;
  key_fingerprint: string;
  site_json: string;
  created_at: number;
}
export interface Player {
  id: string;
  nickname: string | null;
  entry_status: string;
  tech: number;
  photons: number;
  broadcasts: number;
  observer_revoked: number;
}
export interface FlightRow {
  player_id: string;
  status: string;
  voyage: number;
  code_id: string | null;
  departed: number | null;
  staged: number | null;
  ready: number | null;
  deadline: number | null;
}
export interface Home {
  player_id: string;
  code: string;
  status: string;
  version: number;
  rejection: string;
  verified_by: string | null;
  destroyed_game: number | null;
  source: string | null;
}
export interface CodeRow {
  id: string;
  player_id: string;
  voyage: number;
  mac: string;
  ciphertext: string;
  key_version: number;
  status: string;
  issued_utc: number;
  activated_utc: number | null;
  activated_game: number | null;
  retired_utc: number | null;
  retired_game: number | null;
  retired_reason: string | null;
  request_id: string;
}
export interface Actor {
  version: number;
  id: string;
  match_id: string;
  role: 'player' | 'judge';
  name: string;
  permissions: string;
  credential_hash: string;
  enabled: number;
}
export interface Scheduled {
  id: string;
  kind: string;
  clock: 'game' | 'utc';
  due: number;
  priority: number;
  status: string;
  payload: string;
  committed_utc: number | null;
  attempt_count: number;
  last_attempt_utc: number | null;
  last_error: string;
  last_error_utc: number | null;
}
export interface Parameters {
  singerPercent: number;
  firstLockSeconds: number;
  secondLockSeconds: number;
  secondOutPercent: number;
  respawnSeconds: number;
  observerWaitSeconds: number;
  sightingIntervalMs: number;
  sightingsPerMinute: number;
}
export const DEFAULT_PARAMETERS: Parameters = {
  singerPercent: 5,
  firstLockSeconds: 300,
  secondLockSeconds: 900,
  secondOutPercent: 50,
  respawnSeconds: 900,
  observerWaitSeconds: 180,
  sightingIntervalMs: 4000,
  sightingsPerMinute: 10,
};
export const DEFAULT_SITE: SiteConfig = {
  version: 1,
  title: '黑暗森林：观察者效应',
  description:
    '以文明为名，参加一场现场观察与信息博弈。使用长期口令登录并选择比赛，所有现场移动请正常步行。',
  timezone: 'Asia/Shanghai',
  qqGroup: '',
  judgeContact: '',
  endgameFile: '终局圈图片',
  colors: {
    BK: '#1A1A1A',
    WH: '#F5F5F5',
    GY: '#858585',
    YL: '#F4D12B',
    OR: '#F0802B',
    SB: '#56B7E6',
    PU: '#884CB5',
  },
};
export class Store {
  constructor(public storage: DurableObjectStorage) {}
  /** Rows follow the selected SQL columns; every declared field must be a SQL value. */
  all<
    T extends {[K in keyof T]: SqlStorageValue} = Record<
      string,
      SqlStorageValue
    >,
  >(query: string, ...values: SqlStorageValue[]): T[] {
    return this.storage.sql
      .exec<T & Record<string, SqlStorageValue>>(query, ...values)
      .toArray();
  }
  one<
    T extends {[K in keyof T]: SqlStorageValue} = Record<
      string,
      SqlStorageValue
    >,
  >(query: string, ...values: SqlStorageValue[]): T | undefined {
    return this.all<T>(query, ...values)[0];
  }
  exec(query: string, ...values: SqlStorageValue[]): void {
    this.storage.sql.exec(query, ...values);
  }
  tx<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
  match(): Match {
    const match = this.one<Match>('SELECT * FROM matches');
    if (!match) {
      throw new Fault(503, 'MATCH_NOT_INITIALIZED', '本场比赛尚未初始化。');
    }
    return match;
  }
  player(id: string): Player {
    const player = this.one<Player>('SELECT * FROM players WHERE id=?', id);
    if (!player) {
      throw new Fault(404, 'PLAYER_NOT_FOUND', '文明不存在。');
    }
    return player;
  }
  flight(id: string): FlightRow {
    const flight = this.one<FlightRow>(
      'SELECT * FROM flights WHERE player_id=?',
      id,
    );
    if (!flight) {
      throw new Error('FLIGHT_MISSING');
    }
    return flight;
  }
  roster(): string[] {
    return this.all<{player_id: string}>(
      'SELECT player_id FROM roster_members ORDER BY player_id',
    ).map(r => r.player_id);
  }
  home(id: string): Home | undefined {
    return this.one<Home>('SELECT * FROM homeworlds WHERE player_id=?', id);
  }
  officialHome(code: string, alive = false): Home | undefined {
    return this.one<Home>(
      `SELECT h.* FROM homeworlds h JOIN roster_members r ON r.player_id=h.player_id WHERE h.code=? AND h.status='verified'${alive ? ' AND h.destroyed_game IS NULL' : ''}`,
      code,
    );
  }
  parameters(): Parameters {
    return {
      ...DEFAULT_PARAMETERS,
      ...JSON.parse(
        this.one<{value: string}>(
          "SELECT value FROM settings WHERE key='parameters'",
        )!.value,
      ),
    };
  }
  bump(): void {
    this.exec(
      'UPDATE matches SET revision=revision+1,scheduler_revision=scheduler_revision+1',
    );
  }
}
export class Fault extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function requireThat(
  condition: unknown,
  code: string,
  message: string,
  status = 409,
): asserts condition {
  if (!condition) {
    throw new Fault(status, code, message);
  }
}
export function permission(actor: Actor, name: string): void {
  requireThat(
    actor.role === 'judge' && JSON.parse(actor.permissions).includes(name),
    'FORBIDDEN',
    '当前账号没有执行权限。',
    403,
  );
}
