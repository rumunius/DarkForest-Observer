import {type ManagementPreview} from '@darkforest/contracts';
import {useState, type ReactNode} from 'react';
import {handleAsync} from '../../data/async_event';
import {useApp} from '../../state';
import {Button, Field, Frame, Icon} from '../../ui';

/** 把管理草稿、原因和预览版本绑定，确认前草稿变化会使旧预览失效。 */
export function ManagementForm({
  title,
  path,
  payload = {},
  children,
  change,
  ready = true,
  reasonRequired = true,
  current,
}: {
  title: string;
  path: string;
  payload?: Record<string, unknown>;
  children?: ReactNode;
  change?: string;
  ready?: boolean;
  reasonRequired?: boolean;
  current?: string;
}) {
  const {reportError, operate, busy, data} = useApp();
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<ManagementPreview | null>(null);
  const [stamp, setStamp] = useState('');
  const fingerprint = JSON.stringify({payload, reason});
  const usable = ready && (!reasonRequired || !!reason.trim());
  const currentPreview = preview && stamp === fingerprint ? preview : null;
  return (
    <div className="management-form">
      <h2>{title}</h2>
      {current && <p className="secondary">当前：{current}</p>}
      {children}
      {reasonRequired && (
        <Field label="操作原因">
          <textarea
            rows={2}
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder="填写本次操作的具体原因"
          />
        </Field>
      )}
      {!currentPreview && (
        <Button
          disabled={busy || !usable}
          onClick={handleAsync(async () => {
            const r = await operate('/judge/manage/preview', {
              path,
              ...payload,
              reason,
              change: change ?? title,
              expected_revision: data.match!.revision,
            });
            if (r?.preview) {
              setPreview(r.preview);
              setStamp(fingerprint);
            }
          }, reportError)}
        >
          预览操作影响
          <Icon name="arrow" size={18} />
        </Button>
      )}
      {currentPreview && (
        <Frame className="preview-result">
          <h3>确认本次影响</h3>
          {currentPreview.changes.map((c, i) => (
            <div key={i} className="change-row">
              <strong>{c.target}</strong>
              <span>{c.before}</span>
              <Icon name="arrow" size={16} />
              <span>{c.after}</span>
            </div>
          ))}
          {currentPreview.consequences.map(c => (
            <p className="secondary" key={c}>
              {c}
            </p>
          ))}
          <Button
            className="primary full"
            disabled={busy}
            onClick={handleAsync(async () => {
              const r = await operate(path, {
                ...payload,
                reason,
                preview_token: currentPreview.token,
                expected_revision: currentPreview.revision,
              });
              if (r?.status === 'complete') {
                setPreview(null);
              }
            }, reportError)}
          >
            确认执行：{title}
          </Button>
          <button className="text-button" onClick={() => setPreview(null)}>
            取消本次预览
          </button>
        </Frame>
      )}
    </div>
  );
}
