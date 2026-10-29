export const SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS users(
    telegram_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS sales(
    id INTEGER PRIMARY KEY,
    buyer_id INTEGER NOT NULL,
    course_id TEXT NOT NULL,
    creator_id TEXT NOT NULL,
    price_toman INTEGER NOT NULL CHECK(price_toman > 0),
    creator_share_toman INTEGER NOT NULL,
    platform_share_toman INTEGER NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('zarinpal','zibal','manual_receipt','demo')),
    payment_ref TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS purchases(
    buyer_id INTEGER NOT NULL,
    course_id TEXT NOT NULL,
    sale_id INTEGER NOT NULL REFERENCES sales(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY(buyer_id, course_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS creator_ledger(
    id INTEGER PRIMARY KEY,
    creator_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('sale_credit','payout_hold','payout_paid','payout_release','adjustment')),
    amount_toman INTEGER NOT NULL,
    ref TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(kind, ref)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS ledger_creator ON creator_ledger(creator_id);

  CREATE TABLE IF NOT EXISTS payment_intents(
    authority TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    course_id TEXT NOT NULL,
    amount_toman INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('created','redirected','verifying','settled','failed','expired')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS payouts(
    payout_id TEXT PRIMARY KEY,
    creator_id TEXT NOT NULL,
    sheba TEXT NOT NULL,
    amount_toman INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  ) STRICT;

  CREATE TABLE IF NOT EXISTS receipts(
    receipt_id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    course_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  ) STRICT;

  CREATE TABLE IF NOT EXISTS ai_usage(
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    course_id TEXT NOT NULL,
    queries_count INTEGER NOT NULL DEFAULT 0,
    bonus_quota INTEGER NOT NULL DEFAULT 0,
    last_chat_at INTEGER,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, course_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS progress(
    user_id INTEGER NOT NULL,
    course_id TEXT NOT NULL,
    review_count INTEGER NOT NULL DEFAULT 0,
    known_count INTEGER NOT NULL DEFAULT 0,
    total_cards INTEGER NOT NULL DEFAULT 0,
    pending_cards_json TEXT,
    last_sync_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, course_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS reports(
    report_id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    claim TEXT NOT NULL,
    proposed_fix TEXT,
    learned_rule TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending_admin','approved','rejected')),
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  ) STRICT;

  CREATE TABLE IF NOT EXISTS learned_rules(
    id INTEGER PRIMARY KEY,
    rule TEXT NOT NULL UNIQUE,
    source_report_id TEXT,
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS meta(
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS legacy_quarantine(
    id INTEGER PRIMARY KEY,
    entity_type TEXT NOT NULL,
    raw_json TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
`;
