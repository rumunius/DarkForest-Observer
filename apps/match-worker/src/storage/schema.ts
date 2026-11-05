export const SCHEMA_VERSION = 6;
/** All statements are static. Platform migration tags are independent of this version. */
const migration1 = `
CREATE TABLE matches (
 id TEXT PRIMARY KEY, phase TEXT NOT NULL DEFAULT 'setup' CHECK(phase IN ('setup','armed','outfitting','start_countdown','forest','apocalypse','transfer','hunt','ended')),
 revision INTEGER NOT NULL DEFAULT 1, scheduler_revision INTEGER NOT NULL DEFAULT 0,
 release_at INTEGER, started_at INTEGER, start_settled INTEGER,
 paused_at INTEGER, paused_total INTEGER NOT NULL DEFAULT 0, pause_reason TEXT NOT NULL DEFAULT '', hunt_finalized INTEGER,
 ended_game INTEGER, ended_utc INTEGER, finish_reason TEXT NOT NULL DEFAULT '',
 key_fingerprint TEXT NOT NULL, site_json TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE accounts (id TEXT PRIMARY KEY, match_id TEXT NOT NULL REFERENCES matches(id), role TEXT NOT NULL CHECK(role IN ('player','judge')), name TEXT NOT NULL, credential_hash TEXT NOT NULL UNIQUE, permissions TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)));
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), csrf TEXT NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)));
CREATE INDEX session_account ON sessions(account_id);
CREATE TABLE players (id TEXT PRIMARY KEY REFERENCES accounts(id), nickname TEXT UNIQUE, entry_status TEXT NOT NULL DEFAULT 'registered' CHECK(entry_status IN ('registered','withdrawn','absent')), tech INTEGER NOT NULL DEFAULT 0 CHECK(tech IN (0,1)), photons INTEGER NOT NULL DEFAULT 0 CHECK(photons IN (0,1)), broadcasts INTEGER NOT NULL DEFAULT 0 CHECK(broadcasts BETWEEN 0 AND 2), observer_revoked INTEGER NOT NULL DEFAULT 0 CHECK(observer_revoked IN (0,1)));
CREATE TABLE homeworlds (player_id TEXT PRIMARY KEY REFERENCES players(id), code TEXT NOT NULL CHECK(length(code)=6 AND code NOT GLOB '*[^0-9]*'), status TEXT NOT NULL CHECK(status IN ('pending','verified','rejected')), version INTEGER NOT NULL CHECK(version>=1), rejection TEXT NOT NULL DEFAULT '', verified_by TEXT REFERENCES accounts(id), destroyed_game INTEGER, source TEXT);
CREATE UNIQUE INDEX verified_coordinate ON homeworlds(code) WHERE status='verified';
CREATE TABLE sighting_codes (id TEXT PRIMARY KEY, player_id TEXT NOT NULL REFERENCES players(id), voyage INTEGER NOT NULL, mac TEXT NOT NULL UNIQUE, ciphertext TEXT NOT NULL, key_version INTEGER NOT NULL DEFAULT 1 CHECK(key_version=1), status TEXT NOT NULL CHECK(status IN ('reserved','active','retired')), issued_utc INTEGER NOT NULL, activated_utc INTEGER, activated_game INTEGER, retired_utc INTEGER, retired_game INTEGER, retired_reason TEXT, request_id TEXT NOT NULL, UNIQUE(player_id,request_id));
CREATE UNIQUE INDEX one_live_code ON sighting_codes(player_id) WHERE status IN ('reserved','active');
CREATE TABLE flights (player_id TEXT PRIMARY KEY REFERENCES players(id), status TEXT NOT NULL DEFAULT 'prelaunch' CHECK(status IN ('prelaunch','staged','outfitting','ready','active','returning','preparing','issued','eliminated')), voyage INTEGER NOT NULL DEFAULT 0, code_id TEXT REFERENCES sighting_codes(id), departed INTEGER, staged INTEGER, ready INTEGER, deadline INTEGER);
CREATE TABLE attack_controls (player_id TEXT PRIMARY KEY REFERENCES players(id), wrong INTEGER NOT NULL DEFAULT 0 CHECK(wrong BETWEEN 0 AND 3), locked_until INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, last_at INTEGER);
CREATE TABLE attacks (id TEXT PRIMARY KEY, actor TEXT NOT NULL REFERENCES players(id), target TEXT REFERENCES players(id), code_id TEXT REFERENCES sighting_codes(id), request_id TEXT NOT NULL, classification TEXT NOT NULL, roll INTEGER CHECK(roll BETWEEN 0 AND 99), wrong_index INTEGER, edge_utc INTEGER NOT NULL, committed_utc INTEGER NOT NULL, game_ms INTEGER NOT NULL, valid INTEGER NOT NULL DEFAULT 1 CHECK(valid IN (0,1)), UNIQUE(actor,request_id));
CREATE UNIQUE INDEX one_hit ON attacks(code_id) WHERE classification='hit' AND valid=1;
CREATE TABLE intel_grants (id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES players(id), target TEXT NOT NULL REFERENCES players(id), code TEXT NOT NULL, source TEXT NOT NULL, game_ms INTEGER NOT NULL, UNIQUE(owner,target,source));
CREATE TABLE eliminations (seq INTEGER PRIMARY KEY AUTOINCREMENT, player_id TEXT NOT NULL REFERENCES players(id), game_ms INTEGER NOT NULL, utc_ms INTEGER NOT NULL, committed_utc INTEGER NOT NULL, reason TEXT NOT NULL, source TEXT NOT NULL, group_id TEXT NOT NULL, valid INTEGER NOT NULL DEFAULT 1 CHECK(valid IN (0,1)));
CREATE UNIQUE INDEX one_elimination ON eliminations(player_id) WHERE valid=1;
CREATE TABLE scheduled_events (id TEXT PRIMARY KEY, kind TEXT NOT NULL, clock TEXT NOT NULL CHECK(clock IN ('game','utc')), due INTEGER NOT NULL, priority INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','settled','cancelled')), payload TEXT NOT NULL, committed_utc INTEGER);
CREATE INDEX due_events ON scheduled_events(status,clock,due,priority,id);
CREATE TABLE event_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, audience TEXT NOT NULL CHECK(audience IN ('public','personal','global')), owner TEXT REFERENCES players(id), civilization_ids TEXT NOT NULL, code TEXT, actor TEXT, game_ms INTEGER NOT NULL, utc_ms INTEGER NOT NULL, committed_utc INTEGER NOT NULL);
CREATE TABLE broadcasts (id TEXT PRIMARY KEY REFERENCES event_log(id), actor TEXT NOT NULL REFERENCES players(id), code TEXT NOT NULL UNIQUE, song_due INTEGER, singer_status TEXT NOT NULL CHECK(singer_status IN ('pending','not_selected','settled')));
CREATE TABLE photon_shots (id TEXT PRIMARY KEY REFERENCES event_log(id), actor TEXT NOT NULL REFERENCES players(id), code TEXT NOT NULL, target TEXT REFERENCES players(id));
CREATE TABLE notice_queue (id TEXT PRIMARY KEY, dedup_key TEXT NOT NULL UNIQUE, channel TEXT NOT NULL CHECK(channel IN ('private','group')), target TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, game_ms INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','copied','sent','error')), version INTEGER NOT NULL DEFAULT 1, operator TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '');
CREATE TABLE request_journal (actor TEXT NOT NULL REFERENCES accounts(id), request_id TEXT NOT NULL, path TEXT, digest TEXT, result_json TEXT NOT NULL, cancelled INTEGER NOT NULL DEFAULT 0 CHECK(cancelled IN (0,1)), PRIMARY KEY(actor,request_id));
CREATE TABLE previews (token TEXT PRIMARY KEY, actor TEXT NOT NULL REFERENCES accounts(id), path TEXT NOT NULL, payload TEXT NOT NULL, revision INTEGER NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0 CHECK(used IN (0,1)));
CREATE TABLE audit_logs (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, reason TEXT NOT NULL, utc_ms INTEGER NOT NULL, detail TEXT NOT NULL);
CREATE TABLE clock_pauses (id INTEGER PRIMARY KEY AUTOINCREMENT, opened INTEGER NOT NULL, closed INTEGER, reason TEXT NOT NULL, actor TEXT NOT NULL);
CREATE UNIQUE INDEX one_pause ON clock_pauses((1)) WHERE closed IS NULL;
CREATE TABLE scheduler_health (id INTEGER PRIMARY KEY CHECK(id=1), last_success INTEGER NOT NULL DEFAULT 0, next_wake INTEGER, error TEXT NOT NULL DEFAULT '');
INSERT INTO scheduler_health(id) VALUES(1);
CREATE TABLE admin_effects (id TEXT PRIMARY KEY, target TEXT NOT NULL, starts INTEGER NOT NULL, ends INTEGER NOT NULL CHECK(ends>starts), reason TEXT NOT NULL, operator TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)));
CREATE TABLE result_reports (version INTEGER PRIMARY KEY, reason TEXT NOT NULL, created_utc INTEGER NOT NULL, report TEXT NOT NULL);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY, bucket INTEGER NOT NULL, count INTEGER NOT NULL CHECK(count>0));
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
INSERT INTO settings(key,value) VALUES('parameters','{}');
`;
export function migrate(storage: DurableObjectStorage): void {
  storage.transactionSync(() => {
    const sql = storage.sql;
    sql.exec('PRAGMA foreign_keys = ON');
    sql.exec(
      'CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)',
    );
    const version = sql
      .exec<{ version: number }>('SELECT COALESCE(MAX(version),0) AS version FROM schema_meta')
      .one().version;
    if (version > SCHEMA_VERSION) throw new Error('SCHEMA_NEWER_THAN_CODE');
    if (version === 0) {
      sql.exec(migration1);
      sql.exec('INSERT INTO schema_meta VALUES (?, ?)', 1, Date.now());
    }
    if (version < 2) {
      sql.exec(
        'ALTER TABLE matches ADD COLUMN participant_count INTEGER NOT NULL DEFAULT 2 CHECK(participant_count BETWEEN 2 AND 350)',
      );
      sql.exec(
        "UPDATE matches SET participant_count=MAX(2,(SELECT COUNT(*) FROM players WHERE entry_status='registered'))",
      );
      sql.exec('CREATE TABLE roster_members (player_id TEXT PRIMARY KEY REFERENCES players(id))');
      sql.exec("INSERT INTO roster_members SELECT id FROM players WHERE entry_status='registered'");
      sql.exec('INSERT INTO schema_meta VALUES(2,?)', Date.now());
    }
    if (version < 3) {
      sql.exec('ALTER TABLE matches DROP COLUMN participant_count');
      sql.exec('INSERT INTO schema_meta VALUES(3,?)', Date.now());
    }
    if (version < 4) {
      sql.exec('ALTER TABLE attacks ADD COLUMN before_json TEXT');
      sql.exec(
        'CREATE TABLE attack_corrections (id TEXT PRIMARY KEY, attack_id TEXT NOT NULL UNIQUE REFERENCES attacks(id), actor TEXT NOT NULL REFERENCES accounts(id), reason TEXT NOT NULL, utc_ms INTEGER NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL)',
      );
      sql.exec('INSERT INTO schema_meta VALUES(4,?)', Date.now());
    }
    if (version < 5) {
      sql.exec("ALTER TABLE matches ADD COLUMN recovery_state TEXT NOT NULL DEFAULT ''");
      sql.exec('ALTER TABLE accounts ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
      sql.exec("ALTER TABLE result_reports ADD COLUMN correction_reason TEXT NOT NULL DEFAULT ''");
      sql.exec('ALTER TABLE result_reports ADD COLUMN snapshot_json TEXT');
      sql.exec('ALTER TABLE notice_queue ADD COLUMN ordering_seq INTEGER');
      sql.exec('UPDATE notice_queue SET ordering_seq=rowid');
      sql.exec('CREATE UNIQUE INDEX notice_order ON notice_queue(ordering_seq)');
      sql.exec(
        'CREATE TABLE recovery_log(id TEXT PRIMARY KEY, state TEXT NOT NULL, created_utc INTEGER NOT NULL, detail TEXT NOT NULL)',
      );
      sql.exec(
        'CREATE TABLE credential_deliveries(id TEXT PRIMARY KEY, actor TEXT NOT NULL REFERENCES accounts(id), account_id TEXT NOT NULL REFERENCES accounts(id), ciphertext TEXT NOT NULL, created_utc INTEGER NOT NULL)',
      );
      sql.exec('INSERT INTO schema_meta VALUES(5,?)', Date.now());
    }
    if (version < 6) {
      sql.exec('ALTER TABLE scheduled_events ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0');
      sql.exec('ALTER TABLE scheduled_events ADD COLUMN last_attempt_utc INTEGER');
      sql.exec("ALTER TABLE scheduled_events ADD COLUMN last_error TEXT NOT NULL DEFAULT ''");
      sql.exec('ALTER TABLE scheduled_events ADD COLUMN last_error_utc INTEGER');
      sql.exec('ALTER TABLE notice_queue ADD COLUMN copied_by TEXT');
      sql.exec('ALTER TABLE notice_queue ADD COLUMN copied_utc INTEGER');
      sql.exec('ALTER TABLE notice_queue ADD COLUMN sent_by TEXT');
      sql.exec('ALTER TABLE notice_queue ADD COLUMN sent_utc INTEGER');
      sql.exec('ALTER TABLE notice_queue ADD COLUMN priority INTEGER NOT NULL DEFAULT 0');
      sql.exec(
        "UPDATE notice_queue SET priority=CASE title WHEN '永久淘汰' THEN 100 WHEN '飞船被击毁' THEN 90 WHEN '母星毁灭' THEN 80 ELSE 0 END",
      );
      sql.exec('CREATE INDEX notice_pending ON notice_queue(status,priority,ordering_seq)');
      sql.exec('ALTER TABLE audit_logs ADD COLUMN game_ms INTEGER');
      sql.exec('ALTER TABLE previews ADD COLUMN impact TEXT');
      sql.exec(
        'CREATE TABLE notice_actions (id TEXT PRIMARY KEY, notice_id TEXT NOT NULL REFERENCES notice_queue(id), actor TEXT NOT NULL, action TEXT NOT NULL, utc_ms INTEGER NOT NULL, detail TEXT NOT NULL)',
      );
      sql.exec(
        'CREATE TABLE judge_eliminations (source TEXT NOT NULL, player_id TEXT NOT NULL REFERENCES players(id), before_json TEXT NOT NULL, PRIMARY KEY(source,player_id))',
      );
      sql.exec('INSERT INTO schema_meta VALUES(6,?)', Date.now());
    }
    if (sql.exec<{ foreign_keys: number }>('PRAGMA foreign_keys').one().foreign_keys !== 1)
      throw new Error('FOREIGN_KEYS_DISABLED');
  });
}
