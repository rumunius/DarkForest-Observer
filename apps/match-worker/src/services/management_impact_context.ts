import type {ManagementPreview} from '@darkforest/contracts';
import {stableJson} from '../../../../packages/contracts/src/backend';
import {observerAllowed} from '../projections/snapshot';
import type {Match, Store} from '../storage/store';
import {requireThat} from '../storage/store';
import type {Engine} from './engine';
import {survivors} from './life';
import {restoration} from './player_correction';

/** 管理预览的变化与后果；不包含确认令牌或执行结果。 */
export type Impact = Pick<ManagementPreview, 'changes' | 'consequences'>;
/** 一次影响计算沿用的权威比赛行、已校验正文及有序输出。 */
export interface ManagementImpactContext {
  readonly engine: Engine;
  readonly db: Store;
  readonly matchState: Match;
  readonly target: string;
  readonly body: Record<string, unknown>;
  readonly changes: Impact['changes'];
  readonly consequences: string[];
}
/** 用统一序列化方式追加前后变化，保留用户确认时的显示顺序。 */
export function addChange(
  context: ManagementImpactContext,
  label: string,
  before: unknown,
  after: unknown,
): number {
  return context.changes.push({
    target: label,
    before: typeof before === 'string' ? before : stableJson(before),
    after: typeof after === 'string' ? after : stableJson(after),
  });
}
/** 核对尚未发行容量并说明随机签发及旧码永久退役。 */
export function issuanceImpact(context: ManagementImpactContext): void {
  const {db, consequences} = context;

  const remaining =
    350 -
    db.one<{count: number}>('SELECT COUNT(*) AS count FROM sighting_codes')!
      .count;
  requireThat(
    remaining > 0,
    'CODEBOOK_EXHAUSTED',
    '本场手环配置已耗尽，请暂停处置。',
  );
  addChange(context, '尚可发行配置', remaining, remaining - 1);
  consequences.push(
    '旧配置永久退役；执行时从尚未发行的配置中随机签发一枚新码，佩戴核对后由裁判激活。',
  );
}
/** 预览恢复文明的航次、淘汰资格及观战变化。 */
export function restorationImpact(
  context: ManagementImpactContext,
  id: string,
): void {
  const {engine, db, consequences} = context;

  const next = restoration(engine, id);
  addChange(context, `${id}飞船`, db.flight(id).status, next.status);
  addChange(
    context,
    `${id}重生截止（有效毫秒）`,
    db.flight(id).deadline,
    next.deadline,
  );
  addChange(context, `${id}有效淘汰记录`, '有效', '撤销并保留原记录');
  addChange(
    context,
    `${id}赛中观战`,
    observerAllowed(engine, db.player(id)),
    false,
  );
  if (next.status === 'issued') {
    issuanceImpact(context);
  }
  consequences.push(
    '重新计算存活与排名资格；已传播的情报及旧通知保留，并新增资格更正通知。',
  );
}
/** 预览一批文明淘汰及可能触发的提前完赛。 */
export function eliminationImpact(
  context: ManagementImpactContext,
  ids: string[],
): void {
  const {engine, db, consequences} = context;

  for (const id of ids) {
    addChange(context, `${id}飞船`, db.flight(id).status, 'eliminated');
    addChange(
      context,
      `${id}配置`,
      db.flight(id).code_id ?? '无当前配置',
      '永久退役、清空当前引用',
    );
  }
  const left = survivors(engine).length - ids.length;
  addChange(context, '存活文明', survivors(engine).length, left);
  consequences.push(
    `写入淘汰、通知与排名记录；观战等待${db.parameters().observerWaitSeconds}秒。${left <= 1 ? '本次结算将触发提前完赛、封存排名并取消剩余正赛计划。' : '比赛继续。'}`,
  );
}
