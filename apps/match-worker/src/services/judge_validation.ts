import {
  integer,
  strict,
  text,
} from '../../../../packages/contracts/src/backend';
import {
  permission,
  requireThat,
  type Actor,
  type Parameters,
} from '../storage/store';
import {validateAccount} from './accounts';
import {correctionTarget} from './attack_correction';
import {type Engine} from './engine';
import {restoration} from './player_correction';
import {validateReportCorrection} from './report_correction';

import {
  validateHuntElimination,
  validateHuntFinalization,
  validatePause,
  validateResume,
} from './judge_clock_validation';
import {
  validateAnnouncement,
  validateDelayedAnnouncement,
  validateEventControl,
  validateEventTrigger,
  validateReplay,
  validateStatistic,
} from './judge_event_validation';
import {
  validateEffect,
  validateEquipmentCorrection,
  validateObserverAccess,
  validatePlayerCorrection,
  validatePlayerElimination,
} from './judge_player_validation';
import {
  validateArming,
  validateRoster,
  validateWithdrawal,
} from './judge_setup_validation';
import type {JudgeValidationContext} from './judge_validation_context';

const fields: Record<string, string[]> = {
  '/judge/recovery-finalize': [],
  '/judge/report-correction': ['target', 'field', 'value', 'expected_version'],
  '/judge/accounts': ['target', 'operation', 'expected_version', 'duty'],
  '/judge/arm-code-release': ['time', 'expected_roster'],
  '/judge/arm-start': ['time', 'expected_roster'],
  '/judge/pause': [],
  '/judge/resume': [],
  '/judge/hunt-finalize': ['eliminations'],
  '/judge/hunt-eliminate': ['target', 'reason_code'],
  '/judge/player-eliminate': ['target'],
  '/judge/player-restore': ['target'],
  '/judge/effects': ['target', 'seconds', 'revoke'],
  '/judge/parameters': ['values', 'expected_version'],
  '/judge/scheduler/rearm': [],
  '/judge/events/settle-due': [],
  '/judge/correction': ['target', 'field', 'value'],
  '/judge/equipment-correction': ['target', 'mode'],
  '/judge/observer-access': ['target', 'allowed'],
  '/judge/roster': ['members'],
  '/judge/announce': ['target', 'message'],
  '/judge/attack-correction': ['attack_id'],
  '/judge/event-control': ['event_id', 'operation'],
  '/judge/event-trigger': ['kind', 'code'],
  '/judge/schedule-announcement': ['seconds', 'message'],
  '/judge/reveal': ['statistic'],
  '/judge/replay': ['count'],
};

const capabilities: Record<string, string> = {
  '/judge/arm-code-release': 'clock',
  '/judge/arm-start': 'clock',
  '/judge/pause': 'clock',
  '/judge/resume': 'clock',
  '/judge/hunt-finalize': 'endgame',
  '/judge/hunt-eliminate': 'endgame',
  '/judge/player-eliminate': 'commands',
  '/judge/player-restore': 'commands',
  '/judge/event-control': 'system',
  '/judge/event-trigger': 'system',
  '/judge/effects': 'effects',
  '/judge/parameters': 'settings',
  '/judge/scheduler/rearm': 'system',
  '/judge/events/settle-due': 'system',
  '/judge/correction': 'commands',
  '/judge/equipment-correction': 'equipment',
  '/judge/observer-access': 'commands',
};

const metadata = ['request_id', 'reason', 'preview_token', 'expected_revision'];

/** 提取可审计的业务参数，剥离请求身份、确认令牌与版本元数据。 */
export function payloadOf(
  body: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body).filter(
      ([k]) =>
        ![
          'request_id',
          'preview_token',
          'expected_revision',
          'change',
          'path',
        ].includes(k),
    ),
  );
}

/** 只接收固定管理路径及受限文明退出路径，禁止任意动态动作。 */
export function recognized(path: string): boolean {
  return !!fields[path] || /^\/judge\/roster\/C\d{2,3}\/withdraw$/.test(path);
}

/** 按管理路径映射本场裁判职责，平台任职不能隐式放行。 */
export function authorize(actor: Actor, path: string): void {
  permission(
    actor,
    ['/judge/accounts', '/judge/recovery-finalize'].includes(path)
      ? 'system'
      : path === '/judge/roster'
        ? 'clock'
        : (capabilities[path] ?? 'commands'),
  );
}

/** 按具体管理动作的字段白名单拒绝多余参数。 */
export function checkSchema(path: string, body: Record<string, unknown>): void {
  strict(body, [
    ...metadata,
    ...(fields[path] ?? ['target', 'field', 'value']),
  ]);
}

