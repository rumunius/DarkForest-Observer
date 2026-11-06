import {useState} from 'react';
import {handleAsync} from '../../data/async_event';
import {judgeCan} from '../../permissions';
import {useApp} from '../../state';
import {Button, Empty, Field, Icon, Link, PageTitle} from '../../ui';
import {ReportCorrection} from '../report_correction';
import {requireError} from '@darkforest/contracts';

/** 下载和展示赛事结果及版本，更正另经专用流程保存依据。 */
export function ResultsManagement() {
  const {reportError, data, source} = useApp();
  const [kind, setKind] = useState('report');
  const [exportError, setExportError] = useState('');
  const exportData = async () => {
    if (source.exportData) {
      try {
        const file = await source.exportData(kind);
        const url = URL.createObjectURL(
          new Blob([file.text], {type: 'application/json'}),
        );
        const link = document.createElement('a');
        link.href = url;
        link.download = file.fileName;
        link.click();
        URL.revokeObjectURL(url);
        setExportError('');
      } catch (error) {
        setExportError(requireError(error).message);
      }
      return;
    }
    const object =
      kind === 'report'
        ? {
            version: data.results?.version,
            reason: data.results?.reason,
            standings: data.results?.standings.map(c => ({
              id: c.id,
              nickname: c.nickname,
              rank: c.rank,
              kills: c.kills,
            })),
            events: data.events.filter(e => e.audience === 'public'),
          }
        : {audits: data.judge?.audits};
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(object, null, 2)], {type: 'application/json'}),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = kind === 'report' ? '正式战报.json' : '裁判操作记录.json';
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <>
      <PageTitle title="比赛结果管理" />
      <ReportCorrection />
      {data.match!.stage === 'ended' ? (
        <>
          <h2>{data.results?.reason ?? '比赛已结束'}</h2>
          <Link className="text-link" to="/results">
            查看正式结果与完整复盘
            <Icon name="arrow" size={18} />
          </Link>
          <Field label="导出内容">
            <select value={kind} onChange={e => setKind(e.target.value)}>
              <option value="report">正式战报，不含秘密历史与内部审计</option>
              <option value="audit">裁判操作记录，仅限授权人员</option>
            </select>
          </Field>
          <Button onClick={() => void exportData()}>
            导出{kind === 'report' ? '正式战报' : '裁判操作记录'}
          </Button>
        </>
      ) : (
        <Empty title="当前尚未正式完赛" to="/judge">
          比赛结束后可查看并导出正式结果。
        </Empty>
      )}
      {judgeCan(data, 'system') && (
        <>
          <p className="attention" role="status">
            {exportError}
          </p>
          <Button
            onClick={handleAsync(async () => {
              try {
                const file = await source.exportData?.('backup');
                if (!file) {
                  return;
                }
                const url = URL.createObjectURL(
                  new Blob([file.text], {type: 'application/json'}),
                );
                const link = document.createElement('a');
                link.href = url;
                link.download = file.fileName;
                link.click();
                URL.revokeObjectURL(url);
                setExportError('');
              } catch (error) {
                setExportError(requireError(error).message);
              }
            }, reportError)}
          >
            导出加密备份
          </Button>
        </>
      )}
    </>
  );
}
