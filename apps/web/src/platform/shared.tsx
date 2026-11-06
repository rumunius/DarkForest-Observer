import type {MatchEntry} from '@darkforest/contracts';
import {useEffect, useState, type ReactNode} from 'react';
import {object, parseJson} from '../../../../packages/contracts/src/backend';
import type {PlatformClient} from '../data/platform';
import {HumanData} from '../platform_copy';
import {Button, type FeedbackMessage} from '../ui';
import {requireError} from '@darkforest/contracts';

/** 平台目录状态的用户可读标签，不改变后端状态机。 */
export const states: Record<string, string> = {
  draft: '草稿',
  provisioning: '创建中',
  available: '已发布',
  archiving: '归档中',
  archived: '已归档',
  purge_pending: '待清理',
  purged: '已清理',
  imported_archive: '导入档案',
  pending: '待执行',
  succeeded: '已完成',
  partial: '部分完成',
  failed: '需处理',
  cancelled: '已取消',
  active: '已激活',
  disabled: '已停用',
};

/** 长期账号状态的用户可读标签。 */
export const accountStates: Record<string, string> = {
  pending: '待领取',
  active: '已激活',
  disabled: '已停用',
};

/** 平台任职的显示名称，与本场裁判岗位分开。 */
export const roles: Record<string, string> = {
  owner: '平台所有者',
  admin: '平台管理员',
  archivist: '资料管理员',
};

/** 为平台表单字段提供一致的可访问标签和内容布局。 */
export function Label({children}: {children: ReactNode}) {
  return <span className="platform-label">{children}</span>;
}

/** 展示平台页面标题及可选上下文操作。 */
export function Header({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="platform-heading">
      <div>
        <h1 tabIndex={-1}>{title}</h1>
      </div>
      {children}
    </header>
  );
}

/** 把已确认结果、错误和处理中状态组合成页面反馈。 */
export function platformFeedbackMessages(
  client: PlatformClient,
  run: Run,
  error: string,
  notice: string,
  busy: boolean,
  clear: () => void,
): FeedbackMessage[] {
  const pending = client.session && client.pending();
  if (!error && !notice && !pending) {
    return [];
  }
  return [
    {
      tone: error ? 'error' : busy || pending ? 'pending' : 'result',
      ...(busy ? {} : {onClose: clear}),
      content: (
        <>
          <p>
            {error ||
              notice ||
              '正在确认上一次操作结果。取得处理结果后再提交新的操作。'}
          </p>
          {pending && !busy && (
            <Button onClick={() => void run(() => client.resolvePending())}>
              查询原操作结果
            </Button>
          )}
        </>
      ),
    },
  ];
}

/** 仅展示本次获授权的邀请或口令交付，其余结果使用可读字段投影。 */
export function Delivery({value}: {value: Record<string, unknown> | null}) {
  if (!value) {
    return null;
  }
  const invitation = value.invitation;
  return (
    <section className="platform-delivery">
      <h2>本次交付</h2>
      <p>
        请单人复制或打印交付；长期口令只在领取时显示。邀请7天有效，交付原文24小时后清除。
      </p>
      {typeof invitation === 'string' && (
        <>
          <code className="credential-text">{`${location.origin}/claim#${invitation}`}</code>
          <Button
            onClick={() =>
              void navigator.clipboard.writeText(
                `${location.origin}/claim#${invitation}`,
              )
            }
          >
            复制领取链接
          </Button>
        </>
      )}
      {typeof value.credential === 'string' && (
        <code className="credential-text">{value.credential}</code>
      )}
      <HumanData
        value={Object.fromEntries(
          Object.entries(value).filter(
            ([k]) => !['invitation', 'credential'].includes(k),
          ),
        )}
      />
    </section>
  );
}

/** 统一的异步页面工作入口，负责忙碌、错误及操作结果反馈。 */
export type Run = (work: () => Promise<unknown>) => Promise<void>;

/** 加载指定平台列表并在参数变化或卸载后忽略过时响应。 */
export function useRows<T>(client: PlatformClient, path: string, tick: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void client
      .request<T>(path)
      .then(value => {
        if (active) {
          setData(value);
          setError('');
        }
      })
      .catch(e => {
        if (active) {
          setError(requireError(e).message);
        }
      });
    return () => {
      active = false;
    };
  }, [client, path, tick]);
  return {data, error};
}

/** 优先读取目录阶段，兼容旧摘要中的已结束标记；坏摘要不会被当作完赛。 */
export function matchEnded(entry: MatchEntry) {
  if (entry.phase) {
    return entry.phase === 'ended';
  }
  try {
    return object(parseJson(entry.summary)).phase === 'ended';
  } catch {
    return false;
  }
}
