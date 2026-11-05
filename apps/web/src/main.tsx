import { createRoot } from 'react-dom/client';
import { MatchApp, PlatformApp } from './platform';
import './styles.css';

const match = /^\/m\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(location.pathname);
createRoot(document.getElementById('app')!).render(
  match ? <MatchApp id={match[1]!} /> : <PlatformApp />,
);
