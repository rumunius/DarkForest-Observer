import {parseJson} from '../../../../packages/contracts/src/backend';
import {CommandSyntaxError} from '../../../../packages/contracts/src/commands';
import {uniformInt} from '../domain/rules';
import {requireThat} from '../storage/store';
import type {Engine} from './engine';

export function splitFilters(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '\\' && quoted) {
      i++;
      continue;
    }
    if (c === '"') {
      quoted = !quoted;
    }
    if (!quoted) {
      if (c === '{') {
        depth++;
      }
      if (c === '}') {
        depth--;
      }
      if (c === ',' && depth === 0) {
        parts.push(input.slice(start, i).trim());
        start = i + 1;
      }
    }
  }
  if (depth || quoted) {
    throw new CommandSyntaxError('筛选条件未闭合');
  }
  parts.push(input.slice(start).trim());
  return parts;
}
export function inRange(n: number, range: string): boolean {
  if (!/^(?:\d+(?:\.\.\d*)?|\.\.\d+)$/.test(range)) {
    throw new CommandSyntaxError('数值范围格式不正确');
  }
  if (!range.includes('..')) {
    return n === Number(range);
  }
  const [a, b] = range.split('..');
  if (a && b && Number(a) > Number(b)) {
    throw new CommandSyntaxError('范围下界大于上界');
  }
  return (!a || n >= Number(a)) && (!b || n <= Number(b));
}
export function score(e: Engine, id: string, key: string): number {
  const p = e.db.player(id);
  if (key === 'photons') {
    return p.photons;
  }
  if (key === 'broadcasts') {
    return 2 - p.broadcasts;
  }
  if (key === 'wrong') {
    return e.db.one<{wrong: number}>(
      'SELECT wrong FROM attack_controls WHERE player_id=?',
      id,
    )!.wrong;
  }
  if (key === 'kills') {
    return e.db.one<{n: number}>(
      "SELECT COUNT(DISTINCT target) n FROM attacks WHERE actor=? AND classification='hit' AND valid=1",
      id,
    )!.n;
  }
  throw new CommandSyntaxError('未知战绩字段 ' + key);
}
export interface TargetSet {
  candidates: string[];
  count: number;
  random: boolean;
  ids: string[];
}
export function targets(
  e: Engine,
  value: string,
  self?: string,
  preview = false,
  bindings: Record<string, string[]> = {},
): TargetSet {
  if (value in bindings) {
    return {
      candidates: bindings[value]!,
      ids: bindings[value]!,
      count: bindings[value]!.length,
      random: false,
    };
  }
  if (value === '@s') {
    requireThat(self, 'NO_SELF', '@s只能用于execute as绑定。', 400);
    value = self;
  }
  if (/^C\d{2,3}$/.test(value)) {
    e.db.player(value);
    return {candidates: [value], ids: [value], count: 1, random: false};
  }
  if (/^\{\s*C/.test(value)) {
    const ids = [
      ...new Set(
        value
          .slice(1, -1)
          .split(',')
          .map(v => v.trim()),
      ),
    ].sort();
    for (const id of ids) {
      requireThat(
        /^C\d{2,3}$/.test(id),
        'BAD_TARGET',
        '集合只能包含文明编号。',
        400,
      );
      e.db.player(id);
    }
    return {candidates: ids, ids, count: ids.length, random: false};
  }
  const m = /^@(a|alive|dead|random|pool)(?:\[(.*)\])?$/.exec(value);
  if (!m) {
    throw new CommandSyntaxError('无法识别目标 ' + value);
  }
  const roster = e.db.roster();
  const base = m[1]!;
  const registered = e.db
    .all<{id: string}>(
      "SELECT id FROM players WHERE entry_status='registered' ORDER BY id",
    )
    .map(p => p.id);
  let ids =
    base === 'pool'
      ? e.db
          .all<{id: string}>('SELECT id FROM players ORDER BY id')
          .map(p => p.id)
      : roster.filter(id => registered.includes(id));
  const scope = e.commandSnapshot[value];
  if (scope) {
    ids = ids.filter(id => scope.includes(id));
  }
  const alive = (id: string) =>
    e.db.match().start_settled !== null &&
    e.db.flight(id).status !== 'eliminated';
  if (base === 'alive') {
    ids = ids.filter(alive);
  }
  if (base === 'dead') {
    ids = ids.filter(id => e.db.match().start_settled !== null && !alive(id));
  }
  let random = base === 'random';
  let limit = base === 'random' ? 1 : Number.MAX_SAFE_INTEGER;
  const seen = new Set<string>();
  for (const item of m[2] ? splitFilters(m[2]) : []) {
    const eq = item.indexOf('=');
    const key = eq < 0 ? item : item.slice(0, eq);
    const raw = eq < 0 ? 'true' : item.slice(eq + 1);
    if (key !== 'tag' && seen.has(key)) {
      throw new CommandSyntaxError('重复筛选项 ' + key);
    }
    seen.add(key);
    const negate = raw.startsWith('!');
    const val = negate ? raw.slice(1) : raw;
    const filter = (fn: (id: string) => boolean) => {
      ids = ids.filter(id => fn(id) !== negate);
    };
    if (key === 'alive') {
      if (!['true', 'false'].includes(val)) {
        throw new CommandSyntaxError('alive须为true或false');
      }
      filter(id => alive(id) === (val === 'true'));
    } else if (key === 'status') {
      if (
        ![
          'prelaunch',
          'staged',
          'outfitting',
          'ready',
          'active',
          'returning',
          'preparing',
          'issued',
          'eliminated',
        ].includes(val)
      ) {
        throw new CommandSyntaxError('未知飞船状态');
      }
      filter(id => e.db.flight(id).status === val);
    } else if (key === 'homeworld') {
      if (!['alive', 'destroyed', 'pending'].includes(val)) {
        throw new CommandSyntaxError('未知母星状态');
      }
      filter(id => {
        const h = e.db.home(id);
        return val === 'pending'
          ? h?.status === 'pending'
          : h?.status === 'verified' &&
              (val === 'alive'
                ? h.destroyed_game === null
                : h.destroyed_game !== null);
      });
    } else if (key === 'tech') {
      if (!['0', '1'].includes(val)) {
        throw new CommandSyntaxError('科技为0或1');
      }
      filter(id => e.db.player(id).tech === Number(val));
    } else if (key === 'tag') {
      const tag = val.startsWith('"') ? (parseJson(val) as string) : val;
      filter(
        id =>
          !!e.db.one(
            'SELECT player_id FROM command_tags WHERE player_id=? AND tag=?',
            id,
            tag,
          ),
      );
    } else if (key === 'scores') {
      if (negate || !/^\{.*\}$/.test(val)) {
        throw new CommandSyntaxError('scores须为字段范围集合');
      }
      const fields = new Set<string>();
      for (const f of splitFilters(val.slice(1, -1))) {
        const [k, r] = f.split('=');
        if (!k || !r || fields.has(k)) {
          throw new CommandSyntaxError('重复或缺少战绩范围');
        }
        fields.add(k);
        inRange(0, r);
        ids = ids.filter(id => inRange(score(e, id, k), r));
      }
    } else if (key === 'sort') {
      if (!['id', 'random'].includes(val)) {
        throw new CommandSyntaxError('sort为id或random');
      }
      random = val === 'random';
    } else if (key === 'limit') {
      if (!/^\d+$/.test(val) || !Number.isSafeInteger(Number(val))) {
        throw new CommandSyntaxError('limit须为安全非负整数');
      }
      limit = Number(val);
    } else {
      throw new CommandSyntaxError('未知筛选项 ' + key);
    }
  }
  if (base === 'random') {
    limit = 1;
    random = true;
  }
  const candidates = [...ids].sort();
  const count = Math.min(limit, ids.length);
  if (random && !preview) {
    for (let i = ids.length - 1; i > 0; i--) {
      const j = uniformInt(i + 1);
      [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    }
  }
  return {candidates, count, random, ids: ids.slice(0, count).sort()};
}
