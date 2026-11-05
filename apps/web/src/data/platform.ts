import type { PlatformSession } from '@darkforest/contracts';
import { ApiError } from './http';
export type PlatformReview = {
  previewToken: string;
  review: { path: string; body: Record<string, unknown> };
} & Record<string, unknown>;
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
    let result = await this.request<{ status: string }>(`/me/operations/${pending.id}`);
    if (result.status === 'unknown')
      result = await this.request(`/me/operations/${pending.id}/resolve`, {});
    sessionStorage.removeItem(this.pendingKey);
    return result;
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
          data.message ?? '本次请求未完成，请查询原操作。',
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
  const url = URL.createObjectURL(new Blob([value], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
