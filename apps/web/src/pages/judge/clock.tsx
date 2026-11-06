import {STAGE_NAMES} from '@darkforest/contracts';
import {useState} from 'react';
import {useApp} from '../../state';
import {
  Empty,
  Field,
  Frame,
  Icon,
  Identity,
  Link,
  MatchSummary,
  PageTitle,
} from '../../ui';
import {AuditEntries} from './audit';
import {ManagementForm} from './management_form';

/** 分批收集终局资格草稿，最终一次提交完整核验结果。 */
export function EndgameManagement() {
  const {data} = useApp();
  const [selections, setSelections] = useState<Record<string, string>>({});
  const match = data.match!;
  const living = data.civilizations.filter(c => c.flight !== 'eliminated');
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('left_zone');
  return (
    <>
      <PageTitle title="终局执裁" />
      <MatchSummary />
      {match.verification ? (
        <>
          <p>
            请在QQ核对每个人截至98:00的共享与入圈资格。勾选只形成裁决草稿，最后一次提交整批名单。
          </p>
          <div className="endgame-roster">
            {living.map(civilization => (
              <div className="endgame-row" key={civilization.id}>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={civilization.id in selections}
                    onChange={e =>
                      setSelections(previous => {
                        const next = {...previous};
                        if (e.target.checked) {
                          next[civilization.id] = 'no_share_at_cutoff';
                        } else {
                          delete next[civilization.id];
                        }
                        return next;
                      })
                    }
                  />
                  <Identity
                    id={civilization.id}
                    nickname={civilization.nickname}
                  />
                </label>
                {civilization.id in selections ? (
                  <select
                    aria-label={`${civilization.id}淘汰原因`}
                    value={selections[civilization.id]}
                    onChange={e =>
                      setSelections({
                        ...selections,
                        [civilization.id]: e.target.value,
                      })
                    }
                  >
                    <option value="no_share_at_cutoff">
                      未按时加入位置共享
                    </option>
                    <option value="outside_at_cutoff">
                      截止时未进入终局圈
                    </option>
                  </select>
                ) : (
                  <span className="secondary">本次保留</span>
                )}
              </div>
            ))}
          </div>
          <ManagementForm
            title="完成终局资格核验"
            path="/judge/hunt-finalize"
            payload={{
              eliminations: Object.entries(selections).map(([id, reason]) => ({
                id,
                reason,
              })),
            }}
            change={`批量淘汰${Object.keys(selections).length}人，预计保留${living.length - Object.keys(selections).length}人`}
          >
            <p className="notice-block">
              预计保留{living.length - Object.keys(selections).length}
              名文明。至少2人时开始最后狩猎；仅余1人或无人存活时直接完赛。允许提交空淘汰名单。
            </p>
          </ManagementForm>
        </>
      ) : match.stage === 'hunt' ? (
        <>
          <h2>终局持续执裁</h2>
          <Field label="需要处理的文明">
            <select value={target} onChange={e => setTarget(e.target.value)}>
              <option value="">选择文明</option>
              {living.map(c => (
                <option key={c.id} value={c.id}>
                  {c.id}（{c.nickname}）
                </option>
              ))}
            </select>
          </Field>
          <ManagementForm
            title="确认终局淘汰"
            path="/judge/hunt-eliminate"
            payload={{target, reason_code: reason}}
            ready={!!target}
          >
            <Field label="裁决原因">
              <select value={reason} onChange={e => setReason(e.target.value)}>
                <option value="left_zone">离开终局圈</option>
                <option value="sharing_stopped">停止位置共享</option>
                <option value="location_violation">定位违规</option>
              </select>
            </Field>
          </ManagementForm>
        </>
      ) : (
        <Empty title="终局执裁尚未开始" to="/judge">
          90分钟起核对存活文明，98分钟进入统一资格核验。
        </Empty>
      )}
    </>
  );
}

/** 显示UTC与有效比赛时钟，并通过管理预览暂停或恢复。 */
export function ClockManagement() {
  const {data} = useApp();
  const match = data.match!;
  return (
    <>
      <PageTitle title="比赛时间" />
      <MatchSummary />
      <p className="secondary">
        当前真实时间：
        {new Date(match.serverUtcMs).toLocaleString('zh-CN', {
          timeZone: data.site.timezone,
        })}
      </p>
      <p>
        全场暂停冻结有效比赛时间和重生期限。个人禁止目击攻击、淘汰后观战等待仍按真实时间继续。
      </p>
      {match.verification ? (
        <Frame>
          <h2>请先完成终局资格核验</h2>
          <p>核验暂停不能用普通恢复操作结束。</p>
          <Link className="text-link" to="/judge/endgame">
            前往终局执裁
            <Icon name="arrow" size={18} />
          </Link>
        </Frame>
      ) : match.stage === 'ended' ? (
        <p>比赛已经结束。</p>
      ) : (
        <ManagementForm
          title={match.paused ? '恢复比赛' : '暂停比赛'}
          path={match.paused ? '/judge/resume' : '/judge/pause'}
          current={`${STAGE_NAMES[match.stage]}，${match.paused ? '已暂停' : '计时中'}`}
          change={
            match.paused
              ? '恢复有效比赛时间，重新核验所有行动权限'
              : '冻结有效比赛时间和重生期限，暂停普通战局操作'
          }
        />
      )}
      <h2>计时操作记录</h2>
      <AuditEntries />
    </>
  );
}
