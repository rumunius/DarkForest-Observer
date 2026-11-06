import {Store} from '../storage/store';
export function platformStore(storage: DurableObjectStorage): Store {
  const db = new Store(storage);
  db.tx(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS platform_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS platform_accounts(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('player','staff')),name TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','active','disabled')),auth_epoch INTEGER NOT NULL DEFAULT 1,version INTEGER NOT NULL DEFAULT 1,tags TEXT NOT NULL DEFAULT '',credential_hash TEXT UNIQUE,totp_ciphertext TEXT,last_totp_step INTEGER NOT NULL DEFAULT -1,created_utc INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS platform_roles(account_id TEXT NOT NULL REFERENCES platform_accounts(id),role TEXT NOT NULL CHECK(role IN ('owner','admin','archivist')),PRIMARY KEY(account_id,role));
      CREATE TABLE IF NOT EXISTS platform_sessions(token_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES platform_accounts(id),auth_epoch INTEGER NOT NULL,csrf TEXT NOT NULL,created_utc INTEGER NOT NULL,expires INTEGER NOT NULL,reauth_utc INTEGER NOT NULL,second_factor INTEGER NOT NULL DEFAULT 0,revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS recovery_codes(account_id TEXT NOT NULL,hash TEXT NOT NULL UNIQUE,used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS invitations(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES platform_accounts(id),token_hash TEXT NOT NULL UNIQUE,expires INTEGER NOT NULL,claimed INTEGER NOT NULL DEFAULT 0,ciphertext TEXT,delivery_expires INTEGER NOT NULL,issuer TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS match_directory(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,pool_id TEXT NOT NULL DEFAULT 'default',object_name TEXT NOT NULL UNIQUE,version INTEGER NOT NULL DEFAULT 1,created_utc INTEGER NOT NULL,summary TEXT NOT NULL DEFAULT '{}',synced_utc INTEGER,recommended INTEGER NOT NULL DEFAULT 0,retention_days INTEGER NOT NULL,audit_days INTEGER NOT NULL,config TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS account_match_index(account_id TEXT NOT NULL,match_id TEXT NOT NULL REFERENCES match_directory(id),PRIMARY KEY(account_id,match_id));
      CREATE TABLE IF NOT EXISTS platform_operations(id TEXT PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,body_hash TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',created_utc INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',result TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS operation_targets(operation_id TEXT NOT NULL REFERENCES platform_operations(id),target TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',receipt TEXT NOT NULL DEFAULT '{}',PRIMARY KEY(operation_id,target));
      CREATE TABLE IF NOT EXISTS platform_audit(id TEXT PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,reason TEXT NOT NULL,utc_ms INTEGER NOT NULL,detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS platform_previews(id TEXT PRIMARY KEY,actor TEXT NOT NULL,path TEXT NOT NULL,body_hash TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS import_batches(id TEXT PRIMARY KEY,body_hash TEXT NOT NULL,result TEXT NOT NULL,actor TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS erasure_ledger(match_id TEXT PRIMARY KEY,generation INTEGER NOT NULL,scope TEXT NOT NULL,created_utc INTEGER NOT NULL,execute_after INTEGER NOT NULL,status TEXT NOT NULL,reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS retention_holds(match_id TEXT PRIMARY KEY,reason TEXT NOT NULL,actor TEXT NOT NULL,review_utc INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS archive_grants(account_id TEXT NOT NULL REFERENCES platform_accounts(id),match_id TEXT NOT NULL REFERENCES match_directory(id),expires INTEGER NOT NULL,PRIMARY KEY(account_id,match_id));
      CREATE TABLE IF NOT EXISTS platform_rate_limits(key TEXT PRIMARY KEY,bucket INTEGER NOT NULL,count INTEGER NOT NULL);
    `);
    const version = db.one<{value: string}>(
      "SELECT value FROM platform_meta WHERE key='schema'",
    );
    if (version && version.value !== '1') {
      throw new Error('PLATFORM_SCHEMA_INCOMPATIBLE');
    }
    db.exec("INSERT OR IGNORE INTO platform_meta VALUES('schema','1')");
  });
  return db;
}
