import {useApp} from '../../state';
import {PageTitle} from '../../ui';
import {CommandConsole} from '../command_console';
import {RecoveryTools} from '../recovery';
import {AuditEntries} from './audit';
import {ManagementForm} from './management_form';

/** 提供当前裁判职责下的命令控制台入口。 */
export function Commands() {
  return (
    <>
      <CommandConsole />
      <h2>业务审计</h2>
      <AuditEntries />
    </>
  );
}

/** 展示调度积压和故障证据，修复动作仍通过权威管理服务执行。 */
export function SystemStatus() {
  const {data} = useApp();
  const scheduler = data.judge!.scheduler;
  return (
    <>
      <PageTitle title="系统状态" />
      <RecoveryTools />
      <div className="stat-lines">
        <div>
          <span>最近一次成功处理时间</span>
          <strong>
            {new Date(scheduler.lastSuccessUtcMs).toLocaleTimeString('zh-CN')}
          </strong>
        </div>
        <div>
          <span>下次自动处理时间</span>
          <strong>
            {scheduler.nextWakeUtcMs
              ? new Date(scheduler.nextWakeUtcMs).toLocaleTimeString('zh-CN')
              : '暂无待执行计划'}
          </strong>
        </div>
        <div>
          <span>已到期但尚未处理的事件</span>
          <strong>{scheduler.backlog}个事件</strong>
        </div>
        <div>
          <span>最近错误</span>
          <strong>{scheduler.error || '没有已记录错误'}</strong>
        </div>
      </div>
      <ManagementForm
        title="重新安排自动处理时间"
        path="/judge/scheduler/rearm"
        change="根据已保存的赛事计划，重新安排下次自动处理时间"
      />
      <ManagementForm
        title="结算到期事件"
        path="/judge/events/settle-due"
        change={`重新核对并结算${scheduler.backlog}个到期事件，保留原事件编号`}
      />
    </>
  );
}
