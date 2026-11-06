import {useApp} from '../state';
import {Button} from '../ui';
/** 按裁判集合游标加载历史，保留请求期间的忙碌反馈。 */
export function RecordPagination({
  kind,
}: {
  kind: 'notices' | 'audits' | 'attacks';
}) {
  const {data, loadJudgeRecords} = useApp();
  return data.judge?.cursors?.[kind] ? (
    <Button onClick={() => void loadJudgeRecords(kind)}>加载更早记录</Button>
  ) : null;
}
