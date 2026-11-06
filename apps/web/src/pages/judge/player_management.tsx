import {FLIGHT_NAMES, type Civilization} from '@darkforest/contracts';
import {useState} from 'react';
import {judgeCan} from '../../permissions';
import {useApp} from '../../state';
import {
  Disclosure,
  Empty,
  Events,
  Field,
  MiniArms,
  PageTitle,
  Tabs,
} from '../../ui';
import {CivilizationDetail} from '../observe';
import {RecordPagination} from '../record_pagination';
import {ManagementForm} from './management_form';

/** 展示指定文明的裁判管理操作，使用真实预览解释跨状态影响。 */
export function PlayerManagement({c}: {c: Civilization}) {
  const {data} = useApp();
  const [operation, setOperation] = useState('nickname');
  const [value, setValue] = useState('');
  return (
    <>
      <CivilizationDetail
        civilization={c}
        back="/judge/players"
        title="文明管理详情"
      />
      {judgeCan(data, 'commands') && (
        <Disclosure title="裁判管理操作">
          <Field label="拟变更内容">
            <select
              value={operation}
              onChange={e => setOperation(e.target.value)}
            >
              <option value="nickname">更正文明昵称</option>
              <option value="photons">修正光粒库存</option>
              <option value="broadcasts">修正广播次数</option>
              <option value="restore">恢复参赛资格</option>
              <option value="eliminate">记录严重违规淘汰</option>
              <option value="absence">登记赛前缺席</option>
            </select>
          </Field>
          <ManagementForm
            title={
              operation === 'restore'
                ? '恢复参赛资格'
                : operation === 'eliminate'
                  ? '记录严重违规淘汰'
                  : operation === 'absence'
                    ? '登记赛前缺席'
                    : '修正文明确认信息'
            }
            path={
              operation === 'absence'
                ? `/judge/roster/${c.id}/withdraw`
                : operation === 'restore'
                  ? '/judge/player-restore'
                  : operation === 'eliminate'
                    ? '/judge/player-eliminate'
                    : '/judge/correction'
            }
            payload={
              ['restore', 'eliminate'].includes(operation)
                ? {target: c.id}
                : {target: c.id, field: operation, value}
            }
            ready={
              ['restore', 'absence', 'eliminate'].includes(operation) ||
              !!value.trim()
            }
            current={`${c.id}（${c.nickname}），${FLIGHT_NAMES[c.flight]}`}
          >
            {!['restore', 'absence', 'eliminate'].includes(operation) && (
              <Field label="拟变更值">
                <input value={value} onChange={e => setValue(e.target.value)} />
              </Field>
            )}
            <p className="secondary">
              恢复资格前先暂停并核对人工淘汰记录。原出航文明将领取全新配置，核对佩戴后由裁判激活；已传播的情报保留审计说明。
            </p>
          </ManagementForm>
        </Disclosure>
      )}
    </>
  );
}

