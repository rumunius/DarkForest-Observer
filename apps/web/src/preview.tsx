import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {App} from './app';
import {
  MockSource,
  PREVIEW_ROLES,
  SCENARIOS,
  type PreviewRole,
} from './dev/mock_source';
import {useApp} from './state';
import './styles.css';

const preferences = (() => {
  const params = new URLSearchParams(location.search);
  let saved: {role?: string; scenario?: string} = {};
  try {
    saved = JSON.parse(sessionStorage.getItem('darkforest.preview') ?? '{}');
  } catch {
    /* Defaults remain usable. */
  }
  const role = params.get('role') ?? saved.role ?? 'player';
  const scenario = params.get('scene') ?? saved.scenario ?? 'active';
  return {
    role: PREVIEW_ROLES.some(r => r.id === role)
      ? (role as PreviewRole)
      : ('player' as PreviewRole),
    scenario: SCENARIOS.some(s => s.id === scenario) ? scenario : 'active',
  };
})();
const source = new MockSource();
source.reset(preferences.role, preferences.scenario);
function Controls({onReset}: {onReset: () => void}) {
  const {go, refresh, logout} = useApp();
  const [role, setRole] = useState<PreviewRole>(preferences.role);
  const [scenario, setScenario] = useState(preferences.scenario);
  const [open, setOpen] = useState(false);
  const [fault, setFault] = useState('none');
  const apply = (nextRole: PreviewRole, nextScenario: string) => {
    source.reset(nextRole, nextScenario);
    setRole(nextRole);
    setScenario(nextScenario);
    setFault('none');
    try {
      sessionStorage.setItem(
        'darkforest.preview',
        JSON.stringify({role: nextRole, scenario: nextScenario}),
      );
    } catch {
      /* Optional display preference only. */
    }
    const destination =
      nextRole === 'display'
        ? '/display'
        : ['chief', 'event', 'communication'].includes(nextRole)
          ? '/judge'
          : nextRole === 'observer'
            ? '/observer'
            : '/player';
    go(destination, true);
    onReset();
  };
  return (
    <div className="preview-toolbar">
      <div className="preview-bar">
        <span className="preview-label">
          开发预览<span>模拟数据</span>
        </span>
        <label>
          角色
          <select
            value={role}
            onChange={e => {
              const next = e.target.value as PreviewRole;
              apply(next, next === 'observer' ? 'observer' : scenario);
            }}
          >
            {PREVIEW_ROLES.map(role => (
              <option key={role.id} value={role.id}>
                {role.label}
              </option>
            ))}
          </select>
        </label>
        <label className="preview-scenario">
          场景
          <select value={scenario} onChange={e => apply(role, e.target.value)}>
            {SCENARIOS.map(s => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => apply(role, scenario)}>
          重置场景
        </button>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? '收起工具' : '更多工具'}
        </button>
      </div>
      {open && (
        <div className="preview-extra">
          <label>
            下次目击结果
            <select
              onChange={e => source.setSightingResult(e.target.value)}
              defaultValue="hit"
            >
              <option value="hit">击毁成功</option>
              <option value="neutral">未产生击毁，错误次数不变</option>
              <option value="wrong">错误提交，按累计次数处罚</option>
            </select>
          </label>
          <label>
            连接与请求
            <select
              value={fault}
              onChange={e => {
                setFault(e.target.value);
                source.setFault(e.target.value);
                void refresh();
              }}
            >
              <option value="none">正常</option>
              <option value="offline">连接中断</option>
              <option value="expired">会话失效</option>
              <option value="unknown">下次提交结果待确认</option>
            </select>
          </label>
          <button type="button" onClick={() => void logout()}>
            查看进入页
          </button>
          <a href="/" target="_blank" rel="noreferrer">
            打开正式入口
          </a>
          <span>场景变化仅影响当前预览；重置可重新走流程。</span>
        </div>
      )}
    </div>
  );
}
function PreviewApp() {
  const [epoch, setEpoch] = useState(0);
  return (
    <App
      source={source}
      base="/dev-preview"
      epoch={epoch}
      preview={
        new URLSearchParams(location.search).get('tools') ===
        'hidden' ? null : (
          <Controls onReset={() => setEpoch(e => e + 1)} />
        )
      }
    />
  );
}
createRoot(document.getElementById('app')!).render(<PreviewApp />);
