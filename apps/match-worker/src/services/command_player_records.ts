import {nickname, text} from '../../../../packages/contracts/src/backend';
import {
  recordChange,
  renderCommandTemplate,
  requireCommandArgument,
  saveCommandObject,
} from './command_context';
import {
  forEachCommandPlayer,
  type CommandPlayerContext,
} from './command_player_context';

/** 按目标渲染昵称并核对唯一性，不更改参赛身份。 */
export function renameCommandPlayers(context: CommandPlayerContext): unknown {
  const {commandContext, db, commandArguments} = context;

  return forEachCommandPlayer(context, id => {
    const name = nickname(
      renderCommandTemplate(commandContext, commandArguments[1]!, id),
    );
    requireCommandArgument(
      !db.one<Record<string, SqlStorageValue>>(
        'SELECT id FROM players WHERE nickname=? AND id<>?',
        name,
        id,
      ),
      '昵称已被使用',
    );
    db.exec('UPDATE players SET nickname=? WHERE id=?', name, id);
  });
}

/** 在当前目标池内保存或移除标签，保留明确的变化记录。 */
export function changeCommandTags(context: CommandPlayerContext): unknown {
  const {commandContext, db, path, commandArguments} = context;

  return forEachCommandPlayer(
    context,
    id => {
      const tag = text(commandArguments[1], 1024);
      if (path === 'tag add') {
        db.exec('INSERT OR IGNORE INTO command_tags VALUES(?,?)', id, tag);
      } else {
        db.exec(
          'DELETE FROM command_tags WHERE player_id=? AND tag=?',
          id,
          tag,
        );
      }
      recordChange(
        commandContext,
        id + '标签',
        path.endsWith('add') ? '未添加' : '已添加',
        tag,
      );
    },
    true,
  );
}

/** 保存指定文明的现场准备备注，不捏造穿戴或准备事实。 */
export function noteCommandPreflight(context: CommandPlayerContext): unknown {
  const {commandContext, commandArguments} = context;

  return forEachCommandPlayer(
    context,
    id => {
      saveCommandObject(commandContext, 'preflight', {
        target: id,
        note: commandArguments[1],
      });
    },
    true,
  );
}
