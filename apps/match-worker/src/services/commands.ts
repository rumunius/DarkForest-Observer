import { strict, text } from '../../../../packages/contracts/src/backend';
import { Fault, permission } from '../storage/store';
import type { Actor } from '../storage/store';
import type { OperationResult } from '@darkforest/contracts';
import { completed, type Engine, type PreparedCode } from './engine';
import { judgeAction, previewAction } from './judge';
import { civilization, events, matchProjection } from '../projections/snapshot';
type Parsed =
  { query: string; target?: string } | { path: string; payload: Record<string, unknown> };
export function parseCommand(value: unknown): Parsed {
  const command = text(value, 1200).trim();
  let match: RegExpExecArray | null;
  if (command === '/help') return { query: 'help' };
  if (['/clock status', '/codebook status', '/events list'].includes(command))
    return { query: command.slice(1) };
  if ((match = /^\/(inspect|history) (C\d{2,3})$/.exec(command)))
    return { query: match[1]!, target: match[2]! };
  if ((match = /^\/clock (pause|resume)$/.exec(command)))
    return { path: `/judge/${match[1]}`, payload: {} };
  if ((match = /^\/pause_attack (@a|C\d{2,3}) ([0-9]+)$/.exec(command)))
    return { path: '/judge/effects', payload: { target: match[1], seconds: Number(match[2]) } };
  if ((match = /^\/player grant (C\d{2,3}) photoid ([01])$/.exec(command)))
    return {
      path: '/judge/correction',
      payload: { target: match[1], field: 'photons', value: match[2] },
    };
  if ((match = /^\/player revive (C\d{2,3})$/.exec(command)))
    return {
      path: '/judge/correction',
      payload: { target: match[1], field: 'restore', value: '' },
    };
  if ((match = /^\/code reissue (C\d{2,3})$/.exec(command)))
    return { path: '/judge/equipment-correction', payload: { target: match[1], mode: 'reissue' } };
  if ((match = /^\/announce @a "([^"\r\n]+)"$/.exec(command)))
    return { path: '/judge/announce', payload: { target: '@a', message: match[1] } };
  if ((match = /^\/tell (C\d{2,3}) "([^"\r\n]+)"$/.exec(command)))
    return { path: '/judge/announce', payload: { target: match[1], message: match[2] } };
  if ((match = /^\/resume_attack (FX-[A-Za-z0-9_-]+)$/.exec(command)))
    return { path: '/judge/effects', payload: { revoke: match[1] } };
  if ((match = /^\/event (retry|cancel) ([A-Za-z0-9:_-]+)$/.exec(command)))
    return { path: '/judge/event-control', payload: { event_id: match[2], operation: match[1] } };
  if ((match = /^\/schedule ([0-9]+) \/announce @a "([^"\r\n]+)"$/.exec(command)))
    return {
      path: '/judge/schedule-announcement',
      payload: { seconds: Number(match[1]), message: match[2] },
    };
  if ((match = /^\/reveal @a (alive_homeworlds|unused_photoids|kills_last_10min)$/.exec(command)))
    return { path: '/judge/reveal', payload: { statistic: match[1] } };
  if ((match = /^\/replay @a public_events ([0-9]+)$/.exec(command)))
    return { path: '/judge/replay', payload: { count: Number(match[1]) } };
  throw new Fault(400, 'UNKNOWN_COMMAND', '无法识别这条指令，请查看查询命令与参数提示。');
}
export function commandAction(
  e: Engine,
  actor: Actor,
  id: string,
  path: string,
  raw: Record<string, unknown>,
  prepared: PreparedCode[],
  keys: Awaited<ReturnType<Engine['keys']>>,
): OperationResult {
  permission(actor, 'commands');
  strict(raw, ['request_id', 'command', 'reason', 'expected_revision', 'preview_token']);
  const parsed = parseCommand(raw.command);
  if ('query' in parsed) {
    let result: unknown;
    if (parsed.query === 'clock status') result = matchProjection(e);
    else if (parsed.query === 'codebook status')
      result = {
        issued: e.db.one<{ count: number }>('SELECT COUNT(*) AS count FROM sighting_codes')!.count,
        capacity: 350,
      };
    else if (parsed.query === 'events list')
      result = events(e, actor, true, Number.MAX_SAFE_INTEGER, 30);
    else if (parsed.query === 'inspect' || parsed.query === 'history')
      result = civilization(e, parsed.target!, keys, true);
    else
      result = [
        '查询：/inspect C07、/history C07、/events list、/clock status、/codebook status',
        '管理：/clock pause、/clock resume、/pause_attack @a 60、/player grant C07 photoid 1、/player revive C07、/code reissue C07',
        '通知：/announce @a "消息"、/tell C07 "消息"',
      ];
    return completed(id, '查询完成', JSON.stringify(result, null, 2));
  }
  const body = {
    ...parsed.payload,
    request_id: id,
    reason: raw.reason,
    expected_revision: raw.expected_revision,
    ...(raw.preview_token ? { preview_token: raw.preview_token } : {}),
  };
  if (path.endsWith('/preview'))
    return previewAction(e, actor, id, {
      ...body,
      path: parsed.path,
      change: text(raw.command, 1200),
    });
  return judgeAction(e, actor, id, parsed.path, body, prepared);
}
