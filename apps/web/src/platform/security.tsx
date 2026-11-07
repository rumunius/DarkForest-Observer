import {useState} from 'react';
import type {PlatformClient} from '../data/platform';
import {Button, Field} from '../ui';
import type {Run} from './shared';
import {Header, useRows} from './shared';

/** 管理长期口令、第二因素与恢复码，敏感变更以有效会话验证。 */
export function Security({
  client,
  run,
  refresh,
}: {
  client: PlatformClient;
  run: Run;
  refresh: () => Promise<void>;
}) {
  const [credential, setCredential] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<{secret: string} | null>(null);
  const [recovery, setRecovery] = useState<string[]>([]);
  const {data: sessions} = useRows<
    Array<{created_utc: number; expires: number; revoked: number}>
  >(client, '/me/sessions', 0);
  return (
    <>
      <Header title="账号与安全" />
      <p>
        {client.session?.account.name}，
        {client.audience === 'staff' ? '工作人员' : '玩家'}
      </p>
      {client.session?.secondFactorEnabled && !client.session.secondFactor && (
        <form
          className="form-stack platform-form"
          onSubmit={e => {
            e.preventDefault();
            void run(async () => {
              await client.request<unknown>('/auth/reauth', {credential, code});
              setCredential('');
              setCode('');
              await refresh();
            });
          }}
        >
          <p>关闭第二因素验证前，请先在当前设备验证第二因素。</p>
          <Field label="长期口令">
            <input
              type="password"
              autoComplete="current-password"
              value={credential}
              onChange={e => setCredential(e.target.value)}
            />
          </Field>
          <Field label="第二因素验证码或恢复码">
            <input
              autoComplete="one-time-code"
              value={code}
              onChange={e => setCode(e.target.value)}
            />
          </Field>
          <Button type="submit" disabled={!credential || !code}>
            验证第二因素
          </Button>
        </form>
      )}
      {!client.session?.secondFactorEnabled && (
        <section className="platform-detail">
          <h2>设置第二因素</h2>
          <p>
            你可以自愿启用第二因素验证。启用后，登录需要认证器验证码或恢复码，也可以在这里关闭。
          </p>
          <Button
            onClick={() =>
              void run(async () => {
                setSetup(
                  await client.request<{secret: string}>(
                    '/me/security/setup',
                    {},
                  ),
                );
              })
            }
          >
            生成认证器密钥
          </Button>
          {setup && (
            <>
              <code className="credential-text">{setup.secret}</code>
              <Field label="认证器验证码">
                <input
                  autoComplete="one-time-code"
                  value={code}
                  onChange={e => setCode(e.target.value)}
                />
              </Field>
              <Button
                disabled={!code}
                onClick={() =>
                  void run(async () => {
                    const result = await client.request<{
                      recoveryCodes: string[];
                    }>('/me/security/confirm', {code});
                    setRecovery(result.recoveryCodes);
                    setSetup(null);
                    await refresh();
                  })
                }
              >
                确认验证码
              </Button>
            </>
          )}
        </section>
      )}
      {client.session?.secondFactorEnabled && (
        <section className="platform-detail">
          <h2>第二因素验证已启用</h2>
          <Button
            disabled={!client.session.secondFactor}
            onClick={() =>
              void run(async () => {
                await client.request<unknown>('/me/security/disable', {});
                setRecovery([]);
                await refresh();
              })
            }
          >
            关闭第二因素验证
          </Button>
        </section>
      )}
      {recovery.length > 0 && (
        <section className="platform-detail">
          <p>一次性恢复码，请安全保存，离页后不再显示。</p>
          <pre>{recovery.join('\n')}</pre>
        </section>
      )}
      <section className="platform-detail">
        <h2>设备登录记录</h2>
        {sessions?.map((s, i) => (
          <p key={i}>
            {new Date(s.created_utc).toLocaleString('zh-CN')}，
            {s.revoked
              ? '已退出登录'
              : new Date(s.expires).toLocaleString('zh-CN') + ' 到期'}
          </p>
        ))}
        <Button
          onClick={() =>
            void run(async () => {
              await client.request<unknown>('/me/sessions/revoke', {});
              await refresh();
            })
          }
        >
          退出全部设备
        </Button>
      </section>
    </>
  );
}
