import {useState} from 'react';
import {MatchLinks} from '../../components/match_context';
import {handleAsync} from '../../data/async_event';
import {canAct} from '../../permissions';
import {useApp} from '../../state';
import {
  ArmsView,
  Button,
  CopyText,
  Empty,
  Events,
  Field,
  Icon,
  Identity,
  Link,
  MiniArms,
  PageTitle,
  PlayerStatus,
} from '../../ui';

/** 展示本人资源、状态和偏好入口，资源权威值取自服务端快照。 */
export function Me() {
  const {data} = useApp();
  const me = data.player!;
  return (
    <>
      <PageTitle title="我的" />
      <div className="profile-heading">
        <Identity id={me.id} nickname={me.nickname} />
        <PlayerStatus />
      </div>
      <div className="stat-lines">
        <div>
          <span>母星状态</span>
          <strong>{me.homeAlive ? '尚存' : '已毁灭'}</strong>
        </div>
        <div>
          <span>当前航次</span>
          <strong className="numeric">{me.flightNumber}</strong>
        </div>
        <div>
          <span>广播额度</span>
          <strong>
            剩余<span className="numeric">{me.broadcasts}</span>次
          </strong>
        </div>
        <div>
          <span>光粒额度</span>
          <strong>
            {me.photons > 0 ? (
              <>
                剩余<span className="numeric">{me.photons}</span>枚
              </>
            ) : (
              '无光粒'
            )}
          </strong>
        </div>
        <div>
          <span>已击毁的不同文明数</span>
          <strong className="numeric">{me.kills}</strong>
        </div>
        <div>
          <span>提交错误手环颜色的次数</span>
          <strong className="numeric">{me.wrongCount}</strong>
        </div>
      </div>
      {me.arms && (
        <Link className="row-link" to="/player/bracelets">
          <span>
            本航次手环
            <MiniArms arms={me.arms} />
          </span>
          <Icon name="arrow" size={18} />
        </Link>
      )}
      {[
        {to: '/player/homeworld', label: '本人母星'},
        {to: '/player/records', label: '个人战绩'},
        {to: '/rules', label: '比赛规则'},
        {to: '/player/help', label: '联系裁判'},
        {to: '/player/exception', label: '异常申报'},
        {to: '/player/account', label: '账号与设置'},
      ].map(item => (
        <Link className="row-link" to={item.to} key={item.to}>
          {item.label}
          <Icon name="arrow" size={18} />
        </Link>
      ))}
      <MatchLinks />
    </>
  );
}

/** 展示本人当前手环配置；编码与六位母星坐标保持独立。 */
export function Bracelets() {
  const {data} = useApp();
  const me = data.player!;
  return (
    <>
      <PageTitle
        title={
          me.flight === 'outfitting' || me.flight === 'issued'
            ? '需要佩戴的手环'
            : '本航次手环'
        }
        back="/player/me"
      />
      <p className="secondary">
        第{me.flightNumber}航次{me.arms ? '' : '，配置已失效'}
      </p>
      {me.arms ? (
        <>
          <ArmsView arms={me.arms} />
          <p>同侧顺序不限，两侧可以交换。未佩戴的其他手环收入口袋。</p>
        </>
      ) : (
        <Empty
          title="当前没有可用的手环配置"
          to="/player/records"
          action="查看历史记录"
        >
          被击毁后请摘下全部比赛手环，历史配置不能继续使用。
        </Empty>
      )}
    </>
  );
}

/** 展示本人航次和已发生战绩，去重统计沿用服务端结果。 */
export function Records() {
  const {data} = useApp();
  return (
    <>
      <PageTitle title="个人战绩" back="/player/me" />
      <div className="record-number">
        <strong className="numeric">{data.player!.kills}</strong>
        <span>已击毁的不同文明数</span>
      </div>
      <p className="secondary">
        同一文明被多次击毁只计一次。广播、光粒和歌者造成的母星毁灭不计入此数。
      </p>
      <Events
        events={data.events.filter(
          e =>
            e.civilizationIds.includes(data.player!.id) &&
            ['sighting', 'respawn', 'notice'].includes(e.kind),
        )}
      />
    </>
  );
}

/** 提供当前流程的异常指引及裁判联系方式，不替代现场执裁。 */
export function Help({exception = false}: {exception?: boolean}) {
  const {data} = useApp();
  const [kind, setKind] = useState('手环损坏');
  return (
    <>
      <PageTitle
        title={exception ? '异常申报' : '联系裁判'}
        back="/player/me"
      />
      <p>裁判联系方式</p>
      <p className="contact-text">
        {data.site.judgeContact || '请查看活动QQ群的裁判联系方式。'}
      </p>
      {data.site.qqGroup && (
        <p className="secondary">比赛QQ群：{data.site.qqGroup}</p>
      )}
      {exception ? (
        <>
          <Field label="需要处理的情况">
            <select value={kind} onChange={e => setKind(e.target.value)}>
              {[
                '手环损坏',
                '网页无法提交',
                '攻击结果需要复核',
                '其他现场异常',
              ].map(k => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </Field>
          <p>复制申报消息，在裁判QQ私聊中说明“{kind}”及现场情况。</p>
          <CopyText kind="exception" label="获取并复制申报消息" />
        </>
      ) : (
        <>
          <p>请通过裁判QQ私聊发送照片和说明。</p>
          <Link className="row-link" to="/player/exception">
            异常申报
            <Icon name="arrow" size={18} />
          </Link>
          <Link className="row-link" to="/rules">
            查看比赛规则
            <Icon name="arrow" size={18} />
          </Link>
        </>
      )}
    </>
  );
}

/** 提供本人会话和退出操作，不向页面暴露凭据摘要。 */
export function Account() {
  const {
    reportError,
    data,
    logout,
    names,
    setNames,
    reduced,
    setReduced,
    operate,
    busy,
    go,
  } = useApp();
  const [quit, setQuit] = useState(false);
  return (
    <>
      <PageTitle title="账号与设置" back="/player/me" />
      <MatchLinks />
      <Identity id={data.player!.id} nickname={data.player!.nickname} />
      <div className="preferences">
        <label className="check-label">
          <input
            type="checkbox"
            checked={names}
            onChange={e => setNames(e.target.checked)}
          />
          显示颜色名称
        </label>
        <label className="check-label">
          <input
            type="checkbox"
            checked={reduced}
            onChange={e => setReduced(e.target.checked)}
          />
          减少动态效果
        </label>
      </div>
      <Button onClick={() => void logout()} className="full">
        <Icon name="logout" size={18} />
        退出登录
      </Button>
      {canAct(data, 'withdraw') && (
        <div className="danger-zone">
          {quit ? (
            <>
              <p>
                确认退出后，你的文明将永久淘汰。请在安全位置摘下全部比赛手环，步行返回中控室。
              </p>
              <Button
                className="danger full"
                disabled={busy}
                onClick={handleAsync(async () => {
                  const r = await operate('/action/withdraw');
                  if (r?.status === 'complete') {
                    go('/player/eliminated');
                  }
                }, reportError)}
              >
                确认退出比赛
              </Button>
              <button className="text-button" onClick={() => setQuit(false)}>
                继续参加比赛
              </button>
            </>
          ) : (
            <button
              className="text-button danger"
              onClick={() => setQuit(true)}
            >
              退出比赛
            </button>
          )}
        </div>
      )}
    </>
  );
}
