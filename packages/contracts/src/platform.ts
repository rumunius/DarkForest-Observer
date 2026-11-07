/** 长期账号的玩家或工作人员类别，不等于单场裁判授权。 */
export type AccountKind = 'player' | 'staff';
/** 平台所有者、管理员或资料管理员任职，与本场岗位分开。 */
export type PlatformRole = 'owner' | 'admin' | 'archivist';
/** 独立正式比赛或试玩类别，均保有自己的权威比赛对象。 */
export type MatchKind = 'official' | 'trial';
/** 平台目录生命周期，不能直接替代比赛内部阶段。 */
export type ManagementState =
  | 'draft'
  | 'provisioning'
  | 'available'
  | 'archiving'
  | 'archived'
  | 'purge_pending'
  | 'purged'
  | 'imported_archive';
/** 长期账号的脱敏公开信息，凭据摘要和第二因素秘密不在其中。 */
export interface PlatformAccount {
  id: string;
  kind: AccountKind;
  name: string;
  status: 'pending' | 'active' | 'disabled';
  version: number;
  auth_epoch: number;
  tags: string;
}
/** 长期会话公开投影，包含平台任职与第二因素验证状态。 */
export interface PlatformSession {
  account: PlatformAccount;
  roles: PlatformRole[];
  csrfToken: string;
  secondFactor: boolean;
  secondFactorEnabled?: boolean;
}
/** 当前账号可发现的比赛目录及可选成员信息，返回范围由服务器授权。 */
export interface MatchEntry {
  id: string;
  name: string;
  kind: MatchKind;
  state: ManagementState;
  version: number;
  created_utc: number;
  summary: string;
  synced_utc: number | null;
  recommended: number;
  retention_days: number;
  audit_days: number;
  membership?: MatchMember;
  phase?: string;
}
/** 平台持久操作及收据投影，pending或unknown不能当作完成。 */
export interface PlatformOperation {
  id: string;
  actor: string;
  action: string;
  target: string;
  status: 'pending' | 'succeeded' | 'partial' | 'failed' | 'cancelled';
  created_utc: number;
  attempts: number;
  error: string;
  result: string;
}
/** 长期账号在单场的成员与岗位映射，撤销后不得复用旧身份。 */
export interface MatchMember {
  account_id: string;
  kind: AccountKind;
  name: string;
  local_id: string | null;
  state: 'invited' | 'accepted' | 'bound' | 'revoked';
  epoch: number;
  assignment_id: string | null;
}
/** 按角色与保留期限开放的赛事资料类别。 */
export type MatchDownload = 'report' | 'replay' | 'audit' | 'backup';
/** 本场历史入口、战报版本及当前可下载范围，不承诺已清理资料可恢复。 */
export interface MatchHistory {
  phase: string;
  versions: Array<{
    version: number;
    created_utc: number;
    correction_reason: string;
  }>;
  replayAvailable: boolean;
  downloads: MatchDownload[];
}
