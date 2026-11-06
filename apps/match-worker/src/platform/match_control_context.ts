import type {Engine} from '../services/engine';
import type {Store} from '../storage/store';
import type {ControlRequest} from './match_control';

/** 已核验签名且处于本场同步事务中的控制材料，哈希和指纹由入口预先准备。 */
export interface MatchControlContext {
  readonly engine: Engine;
  readonly db: Store;
  readonly request: ControlRequest;
  readonly payload: Record<string, unknown>;
  readonly hash: string;
  readonly fingerprint: string;
}
