import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dbPath = process.env.DB_PATH || '/data/streams.db';
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS endpoints (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    protocol    TEXT NOT NULL,
    port        INTEGER NOT NULL UNIQUE,
    status      TEXT NOT NULL DEFAULT 'stopped',
    srt_password TEXT,
    ffmpeg_pid  INTEGER,
    yt_stream_key TEXT,
    yt_status   TEXT NOT NULL DEFAULT 'off',
    yt_pid      INTEGER,
    fb_stream_key TEXT,
    fb_status   TEXT NOT NULL DEFAULT 'off',
    fb_pid      INTEGER,
    ig_stream_key TEXT,
    ig_status   TEXT NOT NULL DEFAULT 'off',
    ig_pid      INTEGER,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at  TEXT NOT NULL
  );
`);

// Migrations: add columns if they don't exist (safe to run multiple times)
const existingCols = (db.prepare("PRAGMA table_info(endpoints)").all() as any[]).map(c => c.name);
if (!existingCols.includes('fb_stream_key')) db.exec("ALTER TABLE endpoints ADD COLUMN fb_stream_key TEXT");
if (!existingCols.includes('fb_status'))     db.exec("ALTER TABLE endpoints ADD COLUMN fb_status TEXT NOT NULL DEFAULT 'off'");
if (!existingCols.includes('fb_pid'))        db.exec("ALTER TABLE endpoints ADD COLUMN fb_pid INTEGER");
if (!existingCols.includes('ig_stream_key')) db.exec("ALTER TABLE endpoints ADD COLUMN ig_stream_key TEXT");
if (!existingCols.includes('ig_status'))     db.exec("ALTER TABLE endpoints ADD COLUMN ig_status TEXT NOT NULL DEFAULT 'off'");
if (!existingCols.includes('ig_pid'))        db.exec("ALTER TABLE endpoints ADD COLUMN ig_pid INTEGER");

export default db;
