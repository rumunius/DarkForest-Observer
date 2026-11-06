import type {OperationResult} from '@darkforest/contracts';
import {coordinate, nickname} from '../../../../packages/contracts/src/backend';
import {requireThat} from '../storage/store';
import {completed} from './engine';
import type {PlayerActionContext} from './player_action_context';
/** 确认赛前昵称并保持同场唯一性，由入口统一保存审计和版本。 */
export function setPlayerNickname(
  context: PlayerActionContext,
): OperationResult {
  const {raw, db, actor, id} = context;
  const name = nickname(raw.nickname);
  requireThat(
    !db.one<Record<string, SqlStorageValue>>(
      'SELECT id FROM players WHERE nickname=?',
      name,
    ),
    'NICKNAME_TAKEN',
    '这个昵称已被使用。',
  );
  db.exec(
    'UPDATE players SET nickname=? WHERE id=? AND nickname IS NULL',
    name,
    actor.id,
  );
  const result = completed(id, '昵称已确认');
  return result;
}

/** 保存母星待审核版本，不把提交当作裁判审核通过。 */
export function submitHomeworld(context: PlayerActionContext): OperationResult {
  const {raw, db, actor, id} = context;
  const code = coordinate(raw.code);
  db.exec(
    "INSERT INTO homeworlds(player_id,code,status,version) VALUES(?,?,'pending',1) ON CONFLICT(player_id) DO UPDATE SET code=excluded.code,status='pending',version=version+1,rejection='',verified_by=NULL",
    actor.id,
    code,
  );
  const result = completed(
    id,
    '母星登记已提交',
    '请复制消息，附上时间水印照片后发送给裁判。',
  );
  return result;
}
