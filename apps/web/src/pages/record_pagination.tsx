import {useApp} from '../state';
import {Button} from '../ui';
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
