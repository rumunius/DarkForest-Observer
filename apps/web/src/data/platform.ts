import type { PlatformSession } from '@darkforest/contracts';
import { ApiError } from './http';
export type PlatformReview = {
  previewToken: string;
  review: { path: string; body: Record<string, unknown> };
} & Record<string, unknown>;
type OperationReply = {
  operationId?: string;
  id?: string;
  status?: string;
  error?: string;
};
export class PlatformClient {
  session: PlatformSession | null = null;
  constructor(readonly audience: 'player' | 'staff') {}
  get pendingKey() {
    return `darkforest.platform-pending.${this.audience}`;
  }
  pending(): { id: string; account: string } | null {
    try {
      return JSON.parse(sessionStorage.getItem(this.pendingKey) ?? 'null') as {
        id: string;
        account: string;
      } | null;
    } catch {
      return null;
    }
  }
  async resolvePending() {
    const pending = this.pending();
    if (!pending) return null;
    if (pending.account !== this.session?.account.id)
      throw new Error('待确认操作属于另一账号，请切回原账号。');
    let result = await this.request<OperationReply>(`/me/operations/${pending.id}`);
    if (result.status === 'unknown')
      result = await this.request(`/me/operations/${pending.id}/resolve`, {});
    if (result.status !== 'pending') sessionStorage.removeItem(this.pendingKey);
    return { ...result, id: pending.id };
  }
  async request<T>(path: string, body?: unknown): Promise<T> {
    const write =
      body && typeof body === 'object' && 'request_id' in body && path !== '/platform/preview';
    if (write) {
      if (this.pending()) throw new Error('请先查询上一次操作结果。');
      sessionStorage.setItem(
        this.pendingKey,
        JSON.stringify({
          id: (body as { request_id: string }).request_id,
          account: this.session?.account.id,
        }),
      );
    }
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(`/api${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'X-Darkforest-Audience': this.audience,
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
      const data = (await response.json()) as T & { message?: string; definitive?: boolean };
      if (!response.ok) {
        if (write && data.definitive) sessionStorage.removeItem(this.pendingKey);
        throw new ApiError(
          data.message ?? '本次操作的结果尚未确认，请查询操作结果。',
          response.status,
          data.definitive ?? false,
        );
      }
      if (write) sessionStorage.removeItem(this.pendingKey);
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
  async load() {
    this.session = await this.request<PlatformSession | null>('/auth/session');
    return this.session;
  }
  private operationFinished(result: OperationReply) {
    if (!result.status || result.status === 'pending' || result.status === 'unknown') return false;
    sessionStorage.removeItem(this.pendingKey);
    if (result.status === 'succeeded') return true;
    const message =
      result.status === 'partial'
        ? `操作仅部分完成。${result.error || '请核对各项处理结果后重试未完成步骤。'}`
        : result.error ||
          (result.status === 'cancelled'
            ? '操作已取消，请核对后重试。'
            : '操作未完成，请核对处理结果后重试。');
    throw new Error(message);
  }
  async completeOperation(value: unknown, onPending: () => void) {
    if (!value || typeof value !== 'object') return false;
    const result = value as OperationReply;
    const id = result.operationId ?? (result.status ? result.id : undefined);
    if (!id) return false;
    if (!this.operationFinished(result)) {
      onPending();
      await this.waitOperation(id);
    }
    return true;
  }
  async waitOperation(id: string) {
    sessionStorage.setItem(
      this.pendingKey,
      JSON.stringify({ id, account: this.session?.account.id }),
    );
    for (let attempt = 0; attempt < 60; attempt++) {
      let result: OperationReply;
      try {
        result = await this.request<OperationReply>(`/me/operations/${id}`);
      } catch (error) {
        throw error instanceof ApiError
          ? error
          : new Error('暂时无法查询操作结果，请查询原操作结果。');
      }
      if (this.operationFinished(result)) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('操作仍在处理中，请查询原操作结果。');
  }
  async login(credential: string, code: string) {
    this.session = await this.request<PlatformSession>('/auth/exchange', {
      credential,
      code,
      audience: this.audience,
    });
    return this.session;
  }
  mutate<T = unknown>(path: string, payload: Record<string, unknown>, preview?: false): Promise<T>;
  mutate(path: string, payload: Record<string, unknown>, preview: true): Promise<PlatformReview>;
  async mutate<T>(
    path: string,
    payload: Record<string, unknown>,
    preview = false,
  ): Promise<T | PlatformReview> {
    const body = { ...payload, reason: payload.reason ?? '网站管理操作' };
    if (preview) {
      const result = await this.request<{ previewToken: string }>('/platform/preview', {
        path,
        payload: body,
      });
      return { ...result, review: { path, body } };
    }
    return this.request<T>(path, {
      ...body,
      request_id: crypto.randomUUID(),
    });
  }
}
export function saveDownload(fileName: string, value: string) {
  // Excel uses the BOM to recognize UTF-8 when opening a CSV directly on Windows.
  const csv = /\.csv$/i.test(fileName);
  const url = URL.createObjectURL(
    new Blob(csv ? ['\uFEFF', value.replace(/^\uFEFF/, '')] : [value], {
      type: csv ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8',
    }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
