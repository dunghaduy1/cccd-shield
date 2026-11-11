import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDotEnv, loadConfig } from '../config.mjs';
import {
  createEmptyState,
  loadState,
  saveState,
  syncInitToken,
  pruneState,
  acquireLock,
  canSendReply,
} from '../state.mjs';

test('parseDotEnv handles comments, quotes, equals in value', () => {
  const parsed = parseDotEnv('# comment\nINIT_THREADS_TOKEN="tok=123"\nDRY_RUN=false\n');
  assert.equal(parsed.INIT_THREADS_TOKEN, 'tok=123');
  assert.equal(parsed.DRY_RUN, 'false');
});

test('loadConfig applies Spec defaults and rejects missing required secrets', () => {
  assert.throws(() => loadConfig('/nonexistent/.env', {}), /INIT_THREADS_TOKEN/);
  const cfg = loadConfig('/nonexistent/.env', {
    INIT_THREADS_TOKEN: 'th_tok',
    GEMINI_API_KEY: 'gm_key',
  });
  assert.equal(cfg.dryRun, true);
  assert.equal(cfg.geminiModel, 'gemini-3.8-flash');
  assert.equal(cfg.delayMinSec, 60);
  assert.equal(cfg.delayMaxSec, 300);
  assert.equal(cfg.maxRepliesPerHour, 20);
  assert.equal(cfg.maxRepliesPerDay, 100);
  assert.equal(cfg.maxQueueAgeSec, 2700);
  assert.equal(cfg.affiliateMode, 'off');
});

test('loadConfig rejects AFFILIATE_MODE other than off', () => {
  assert.throws(
    () => loadConfig('/nonexistent/.env', { INIT_THREADS_TOKEN: 'a', GEMINI_API_KEY: 'b', AFFILIATE_MODE: 'on' }),
    /AFFILIATE_MODE/
  );
});

test('syncInitToken seeds empty state, preserves refreshed token, and overrides only when env token changes', () => {
  const s0 = createEmptyState();
  const r1 = syncInitToken(s0, 'tok_v1', 1000);
  assert.equal(r1.source, 'init');
  assert.equal(r1.state.auth.access_token, 'tok_v1');
  assert.equal(r1.state.auth.expires_at, 1000 + 60 * 86400);

  // Simulate auto-refresh updating state.auth.access_token while .env still has tok_v1
  r1.state.auth.access_token = 'tok_refreshed';
  const r2 = syncInitToken(r1.state, 'tok_v1', 2000);
  assert.equal(r2.source, 'state');
  assert.equal(r2.state.auth.access_token, 'tok_refreshed');

  // User updates .env with brand new tok_v2 -> overrides refreshed token
  const r3 = syncInitToken(r2.state, 'tok_v2', 3000);
  assert.equal(r3.source, 'init');
  assert.equal(r3.state.auth.access_token, 'tok_v2');
});

test('saveState writes atomically and pruneState drops posts >7d and comments >14d', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'th-state-'));
  const file = path.join(dir, 'state.json');
  const now = 2_000_000;
  const s = createEmptyState();
  s.watched_posts['old'] = { post_id: 'old', published_at: now - 8 * 86400 };
  s.watched_posts['fresh'] = { post_id: 'fresh', published_at: now - 2 * 86400 };
  s.comments['c_old'] = { comment_id: 'c_old', status: 'sent', created_at: now - 15 * 86400 };
  s.comments['c_new'] = { comment_id: 'c_new', status: 'pending', created_at: now - 100 };

  pruneState(s, now);
  saveState(file, s);
  const loaded = loadState(file);
  assert.equal(loaded.watched_posts['old'], undefined);
  assert.ok(loaded.watched_posts['fresh']);
  assert.equal(loaded.comments['c_old'], undefined);
  assert.ok(loaded.comments['c_new']);
});

test('acquireLock blocks live duplicate PID and recovers stale dead PID', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'th-lock-'));
  const lockFile = path.join(dir, 'worker.pid');
  const release = acquireLock(lockFile, process.pid);
  assert.throws(() => acquireLock(lockFile, process.pid), /already running/i);
  release();

  // Stale dead PID gets cleaned up and acquired
  fs.writeFileSync(lockFile, '99999999');
  const release2 = acquireLock(lockFile, process.pid);
  release2();
  assert.equal(fs.existsSync(lockFile), false);
});

test('canSendReply enforces hourly and daily caps', () => {
  const now = 100_000;
  const s = createEmptyState();
  s.hourly_sent_timestamps = Array.from({ length: 20 }, (_, i) => now - i * 60);
  assert.equal(canSendReply(s, 20, 100, now).allowed, false);

  s.hourly_sent_timestamps = Array.from({ length: 100 }, (_, i) => now - 4000 - i * 100);
  assert.equal(canSendReply(s, 20, 100, now).allowed, false);

  s.hourly_sent_timestamps = [now - 100];
  assert.equal(canSendReply(s, 20, 100, now).allowed, true);
});
