import type {
  DataSource,
  Operation,
  OperationResult,
  Snapshot,
  Session,
  GameEvent,
} from '@darkforest/contracts';

/** HTTP失败的用户说明与确定性标志；未知结果不能直接当作已失败重发。 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly definitive = status >= 400 && status < 500 && status !== 408,
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

  /** 为本场请求设置私有同源头和超时，错误保留操作结果的确定性。 */
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
          ...(this.matchId ? {'X-Darkforest-Audience': this.audience} : {}),
          ...(body === undefined
            ? {}
            : {
                'Content-Type': 'application/json',
                'X-CSRF-Token': this.session?.csrfToken ?? '',
              }),
        },
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
        signal: controller.signal,
      });
      if (!response.headers.get('content-type')?.includes('application/json')) {
        throw new ApiError(
          '服务暂时不可用，请稍后重新连接。',
          response.status === 200 ? 503 : response.status,
        );
      }
      const data = (await response.json()) as T & {
        message?: string;
        definitive?: boolean;
      };
      if (!response.ok) {
        throw new ApiError(
          data.message ??
            (response.status === 401
              ? '请重新登录。'
              : '本次操作未完成，请稍后再试。'),
          response.status,
          data.definitive ?? false,
        );
      }
      return data;
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  /** 取得服务端授权快照并更新本场CSRF会话。 */
  async read(route: string): Promise<Snapshot> {
    const snapshot = await this.request<Snapshot>(
      `/snapshot?route=${encodeURIComponent(route)}`,
    );
    this.session = snapshot.session;
    return snapshot;
  }

  /** 从受限裁判导出入口下载指定资料，不把存储秘密加入普通快照。 */
  exportData(kind: string): Promise<{fileName: string; text: string}> {
    return this.request<{fileName: string; text: string}>(
      `/judge/export?kind=${encodeURIComponent(kind)}`,
    );
  }

  /** 按专用交付ID读取本次获授权的新凭据。 */
  credential(id: string): Promise<{accountId: string; credential: string}> {
    return this.request<{accountId: string; credential: string}>(
      `/judge/credentials/${encodeURIComponent(id)}`,
    );
  }

  /** 按裁判集合和不透明游标请求更早记录。 */
  judgePage(
    kind: 'notices' | 'audits' | 'attacks',
    cursor: string,
  ): ReturnType<NonNullable<DataSource['judgePage']>> {
    return this.request<
      Awaited<ReturnType<NonNullable<DataSource['judgePage']>>>
    >(`/judge/records/${kind}?before=${encodeURIComponent(cursor)}`);
  }

  /** 按当前路由可见性和游标读取更早事件。 */
  eventsPage(
    route: string,
    cursor: string,
  ): Promise<{items: GameEvent[]; nextCursor: string | null}> {
    return this.request<{items: GameEvent[]; nextCursor: string | null}>(
      `/timeline?route=${encodeURIComponent(route)}&before=${encodeURIComponent(cursor)}`,
    );
  }

  /** 交换本场旧登录凭据并保存返回会话。 */
  async login(credential: string, judge: boolean): Promise<void> {
    this.session = await this.request<Session>('/auth/exchange', {
      credential,
      audience: judge ? 'judge' : 'player',
    });
  }

  /** 确认服务端退出后清除当前适配器会话。 */
  async logout(): Promise<void> {
    await this.request<unknown>('/auth/logout', {});
    this.session = null;
  }

  /** 提交稳定请求ID和原草稿，网络不确定时由上层查询原结果。 */
  submit(operation: Operation): Promise<OperationResult> {
    return this.request<OperationResult>(operation.path, {
      ...operation.payload,
      request_id: operation.requestId,
    });
  }

  /** 查询原操作，必要时使用专用resolve入口取得确定结论。 */
  async result(requestId: string): Promise<OperationResult> {
    const result = await this.request<OperationResult>(
      `/operations/${encodeURIComponent(requestId)}`,
    );
    return result.status === 'complete'
      ? result
      : this.request<OperationResult>(
          `/operations/${encodeURIComponent(requestId)}/resolve`,
          {},
        );
  }

  /** 读取当前本人状态允许生成的QQ材料正文。 */
  template(kind: string): Promise<string> {
    return this.request<{text: string}>(
      `/player/templates/${encodeURIComponent(kind)}`,
    ).then(r => r.text);
  }
}
