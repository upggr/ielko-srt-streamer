'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DB_PATH || '/data/streams.db';
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS endpoints (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE,
    protocol     TEXT NOT NULL,
    port         INTEGER NOT NULL UNIQUE,
    status       TEXT NOT NULL DEFAULT 'stopped',
    srt_password TEXT,
    ffmpeg_pid   INTEGER,
    yt_stream_key TEXT,
    yt_status    TEXT NOT NULL DEFAULT 'off',
    yt_pid       INTEGER,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
`);

module.exports = db;
