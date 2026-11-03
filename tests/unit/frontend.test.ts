import { describe, expect, it } from 'vitest';
import {
  COLORS,
  isCoordinateCode,
  validArms,
  validNickname,
  type Arms,
  type OperationResult,
  type SessionState,
} from '../../packages/contracts/src/index';
import {
  canAct,
  clockNow,
  formatDuration,
  moveColor,
  wrongConsequence,
} from '../../apps/web/src/core/model';
import { Client, ApiError, type Transport } from '../../apps/web/src/core/api';
import { knownRoute, mayRead, pageEndpoint } from '../../apps/web/src/core/routes';
import { createPreviewState } from '../../apps/web/src/dev/preview';
import { e } from '../../apps/web/src/ui';

describe('bracelet input invariants', () => {
  it.each<Arms>([
    [['BK', 'YL'], ['WH']],
    [
      ['BK', 'YL'],
      ['WH', 'PU'],
    ],
    [['BK', 'YL', 'OR'], ['WH']],
  ])('accepts each legal shape and its exchange', (a, b) => {
    expect(validArms([a, b])).toBe(true);
    expect(validArms([b, a])).toBe(true);
    expect(validArms([[...a].reverse(), b])).toBe(true);
  });
  it.each([
    [[], []],
    [['BK'], ['WH']],
    [['BK', 'WH'], ['BK']],
    [['ZZ', 'YL'], ['WH']],
    [
      ['BK', 'WH', 'GY'],
      ['YL', 'PU'],
    ],
  ])('rejects illegal input without converting it into an attack', (a, b) =>
    expect(validArms([a, b])).toBe(false),
  );
  it('transfers a unique color atomically and preserves an over-capacity draft', () => {
    const initial: Arms = [['BK', 'WH', 'GY'], ['YL']];
    expect(moveColor(initial, 'YL', 0)).toEqual({ arms: initial, error: '每侧最多选择3条' });
    expect(moveColor(initial, 'PU', 1)).toEqual({ arms: initial, error: '最多选择4条手环' });
    expect(moveColor(initial, 'GY', 1).arms).toEqual([
      ['BK', 'WH'],
      ['YL', 'GY'],
    ]);
    expect(moveColor(initial, 'WH', null).arms).toEqual([['BK', 'GY'], ['YL']]);
    expect(initial).toEqual([['BK', 'WH', 'GY'], ['YL']]);
  });
  it('keeps fixed color identity and Chinese names', () =>
    expect(COLORS.map((c) => c.id)).toEqual(['BK', 'WH', 'GY', 'YL', 'OR', 'SB', 'PU']));
});
describe('progressive disclosure and clock boundaries', () => {
  it.each([
    'returning',
    'preparing',
    'issued',
    'paused',
    'eliminated',
    'observer',
    'ended',
    'transfer',
    'review',
    'ready',
    'wear',
    'nickname',
    'pending',
  ])('%s exposes no battle form', (scenario) => {
    const s = createPreviewState(scenario);
    s.allowed_actions.push('sighting', 'broadcast', 'photon');
    expect(['sighting', 'broadcast', 'photon'].map((a) => canAct(s, a as 'sighting'))).toEqual([
      false,
      false,
      false,
    ]);
  });
  it('a sighting penalty does not remove other lawful actions', () => {
    const s = createPreviewState('locked');
    expect(canAct(s, 'sighting')).toBe(false);
    expect(canAct(s, 'broadcast')).toBe(true);
    expect(canAct(s, 'photon')).toBe(true);
  });
  it('destroyed homeworld does not remove first-phase onboard resources', () => {
    const s = createPreviewState('active');
    s.me!.home_status = 'destroyed';
    expect(canAct(s, 'photon')).toBe(true);
    s.match.phase = 'apocalypse';
    expect(canAct(s, 'photon')).toBe(false);
    expect(canAct(s, 'broadcast')).toBe(false);
  });
  it('freezes game clock during pause while UTC continues and formats 98 minutes', () => {
    const s = createPreviewState('paused');
    const time = clockNow(s, 3000);
    expect(time.game).toBe(s.match.clock.game_ms);
    expect(time.utc).toBe(s.match.clock.server_utc_ms + 3000);
    expect(formatDuration(5880000)).toBe('98:00');
    expect(formatDuration(-1)).toBe('00:00');
  });
  it('cannot unlock observation from a locally expired countdown', () => {
    const s = createPreviewState('eliminated');
    s.me!.observer_unlock_at_utc_ms = 0;
    expect(mayRead('/observer', s)).toBe(false);
    s.results_allowed = true;
    expect(mayRead('/results', s)).toBe(false);
    s.match.phase = 'ended';
    expect(mayRead('/results', s)).toBe(true);
  });
  it('keeps the display and staff data behind independent role permissions', () => {
    expect(mayRead('/display', createPreviewState('observer'))).toBe(false);
    expect(mayRead('/display', createPreviewState('judge'))).toBe(true);
    expect(mayRead('/judge/commands', createPreviewState('judge-comms'))).toBe(false);
  });
  it('all three wrong-submission consequences are explicit', () => {
    expect(wrongConsequence(0)).toContain('5分钟');
    expect(wrongConsequence(1).match(/50%/g)).toHaveLength(2);
    expect(wrongConsequence(2)).toContain('永久淘汰');
  });
});
describe('input and routes', () => {
  it('keeps zero-prefixed coordinates as strings', () => {
    expect(isCoordinateCode('001234')).toBe(true);
    expect(isCoordinateCode('000000')).toBe(true);
    expect(isCoordinateCode(123456)).toBe(false);
    expect(isCoordinateCode('１２３４５６')).toBe(false);
  });
  it('normalizes nickname length and rejects invisible controls', () => {
    expect(validNickname('归零者')).toBe(true);
    expect(validNickname('a')).toBe(false);
    expect(validNickname('归\u200b零')).toBe(false);
  });
  it('escapes server-provided nickname and message markup', () =>
    expect(e('<img src=x onerror="alert(1)">')).toBe(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;',
    ));
  it('resolves dedicated data endpoints and rejects unknown routes', () => {
    expect(pageEndpoint('/display')).toBe('/api/judge/display');
    expect(pageEndpoint('/results/civilizations/C07')).toBe('/api/results/civilizations/C07');
    expect(knownRoute('/player/unknown')).toBe(false);
    expect(knownRoute('/judge/players/C07')).toBe(true);
  });
});
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
describe('request recovery and response races', () => {
  it('persists only identity and request ID; timeout cannot create a second write', async () => {
    const saved = storage();
    const calls: { path: string; body?: string }[] = [];
    const transport: Transport = async <T>(path: string, init?: RequestInit) => {
      calls.push(init?.body ? { path, body: String(init.body) } : { path });
      if (path === '/api/auth/session') return createPreviewState('active') as T;
      if (path.startsWith('/api/operations')) return { status: 'pending' } as T;
      throw new Error('timeout');
    };
    const client = new Client(transport, saved);
    await client.refresh();
    await expect(
      client.submit('/api/action/sighting', { arm_a: ['BK', 'WH'], arm_b: ['YL'] }),
    ).rejects.toThrow('timeout');
    const pending = JSON.parse(saved.getItem('forest.pending')!);
    expect(Object.keys(pending).sort()).toEqual(['account_id', 'match_id', 'request_id']);
    expect(saved.getItem('forest.pending')).not.toContain('arm_a');
    await client.submit('/api/action/sighting', { arm_a: ['BK', 'WH'], arm_b: ['YL'] });
    expect(calls.filter((c) => c.body)).toHaveLength(1);
    const reload = new Client(transport, saved);
    await reload.refresh();
    expect(reload.pending?.request_id).toBe(pending.request_id);
    await reload.recover();
    expect(reload.pending).not.toBeNull();
  });
  it('not-found is not permission to repeat an unknown action', async () => {
    const saved = storage();
    saved.setItem(
      'forest.pending',
      JSON.stringify({ account_id: 'preview-player', match_id: 'preview', request_id: 'fixed' }),
    );
    const transport: Transport = async <T>(path: string) =>
      (path === '/api/auth/session' ? createPreviewState('active') : { status: 'not_found' }) as T;
    const c = new Client(transport, saved);
    await c.refresh();
    await c.recover();
    expect(c.pending?.request_id).toBe('fixed');
  });
  it('explicit rejection unlocks the draft but an HTTP 500 does not', async () => {
    for (const status of [409, 500]) {
      const c = new Client(async <T>(path: string) => {
        if (path === '/api/auth/session') return createPreviewState('active') as T;
        throw new ApiError(status, 'rejected');
      }, storage());
      await c.refresh();
      await expect(c.submit('/api/action/broadcast', { code: '001234' })).rejects.toThrow();
      expect(c.pending === null).toBe(status === 409);
    }
  });
  it('ignores a stale self response and a response after logout', async () => {
    const resolves: ((value: SessionState) => void)[] = [];
    const transport: Transport = <T>() =>
      new Promise<SessionState>((resolve) => resolves.push(resolve)) as Promise<T>;
    const c = new Client(transport, storage());
    const first = c.refresh();
    const second = c.refresh();
    const newer = createPreviewState('paused');
    newer.version = 5;
    resolves[1]!(newer);
    await second;
    resolves[0]!(createPreviewState('active'));
    await first;
    expect(c.state?.version).toBe(5);
    const third = c.refresh();
    c.clear();
    resolves[2]!(newer);
    await third;
    expect(c.state).toBeNull();
  });
  it('completed result clears pending journal and applies the server state', async () => {
    const next = createPreviewState('returning');
    next.version = 2;
    const c = new Client(
      async <T>(path: string) =>
        (path === '/api/auth/session'
          ? createPreviewState('active')
          : ({ status: 'completed', state: next } satisfies OperationResult)) as T,
      storage(),
    );
    await c.refresh();
    await c.submit('/api/action/sighting', {});
    expect(c.pending).toBeNull();
    expect(c.state?.me?.flight_status).toBe('returning');
  });
});
