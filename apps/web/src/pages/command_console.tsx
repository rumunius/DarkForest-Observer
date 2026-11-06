import {useId, useRef, useState} from 'react';
import {
  COLORS,
  type ColorId,
  type ManagementPreview,
} from '@darkforest/contracts';
import {
  COMMAND_SPECS,
  commandCompletions,
  commandSpec,
  parseCommandTree,
  type Completion,
} from '../../../../packages/contracts/src/commands';
import {useApp} from '../state';
import {Button, CutOutline, Disclosure, Field, Frame, PageTitle} from '../ui';

export function CommandConsole() {
  const {data, operate, busy} = useApp();
  const [command, setCommand] = useState('');
  const [reason, setReason] = useState('');
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [preview, setPreview] = useState<ManagementPreview | null>(null);
  const [previewCommand, setPreviewCommand] = useState('');
  const [result, setResult] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const id = useId();
  let spec;
  let syntax = '';
  try {
    if (command.trim()) {
      spec = commandSpec(parseCommandTree(command));
    }
  } catch (error) {
    syntax = error instanceof Error ? error.message : '指令格式不正确';
  }
  const direct =
    spec?.query ||
    spec?.direct ||
    ['confirm', 'plan inspect', 'plan cancel', 'request inspect'].includes(
      spec?.path ?? '',
    );
  const players = data.civilizations ?? [];
  const suggestions = dismissed
    ? []
    : commandCompletions(command, caret, players);
  const selected = Math.min(active, Math.max(0, suggestions.length - 1));
  const select = (index: number) => {
    setActive(index);
    const panel = list.current;
    const option = panel?.children[index] as HTMLElement | undefined;
    if (panel && option) {
      if (option.offsetTop < panel.scrollTop) {
        panel.scrollTop = option.offsetTop;
      }
      if (
        option.offsetTop + option.offsetHeight >
        panel.scrollTop + panel.clientHeight
      ) {
        panel.scrollTop =
          option.offsetTop + option.offsetHeight - panel.clientHeight;
      }
    }
  };
  const complete = (item: Completion) => {
    const suffix = command.slice(item.end);
    const incompleteFilter =
      item.value.includes('[') && !item.value.endsWith(']');
    const text =
      item.value + (incompleteFilter || /^\s/.test(suffix) ? '' : ' ');
    const updated = command.slice(0, item.start) + text + suffix;
    const position = item.start + text.length;
    setCommand(updated);
    setCaret(position);
    setActive(0);
    setDismissed(false);
    setPreview(null);
    requestAnimationFrame(() => {
      if (list.current) {
        list.current.scrollTop = 0;
      }
      input.current?.focus();
      input.current?.setSelectionRange(position, position);
    });
  };
  const execute = async (confirm = false) => {
    const r = await operate(
      confirm || direct ? '/judge/command/execute' : '/judge/command/preview',
      {
        command: confirm ? `/confirm ${preview!.token}` : command,
        reason,
        expected_revision: data.match!.revision,
      },
    );
    if (r?.preview) {
      setPreview(r.preview);
      setPreviewCommand(command);
    } else if (r) {
      setPreview(null);
      setResult(`${r.title}\n${r.message ?? ''}`);
    }
  };
  return (
    <>
      <PageTitle title="指令控制台" />
      <p className="secondary">
        输入“/”查看命令。多条操作请写在 batch run 操作块中。
      </p>
      <Field label="输入赛事指令">
        <textarea
          ref={input}
          className="command-input"
          value={command}
          rows={5}
          spellCheck={false}
          aria-autocomplete="list"
          aria-controls={`${id}-list`}
          aria-expanded={suggestions.length > 0}
          aria-activedescendant={
            suggestions.length ? `${id}-option-${selected}` : undefined
          }
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onSelect={e => {
            setCaret(e.currentTarget.selectionStart);
          }}
          onChange={e => {
            if (list.current) {
              list.current.scrollTop = 0;
            }
            setCommand(e.target.value);
            setCaret(e.target.selectionStart);
            setActive(0);
            setDismissed(false);
            setPreview(null);
          }}
          onKeyDown={e => {
            if (composing.current || e.nativeEvent.isComposing) {
              return;
            }
            if (e.key === 'Escape') {
              setDismissed(true);
              return;
            }
            if (!suggestions.length) {
              return;
            }
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              select(
                Math.max(
                  0,
                  Math.min(
                    suggestions.length - 1,
                    selected + (e.key === 'ArrowDown' ? 1 : -1),
                  ),
                ),
              );
            }
            if (e.key === 'Tab' && !e.shiftKey) {
              e.preventDefault();
              complete(suggestions[selected]!);
            }
          }}
          placeholder="/"
        />
      </Field>
      {suggestions.length > 0 && (
        <div className="cut command-completion" aria-label="指令补全">
          <CutOutline cut={10} />
          <div className="command-completion-heading">
            <span>候选指令</span>
            <span>
              第{selected + 1}项，共{suggestions.length}项
            </span>
          </div>
          <div
            ref={list}
            id={`${id}-list`}
            role="listbox"
            aria-label="候选指令"
            className="command-completion-list"
          >
            {suggestions.map((item, index) => (
              <button
                key={item.value}
                id={`${id}-option-${index}`}
                type="button"
                role="option"
                aria-selected={index === selected}
                className={index === selected ? 'selected' : ''}
                tabIndex={-1}
                onMouseDown={e => e.preventDefault()}
                onClick={() => complete(item)}
              >
                <code>{item.value}</code>
                <span>
                  {COLORS.some(color => color.id === item.value) && (
                    <i
                      className="command-color-swatch"
                      aria-hidden="true"
                      style={{
                        backgroundColor:
                          data.site.colors[item.value as ColorId],
                      }}
                    />
                  )}
                  {item.description}
                </span>
              </button>
            ))}
          </div>
          <p className="command-completion-footnote">
            用上下方向键选择，按 Tab 或点击候选项补全，按 Esc 收起。
            {suggestions.length > 10 && '滚轮可以浏览其余候选项。'}
          </p>
        </div>
      )}
      {spec && (
        <p className="secondary command-usage-row">
          <code className="command-usage">
            /{spec.path} {spec.args}
          </code>
          <span>{spec.description}</span>
        </p>
      )}
      {syntax && (
        <p role="status" className="secondary">
          {syntax}
        </p>
      )}
      {!spec?.query && (
        <Field label="执行原因（可选）">
          <input
            value={reason}
            placeholder="留空记录为“裁判主动干预”"
            onChange={e => {
              setReason(e.target.value);
              setPreview(null);
            }}
          />
        </Field>
      )}
      {command.trim() && !preview && (
        <Button
          className="primary"
          disabled={busy || !!syntax || !spec}
          onClick={() => execute()}
        >
          {direct ? (spec?.query ? '执行查询' : '执行指令') : '预览指令影响'}
        </Button>
      )}
      {preview && previewCommand === command && (
        <Frame>
          <h2>指令影响预览</h2>
          <p>
            <code>{preview.token}</code>
          </p>
          <pre className="command-preview">{previewCommand}</pre>
          {preview.changes.map((change, i) => (
            <div className="command-change" key={i}>
              <strong>{change.target}</strong>
              <pre>{change.before}</pre>
              <span>↓</span>
              <pre>{change.after}</pre>
            </div>
          ))}
          {preview.consequences.map((note, i) => (
            <p className="secondary" key={i}>
              {note}
            </p>
          ))}
          <Button
            className="primary"
            disabled={busy}
            onClick={() => execute(true)}
          >
            确认执行
          </Button>
          <Button
            disabled={busy}
            onClick={async () => {
              const r = await operate('/judge/command/execute', {
                command: `/plan cancel ${preview.token}`,
              });
              if (r) {
                setPreview(null);
              }
            }}
          >
            取消计划
          </Button>
        </Frame>
      )}
      {result && (
        <Frame>
          <h2>执行结果</h2>
          <pre className="command-result" aria-live="polite">
            {result}
          </pre>
        </Frame>
      )}
      <Disclosure title="完整命令目录与中文帮助">
        <div className="command-catalogue">
          {COMMAND_SPECS.map(s => (
            <button
              key={s.path}
              onClick={() => {
                const text = `/${s.path} `;
                setCommand(text);
                setCaret(text.length);
                setActive(0);
                setPreview(null);
                setDismissed(false);
                input.current?.focus();
              }}
            >
              <code>/{s.path}</code>
              <span>{s.description}</span>
            </button>
          ))}
        </div>
      </Disclosure>
    </>
  );
}
