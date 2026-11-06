import type {
  Actor,
  FlightRow,
  Home,
  Match,
  Player,
  Store,
} from '../storage/store';
import type {Engine, PreparedCode} from './engine';
/** 仅在同一玩家操作事务内传递的既有时间、状态与准备材料；处理器不能重取另一套时基。 */
export interface PlayerActionContext {
  readonly raw: Record<string, unknown>;
  readonly db: Store;
  readonly actor: Actor;
  readonly id: string;
  readonly now: number;
  readonly engine: Engine;
  readonly prepared: PreparedCode[];
  readonly flight: FlightRow;
  readonly game: number;
  readonly eventId: string;
  readonly matchState: Match;
  readonly keys: Awaited<ReturnType<Engine['keys']>>;
  readonly home: Home | undefined;
  readonly edgeUtc: number;
  readonly playerState: Player;
}
