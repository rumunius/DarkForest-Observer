import { useState } from 'react';
import { useApp } from '../state';
import { Button, CopyText, Field } from '../ui';
import { ManagementForm } from './judge';
export function AccountsManagement() {
  const { data, source, result } = useApp();
  const [selected, setSelected] = useState(''),
    [operation, setOperation] = useState('disable'),
    [duty, setDuty] = useState('communications');
  const [delivery, setDelivery] = useState<{ accountId: string; credential: string } | null>(null),
    [error, setError] = useState('');
  const accounts = data.judge?.accounts?.filter(
    (a) => a.id !== data.session?.id && !a.permissions.includes('system'),
  );
  const account = accounts?.find((a) => a.id === selected) ?? accounts?.[0];
  if (!account) return null;
  return (
    <section>
      <h2>账号管理</h2>
      <Field label="需要处理的账号">
        <select
          value={account.id}
          onChange={(event) => {
            setSelected(event.target.value);
            setOperation('disable');
            setDelivery(null);
          }}
        >
          {accounts!.map((a) => (
            <option key={a.id} value={a.id}>
              {a.id}（{a.name}），{a.enabled ? '已启用' : '已停用'}
            </option>
          ))}
        </select>
      </Field>
      <Field label="账号操作">
        <select value={operation} onChange={(event) => setOperation(event.target.value)}>
          <option value="disable">停用账号</option>
          <option value="enable">启用账号</option>
          <option value="reset">重置登录口令</option>
          {account.role === 'judge' && <option value="duty">调整裁判职责</option>}
        </select>
      </Field>
      {operation === 'duty' && (
        <Field label="裁判职责">
          <select value={duty} onChange={(event) => setDuty(event.target.value)}>
            <option value="communications">通讯裁判</option>
            <option value="events">事件裁判</option>
          </select>
        </Field>
      )}
      <ManagementForm
        title="确认账号操作"
        path="/judge/accounts"
        payload={{
          target: account.id,
          operation,
          expected_version: account.version,
          ...(operation === 'duty' ? { duty } : {}),
        }}
      />
      {result?.credentialDeliveryId && (
        <Button
          onClick={async () => {
            try {
              setDelivery(await source.credential!(result.credentialDeliveryId!));
              setError('');
            } catch (e) {
              setError(e instanceof Error ? e.message : '暂时无法读取新口令。');
            }
          }}
        >
          读取新登录口令
        </Button>
      )}
      {delivery && (
        <>
          <p>{delivery.accountId}的新登录口令</p>
          <CopyText text={delivery.credential} label="复制新口令" />
        </>
      )}
      {error && <p role="status">{error}</p>}
    </section>
  );
}
