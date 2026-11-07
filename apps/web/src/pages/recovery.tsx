import {handleAsync} from '../data/async_event';
import {useState} from 'react';
import {useApp} from '../state';
import {Button} from '../ui';
import {ManagementForm} from './judge';
import {requireError} from '@darkforest/contracts';

/** 展示受限检查点和恢复核对流程，要求保存材料及证据后再继续。 */
export function RecoveryTools() {
  const {reportError, data, source} = useApp();
  const [error, setError] = useState('');
  if (!data.session?.permissions.includes('system')) {
    return null;
  }
  return (
    <section>
      <h2>比赛恢复</h2>
      <Button
        onClick={handleAsync(async () => {
          try {
            const file = await source.exportData?.('checkpoint');
            if (!file) {
              return;
            }
            const url = URL.createObjectURL(
              new Blob([file.text], {type: 'application/json'}),
            );
            const a = document.createElement('a');
            a.href = url;
            a.download = file.fileName;
            a.click();
            URL.revokeObjectURL(url);
            setError('');
          } catch (e) {
            setError(requireError(e).message);
          }
        }, reportError)}
      >
        保存恢复检查点
      </Button>
      {data.match?.recoveryReview && (
        <ManagementForm title="完成恢复核对" path="/judge/recovery-finalize" />
      )}
      {error && <p role="status">{error}</p>}
    </section>
  );
}
