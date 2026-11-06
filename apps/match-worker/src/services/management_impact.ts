import {accountPermissions} from '../storage/store';
import {
  scalarText,
  parseJson,
} from '../../../../packages/contracts/src/backend';
import type {ManagementPreview} from '@darkforest/contracts';
import {nickname, stableJson} from '../../../../packages/contracts/src/backend';
import type {Engine} from './engine';
import {correctionTarget} from './attack_correction';
import {restoration} from './player_correction';
import {survivors} from './life';
import {DUTIES} from './accounts';
import {Fault, requireThat, type Actor, type Scheduled} from '../storage/store';
import {dueUtc} from '../scheduler/events';
import {observerAllowed} from '../projections/snapshot';

type Impact = Pick<ManagementPreview, 'changes' | 'consequences'>;
/** 根据权威状态计算管理前后变化及副作用说明，执行时仍需重新校验。 */
export function managementImpact(
  engine: Engine,
  path: string,
  body: Record<string, unknown>,
): Impact {
  const db = engine.db;
  const matchState = db.match();
  const target = scalarText(body.target ?? matchState.id);
  const changes: Impact['changes'] = [];
  const consequences: string[] = [];
  const add = (label: string, before: unknown, after: unknown) =>
    changes.push({
      target: label,
      before: typeof before === 'string' ? before : stableJson(before),
      after: typeof after === 'string' ? after : stableJson(after),
    });
  const capacity = () => {
    const remaining =
      350 -
      db.one<{count: number}>('SELECT COUNT(*) AS count FROM sighting_codes')!
        .count;
    requireThat(
      remaining > 0,
      'CODEBOOK_EXHAUSTED',
      '本场手环配置已耗尽，请暂停处置。',
    );
    add('尚可发行配置', remaining, remaining - 1);
    consequences.push(
      '旧配置永久退役；执行时从尚未发行的配置中随机签发一枚新码，佩戴核对后由裁判激活。',
    );
  };
  const restoring = (id: string) => {
    const next = restoration(engine, id);
    add(`${id}飞船`, db.flight(id).status, next.status);
    add(`${id}重生截止（有效毫秒）`, db.flight(id).deadline, next.deadline);
    add(`${id}有效淘汰记录`, '有效', '撤销并保留原记录');
    add(`${id}赛中观战`, observerAllowed(engine, db.player(id)), false);
    if (next.status === 'issued') {
      capacity();
    }
    consequences.push(
      '重新计算存活与排名资格；已传播的情报及旧通知保留，并新增资格更正通知。',
    );
  };
  const eliminating = (ids: string[]) => {
    for (const id of ids) {
      add(`${id}飞船`, db.flight(id).status, 'eliminated');
      add(
        `${id}配置`,
        db.flight(id).code_id ?? '无当前配置',
        '永久退役、清空当前引用',
      );
    }
    const left = survivors(engine).length - ids.length;
    add('存活文明', survivors(engine).length, left);
    consequences.push(
      `写入淘汰、通知与排名记录；观战等待${db.parameters().observerWaitSeconds}秒。${left <= 1 ? '本次结算将触发提前完赛、封存排名并取消剩余正赛计划。' : '比赛继续。'}`,
    );
  };
  if (path === '/judge/correction') {
    const playerState = db.player(target);
    if (body.field === 'restore') {
      restoring(target);
    } else if (body.field === 'nickname') {
      add(`${target}昵称`, playerState.nickname, nickname(body.value));
    } else if (body.field === 'photons') {
      add(`${target}光粒`, playerState.photons, Number(body.value));
      add(
        `${target}技术升级`,
        playerState.tech,
        Number(body.value) === 1 ? 1 : playerState.tech,
      );
    } else {
      add(`${target}剩余广播`, 2 - playerState.broadcasts, Number(body.value));
    }
  } else if (path === '/judge/player-restore') {
    restoring(target);
  } else if (
    path === '/judge/player-eliminate' ||
    path === '/judge/hunt-eliminate'
  ) {
    eliminating([target]);
  } else if (path === '/judge/equipment-correction') {
    const flight = db.flight(target);
    add(
      `${target}当前配置`,
      flight.code_id,
      body.mode === 'reissue' ? '新配置（执行时随机签发）' : flight.code_id,
    );
    add(
      `${target}航次`,
      flight.voyage,
      body.mode === 'reissue' ? flight.voyage + 1 : flight.voyage,
    );
    add(
      `${target}飞船`,
      flight.status,
      body.mode === 'replace'
        ? flight.status
        : body.mode === 'activate'
          ? 'active'
          : 'issued',
    );
    if (body.mode === 'reissue') {
      capacity();
    } else {
      consequences.push(
        body.mode === 'replace'
          ? '仅记录同色同款实物替换，当前码、航次及容量均保持原值。'
          : '激活当前保留配置；暂停、阶段和个人禁攻仍分别判定。',
      );
    }
  } else if (path === '/judge/attack-correction') {
    const attack = correctionTarget(engine, body.attack_id);
    const before = parseJson(attack.before_json!) as {
      wrong: number;
      lockedUntil: number;
      actorHomeDestroyed: number | null;
    };
    add('攻击记录有效性', !!attack.valid, false);
    if (attack.wrong_index !== null) {
      const control = db.one<{wrong: number; locked_until: number}>(
        'SELECT * FROM attack_controls WHERE player_id=?',
        attack.actor,
      )!;
      add(`${attack.actor}错误提交累计`, control.wrong, before.wrong);
      add(
        `${attack.actor}禁攻截止UTC`,
        control.locked_until,
        before.lockedUntil,
      );
      if (
        db.home(attack.actor)?.source ===
        `action:${attack.actor}:${attack.request_id}`
      ) {
        add(
          `${attack.actor}母星毁灭时刻`,
          db.home(attack.actor)?.destroyed_game,
          before.actorHomeDestroyed,
        );
      }
    }
    const restored =
      attack.classification === 'hit'
        ? attack.target
        : db.flight(attack.actor).status === 'eliminated'
          ? attack.actor
          : null;
    if (restored) {
      add(`${restored}飞船`, db.flight(restored).status, 'issued');
      add(
        `${restored}有效淘汰记录数`,
        db.one<{count: number}>(
          'SELECT COUNT(*) AS count FROM eliminations WHERE player_id=? AND valid=1',
          restored,
        )!.count,
        0,
      );
      add(
        `${restored}赛中观战`,
        observerAllowed(engine, db.player(restored)),
        false,
      );
      add(`${restored}重生期限`, db.flight(restored).deadline, null);
      capacity();
      consequences.push(
        '取消该文明的旧重生超时任务，赛中观战立即关闭，新增攻击更正通知。',
      );
    }
    const count = (exclude: boolean) =>
      db.one<{count: number}>(
        `SELECT COUNT(DISTINCT target) AS count FROM attacks WHERE actor=? AND classification='hit' AND valid=1${exclude ? ' AND id<>?' : ''}`,
        attack.actor,
        ...(exclude ? [attack.id] : []),
      )!.count;
    add(`${attack.actor}去重击毁`, count(false), count(true));
    consequences.push(
      '保留原攻击、既定抽签及已发通知，写入独立更正记录；已泄露情报无法收回。',
    );
  } else if (path === '/judge/accounts') {
    const accountActor = db.one<Actor>(
      'SELECT * FROM accounts WHERE id=?',
      target,
    )!;
    add(`${target}账号版本`, accountActor.version, accountActor.version + 1);
    if (body.operation === 'disable' || body.operation === 'enable') {
      add(
        `${target}账号可用`,
        !!accountActor.enabled,
        body.operation === 'enable',
      );
    } else if (body.operation === 'duty') {
      add(
        `${target}职责权限`,
        accountPermissions(accountActor),
        DUTIES[body.duty as keyof typeof DUTIES],
      );
    } else {
      add(`${target}登录口令`, '现有口令', '生成新口令并废止旧口令');
    }
    add(
      `${target}有效会话`,
      db.one<{count: number}>(
        'SELECT COUNT(*) AS count FROM sessions WHERE account_id=? AND revoked=0 AND expires>?',
        target,
        engine.now(),
      )!.count,
      0,
    );
    consequences.push(
      '撤销该账号的旧会话及管理预览；账号停用不会自动淘汰文明，赛事裁决须单独执行。口令不进入预览或普通审计。',
    );
  } else if (path === '/judge/event-control') {
    const event = db.one<Scheduled>(
      'SELECT * FROM scheduled_events WHERE id=?',
      String(body.event_id),
    )!;
    add(
      event.id,
      event.status,
      body.operation === 'cancel' ? 'cancelled' : 'settled（已结算时幂等返回）',
    );
    add(
      '事件原定时刻',
      {clock: event.clock, due: event.due},
      {clock: event.clock, due: event.due},
    );
    consequences.push(
      body.operation === 'cancel'
        ? '不回滚已发生效果；取消后不能用重试重新打开该事件。'
        : '按原ID、原时刻及队列顺序补结算；持续故障将返回失败，已结算事件不会重复执行。',
    );
    if (event.kind === 'song_visit') {
      const payload = (() => {
        try {
          return parseJson(event.payload) as {code?: string};
        } catch {
          return {};
        }
      })();
      const home = payload.code
        ? db.officialHome(payload.code, true)
        : undefined;
      if (home && body.operation === 'retry' && event.status === 'pending') {
        add(`${home.player_id}母星`, '尚存', '毁灭');
        if (
          !['active', 'eliminated'].includes(db.flight(home.player_id).status)
        ) {
          eliminating([home.player_id]);
        }
      }
    }
  } else if (path === '/judge/event-trigger') {
    const homeworld = db.officialHome(String(body.code), true);
    add('手动歌者事件', '无', {
      clock: 'game',
      due: engine.game(),
      code: body.code,
      target: homeworld?.player_id ?? null,
    });
    if (homeworld) {
      add(`${homeworld.player_id}母星`, '尚存', '毁灭');
      if (
        !['active', 'eliminated'].includes(
          db.flight(homeworld.player_id).status,
        )
      ) {
        eliminating([homeworld.player_id]);
      }
    }
    consequences.push(
      '新增独立管理来源ID，不复用已取消事件；同事务完成清理及通知。空坐标和已毁母星按未摧毁现存母星结算。',
    );
  } else if (path === '/judge/effects') {
    if (body.revoke) {
      const effect = db.one<Record<string, SqlStorageValue>>(
        'SELECT target,starts,ends,active FROM admin_effects WHERE id=?',
        scalarText(body.revoke),
      )!;
      add(scalarText(body.revoke), effect, {...effect, active: 0});
    } else {
      add('临时禁止目击', '无该项效果', {
        target,
        starts: engine.now(),
        ends: engine.now() + Number(body.seconds) * 1000,
      });
    }
    consequences.push('按真实UTC计时；不冻结比赛、不解除个人处罚或阶段限制。');
  } else if (path === '/judge/observer-access') {
    add(
      `${target}观战管理限制`,
      !!db.player(target).observer_revoked,
      !body.allowed,
    );
    add(
      `${target}当前赛中观战资格`,
      observerAllowed(engine, db.player(target)),
      observerAllowed(engine, {
        ...db.player(target),
        observer_revoked: body.allowed ? 0 : 1,
      }),
    );
    consequences.push(
      '解除管理限制仍须满足永久淘汰及真实UTC等待，不会提前授予观战资格。',
    );
  } else if (
    path === '/judge/arm-code-release' ||
    path === '/judge/arm-start'
  ) {
    const release = path.endsWith('release');
    add(
      release ? '统一发码UTC' : '统一开赛UTC',
      release ? matchState.release_at : matchState.started_at,
      body.time,
    );
    add('正式参赛名单', db.roster(), body.expected_roster);
    consequences.push(
      release
        ? '冻结本场名单和参数；到点开放领码，不提前激活攻防。'
        : '锁定统一开赛及阶段计划，秘密技术爆炸时刻在执行时生成；全部首航在T1统一激活。',
    );
  } else if (path.startsWith('/judge/roster/')) {
    const id = path.split('/')[3]!;
    add(`${id}参赛状态`, db.player(id).entry_status, 'absent');
    add(
      '正式名单',
      db.roster(),
      db.roster().filter(p => p !== id),
    );
    consequences.push(
      '当前已发配置永久退役，不能释放回码本；不参与本场后续母星匹配和排名。',
    );
  } else if (
    path === '/judge/scheduler/rearm' ||
    path === '/judge/events/settle-due'
  ) {
    const pending = db.all<Scheduled>(
      "SELECT * FROM scheduled_events WHERE status='pending'",
    );
    const due = pending.filter(event => {
      const utc = dueUtc(engine, event);
      return utc !== null && utc <= engine.now();
    });
    add(
      '到期事件',
      due.map(event => event.id),
      path.endsWith('rearm')
        ? '核查并重新登记最近唤醒'
        : '按顺序逐项结算，遇到故障返回失败',
    );
    consequences.push(
      '保留原事件ID、原定生效时间和已有结算；不重抽既定随机结果。实际处理数量与剩余积压由返回结果提供。',
    );
  } else if (path === '/judge/recovery-finalize') {
    add('恢复核对状态', matchState.recovery_state, '核对完成');
    consequences.push('结束恢复审查；保持当前暂停，仍需单独确认恢复计时。');
  } else if (path === '/judge/report-correction') {
    const row =
      body.field === 'attack_valid'
        ? db.one<Record<string, SqlStorageValue>>(
            'SELECT valid,actor,target FROM attacks WHERE id=?',
            target,
          )
        : body.field === 'nickname'
          ? {nickname: db.player(target).nickname}
          : db.all<Record<string, SqlStorageValue>>(
              'SELECT seq,valid FROM eliminations WHERE player_id=?',
              target,
            );
    add(`${target}战报事实`, row, {field: body.field, value: body.value});
    add('战报版本', body.expected_version, Number(body.expected_version) + 1);
    consequences.push(
      '重算排名并保存新版本，保留旧战报及更正原因；不重新开赛或复用历史手环码。',
    );
  } else if (path === '/judge/reveal') {
    const value =
      body.statistic === 'alive_homeworlds'
        ? db.one<{count: number}>(
            "SELECT COUNT(*) AS count FROM homeworlds WHERE status='verified' AND destroyed_game IS NULL AND player_id IN (SELECT player_id FROM roster_members)",
          )!.count
        : body.statistic === 'unused_photoids'
          ? db.one<{count: number}>(
              "SELECT COALESCE(SUM(p.photons),0) AS count FROM players p JOIN flights f ON f.player_id=p.id WHERE p.entry_status='registered' AND f.status!='eliminated' AND p.id IN (SELECT player_id FROM roster_members)",
            )!.count
          : db.one<{count: number}>(
              "SELECT COUNT(*) AS count FROM attacks WHERE classification='hit' AND valid=1 AND game_ms>?",
              engine.game() - 600000,
            )!.count;
    add('拟公开的实时统计', '尚未发布本次统计', {
      statistic: body.statistic,
      value,
    });
    consequences.push(
      '执行时重新读取权威统计；产生群公告待办，不消耗正式广播额度或安排歌者。',
    );
  } else if (path === '/judge/replay') {
    const rows = db.all<Record<string, SqlStorageValue>>(
      'SELECT id,title,body,code FROM event_log WHERE audience=? ORDER BY seq DESC LIMIT ?',
      'public',
      Number(body.count),
    );
    add('拟重播的公开事件', '未创建本次重播待办', rows);
    consequences.push('只为已公布事件创建重播通知，不再次执行事件效果。');
  } else if (
    ['/judge/announce', '/judge/schedule-announcement'].includes(path)
  ) {
    add('消息或公开统计', '尚未发布本次消息', {
      target,
      message: body.message ?? null,
      statistic: body.statistic ?? null,
      replayCount: body.count ?? null,
      delaySeconds: body.seconds ?? 0,
    });
    consequences.push(
      '生成独立公告或通知待办，不消耗玩家广播额度、不安排歌者；复制与QQ发送仍须分别记录。',
    );
  } else {
    throw new Fault(
      501,
      'PREVIEW_NOT_IMPLEMENTED',
      '该操作的业务预览尚未实现，已阻止执行。',
    );
  }
  return {changes, consequences};
}

