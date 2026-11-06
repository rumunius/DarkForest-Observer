import {createHash} from 'node:crypto';
import {URL} from 'node:url';
export function stable(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stable).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
export function checksum(value) {
  return createHash('sha256').update(stable(value)).digest('base64');
}
export function siteUrl(value) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('请输入网站首页地址，不包含账号、路径或参数。');
  }
  if (
    url.protocol !== 'https:' &&
    !(
      ['127.0.0.1', 'localhost'].includes(url.hostname) &&
      url.protocol === 'http:'
    )
  ) {
    throw new Error('远端网站必须使用HTTPS。');
  }
  return url;
}
export function nextRecoveryAction(state) {
  if (state === 'prepared') {
    return 'save-carry';
  }
  if (state === 'saved') {
    return 'launch';
  }
  if (state === 'launch-unknown' || state === 'launched') {
    return 'status';
  }
  if (state === 'restored') {
    return 'complete';
  }
  if (state === 'complete') {
    return 'website-review';
  }
  return 'select-checkpoint';
}
export function assertReleaseSafe(diagnostics) {
  const active = diagnostics.matches.filter(match => {
    const summary =
      typeof match.summary === 'string'
        ? JSON.parse(match.summary)
        : match.summary;
    return (
      match.kind === 'official' &&
      summary.phase &&
      !['setup', 'ended'].includes(summary.phase)
    );
  });
  if (active.length) {
    throw new Error(
      `有${active.length}场正式比赛尚未完赛，请先在网站核对状态并安排维护窗口。`,
    );
  }
}
