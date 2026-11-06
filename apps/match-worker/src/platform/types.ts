import type {
  MatchEntry,
  PlatformAccount,
} from '../../../../packages/contracts/src/platform';

/** 平台账号的持久行，包含仅限服务端使用的凭据摘要与第二因素状态。 */
export type Account = PlatformAccount & {
  credential_hash: string | null;
  totp_ciphertext: string | null;
  last_totp_step: number;
  created_utc: number;
} & Record<string, SqlStorageValue>;

/** 平台持久会话行；授权世代、撤销标志和UTC有效期必须在使用时复核。 */
export interface Login {
  token_hash: string;
  account_id: string;
  auth_epoch: number;
  csrf: string;
  created_utc: number;
  expires: number;
  second_factor: number;
  revoked: number;
}

/** 比赛目录持久行；成员投影不属于该SQL行，必须另行查询授权后组合。 */
export type Directory = Omit<MatchEntry, 'membership'> & {
  pool_id: string;
  object_name: string;
  config: string;
} & Record<string, SqlStorageValue>;

/** 平台队列中的幂等操作行，保存请求摘要、执行状态、重试时间和收据。 */
export interface Operation {
  id: string;
  actor: string;
  action: string;
  target: string;
  body_hash: string;
  payload: string;
  status: string;
  created_utc: number;
  attempts: number;
  next_attempt: number;
  error: string;
  result: string;
}

/** 需要资料管理范围校验的操作路径，不能仅以全局平台身份放行。 */
export const DATA_ACTIONS = [
  '/platform/data/hold',
  '/platform/data/purge',
  '/platform/data/cancel-purge',
];
