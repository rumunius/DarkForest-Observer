import {parseJson} from '../../../../packages/contracts/src/backend';
import type {PlatformSession} from '@darkforest/contracts';
import {ApiError} from './http';
/** 平台管理预览令牌及其原始请求草稿，确认时不能混用其他草稿。 */
export type PlatformReview = {
  previewToken: string;
  review: {path: string; body: Record<string, unknown>};
} & Record<string, unknown>;
interface OperationReply {
  operationId?: string;
  id?: string;
  status?: string;
  error?: string;
}
/** 管理长期会话和持久操作查询，网络不确定时保存原请求ID等待确认。 */
export class PlatformClient {
  session: PlatformSession | null = null;

  constructor(readonly audience: 'player' | 'staff') {}

  /** 按玩家或工作人员入口隔离待确认平台操作。 */
  get pendingKey() {
    return `darkforest.platform-pending.${this.audience}`;
  }

  /** 读取当前入口保存的原操作身份，坏本地记录按未保存处理。 */
  pending(): {id: string; account: string} | null {
    try {
      return parseJson(sessionStorage.getItem(this.pendingKey) ?? 'null') as {
        id: string;
        account: string;
      } | null;
    } catch {
      return null;
    }
  }

  /** 只为相同长期账号查询原操作，终态取得后清除待确认记录。 */
  async resolvePending() {
    const pending = this.pending();
    if (!pending) {
      return null;
    }
    if (pending.account !== this.session?.account.id) {
      throw new Error('待确认操作属于另一账号，请切回原账号。');
    }
    let result = await this.request<OperationReply>(
      `/me/operations/${pending.id}`,
    );
    if (result.status === 'unknown') {
      result = await this.request<OperationReply>(
        `/me/operations/${pending.id}/resolve`,
        {},
      );
    }
    if (result.status !== 'pending') {
      sessionStorage.removeItem(this.pendingKey);
    }
    return {...result, id: pending.id};
  }

  /** 发起私有同源平台请求，在网络不确定时保留已登记操作ID。 */
  async request<T>(path: string, body?: unknown): Promise<T> {
    const write =
      body &&
      typeof body === 'object' &&
      'request_id' in body &&
      path !== '/platform/preview';
    if (write) {
      if (this.pending()) {
        throw new Error('请先查询上一次操作结果。');
      }
      sessionStorage.setItem(
        this.pendingKey,
        JSON.stringify({
          id: (body as {request_id: string}).request_id,
          account: this.session?.account.id,
        }),
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
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
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
        signal: controller.signal,
      });
      const data = (await response.json()) as T & {
        message?: string;
        definitive?: boolean;
      };
      if (!response.ok) {
        if (write && data.definitive) {
          sessionStorage.removeItem(this.pendingKey);
        }
        throw new ApiError(
          data.message ?? '本次操作的结果尚未确认，请查询操作结果。',
          response.status,
          data.definitive ?? false,
        );
      }
      if (write) {
        sessionStorage.removeItem(this.pendingKey);
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 刷新当前入口的长期公开会话。 */
  async load() {
    this.session = await this.request<PlatformSession | null>('/auth/session');
    return this.session;
  }

  /** 判定持久操作终态，失败与部分完成分别产生可见说明。 */
  private operationFinished(result: OperationReply) {
    if (
      !result.status ||
      result.status === 'pending' ||
      result.status === 'unknown'
    ) {
      return false;
    }
    sessionStorage.removeItem(this.pendingKey);
    if (result.status === 'succeeded') {
      return true;
    }
    const message =
      result.status === 'partial'
        ? `操作仅部分完成。${result.error || '请核对各项处理结果后重试未完成步骤。'}`
        : result.error ||
          (result.status === 'cancelled'
            ? '操作已取消，请核对后重试。'
            : '操作未完成，请核对处理结果后重试。');
    throw new Error(message);
  }

  /** 识别持久写入收据并在需要时等待队列确认。 */
  async completeOperation(value: unknown, onPending: () => void) {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const result = value as OperationReply;
    const id = result.operationId ?? (result.status ? result.id : undefined);
    if (!id) {
      return false;
    }
    if (!this.operationFinished(result)) {
      onPending();
      await this.waitOperation(id);
    }
    return true;
  }

  /** 在有限次数内查询同一个操作，不因为等待而重复提交业务写入。 */
  async waitOperation(id: string) {
    sessionStorage.setItem(
      this.pendingKey,
      JSON.stringify({id, account: this.session?.account.id}),
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
      if (this.operationFinished(result)) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('操作仍在处理中，请查询原操作结果。');
  }

  /** 交换长期口令与可选第二因素，保存返回的公开会话。 */
  async login(credential: string, code: string) {
    this.session = await this.request<PlatformSession>('/auth/exchange', {
      credential,
      code,
      audience: this.audience,
    });
    return this.session;
  }

  /** 提交平台草稿或请求真实预览，正式写入使用新的稳定请求ID。 */
  mutate<T = unknown>(
    path: string,
    payload: Record<string, unknown>,
    preview?: false,
  ): Promise<T>;
  /** 提交平台草稿或请求真实预览，正式写入使用新的稳定请求ID。 */
  mutate(
    path: string,
    payload: Record<string, unknown>,
    preview: true,
  ): Promise<PlatformReview>;
  /** 提交平台草稿或请求真实预览，正式写入使用新的稳定请求ID。 */
  async mutate<T>(
    path: string,
    payload: Record<string, unknown>,
    preview = false,
  ): Promise<T | PlatformReview> {
    const body = {...payload, reason: payload.reason ?? '网站管理操作'};
    if (preview) {
      const result = await this.request<{previewToken: string}>(
        '/platform/preview',
        {
          path,
          payload: body,
        },
      );
      return {...result, review: {path, body}};
    }
    return this.request<T>(path, {
      ...body,
      request_id: crypto.randomUUID(),
    });
  }
}
/** 通过浏览器下载授权正文；CSV使用UTF-8 BOM兼容Windows Excel。 */
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
