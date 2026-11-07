import {RULES} from '@darkforest/contracts';
import {dimensionCopy} from '../../../../../packages/contracts/src/message_copy';
import {useApp} from '../../state';
import {Empty, Frame, Icon, Link, PageTitle, Timer} from '../../ui';

/** 解释转场与终局位置共享的当前步骤，资格结果由裁判核验。 */
export function Endgame() {
  const {data} = useApp();
  const match = data.match!;
  return (
    <>
      <PageTitle title="终局说明" back="/player" />
      {match.stage === 'transfer' && (
        <Timer label="距离终局资格截止" deadline={RULES.cutoffMs} large />
      )}
      {match.verification && (
        <Frame>
          <h2>终局资格确认中</h2>
          <p>比赛有效时间停在98:00。等待裁判完成资格核验后恢复计时。</p>
        </Frame>
      )}
      <ol className="instruction-list">
        <li>
          <h2>加入QQ群位置共享</h2>
          <p>从比赛时间90:00起，加入比赛QQ群的同一场实时位置共享。</p>
        </li>
        <li>
          <h2>正常步行进入终局圈</h2>
          <p>
            请查看QQ群文件中的{data.site.endgameFile}，并使用手机高德地图前往。
          </p>
        </li>
        <li>
          <h2>98:00前到达并持续共享</h2>
          <p>
            请在比赛时间98:00前进入终局圈，并持续共享位置，等待裁判核验资格。
          </p>
        </li>
      </ol>
      <p className="notice-block">
        最后狩猎期间离开终局圈、停止位置共享或定位违规，裁判将执行永久淘汰。
      </p>
    </>
  );
}

/** 展示淘汰后的现场指引和真实UTC观战等待，不授予管理身份。 */
export function Eliminated() {
  const {data} = useApp();
  const playerState = data.player!;
  if (playerState.flight !== 'eliminated') {
    return (
      <>
        <PageTitle title="淘汰后安排" back="/player" />
        <Empty title="你当前没有淘汰安排" />
      </>
    );
  }
  return (
    <>
      <PageTitle title="淘汰后安排" back="/player" />
      <h2>维度跃迁</h2>
      <p>{playerState.eliminationReason}</p>
      <p className="notice-block message-body">
        {dimensionCopy(data.parameters?.observerWaitSeconds ?? 180)}
      </p>
      {playerState.eliminatedAt && (
        <p className="secondary">
          淘汰生效时间：
          {new Date(playerState.eliminatedAt).toLocaleTimeString('zh-CN', {
            timeZone: data.site.timezone,
          })}
        </p>
      )}
      {playerState.observerAllowed ? (
        <Link className="text-link" to="/observer">
          进入宇宙观测
          <Icon name="arrow" size={18} />
        </Link>
      ) : (
        playerState.eliminatedAt && (
          <Timer
            label="距离开放宇宙观测"
            clock="utc"
            deadline={
              playerState.eliminatedAt +
              (data.parameters?.observerWaitSeconds ?? 180) * 1000
            }
            large
          />
        )
      )}
      <Link className="text-link" to="/player/records">
        查看本人战绩
        <Icon name="arrow" size={18} />
      </Link>
    </>
  );
}
