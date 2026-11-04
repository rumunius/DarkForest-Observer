import type {
  DataSource,
  Operation,
  OperationResult,
  Snapshot,
  Session,
  MatchState,
  PlayerState,
  GameEvent,
  Intel,
  Civilization,
  JudgeState,
  SiteConfig,
  ResultsState,
} from '@darkforest/contracts';
import { DEFAULT_SITE } from '../config';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** The browser has no rule engine. These endpoints return authorized projections. */
export class HttpSource implements DataSource {
  private session: Session | null = null;
  private async request<T>(path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(`/api${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          ...(body === undefined
            ? {}
            : {
                'Content-Type': 'application/json',
                'X-CSRF-Token': this.session?.csrfToken ?? '',
              }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      if (!response.headers.get('content-type')?.includes('application/json'))
        throw new ApiError(
          '服务暂时不可用，请稍后重新连接。',
          response.status === 200 ? 503 : response.status,
        );
      const data = (await response.json()) as T & { message?: string };
      if (!response.ok)
        throw new ApiError(
          data.message ??
            (response.status === 401 ? '请重新登录。' : '本次请求未完成，请重新核对后再试。'),
          response.status,
        );
      return data;
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }
  async read(route: string): Promise<Snapshot> {
    const session = await this.request<Session | null>('/auth/session');
    this.session = session;
    const [site, match] = await Promise.all([
      this.request<SiteConfig>('/public/site-config'),
      this.request<MatchState>('/public/match'),
    ]);
    const snapshot: Snapshot = {
      site: site ?? DEFAULT_SITE,
      session,
      match,
      player: null,
      events: [],
      intel: [],
      civilizations: [],
      judge: null,
      results: null,
    };
    if (!session) return snapshot;
    if (session.role === 'player')
      snapshot.player = await this.request<PlayerState>('/player/self');
    if (route.startsWith('/judge') && session.role === 'judge') {
      const overview = await this.request<{
        judge: JudgeState;
        civilizations: Civilization[];
        events: GameEvent[];
      }>('/judge/overview');
      Object.assign(snapshot, overview);
    } else if (route.startsWith('/display') && session.role === 'judge') {
      Object.assign(
        snapshot,
        await this.request<Pick<Snapshot, 'civilizations' | 'events' | 'results'>>(
          '/judge/display',
        ),
      );
    } else if (route.startsWith('/results') && match.stage === 'ended') {
      snapshot.results = await this.request<ResultsState>('/results/overview');
      snapshot.civilizations = snapshot.results.standings;
      snapshot.events = await this.request<GameEvent[]>('/results/events');
    } else if (route.startsWith('/observer') && snapshot.player?.observerAllowed) {
      const [civilizations, events] = await Promise.all([
        this.request<Civilization[]>('/observer/civilizations'),
        this.request<GameEvent[]>('/observer/events'),
      ]);
      Object.assign(snapshot, { civilizations, events });
    } else if (session.role === 'player') {
      const [events, intel] = await Promise.all([
        this.request<GameEvent[]>('/player/messages'),
        this.request<Intel[]>('/player/intel'),
      ]);
      Object.assign(snapshot, { events, intel });
    }
    return snapshot;
  }
  async login(credential: string, judge: boolean): Promise<void> {
    this.session = await this.request<Session>('/auth/exchange', {
      credential,
      audience: judge ? 'judge' : 'player',
    });
  }
  async logout(): Promise<void> {
    await this.request('/auth/logout', {});
    this.session = null;
  }
  submit(operation: Operation): Promise<OperationResult> {
    return this.request(operation.path, { ...operation.payload, request_id: operation.requestId });
  }
  result(requestId: string): Promise<OperationResult> {
    return this.request(`/operations/${encodeURIComponent(requestId)}`);
  }
  template(kind: string): Promise<string> {
    return this.request<{ text: string }>(`/player/templates/${encodeURIComponent(kind)}`).then(
      (r) => r.text,
    );
  }
}
