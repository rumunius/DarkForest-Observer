import type { OperationResult, SessionState } from '@darkforest/contracts';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export type Transport = <T>(path: string, init?: RequestInit) => Promise<T>;
export const httpTransport: Transport = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    signal: AbortSignal.timeout(12000),
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const json = response.headers.get('content-type')?.includes('application/json');
  if (!json)
    throw new ApiError(response.status === 401 ? 401 : 503, '服务暂时不可用，请稍后重新连接。');
  const data = (await response.json()) as T & { message?: string };
  if (!response.ok)
    throw new ApiError(response.status, data.message ?? '请求未完成，请重新核对当前状态。');
  return data;
};
export interface PendingOperation {
  request_id: string;
  account_id: string;
  match_id: string;
}
export class Client {
  state: SessionState | null = null;
  pending: PendingOperation | null = null;
  private pendingBody: { path: string; body: Record<string, unknown> } | null = null;
  private generation = 0;
  private refreshSequence = 0;
  synchronizedAt = 0;
  constructor(
    public transport: Transport = httpTransport,
    private storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = sessionStorage,
  ) {}
  get<T>(path: string) {
    return this.transport<T>(path);
  }
  async refresh(): Promise<SessionState | null> {
    const generation = this.generation;
    const sequence = ++this.refreshSequence;
    const state = await this.get<SessionState>('/api/auth/session');
    if (generation !== this.generation || sequence !== this.refreshSequence) return this.state;
    if (
      !this.state ||
      state.account_id !== this.state.account_id ||
      state.match.id !== this.state.match.id ||
      state.version >= this.state.version
    ) {
      this.state = state;
      this.synchronizedAt = performance.now();
      const saved = this.storage.getItem('forest.pending');
      if (saved) {
        try {
          const pending = JSON.parse(saved) as PendingOperation;
          if (pending.account_id === state.account_id && pending.match_id === state.match.id)
            this.pending = pending;
          else this.clearPending();
        } catch {
          this.clearPending();
        }
      }
    }
    return this.state;
  }
  async post<T>(path: string, body: unknown): Promise<T> {
    return this.transport<T>(path, {
      method: 'POST',
      headers: { 'X-CSRF-Token': this.state?.csrf_token ?? '' },
      body: JSON.stringify(body),
    });
  }
  async submit(path: string, body: Record<string, unknown>): Promise<OperationResult> {
    if (!this.state) throw new ApiError(401, '请重新登录');
    if (this.pending) return this.recover();
    const pending = {
      request_id: crypto.randomUUID(),
      account_id: this.state.account_id,
      match_id: this.state.match.id,
    };
    this.pending = pending;
    this.pendingBody = { path, body };
    this.storage.setItem('forest.pending', JSON.stringify(pending));
    const generation = this.generation;
    try {
      const result = await this.post<OperationResult>(path, {
        ...body,
        request_id: pending.request_id,
      });
      if (generation !== this.generation || this.pending?.request_id !== pending.request_id)
        throw new ApiError(401, '请重新登录');
      this.applyResult(result);
      return result;
    } catch (error) {
      if (
        generation === this.generation &&
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408
      )
        this.clearPending();
      throw error;
    }
  }
  async recover(): Promise<OperationResult> {
    if (!this.pending) return { status: 'not_found' };
    const generation = this.generation;
    const result = await this.get<OperationResult>(
      `/api/operations/${encodeURIComponent(this.pending.request_id)}`,
    );
    if (generation === this.generation) this.applyResult(result);
    return result;
  }
  async retryOriginal(): Promise<OperationResult> {
    if (!this.pending || !this.pendingBody) return this.recover();
    const result = await this.post<OperationResult>(this.pendingBody.path, {
      ...this.pendingBody.body,
      request_id: this.pending.request_id,
    });
    this.applyResult(result);
    return result;
  }
  private applyResult(result: OperationResult) {
    if (
      result.state &&
      this.state &&
      result.state.account_id === this.state.account_id &&
      result.state.match.id === this.state.match.id &&
      result.state.version >= this.state.version
    ) {
      this.state = result.state;
      this.synchronizedAt = performance.now();
    }
    if (result.status === 'completed') this.clearPending();
  }
  clearPending() {
    this.pending = null;
    this.pendingBody = null;
    this.storage.removeItem('forest.pending');
  }
  clear() {
    this.generation++;
    this.state = null;
    this.pending = null;
    this.pendingBody = null;
  }
}
