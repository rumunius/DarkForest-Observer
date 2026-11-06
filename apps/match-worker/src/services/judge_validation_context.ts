import type {Match, Store} from '../storage/store';
import type {Engine} from './engine';
/** 管理资格检查沿用的权威比赛行及原正文；预览和执行复用相同校验。 */
export interface JudgeValidationContext {
  readonly engine: Engine;
  readonly db: Store;
  readonly matchState: Match;
  readonly body: Record<string, unknown>;
}
