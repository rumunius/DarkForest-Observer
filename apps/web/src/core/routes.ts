import type { SessionState } from '@darkforest/contracts';
import { judgePages } from '../pages/judge';

export function pageEndpoint(path: string, search = ''): string | null {
  const q = new URLSearchParams(search);
  const tab = q.get('tab');
  const fixed: Record<string, string> = {
    '/player/homeworld': '/api/player/templates/homeworld',
    '/player/respawn': '/api/player/templates/respawn',
    '/player/records': '/api/player/records',
    '/player/intel': '/api/player/intel',
    '/player/exception': '/api/player/templates/exception',
    '/player/messages':
      tab === 'public'
        ? '/api/public/events'
        : tab === 'broadcast'
          ? '/api/public/broadcasts'
          : '/api/player/messages',
    '/observer': '/api/observer/overview',
    '/observer/civilizations': '/api/observer/civilizations',
    '/observer/events': '/api/observer/events',
    '/display': '/api/judge/display',
    '/results': '/api/results/overview',
    '/results/events': '/api/results/events',
    '/judge': '/api/judge/overview',
    '/judge/homeworlds': '/api/judge/homeworld-pending',
    '/judge/preflight': '/api/judge/preflight-roster',
    '/judge/players': '/api/judge/civilizations',
    '/judge/notices': '/api/judge/notices',
    '/judge/endgame': '/api/judge/hunt-roster',
    '/judge/clock': '/api/judge/clock',
    '/judge/equipment': '/api/judge/codebook-status',
    '/judge/system': '/api/judge/scheduler/health',
    '/judge/commands': '/api/judge/command/help',
    '/judge/effects': '/api/judge/effects',
    '/judge/events': '/api/judge/events',
    '/judge/attacks': '/api/judge/attacks',
    '/judge/audit': '/api/judge/audit',
    '/judge/results': '/api/results/overview',
    '/judge/settings': '/api/judge/templates',
  };
  let endpoint = fixed[path];
  if (!endpoint) {
    const patterns: [RegExp, string][] = [
      [/^\/player\/messages\/([^/]+)$/, '/api/player/messages/'],
      [/^\/observer\/civilizations\/([^/]+)$/, '/api/observer/civilizations/'],
      [/^\/observer\/events\/([^/]+)$/, '/api/observer/events/'],
      [/^\/results\/civilizations\/([^/]+)$/, '/api/results/civilizations/'],
      [/^\/results\/events\/([^/]+)$/, '/api/results/events/'],
      [/^\/judge\/players\/([^/]+)$/, '/api/judge/civilizations/'],
      [/^\/judge\/homeworlds\/([^/]+)$/, '/api/judge/homeworld/'],
      [/^\/judge\/notices\/([^/]+)$/, '/api/judge/notices/'],
      [/^\/judge\/attacks\/([^/]+)$/, '/api/judge/attack-review/'],
      [/^\/judge\/events\/([^/]+)$/, '/api/judge/events/'],
      [/^\/judge\/audit\/([^/]+)$/, '/api/judge/audit/'],
      [/^\/judge\/effects\/([^/]+)$/, '/api/judge/effects/'],
    ];
    for (const [pattern, prefix] of patterns) {
      const match = path.match(pattern);
      if (match) {
        endpoint = prefix + encodeURIComponent(decodeURIComponent(match[1]!));
        break;
      }
    }
  }
  if (!endpoint) return null;
  q.delete('code');
  q.delete('page');
  q.delete('preview');
  return endpoint + (q.size ? `?${q}` : '');
}
export function mayRead(path: string, s: SessionState): boolean {
  if (path === '/display') return s.role === 'judge' && s.permissions.includes('display');
  if (path.startsWith('/results')) return s.results_allowed && s.match.phase === 'ended';
  if (path.startsWith('/observer'))
    return s.role === 'player' && s.observer_allowed && s.me?.flight_status === 'eliminated';
  if (path.startsWith('/judge'))
    return (
      s.role === 'judge' &&
      (['account', 'more', 'tasks'].includes(path.split('/')[2] ?? '') ||
        s.permissions.includes(path.split('/')[2] ?? 'overview'))
    );
  if (path.startsWith('/player')) return s.role === 'player';
  return true;
}
export function knownRoute(path: string): boolean {
  if (
    [
      '/',
      '/login',
      '/judge/login',
      '/rules',
      '/player',
      '/observer',
      '/observer/civilizations',
      '/observer/events',
      '/display',
      '/results',
      '/results/events',
      '/judge/more',
      '/judge/tasks',
    ].includes(path)
  )
    return true;
  if (judgePages.some((p) => p[2] === path)) return true;
  if (
    /^\/player\/(identity|homeworld|preflight|actions|respawn|endgame|eliminated|messages|intel|me|bracelets|records|help|exception|account)$/.test(
      path,
    )
  )
    return true;
  if (/^\/player\/actions\/(sighting|broadcast|photon)$/.test(path)) return true;
  return /^\/(player\/messages|observer\/(civilizations|events)|results\/(civilizations|events)|judge\/(players|homeworlds|notices|events|attacks|audit|effects))\/[^/]+$/.test(
    path,
  );
}
