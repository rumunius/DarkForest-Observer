import type {Session, Snapshot} from '@darkforest/contracts';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {HttpSource} from '../../apps/web/src/data/http';
import {MockSource} from '../../apps/web/src/dev/mock_source';

interface PendingRequest {
  readonly path: string;
  readonly headers: Headers;
  readonly respond: (body: unknown, status?: number) => void;
}

function captureRequests() {
  const requests: PendingRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (path: string, init?: RequestInit) =>
        new Promise<Response>(resolve => {
          requests.push({
            path,
            headers: new Headers(init?.headers),
            respond: (body, status = 200) =>
              resolve(Response.json(body, {status})),
          });
        }),
    ),
  );
  return requests;
}

async function submitToken(source: HttpSource, requests: PendingRequest[]) {
  const response = source.submit({
    path: '/action/broadcast',
    payload: {code: '001234'},
    requestId: 'session-order',
  });
  const request = requests.at(-1)!;
  request.respond({
    requestId: 'session-order',
    status: 'complete',
    title: '已保存',
    message: '',
  });
  await response;
  return request.headers.get('X-CSRF-Token');
}

async function fixture(): Promise<Snapshot> {
  return new MockSource().read('/player');
}

afterEach(() => vi.unstubAllGlobals());

describe('HTTP session cache ordering', () => {
  it('keeps the newest requested snapshot session when reads finish out of order', async () => {
    const snapshot = await fixture();
    const requests = captureRequests();
    const source = new HttpSource();
    const oldRead = source.read('/player');
    const newRead = source.read('/player/messages');
    requests[1]!.respond({
      ...snapshot,
      session: {...snapshot.session!, csrfToken: 'new-session'},
    });
    await newRead;
    requests[0]!.respond(snapshot);
    await oldRead;
    expect(await submitToken(source, requests)).toBe('new-session');
  });

  it.each(['before', 'during', 'during-but-returned-after'] as const)(
    'does not restore a snapshot session from a read started %s logout',
    async timing => {
      const snapshot = await fixture();
      const requests = captureRequests();
      const source = new HttpSource();
      let read: Promise<Snapshot>;
      let logout: Promise<void>;
      if (timing === 'before') {
        read = source.read('/player');
        logout = source.logout();
      } else {
        logout = source.logout();
        read = source.read('/player');
      }
      const logoutRequest = requests.find(
        request => request.path === '/api/auth/logout',
      )!;
      const readRequest = requests.find(request =>
        request.path.startsWith('/api/snapshot'),
      )!;
      if (timing === 'during') {
        readRequest.respond(snapshot);
        await read;
        expect(await submitToken(source, requests)).toBe('');
      }
      logoutRequest.respond({loggedOut: true});
      await logout;
      if (timing !== 'during') {
        readRequest.respond(snapshot);
        await read;
      }
      expect(await submitToken(source, requests)).toBe('');
    },
  );

  it('keeps a new login session when an older logout completes afterward', async () => {
    const snapshot = await fixture();
    const requests = captureRequests();
    const source = new HttpSource();
    const logout = source.logout();
    const login = source.login('replacement-credential', false);
    requests[1]!.respond({...snapshot.session!, csrfToken: 'replacement'});
    await login;
    requests[0]!.respond({loggedOut: true});
    await logout;
    expect(await submitToken(source, requests)).toBe('replacement');
  });

  it('keeps the existing cache when logout fails and accepts later reads', async () => {
    const snapshot = await fixture();
    const requests = captureRequests();
    const source = new HttpSource();
    const initial = source.read('/player');
    requests[0]!.respond(snapshot);
    await initial;
    const logout = source.logout();
    requests[1]!.respond({message: '退出未完成', definitive: false}, 503);
    await expect(logout).rejects.toMatchObject({status: 503});
    expect(await submitToken(source, requests)).toBe(
      snapshot.session!.csrfToken,
    );
    const read = source.read('/player');
    requests.at(-1)!.respond({
      ...snapshot,
      session: {...snapshot.session!, csrfToken: 'refreshed-session'},
    });
    await read;
    expect(await submitToken(source, requests)).toBe('refreshed-session');
  });

  it('does not restore an older login after a newer logout completes', async () => {
    const snapshot = await fixture();
    const requests = captureRequests();
    const source = new HttpSource();
    const login = source.login('old-credential', false);
    const logout = source.logout();
    requests[1]!.respond({loggedOut: true});
    await logout;
    requests[0]!.respond(snapshot.session);
    await login;
    expect(await submitToken(source, requests)).toBe('');
  });

  it('adopts subsequent snapshot sessions after login fails', async () => {
    const snapshot = await fixture();
    const requests = captureRequests();
    const source = new HttpSource();
    const login = source.login('invalid-credential', false);
    requests[0]!.respond({message: '登录失败', definitive: true}, 401);
    await expect(login).rejects.toMatchObject({status: 401});
    const read = source.read('/player');
    requests[1]!.respond(snapshot);
    await read;
    expect(await submitToken(source, requests)).toBe(
      snapshot.session!.csrfToken,
    );
  });

  it('lets a completed login win over snapshots received while authentication is pending', async () => {
    const snapshot = await fixture();
    const requests = captureRequests();
    const source = new HttpSource();
    const login = source.login('replacement-credential', false);
    const read = source.read('/player');
    requests[1]!.respond(snapshot);
    await read;
    const session: Session = {
      ...snapshot.session!,
      csrfToken: 'authenticated-session',
    };
    requests[0]!.respond(session);
    await login;
    expect(await submitToken(source, requests)).toBe(session.csrfToken);
  });
});
