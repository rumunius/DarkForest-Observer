import type {Actor, Match, Store} from '../storage/store';
import type {CredentialMaterial} from './accounts';
import type {Engine, PreparedCode} from './engine';
/** 裁判入口一次捕获的请求、时间及比赛快照；处理器沿用调用方权威事务。 */
export interface JudgeActionContext {
  readonly engine: Engine;
  readonly actor: Actor;
  readonly id: string;
  readonly path: string;
  readonly raw: Record<string, unknown>;
  readonly prepared: PreparedCode[];
  readonly credentialMaterial: CredentialMaterial | undefined;
  readonly db: Store;
  readonly matchState: Match;
  readonly now: number;
  readonly game: number;
}
/** 已通过共同权限、正文及预览校验的变更上下文，不重新生成来源或原因。 */
export interface JudgeMutationContext extends JudgeActionContext {
  readonly reason: string;
  readonly source: string;
}
