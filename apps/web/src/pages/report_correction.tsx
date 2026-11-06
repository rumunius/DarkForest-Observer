import {useState} from 'react';
import {useApp} from '../state';
import {Field} from '../ui';
import {ManagementForm} from './judge';
export function ReportCorrection() {
  const {data} = useApp();
  const [field, setField] = useState('attack_valid');
  const [target, setTarget] = useState('');
  const [value, setValue] = useState('false');
  if (!data.results || !data.session?.permissions.includes('commands')) {
    return null;
  }
  const targets =
    field === 'attack_valid'
      ? (data.judge?.attacks ?? []).map(a => ({
          id: a.id,
          label: `${a.actor}，${a.target ? `击毁${a.target}` : '未产生击毁'}，${new Date(a.utcMs).toLocaleTimeString('zh-CN')}`,
        }))
      : data.results.standings.map(c => ({
          id: c.id,
          label: `${c.id}（${c.nickname}）`,
        }));
  const selected =
    targets.find(t => t.id === target)?.id ?? targets[0]?.id ?? '';
  return (
    <section>
      <h2>更正赛后战报</h2>
      <Field label="更正项目">
        <select
          value={field}
          onChange={event => {
            setField(event.target.value);
            setTarget('');
            setValue(event.target.value === 'nickname' ? '' : 'false');
          }}
        >
          <option value="attack_valid">更正攻击是否有效</option>
          <option value="elimination_valid">更正淘汰是否有效</option>
          <option value="nickname">更正文明昵称</option>
        </select>
      </Field>
      <Field label="相关记录">
        <select
          value={selected}
          onChange={event => setTarget(event.target.value)}
        >
          {targets.map(t => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </Field>
      {field === 'nickname' ? (
        <Field label="更正后的昵称">
          <input
            value={value}
            onChange={event => setValue(event.target.value)}
          />
        </Field>
      ) : (
        <Field label="更正结果">
          <select
            value={value}
            onChange={event => setValue(event.target.value)}
          >
            <option value="false">无效</option>
            <option value="true">有效</option>
          </select>
        </Field>
      )}
      <ManagementForm
        title="发布更正战报"
        path="/judge/report-correction"
        payload={{
          field,
          target: selected,
          value: field === 'nickname' ? value : value === 'true',
          expected_version: data.results.version,
        }}
        ready={!!selected && !!value.trim()}
      />
      <h3>战报版本</h3>
      {data.results.versions?.map(r => (
        <p key={r.version}>
          第{r.version}版：{r.reason || '比赛结束时的战报'}
        </p>
      ))}
    </section>
  );
}