/** 在最新权威状态中复核管理动作资格，预览与提交复用同一校验。 */
export function validate(
  engine: Engine,
  path: string,
  body: Record<string, unknown>,
  actor: Actor,
): void {
  const db = engine.db;
  const matchState = db.match();
  requireThat(
    !matchState.recovery_state ||
      ![
        '/judge/resume',
        '/judge/hunt-finalize',
        '/judge/arm-code-release',
        '/judge/arm-start',
        '/judge/event-trigger',
        '/judge/events/settle-due',
      ].includes(path),
    'RECOVERY_REVIEW',
    '请先完成比赛恢复核对。',
  );
  if (path === '/judge/recovery-finalize') {
    requireThat(
      matchState.recovery_state.startsWith('review:'),
      'RECOVERY_NOT_REVIEWING',
      '当前没有待核对的恢复。',
    );
    return;
  }
  if (path === '/judge/accounts') {
    validateAccount(engine, actor, body);
    return;
  }
  if (path === '/judge/report-correction') {
    permission(actor, 'commands');
    validateReportCorrection(engine, body);
    return;
  }
  const context: JudgeValidationContext = {engine, db, matchState, body};
  if (['/judge/arm-code-release', '/judge/arm-start'].includes(path)) {
    validateArming(context, path);
  } else if (path === '/judge/roster') {
    validateRoster(context);
  } else if (path === '/judge/parameters') {
    validateParameterChange(context);
  } else if (path === '/judge/pause') {
    validatePause(context);
  } else if (path === '/judge/resume') {
    validateResume(context);
  } else if (path === '/judge/hunt-finalize') {
    validateHuntFinalization(context);
  } else if (path === '/judge/hunt-eliminate') {
    validateHuntElimination(context);
  } else if (path === '/judge/player-eliminate') {
    validatePlayerElimination(context);
  } else if (path === '/judge/player-restore') {
    restoration(engine, text(body.target, 16));
  } else if (path === '/judge/effects') {
    validateEffect(context);
  } else if (path.startsWith('/judge/roster/')) {
    validateWithdrawal(context, path);
  } else if (path === '/judge/equipment-correction') {
    validateEquipmentCorrection(context);
  } else if (path === '/judge/correction') {
    validatePlayerCorrection(context);
  } else if (path === '/judge/observer-access') {
    validateObserverAccess(context);
  } else if (path === '/judge/announce') {
    validateAnnouncement(context);
  } else if (path === '/judge/attack-correction') {
    correctionTarget(engine, body.attack_id);
  } else if (path === '/judge/event-control') {
    validateEventControl(context);
  } else if (path === '/judge/event-trigger') {
    validateEventTrigger(context);
  } else if (path === '/judge/schedule-announcement') {
    validateDelayedAnnouncement(context);
  } else if (path === '/judge/reveal') {
    validateStatistic(context);
  } else if (path === '/judge/replay') {
    validateReplay(context);
  }
}
/** 核对赛前参数锁定状态及设置版本，再校验参数范围。 */
function validateParameterChange(context: JudgeValidationContext): void {
  const {db, matchState, body} = context;

  requireThat(
    matchState.phase === 'setup',
    'PARAMETERS_LOCKED',
    '比赛参数已锁定。',
  );
  requireThat(
    integer(body.expected_version, 1) ===
      db.one<{version: number}>(
        "SELECT version FROM settings WHERE key='parameters'",
      )!.version,
    'VERSION_CONFLICT',
    '参数已更新，请刷新后重新核对。',
  );
  validateParameters(body.values);
}

/** 校验赛前可配置参数的白名单与范围，锁定后的修改另受阶段限制。 */
export function validateParameters(raw: unknown): Parameters {
  const names = [
    'singerPercent',
    'firstLockSeconds',
    'secondLockSeconds',
    'secondOutPercent',
    'respawnSeconds',
    'observerWaitSeconds',
    'sightingIntervalMs',
    'sightingsPerMinute',
  ];
  const parameters = strict(raw, names);
  const read = (name: keyof Parameters) =>
    integer(
      parameters[name],
      ['singerPercent', 'secondOutPercent', 'observerWaitSeconds'].includes(
        name,
      )
        ? 0
        : 1,
      name.endsWith('Percent')
        ? 100
        : name === 'sightingsPerMinute'
          ? 120
          : name === 'sightingIntervalMs'
            ? 60000
            : 86400,
    );
  return {
    singerPercent: read('singerPercent'),
    firstLockSeconds: read('firstLockSeconds'),
    secondLockSeconds: read('secondLockSeconds'),
    secondOutPercent: read('secondOutPercent'),
    respawnSeconds: read('respawnSeconds'),
    observerWaitSeconds: read('observerWaitSeconds'),
    sightingIntervalMs: read('sightingIntervalMs'),
    sightingsPerMinute: read('sightingsPerMinute'),
  };
}
