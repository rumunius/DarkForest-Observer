import {parseJson} from '../../../../packages/contracts/src/backend';
import {accountPermissions} from '../storage/store';
import {
  commandObject,
  namedCommandObject,
  renderCommandTemplate,
  requireObjectOwner,
  singleTarget,
} from './command_context';

import {page} from './command_pagination';
import type {CommandQueryContext} from './command_query_context';
/** 按对象种类和归属检查读取保存对象、模板预览或个案依赖图。 */
export function queryObject(context: CommandQueryContext): unknown {
  const {commandContext, commandNode, engine, words, commandArguments, path} =
    context;

  const kind = path === 'hunt draft inspect' ? 'hunt' : words[0]!;
  if (words[1] === 'list') {
    const all =
      ['macro', 'template'].includes(kind) ||
      accountPermissions(commandContext.actor).includes('commands');
    return page(
      commandContext,
      commandNode,
      'command_objects',
      '*',
      all ? 'kind=?' : 'kind=? AND actor=?',
      all ? [kind] : [kind, commandContext.actor.id],
    );
  }
  if (kind === 'macro' || kind === 'template') {
    const row = namedCommandObject(
      commandContext,
      kind,
      commandArguments[0]!,
      kind === 'macro' && commandArguments[2] !== undefined
        ? Number(commandArguments[2])
        : undefined,
    );
    if (path === 'template preview') {
      const id = singleTarget(commandContext, commandArguments[2]!);
      return renderCommandTemplate(
        commandContext,
        (parseJson(row.data) as {body: string}).body,
        id,
      );
    }
    return {...row, data: parseJson(row.data)};
  }
  const row = commandObject(engine, commandArguments[0]!, kind);
  requireObjectOwner(commandContext, row);
  if (path === 'case graph') {
    const data = parseJson(row.data) as {
      evidence: Array<{ref: string | null; note: string}>;
    };
    const audits = engine.db.all<{
      id: string;
      action: string;
      target: string;
    }>(
      "SELECT id,action,target FROM audit_logs WHERE json_extract(detail,'$.caseId')=? ORDER BY seq",
      row.id,
    );
    const objects = engine.db.all<{id: string; kind: string; status: string}>(
      "SELECT id,kind,status FROM command_objects WHERE json_extract(data,'$.caseId')=? ORDER BY created_utc,id",
      row.id,
    );
    return {
      case: {...row, data},
      nodes: [
        {id: row.id, kind: 'case'},
        ...data.evidence
          .filter(x => x.ref)
          .map(x => ({id: x.ref, kind: 'reference'})),
        ...audits.map(x => ({...x, kind: 'audit'})),
        ...objects,
      ],
      edges: [
        ...data.evidence
          .filter(x => x.ref)
          .map(x => ({
            from: row.id,
            to: x.ref,
            relation: 'evidence',
            note: x.note,
          })),
        ...audits.map(x => ({from: row.id, to: x.id, relation: 'operation'})),
        ...objects.map(x => ({
          from: row.id,
          to: x.id,
          relation: 'authorization',
        })),
      ],
    };
  }
  return {...row, data: parseJson(row.data)};
}
