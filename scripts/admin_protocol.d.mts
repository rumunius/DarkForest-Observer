import type {URL} from 'node:url';
/** 规范化JSON对象键顺序，供请求摘要和材料回读使用。 */
export function stable(value: unknown): string;
/** 为运维材料生成校验摘要，不代替远端消息认证。 */
export function checksum(value: unknown): string;
/** 校验明确选择的站点地址，后续向导请求使用同一来源。 */
export function siteUrl(value: string): URL;
/** 根据持久恢复状态选择下一步，不能跳过材料保存及核对。 */
export function nextRecoveryAction(
  state: string,
):
  | 'save-carry'
  | 'launch'
  | 'status'
  | 'complete'
  | 'website-review'
  | 'select-checkpoint';
/** 检测正式场次状态，在活动比赛不适合发布时阻止继续。 */
export function assertReleaseSafe(diagnostics: {
  matches: Array<{kind: string; summary: string | {phase?: string}}>;
}): void;
