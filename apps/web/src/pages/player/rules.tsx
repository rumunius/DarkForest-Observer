import {STAGE_NAMES} from '@darkforest/contracts';
import {useEffect} from 'react';
import {OBSERVER_AGREEMENT_COPY} from '../../../../../packages/contracts/src/message_copy';
import {DEFAULT_PARAMETERS, duration} from '../../rule_text';
import {useApp} from '../../state';
import {PageTitle} from '../../ui';

/** 展示共享规则及锚点目录，保留比赛参数和现场流程说明。 */
export function Rules() {
  const {data} = useApp();
  const parameters = data.parameters ?? DEFAULT_PARAMETERS;
  useEffect(() => {
    const topic = new URLSearchParams(location.search).get('topic');
    const id =
      location.hash.slice(1).replace(/^rule-/, 'rules-') ||
      (topic === 'sighting' ? 'rules-1' : '');
    if (id) {
      const frame = requestAnimationFrame(() =>
        document.getElementById(id)?.scrollIntoView({block: 'start'}),
      );
      return () => cancelAnimationFrame(frame);
    }
  }, [data.session?.id]);
  return (
    <>
      <PageTitle
        title="比赛规则"
        back={
          data.session?.role === 'judge'
            ? '/judge'
            : data.session
              ? '/player/me'
              : '/'
        }
      />
      <nav className="rules-directory">
        {[
          '比赛流程',
          '手环与目击',
          '母星与重生',
          '广播与光粒',
          '终局要求',
          '淘汰后观战',
          '排名与现场要求',
        ].map((s, i) => (
          <a key={s} href={`#rules-${i}`}>
            {s}
          </a>
        ))}
      </nav>
      <div className="rules-article">
        <section id="rules-0">
          <h2>比赛流程</h2>
          <p>
            领取首航配置后，在安全位置戴好手环并点击「穿戴就绪」，等待全场统一开赛。
          </p>
          <p>
            比赛使用有效比赛时间：0至65分钟为黑暗森林，65至90分钟为宇宙末日，90至98分钟转场。98分钟自动暂停进行终局资格核验，完成后恢复最后狩猎，通常进行至120分钟。完整结算后存活文明不超过一个时可以提前完赛。
          </p>
        </section>
        <section id="rules-1">
          <h2>手环与目击</h2>
          <p>
            在开赛后亲眼辨认目标两臂的当前完整颜色分组，再提交目击。七种颜色各最多使用一次。合法分组为两条与一条、两条与两条、三条与一条；同侧顺序不限，两侧可以交换。
          </p>
          <p>
            第一次提交错误的手环颜色，禁止目击攻击
            {duration(parameters.firstLockSeconds)}；第二次有
            {parameters.secondOutPercent}%的概率永久淘汰，有
            {100 - parameters.secondOutPercent}
            %的概率禁止目击攻击{duration(parameters.secondLockSeconds)}
            ；第三次永久淘汰。错误次数整场累计，重生不清零。暂时禁止目击攻击时仍可被其他人击毁。
          </p>
          <p>
            提交本人或已失效的手环颜色不增加错误次数。多人同时攻击同一目标时，成功击毁后其余攻击不增加错误次数。成功击毁后取得目标的母星坐标。不得传播他人当前手环颜色、远程猜测颜色、偷拍或放大照片录像辨认颜色。
          </p>
        </section>
        <section id="rules-2">
          <h2>母星与重生</h2>
          <p>
            第一阶段被正常目击击毁且母星尚存时，可以重生。立即摘下全部比赛手环，正常步行返航，拍摄时间水印照片并发给裁判，再离开母星至少50米、领取新配置、佩戴并确认完成出航。
          </p>
          <p>
            返航至出航全部步骤共用被击毁后{duration(parameters.respawnSeconds)}
            与比赛65:00中更早的截止，必须严格早于截止完成。次数不限，旧配置永久失效。返航途中母星毁灭或截止时未完成出航则永久淘汰。错误攻击导致的直接出局不能重生。
          </p>
          <p>
            母星毁灭时若飞船正常出航，继续最后一命。65:00所有母星毁灭，未正常出航的文明同时淘汰。
          </p>
        </section>
        <section id="rules-3">
          <h2>广播与光粒</h2>
          <p>
            第一阶段正常出航时，每个文明最多正式广播两次，可输入任意尚未正式广播的六位数字。广播消耗一次次数并公开口令；若对应某文明的登记母星，该文明私下获得广播者的母星口令。广播发布后，不会告知这组六位口令是否对应母星。
          </p>
          <p>
            每个正式广播的口令每满60秒独立接受{parameters.singerPercent}
            %的歌者首次清理检定，最多清理一次。未来清理时间不公开。
          </p>
          <p>
            技术爆炸获得者秘密得到一枚光粒，正常出航时可以消耗它清理任意六位口令。获得者正在返航时不能发射。65:00起广播和光粒停止，未使用光粒失效。
          </p>
        </section>
        <section id="rules-4">
          <h2>终局要求</h2>
          <p>
            90:00起停止目击，加入比赛QQ群位置共享，正常步行在98:00前进入终局圈。请查看QQ群文件中的
            {data.site.endgameFile}，并自行使用手机高德地图前往。
          </p>
          <p>
            比赛时间98:00暂停计时，由裁判核验入圈与共享资格。核验完成后开始最后狩猎。请持续共享位置，离圈、停止共享或定位违规将被淘汰。
          </p>
        </section>
        <section id="rules-5">
          <h2>淘汰后观战</h2>
          <p>
            永久淘汰后在安全位置摘下全部手环，步行返回中控室，停止攻防、侦察和向活人传递情报。淘汰满
            {parameters.observerWaitSeconds}
            秒后可以进入宇宙观测。
          </p>
          <p>
            你可以观察宇宙、与其他四维文明交流，并向裁判提出高维干涉建议。
            {OBSERVER_AGREEMENT_COPY}
            比赛结束后，本场参赛者可以查看完整复盘。
          </p>
        </section>
        <section id="rules-6">
          <h2>排名与现场要求</h2>
          <p>
            生存优先。幸存者按击毁的不同文明数排序；同一文明多次被击毁只计一次。淘汰者按生效时间从晚到早排列，同批淘汰并列。全体淘汰时没有存活冠军。
          </p>
          <p>
            比赛暂停时，比赛和重生倒计时也会暂停；禁止目击攻击的处罚和观战等待继续计时。所有现场移动只可正常步行，不得奔跑、进入限制区域、故意遮挡手环或干扰他人。安全或异常情况及时联系裁判。
          </p>
        </section>
      </div>
      <p className="secondary">
        当前阶段：{data.match ? STAGE_NAMES[data.match.stage] : '等待比赛安排'}
      </p>
    </>
  );
}
