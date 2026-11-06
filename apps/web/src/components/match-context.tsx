import { createContext, useContext, type MouseEvent } from 'react';
import type { MatchEntry } from '@darkforest/contracts';
import { useApp } from '../state';
import { judgeCan } from '../permissions';

export type MatchContext = { entry: MatchEntry; audience: 'player' | 'staff' };
const Context = createContext<MatchContext | null>(null);
export const MatchContextProvider = Context.Provider;

export function MatchHeading() {
  const context = useContext(Context);
  if (!context) return null;
  return (
    <header className="match-heading">
      <strong>{context.entry.name}</strong>
      {/* <span>{context.entry.kind === 'trial' ? '试玩' : '正式比赛'}</span> */}
    </header>
  );
}

export function MatchLinks() {
  const context = useContext(Context);
  const { data, pending } = useApp();
  if (!context) return null;
  const { entry, audience } = context;
  const leave = (event: MouseEvent<HTMLAnchorElement>) => {
    if (pending) {
      event.preventDefault();
      alert('请先在本场查询原操作结果，取得确定结论后再切换页面。');
    }
  };
  return (
    <section className="match-account-links" aria-label="比赛与账号">
      <h2>比赛与账号</h2>
      <p>
        {entry.name}，{entry.kind === 'trial' ? '试玩' : '正式比赛'}
      </p>
      <a className="row-link" href={`/matches?audience=${audience}`} onClick={leave}>
        切换比赛
      </a>
      <a className="row-link" href={`/account?audience=${audience}`} onClick={leave}>
        账号与安全
      </a>
      {judgeCan(data, 'clock') && (
        <a className="row-link" href={`/m/${entry.id}/manage`} onClick={leave}>
          本场成员与裁判岗位
        </a>
      )}
      {data.match?.stage === 'ended' && (
        <a
          className="row-link"
          href={`/m/${entry.id}/history?audience=${audience}`}
          onClick={leave}
        >
          赛后资料
        </a>
      )}
    </section>
  );
}