/** Restricted business audit. Authentication material and cryptographic code indexes are excluded. */
export function managementState(engine: Engine): Record<string, unknown> {
  const db = engine.db;
  return {
    match: db.one<Record<string, SqlStorageValue>>(
      'SELECT id,phase,revision,paused_at,paused_total,pause_reason,release_at,started_at,hunt_finalized,ended_game,ended_utc,finish_reason,recovery_state,site_json FROM matches',
    ),
    roster: db.roster(),
    players: db.all<Record<string, SqlStorageValue>>(
      'SELECT * FROM players ORDER BY id',
    ),
    homes: db.all<Record<string, SqlStorageValue>>(
      'SELECT * FROM homeworlds ORDER BY player_id',
    ),
    flights: db.all<Record<string, SqlStorageValue>>(
      'SELECT * FROM flights ORDER BY player_id',
    ),
    codes: db.all<Record<string, SqlStorageValue>>(
      'SELECT id,player_id,voyage,status,issued_utc,activated_utc,activated_game,retired_utc,retired_game,retired_reason FROM sighting_codes ORDER BY issued_utc,id',
    ),
    eliminations: db.all<Record<string, SqlStorageValue>>(
      'SELECT * FROM eliminations ORDER BY seq',
    ),
    attacks: db.all<Record<string, SqlStorageValue>>(
      'SELECT id,actor,target,classification,valid,wrong_index,game_ms FROM attacks ORDER BY rowid',
    ),
    controls: db.all<Record<string, SqlStorageValue>>(
      'SELECT * FROM attack_controls ORDER BY player_id',
    ),
    scheduled: db.all<Record<string, SqlStorageValue>>(
      'SELECT * FROM scheduled_events ORDER BY id',
    ),
    effects: db.all<Record<string, SqlStorageValue>>(
      'SELECT * FROM admin_effects ORDER BY id',
    ),
    notices: db.all<Record<string, SqlStorageValue>>(
      'SELECT id,target,status,version,copied_by,copied_utc,sent_by,sent_utc,error FROM notice_queue ORDER BY ordering_seq',
    ),
    accounts: db.all<Record<string, SqlStorageValue>>(
      'SELECT id,role,enabled,version,permissions FROM accounts ORDER BY id',
    ),
    sessions: db.all<Record<string, SqlStorageValue>>(
      'SELECT account_id,COUNT(*) AS active FROM sessions WHERE revoked=0 AND expires>? GROUP BY account_id',
      engine.now(),
    ),
    parameters: db.parameters(),
    reports: db.all<Record<string, SqlStorageValue>>(
      'SELECT version,reason,correction_reason FROM result_reports ORDER BY version',
    ),
  };
}