/** 展示攻击证据及纠错流程，保留原判定与已传播情报的说明。 */
export function AttackReview() {
  const {data} = useApp();
  const [id, setId] = useState('C07');
  const [selectedAttack, setSelectedAttack] = useState('');
  const c = data.civilizations.find(c => c.id === id);
  const attacks = data.judge?.attacks?.filter(a => a.actor === id) ?? [];
  const attack = attacks.find(a => a.id === selectedAttack) ?? attacks[0];
  return (
    <>
      <PageTitle title="攻击复核" />
      <RecordPagination kind="attacks" />
      <Field label="选择文明">
        <select value={id} onChange={e => setId(e.target.value)}>
          {data.civilizations.map(c => (
            <option key={c.id} value={c.id}>
              {c.id}（{c.nickname}）
            </option>
          ))}
        </select>
      </Field>
      {c && (
        <>
          <div className="stat-lines">
            <div>
              <span>提交错误目击码的次数</span>
              <strong>{c.wrongCount}</strong>
            </div>
            <div>
              <span>当前飞船状态</span>
              <strong>{FLIGHT_NAMES[c.flight]}</strong>
            </div>
          </div>
          <Events
            events={data.events.filter(
              e => e.kind === 'sighting' && e.civilizationIds.includes(id),
            )}
          />
          {judgeCan(data, 'commands') && attack && (
            <>
              <Field label="需要更正的攻击">
                <select
                  value={attack.id}
                  onChange={event => setSelectedAttack(event.target.value)}
                >
                  {attacks.map(a => (
                    <option value={a.id} key={a.id}>
                      {new Date(a.utcMs).toLocaleTimeString('zh-CN', {
                        timeZone: data.site.timezone,
                      })}
                      ，{a.target ? `击毁${a.target}` : '未产生击毁'}
                      {a.valid ? '' : '，已更正'}
                    </option>
                  ))}
                </select>
              </Field>
              {attack.roll !== null && (
                <p>第二次错误提交的抽签值：{attack.roll}</p>
              )}
              <ManagementForm
                title="有技术证据的攻击纠错"
                path="/judge/attack-correction"
                payload={{attack_id: attack.id}}
                ready={attack.valid}
                change="复核原攻击、关联航次、战绩、淘汰、排名、观战与通知，不重抽既定随机结果"
              >
                <p className="notice-block">
                  仅在有充分技术故障证据时执行。原记录保留，已发生的情报传播写入审计说明。
                </p>
              </ManagementForm>
            </>
          )}
        </>
      )}
    </>
  );
}

/** 处理同色实物替换、新配置和现场激活，保持航次与发行约束。 */
export function Equipment() {
  const {data} = useApp();
  const [id, setId] = useState('C07');
  const [mode, setMode] = useState('replace');
  const c = data.civilizations.find(c => c.id === id);
  return (
    <>
      <PageTitle title="手环处理" />
      <div className="dashboard-metrics">
        <div className="metric">
          <span>已发行配置</span>
          <strong className="numeric">{data.judge!.issuedCodes}</strong>
        </div>
        <div className="metric">
          <span>尚可发行配置</span>
          <strong className="numeric">{350 - data.judge!.issuedCodes}</strong>
        </div>
      </div>
      <p>所有已发行配置在本场永久占用，历史配置不复用。</p>
      <Field label="需要处理的文明">
        <select value={id} onChange={e => setId(e.target.value)}>
          {data.civilizations.map(c => (
            <option key={c.id} value={c.id}>
              {c.id}（{c.nickname}）
            </option>
          ))}
        </select>
      </Field>
      {c?.arms && (
        <>
          <h2>当前有效配置</h2>
          <MiniArms arms={c.arms} />
        </>
      )}
      <Tabs
        tabs={[
          {id: 'replace', label: '同色同款替换'},
          ...(judgeCan(data, 'commands')
            ? [{id: 'reissue', label: '异常注销换码'}]
            : []),
        ]}
        active={mode}
        onChange={setMode}
      />
      {c?.flight === 'issued' && data.match!.paused ? (
        <ManagementForm
          title="确认穿戴并恢复出航"
          path="/judge/equipment-correction"
          payload={{target: id, mode: 'activate'}}
          change="核对新配置穿戴后，恢复该文明出航"
        />
      ) : mode === 'replace' ? (
        <ManagementForm
          title="记录手环替换"
          path="/judge/equipment-correction"
          payload={{target: id, mode: 'replace'}}
          change="只替换同色同款实物手环，当前配置保持有效"
        />
      ) : !data.match!.paused ? (
        <Empty title="请先暂停比赛" to="/judge/clock" action="前往比赛时间">
          异常换码依次核对旧配置、注销、换发与新佩戴，最后才恢复比赛。
        </Empty>
      ) : (
        <ManagementForm
          title="注销旧配置并申请新配置"
          path="/judge/equipment-correction"
          payload={{target: id, mode: 'reissue'}}
          change="旧配置永久退役，从剩余配置中换发，等待核对新佩戴后恢复"
        />
      )}
    </>
  );
}
