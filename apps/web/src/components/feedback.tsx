import {type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {Icon} from './icon';

/** 页面顶部反馈的内容、语气和可选关闭操作。 */
export interface FeedbackMessage {
  tone: 'error' | 'pending' | 'result';
  content: ReactNode;
  onClose?: () => void;
}

/** 通过portal展示实际操作或连接反馈，不参与战局状态计算。 */
export function Feedback({messages}: {messages: FeedbackMessage[]}) {
  if (!messages.length) {
    return null;
  }
  return createPortal(
    <div className="feedback-stack">
      {messages.map(({tone, content, onClose}, index) => (
        <div
          key={`${tone}:${index}`}
          className={`global-feedback ${tone}-feedback`}
          role={tone === 'error' ? 'alert' : 'status'}
          aria-atomic="true"
        >
          <Icon
            name={
              tone === 'error'
                ? 'alert'
                : tone === 'pending'
                  ? 'clock'
                  : 'check'
            }
            size={20}
          />
          <div>{content}</div>
          {onClose && (
            <button
              className="icon-button"
              aria-label="关闭本次操作结果"
              onClick={onClose}
            >
              <Icon name="close" size={18} />
            </button>
          )}
        </div>
      ))}
    </div>,
    document.body,
  );
}
