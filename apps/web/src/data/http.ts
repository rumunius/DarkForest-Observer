import type {
  DataSource,
  Operation,
  OperationResult,
  Snapshot,
  Session,
  GameEvent,
} from '@darkforest/contracts';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public definitive = status >= 400 && status < 500 && status !== 408,
  ) {
    super(message);
  }
}

/** The browser has no rule engine. These endpoints return authorized projections. */
export class HttpSource implements DataSource {
  constructor(
    readonly matchId?: string,
    readonly audience: 'player' | 'staff' = 'player',
  ) {}
  private session: Session | null = null;
  private async request<T>(path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), 12000);
    try {
      const prefix =
        this.matchId && !path.startsWith('/auth/')
          ? `/api/matches/${encodeURIComponent(this.matchId)}`
          : '/api';
      const response = await fetch(`${prefix}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          ...(this.matchId ? { 'X-Darkforest-Audience': this.audience } : {}),
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
      const data = (await response.json()) as T & { message?: string; definitive?: boolean };
      if (!response.ok)
        throw new ApiError(
          data.message ??
            (response.status === 401 ? '请重新登录。' : '本次请求未完成，请重新核对后再试。'),
          response.status,
          data.definitive ?? false,
        );
      return data;
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }
  async read(route: string): Promise<Snapshot> {
    const snapshot = await this.request<Snapshot>(`/snapshot?route=${encodeURIComponent(route)}`);
    this.session = snapshot.session;
    return snapshot;
  }
  exportData(kind: string): Promise<{ fileName: string; text: string }> {
    return this.request(`/judge/export?kind=${encodeURIComponent(kind)}`);
  }
  credential(id: string): Promise<{ accountId: string; credential: string }> {
    return this.request(`/judge/credentials/${encodeURIComponent(id)}`);
  }
  judgePage(
    kind: 'notices' | 'audits' | 'attacks',
    cursor: string,
  ): ReturnType<NonNullable<DataSource['judgePage']>> {
    return this.request(`/judge/records/${kind}?before=${encodeURIComponent(cursor)}`);
  }
  eventsPage(
    route: string,
    cursor: string,
  ): Promise<{ items: GameEvent[]; nextCursor: string | null }> {
    return this.request(
      `/timeline?route=${encodeURIComponent(route)}&before=${encodeURIComponent(cursor)}`,
    );
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
  async result(requestId: string): Promise<OperationResult> {
    const result = await this.request<OperationResult>(
      `/operations/${encodeURIComponent(requestId)}`,
    );
    return result.status === 'complete'
      ? result
      : this.request(`/operations/${encodeURIComponent(requestId)}/resolve`, {});
  }
  template(kind: string): Promise<string> {
    return this.request<{ text: string }>(`/player/templates/${encodeURIComponent(kind)}`).then(
      (r) => r.text,
    );
  }
}
