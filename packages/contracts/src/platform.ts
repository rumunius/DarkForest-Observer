export type AccountKind = 'player' | 'staff';
export type PlatformRole = 'owner' | 'admin' | 'archivist';
export type MatchKind = 'official' | 'trial';
export type ManagementState =
  | 'draft'
  | 'provisioning'
  | 'available'
  | 'archiving'
  | 'archived'
  | 'purge_pending'
  | 'purged'
  | 'imported_archive';
export interface PlatformAccount {
  id: string;
  kind: AccountKind;
  name: string;
  status: 'pending' | 'active' | 'disabled';
  version: number;
  auth_epoch: number;
  tags: string;
}
export interface PlatformSession {
  account: PlatformAccount;
  roles: PlatformRole[];
  csrfToken: string;
  secondFactor: boolean;
  secondFactorEnabled?: boolean;
}
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
export interface MatchMember {
  account_id: string;
  kind: AccountKind;
  name: string;
  local_id: string | null;
  state: 'invited' | 'accepted' | 'bound' | 'revoked';
  epoch: number;
  assignment_id: string | null;
}
export type MatchDownload = 'report' | 'replay' | 'audit' | 'backup';
export interface MatchHistory {
  phase: string;
  versions: { version: number; created_utc: number; correction_reason: string }[];
  replayAvailable: boolean;
  downloads: MatchDownload[];
}
