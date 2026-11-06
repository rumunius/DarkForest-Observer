import {parseJson} from '../../../../packages/contracts/src/backend';
import {
  numericRecord,
  stringArray,
} from '../../../../packages/contracts/src/backend';
import type {DomainPhase} from '../../../../packages/contracts/src/backend';
import type {SiteConfig} from '@darkforest/contracts';
/** 本场权威比赛行；UTC节点、暂停累计和有效时间字段不能混用。 */
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
/** 文明的持久资源与资格行，飞船航次和母星状态由各自记录管理。 */
export interface Player {
  id: string;
  nickname: string | null;
  entry_status: string;
  tech: number;
  photons: number;
  broadcasts: number;
  observer_revoked: number;
}
/** 文明当前航次行，关联唯一现役码与有效比赛时间上的重生截止。 */
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
/** 母星登记与审核版本行，六位口令保留前导零并与手环码独立。 */
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
/** 手环永久发行记录，保留退役事实与加密材料而不向客户端公开索引。 */
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
/** 本场认证账号行；凭据摘要和权限文本仅供服务端使用。 */
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
/** 持久事件行，包含时基、原定时刻、状态和失败诊断以支持幂等补结算。 */
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
/** 赛前可配置的比赛参数，正式锁定后不得由普通配置入口改变。 */
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
/** 未提供可配置项时的默认规则参数，单位在字段名中明确。 */
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
/** 默认公共站点展示配置；不包含业务秘密或可绕过权限的控制项。 */
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
/** 对Durable Object SQLite的参数绑定访问及同步事务封装。 */
export class Store {
  constructor(readonly storage: DurableObjectStorage) {}

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

  /** 读取参数绑定查询的第一行；没有匹配行时返回undefined。 */
  one<
    T extends {[K in keyof T]: SqlStorageValue} = Record<
      string,
      SqlStorageValue
    >,
  >(query: string, ...values: SqlStorageValue[]): T | undefined {
    return this.all<T>(query, ...values)[0];
  }

  /** 执行固定SQL及绑定参数，不拼接调用方输入为SQL结构。 */
  exec(query: string, ...values: SqlStorageValue[]): void {
    this.storage.sql.exec(query, ...values);
  }

  /** 使用Durable Object同步事务包裹整个业务结算，回调中不能等待网络。 */
  tx<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }

  /** 读取本场唯一比赛行，尚未初始化时明确拒绝业务入口。 */
  match(): Match {
    const match = this.one<Match>('SELECT * FROM matches');
    if (!match) {
      throw new Fault(503, 'MATCH_NOT_INITIALIZED', '本场比赛尚未初始化。');
    }
    return match;
  }

  /** 读取指定文明行；账号池成员不一定已经成为本场文明。 */
  player(id: string): Player {
    const player = this.one<Player>('SELECT * FROM players WHERE id=?', id);
    if (!player) {
      throw new Fault(404, 'PLAYER_NOT_FOUND', '文明不存在。');
    }
    return player;
  }

  /** 读取文明当前航次，缺失代表权威数据不完整。 */
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

  /** 以稳定顺序读取正式名单，区别于预注册账号池。 */
  roster(): string[] {
    return this.all<{player_id: string}>(
      'SELECT player_id FROM roster_members ORDER BY player_id',
    ).map(r => r.player_id);
  }

  /** 读取指定文明的母星登记；尚未登记时返回undefined。 */
  home(id: string): Home | undefined {
    return this.one<Home>('SELECT * FROM homeworlds WHERE player_id=?', id);
  }

  /** 仅在正式名单和已审核母星中匹配口令，可进一步要求母星尚存。 */
  officialHome(code: string, alive = false): Home | undefined {
    return this.one<Home>(
      `SELECT h.* FROM homeworlds h JOIN roster_members r ON r.player_id=h.player_id WHERE h.code=? AND h.status='verified'${alive ? ' AND h.destroyed_game IS NULL' : ''}`,
      code,
    );
  }

  /** 合并默认值与校验后的持久数值参数，保持缺省项的历史兼容。 */
  parameters(): Parameters {
    return {
      ...DEFAULT_PARAMETERS,
      ...numericRecord(
        parseJson(
          this.one<{value: string}>(
            "SELECT value FROM settings WHERE key='parameters'",
          )!.value,
        ),
      ),
    };
  }

  /** 在同一业务事务中推进比赛及调度版本，使过时预览可被检测。 */
  bump(): void {
    this.exec(
      'UPDATE matches SET revision=revision+1,scheduler_revision=scheduler_revision+1',
    );
  }
}
/** 可向调用方展示的业务错误，绑定HTTP状态、稳定错误码与说明。 */
export class Fault extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
/** 把失败的业务前置条件转换成明确错误，阻止当前事务继续执行。 */
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
/** Decode the list written by account duty assignment before checking privileges. */
export function accountPermissions(
  actor: Pick<Actor, 'permissions'>,
): string[] {
  return stringArray(parseJson(actor.permissions));
}

/** 按本场角色和已校验权限列表授权，观战或平台管理员不能隐式放行。 */
export function permission(actor: Actor, name: string): void {
  requireThat(
    actor.role === 'judge' && accountPermissions(actor).includes(name),
    'FORBIDDEN',
    '当前账号没有执行权限。',
    403,
  );
}
