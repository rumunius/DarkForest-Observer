import {COLORS, type Arms} from '@darkforest/contracts';
import {useEffect, useId, useRef, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {attackWarning} from '../rule_text';
import {useApp} from '../state';
import {Button, Frame} from './cut_frame';

/** 提供原生模态确认和关闭后的焦点恢复，业务权限由调用方决定。 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef(document.activeElement);
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    const element = dialog.current!;
    const trigger = returnFocus.current;
    element.showModal();
    return () => {
      element.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) {
        trigger.focus({preventScroll: true});
      }
    };
  }, []);
  return createPortal(
    <dialog
      ref={dialog}
      className="confirmation-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={event => {
        event.preventDefault();
        onCancel();
      }}
    >
      <Frame>
        <h2 id={titleId}>{title}</h2>
        <div id={descriptionId}>{children}</div>
        <div className="confirmation-actions">
          <Button autoFocus onClick={onCancel}>
            取消
          </Button>
          <Button className="danger" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </Frame>
    </dialog>,
    document.body,
  );
}

/** 确认当前有效目击草稿并显示适用处罚说明，不自行判定命中。 */
export function AttackConfirmation({
  arms,
  wrong,
  onCancel,
  onConfirm,
}: {
  arms: Arms;
  wrong: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const {data, names} = useApp();
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="attack-dialog"
      aria-labelledby="attack-confirm-title"
      onCancel={event => {
        event.preventDefault();
        onCancel();
      }}
    >
      <Frame>
        <h2 id="attack-confirm-title">确认提交这组手环？</h2>
        {arms.map((arm, index) => (
          <div className="confirmation-arm" key={index}>
            <span>{index ? '另一侧手臂' : '一侧手臂'}</span>
            <div>
              {COLORS.filter(color => arm.includes(color.id)).map(color => (
                <span key={color.id}>
                  <span
                    className="mini-band"
                    style={{backgroundColor: data.site.colors[color.id]}}
                    role="img"
                    aria-label={color.name}
                  />
                  {names && <small>{color.name}</small>}
                </span>
              ))}
            </div>
          </div>
        ))}
        <p className="secondary">
          请确认这是你在现场亲眼观察到的对手两臂完整手环颜色。
        </p>
        <p className="attention">{attackWarning(wrong, data.parameters)}</p>
        <div className="confirmation-actions">
          <Button autoFocus onClick={onCancel}>
            返回检查
          </Button>
          <Button className="primary attack-submit" onClick={onConfirm}>
            确认提交攻击
          </Button>
        </div>
      </Frame>
    </dialog>
  );
}
