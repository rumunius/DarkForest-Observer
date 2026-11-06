import { useState } from 'react';
import { useApp } from '../state';
import { Button } from '../ui';
import { ManagementForm } from './judge';
export function RecoveryTools() {
  const { data, source } = useApp(),
    [error, setError] = useState('');
  if (!data.session?.permissions.includes('system')) return null;
  return (
    <section>
      <h2>比赛恢复</h2>
      <Button
        onClick={async () => {
          try {
            const file = await source.exportData?.('checkpoint');
            if (!file) return;
            const url = URL.createObjectURL(new Blob([file.text], { type: 'application/json' })),
              a = document.createElement('a');
            a.href = url;
            a.download = file.fileName;
            a.click();
            URL.revokeObjectURL(url);
            setError('');
          } catch (e) {
            setError(e instanceof Error ? e.message : '恢复文件导出失败。');
          }
        }}
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
