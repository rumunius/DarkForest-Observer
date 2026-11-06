import {useEffect, useState} from 'react';
import type {PlatformClient} from '../data/platform';
import {Button, Field} from '../ui';
import type {Run} from './shared';
import {Header} from './shared';

/** 交换长期口令和可选第二因素，成功后刷新当前平台会话。 */
export function Login({
  client,
  audience,
  setAudience,
  refresh,
  run,
  busy,
}: {
  client: PlatformClient;
  audience: 'player' | 'staff';
  setAudience: (value: 'player' | 'staff') => void;
  refresh: () => Promise<void>;
  run: Run;
  busy: boolean;
}) {
  const [credential, setCredential] = useState('');
  const [code, setCode] = useState('');
  return (
    <>
      <Header title="进入赛事中心" />
      <p className="platform-intro">一个长期账号，查看属于你的每一场比赛。</p>
      <form
        className="form-stack platform-form"
        onSubmit={e => {
          e.preventDefault();
          void run(async () => {
            await client.login(credential, code);
            setCredential('');
            await refresh();
          });
        }}
      >
        <Field label="账号类别">
          <select
            value={audience}
            onChange={e => setAudience(e.target.value as 'staff' | 'player')}
          >
            <option value="player">玩家</option>
            <option value="staff">工作人员</option>
          </select>
        </Field>
        <Field label="长期口令">
          <input
            type="password"
            required
            autoComplete="current-password"
            value={credential}
            onChange={e => setCredential(e.target.value)}
          />
        </Field>
        {audience === 'staff' && (
          <Field label="第二因素验证码或恢复码（没设置不用填）">
            <input
              autoComplete="one-time-code"
              value={code}
              onChange={e => setCode(e.target.value)}
            />
          </Field>
        )}
        <Button
          type="submit"
          className="primary"
          disabled={busy || !credential}
        >
          {busy ? '正在登录' : '登录'}
        </Button>
      </form>
    </>
  );
}

/** 消费有时限且只能领取一次的邀请，交付原始长期口令。 */
export function Claim({
  client,
  run,
  busy,
}: {
  client: PlatformClient;
  run: Run;
  busy: boolean;
}) {
  const [invitation, setInvitation] = useState(() => location.hash.slice(1));
  useEffect(() => {
    history.replaceState(null, '', location.pathname);
  }, []);
  return (
    <>
      <Header title="领取长期账号" />
      <p>
        请确认这是工作人员单独交付给你的邀请。领取后立即保存生成的长期口令，再回到登录页。
      </p>
      <form
        className="form-stack platform-form"
        onSubmit={e => {
          e.preventDefault();
          void run(async () => {
            const result = await client.request<unknown>('/auth/claim', {
              invitation,
            });
            setInvitation('');
            return result;
          });
        }}
      >
        <Field label="邀请码">
          <input
            type="password"
            required
            value={invitation}
            onChange={e => setInvitation(e.target.value)}
            autoComplete="off"
          />
        </Field>
        <Button type="submit" disabled={busy || !invitation}>
          领取并生成长期口令
        </Button>
      </form>
      <a href="/matches">返回登录</a>
    </>
  );
}
