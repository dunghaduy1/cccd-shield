# Threads Auto-Reply (Local) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a zero-dependency local Node.js daemon that polls comments on your own Threads posts, waits 1–5 minutes, mirrors the commenter's Vietnamese pronouns via Gemini 3.8 Flash, enforces pregnancy/safety guardrails, and logs/alerts escalations locally or to Telegram.

**Architecture:** Sequential 60-second loop in plain ES modules (`threads-auto-reply/`) backed by atomic JSON persistence (`data/state.json`) with a PID lockfile. Each tick refreshes the 60-day Meta token when <14 days remain, polls recent posts/direct replies into a delayed queue, and processes due items with last-second manual-reply deduplication, single-call Gemini JSON classification+generation, and hard post-LLM validation. All network clients accept an injected `fetch` implementation so every behavior is unit-tested offline via `node --test`.

**Tech Stack:** Node.js `v24.9.0` (ES Modules, built-in `node:test`, `node:assert/strict`, `node:fs`, `node:crypto`, global `fetch`), Meta Threads Graph API, Google AI Studio Gemini REST API (`GEMINI_MODEL`), optional Telegram Bot API.

**Spec:** `docs/superpowers/specs/2026-11-11-threads-auto-reply-design.md`

## Global Constraints

- Runtime: Pure Node.js (`>=20`, verified on `v24.9.0`) with **zero npm dependencies** (`package.json` optional only if `"type": "module"` is needed, or use `.mjs` files so no `package.json` / `npm install` is required).
- Isolation: Keep all code under `threads-auto-reply/`; never modify `tinh-tien-thai-san/` or root static site files (except `.gitignore` and `.wranglerignore`).
- Phase 1 strict rule (`AFFILIATE_MODE=off`): Zero affiliate links, zero URLs, zero product pitches, zero Bio redirects in any reply.
- Pacing & anti-spam: Random reply delay `60..300` seconds; max `20` replies/hour and `100` replies/day; discard queued items delayed past `45` minutes (`2700` seconds); max `1` auto-reply per `(post_id, author)` pair; direct top-level replies on own posts within `7` days only.
- Voice & safety: Mirror commenter pronouns (`chị/em`, `tui/bà`, `mình/mom`), default `mình - mom`; `10..220` chars, max `2` sentences, max `1` light emoji, no bullets/AI clichés; never auto-reply to medical emergencies, medication dosages, or pregnancy loss — escalate to Telegram/log instead.
- Safe onboarding: Default `DRY_RUN=true` until explicitly disabled in `.env`; atomic `state.json` persistence (`temp + rename`) with `init_token_hash` tracking so auto-refreshed tokens are not overwritten by stale `.env` values.

## Review Focus

- **Author identity on Threads API:** Threads `/replies` responses primarily expose `username` (sometimes omitting numeric `owner.id`); normalize `authorKey = normalizeUsername(reply.username) || reply.owner?.id` and skip own comments matching either `auth.username` (case-insensitive) or `auth.user_id`.
- **Deleted/unavailable comments & non-retryable 4xx:** If a viewer deletes a comment during the 1–5 min delay, Threads API returns HTTP `400`/`404` (`ThreadsApiError` non-retryable); mark that item `failed`/`skipped_rule` immediately without retrying 3 times and without aborting other comments in the tick.
- **Unicode NFD/NFC & case normalization:** Mobile copy-paste or macOS text can use NFD decomposed Vietnamese accents or uppercase `@Username`; apply `.normalize('NFC').toLowerCase()` inside pre-filter, post-LLM guardrails, and username comparisons.
- **Nested replies vs direct replies & channel self-comments:** Ignore nested replies (`replied_to?.id && replied_to.id !== post.post_id`) and ignore comments whose normalized `username === auth.username` so the bot never replies to itself or sub-conversations between commenters.
- **Duplicate daemon launch & crash-safe JSON:** Guard startup with a PID lockfile (`data/worker.pid` using `wx` flag + `process.kill(pid, 0)` liveness check) and guard `saveState` with temp-file write + `renameSync` so `Ctrl+C` never corrupts `data/state.json`.

---

### Task 1: Repo Ignores, Config Loader & Atomic State Store

**Files:**
- Modify: `.gitignore`
- Modify: `.wranglerignore`
- Create: `threads-auto-reply/.env.example`
- Create: `threads-auto-reply/config.mjs`
- Create: `threads-auto-reply/state.mjs`
- Test: `threads-auto-reply/test/state.test.mjs`

**Interfaces:**
- Produces in `threads-auto-reply/config.mjs`:
  - `parseDotEnv(rawText: string) -> Record<string, string>`
  - `loadConfig(envPath?: string, overrides?: Record<string, string>) -> Config`
    where `Config = { initThreadsToken, geminiApiKey, geminiModel, dryRun, telegramBotToken, telegramChatId, pollIntervalSec, delayMinSec, delayMaxSec, maxRepliesPerHour, maxRepliesPerDay, maxQueueAgeSec, postLookbackDays, affiliateMode, dataDir, stateFile, lockFile, logFile }`
- Produces in `threads-auto-reply/state.mjs`:
  - `createEmptyState() -> State`
  - `loadState(stateFile: string) -> State`
  - `saveState(stateFile: string, state: State) -> void`
  - `syncInitToken(state: State, initToken: string, nowSec: number) -> { state: State, changed: boolean, source: 'state' | 'init' }`
  - `pruneState(state: State, nowSec: number) -> State`
  - `acquireLock(lockFile: string, pid?: number) -> () => void`
  - `canSendReply(state: State, maxPerHour: number, maxPerDay: number, nowSec: number) -> { allowed: boolean, reason?: string }`

- [ ] **Step 1: Write the failing test in `threads-auto-reply/test/state.test.mjs`**

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test threads-auto-reply/test/state.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` (`../config.mjs` missing)

- [ ] **Step 3: Update `.gitignore`, `.wranglerignore`, and create `.env.example`, `config.mjs`, `state.mjs`**

1. Append `threads-auto-reply/data/` to `.gitignore` and `threads-auto-reply/` to `.wranglerignore`.
2. Create `threads-auto-reply/.env.example` documenting `INIT_THREADS_TOKEN`, `GEMINI_API_KEY`, `GEMINI_MODEL=gemini-3.8-flash`, `DRY_RUN=true`, `TELEGRAM_BOT_TOKEN=`, `TELEGRAM_CHAT_ID=`, `POLL_INTERVAL_SEC=60`, `DELAY_MIN_SEC=60`, `DELAY_MAX_SEC=300`, `MAX_REPLIES_PER_HOUR=20`, `MAX_REPLIES_PER_DAY=100`, `AFFILIATE_MODE=off`.
3. Implement `parseDotEnv` and `loadConfig` in `threads-auto-reply/config.mjs` (merges file values with `process.env` or `overrides`, validates positive ints, `delayMinSec <= delayMaxSec`, `affiliateMode === 'off'`, default `dryRun = true` unless explicitly `'false'`).
4. Implement `createEmptyState`, `loadState`, `saveState` (writes to `${stateFile}.tmp` then `renameSync`), `syncInitToken` (SHA-256 hash comparison on `auth.init_token_hash`), `pruneState` (`watched_posts` >7d, `comments` >14d, `hourly_sent_timestamps` >24h), `acquireLock` (`openSync(..., 'wx')` + `process.kill(oldPid, 0)` stale detection), and `canSendReply` in `threads-auto-reply/state.mjs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test threads-auto-reply/test/state.test.mjs`
Expected: PASS (7/7 tests passing)

- [ ] **Step 5: Commit**

```bash
git add .gitignore .wranglerignore threads-auto-reply/.env.example threads-auto-reply/config.mjs threads-auto-reply/state.mjs threads-auto-reply/test/state.test.mjs
git commit -m "feat(threads-auto-reply): add config loader, ignore rules, and atomic state store"
```

---

### Task 2: Deterministic Pre-Filters & Post-LLM Guardrails

**Files:**
- Create: `threads-auto-reply/filters.mjs`
- Test: `threads-auto-reply/test/filters.test.mjs`

**Interfaces:**
- Consumes: none (pure functions)
- Produces in `threads-auto-reply/filters.mjs`:
  - `preFilterComment(text: string) -> { decision: 'pass' | 'skip' | 'escalate', reason?: string }`
  - `validateGeneratedReply(text: string) -> { ok: boolean, reason?: string, cleanText?: string }`

- [ ] **Step 1: Write the failing test in `threads-auto-reply/test/filters.test.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { preFilterComment, validateGeneratedReply } from '../filters.mjs';

test('preFilterComment skips empty, pure-emoji, mention-only, and URL/phone spam', () => {
  assert.equal(preFilterComment('   ').decision, 'skip');
  assert.equal(preFilterComment('❤️❤️🥰🤰').decision, 'skip');
  assert.equal(preFilterComment('@lan.nguyen @hoa_tran').decision, 'skip');
  assert.equal(preFilterComment('ib zalo 0912345678 tư vấn').decision, 'skip');
  assert.equal(preFilterComment('xem ở https://s.shopee.vn/abc nha').decision, 'skip');
});

test('preFilterComment escalates medical risk, medication dosage, and pregnancy loss (including NFD Unicode)', () => {
  const nfdBleeding = 'Ra máu nâu tuần 8 có sao ko mom ơi'.normalize('NFD');
  assert.equal(preFilterComment(nfdBleeding).decision, 'escalate');
  assert.equal(preFilterComment('đau bụng dưới dữ dội quá').decision, 'escalate');
  assert.equal(preFilterComment('bầu uống paracetamol liều mấy viên').decision, 'escalate');
  assert.equal(preFilterComment('dùng kháng sinh được ko ạ').decision, 'escalate');
  assert.equal(preFilterComment('mình mới bị lưu thai tuần 9 buồn quá').decision, 'escalate');
  assert.equal(preFilterComment('sốt cao 39 độ rét run').decision, 'escalate');
});

test('preFilterComment passes normal pregnancy engagement comments', () => {
  assert.equal(preFilterComment('mình 28w cũng hay mất ngủ lắm mom').decision, 'pass');
  assert.equal(preFilterComment('chị ơi em mới 12w nghén quá trời').decision, 'pass');
  assert.equal(preFilterComment('trộm vía quá bà ơi').decision, 'pass');
  assert.equal(preFilterComment('hóng chia sẻ của mom nha').decision, 'pass');
});

test('validateGeneratedReply accepts natural 1-2 sentence replies and rejects links, clichés, bullets, or overlong text', () => {
  const ok = validateGeneratedReply('Trộm vía ghê nha mom, ráng ăn ngủ đều giữ sức cho hai mẹ con nhé');
  assert.equal(ok.ok, true);

  assert.equal(validateGeneratedReply('ngắn quá').ok, false);
  assert.equal(validateGeneratedReply('a '.repeat(120)).ok, false);
  assert.equal(validateGeneratedReply('Câu 1 nè. Câu 2 nè. Câu 3 dư rồi.').ok, false);
  assert.equal(validateGeneratedReply('- Ý 1\n- Ý 2').ok, false);
  assert.equal(validateGeneratedReply('Bạn mua ở shopee.vn nha mom').ok, false);
  assert.equal(validateGeneratedReply('Xem link bio đầu trang mình nha').ok, false);
  assert.equal(validateGeneratedReply('Cảm ơn bạn đã chia sẻ câu chuyện của mình').ok, false);
  assert.equal(validateGeneratedReply('Là một AI mình khuyên bạn nên nghỉ ngơi').ok, false);
  assert.equal(validateGeneratedReply('Bạn uống thuốc paracetamol 500mg mỗi 6 tiếng nhé').ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test threads-auto-reply/test/filters.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` (`../filters.mjs` missing)

- [ ] **Step 3: Implement `preFilterComment` and `validateGeneratedReply` in `threads-auto-reply/filters.mjs`**

Normalize all input with `.normalize('NFC').trim()`. For `preFilterComment`: check empty/length, strip `@mentions` and emoji/punctuation (`\p{Emoji_Presentation}\p{Extended_Pictographic}\p{P}\p{S}\s`) to skip non-text comments, detect URL/phone spam (`https?://`, `www\.`, `.vn/`, `.com/`, `0\d{8,10}`), and check pregnancy emergency/medication/loss keywords (`ra máu`, `xuất huyết`, `băng huyết`, `đau bụng dữ dội`, `đau quặn`, `dọa sảy`, `sảy thai`, `lưu thai`, `thai lưu`, `mất bé`, `mất con`, `ngất`, `co giật`, `sốt cao`, `39 độ`, `40 độ`, `uống thuốc`, `liều thuốc`, `liều mấy`, `kháng sinh`, `paracetamol`, `thuốc đặt`, `nên uống gì`, `cấp cứu`). For `validateGeneratedReply`: trim text, enforce `10..220` chars, forbid newlines/bullets (`\n`, `- `, `* `), count sentences by `[.!?]+` (`<= 2`), forbid URLs/domains/affiliate terms (`http`, `www.`, `.vn`, `.com`, `shopee`, `bio`, `link`), prescription phrases (`uống thuốc`, `liều`, `kháng sinh`, `chẩn đoán`), and AI clichés (`cảm ơn bạn đã chia sẻ`, `là một ai`, `mình rất hiểu cảm giác`, `hy vọng thông tin này hữu ích`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test threads-auto-reply/test/filters.test.mjs`
Expected: PASS (all assertions pass)

- [ ] **Step 5: Commit**

```bash
git add threads-auto-reply/filters.mjs threads-auto-reply/test/filters.test.mjs
git commit -m "feat(threads-auto-reply): add pre-filters and post-LLM safety guardrails"
```

---

### Task 3: Meta Threads API Client

**Files:**
- Create: `threads-auto-reply/threads-api.mjs`
- Test: `threads-auto-reply/test/threads-api.test.mjs`

**Interfaces:**
- Produces in `threads-auto-reply/threads-api.mjs`:
  - `ThreadsApiError` (class extending `Error` with `{ status: number, code?: number, retryable: boolean }`)
  - `createThreadsClient({ fetchImpl?: typeof fetch, baseUrl?: string }) -> ThreadsClient`
    where `ThreadsClient` exposes:
    - `getMe(accessToken: string) -> Promise<{ id: string, username: string }>`
    - `getUserThreads(userId: string, accessToken: string, limit?: number) -> Promise<Array<{ id: string, text: string, permalink: string, timestamp: string }>>`
    - `getReplies(mediaId: string, accessToken: string) -> Promise<Array<{ id: string, text: string, username?: string, owner?: { id: string }, timestamp: string, has_replies?: boolean, replied_to?: { id: string } }>>`
    - `replyToComment(userId: string, commentId: string, text: string, accessToken: string) -> Promise<{ id: string }>`
    - `refreshLongLivedToken(accessToken: string) -> Promise<{ access_token: string, expires_in: number }>`

- [ ] **Step 1: Write the failing test in `threads-auto-reply/test/threads-api.test.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createThreadsClient, ThreadsApiError } from '../threads-api.mjs';

test('getMe, getUserThreads, and getReplies parse Graph responses with auth header/query', async () => {
  const calls = [];
  const client = createThreadsClient({
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      if (url.includes('/me?')) {
        return new Response(JSON.stringify({ id: 'u1', username: 'mebau.vn' }), { status: 200 });
      }
      if (url.includes('/u1/threads?')) {
        return new Response(JSON.stringify({ data: [{ id: 'p1', text: 'Bầu tuần 20', permalink: 'https://threads.net/t/p1', timestamp: '2026-11-11T01:00:00Z' }] }), { status: 200 });
      }
      if (url.includes('/p1/replies?')) {
        return new Response(JSON.stringify({ data: [{ id: 'c1', text: 'Chúc mom khỏe', username: 'lan', timestamp: '2026-11-11T01:05:00Z', replied_to: { id: 'p1' } }] }), { status: 200 });
      }
      throw new Error('Unexpected URL: ' + url);
    },
  });

  const me = await client.getMe('tok');
  assert.equal(me.username, 'mebau.vn');
  const posts = await client.getUserThreads('u1', 'tok');
  assert.equal(posts.length, 1);
  const replies = await client.getReplies('p1', 'tok');
  assert.equal(replies[0].id, 'c1');
  assert.ok(calls.every((c) => c.opts.headers.Authorization === 'Bearer tok'));
});

test('replyToComment performs 2-step create + publish container', async () => {
  const calls = [];
  const client = createThreadsClient({
    fetchImpl: async (url, opts) => {
      calls.push({ url, method: opts.method, body: opts.body });
      if (url.endsWith('/u1/threads')) {
        return new Response(JSON.stringify({ id: 'creation_99' }), { status: 200 });
      }
      if (url.endsWith('/u1/threads_publish')) {
        return new Response(JSON.stringify({ id: 'reply_77' }), { status: 200 });
      }
      throw new Error('Unexpected URL: ' + url);
    },
  });

  const res = await client.replyToComment('u1', 'c1', 'Cảm ơn mom nha', 'tok');
  assert.equal(res.id, 'reply_77');
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].body, /reply_to_id=c1/);
  assert.match(calls[1].body, /creation_id=creation_99/);
});

test('refreshLongLivedToken uses th_refresh_token and marks 400 non-retryable vs 429/500 retryable', async () => {
  const clientOk = createThreadsClient({
    fetchImpl: async (url) => {
      assert.match(url, /grant_type=th_refresh_token/);
      return new Response(JSON.stringify({ access_token: 'new_tok', expires_in: 5184000 }), { status: 200 });
    },
  });
  const refreshed = await clientOk.refreshLongLivedToken('old_tok');
  assert.equal(refreshed.access_token, 'new_tok');

  const client400 = createThreadsClient({
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'Deleted', code: 100 } }), { status: 400 }),
  });
  await assert.rejects(() => client400.getReplies('bad', 'tok'), (e) => e instanceof ThreadsApiError && e.retryable === false);

  const client429 = createThreadsClient({
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'Rate limit', code: 4 } }), { status: 429 }),
  });
  await assert.rejects(() => client429.getReplies('p1', 'tok'), (e) => e instanceof ThreadsApiError && e.retryable === true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test threads-auto-reply/test/threads-api.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` (`../threads-api.mjs` missing)

- [ ] **Step 3: Implement `ThreadsApiError` and `createThreadsClient` in `threads-auto-reply/threads-api.mjs`**

Use `https://graph.threads.net` as default `baseUrl`, `Authorization: Bearer ${accessToken}` header (avoids putting token in URL logs for GET endpoints except Meta's documented `refresh_access_token` query param if required — pass token in `Authorization` header on Graph endpoints and only query param on `refresh_access_token` without leaking it in error messages), `AbortSignal.timeout(15000)`, URLSearchParams form body for `POST /v1.0/{userId}/threads` (`media_type=TEXT`, `text`, `reply_to_id`) and `POST /v1.0/{userId}/threads_publish` (`creation_id`). Mark HTTP `429` and `>= 500` and network/timeout errors `retryable: true`; all other `4xx` `retryable: false`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test threads-auto-reply/test/threads-api.test.mjs`
Expected: PASS (3/3 tests passing)

- [ ] **Step 5: Commit**

```bash
git add threads-auto-reply/threads-api.mjs threads-auto-reply/test/threads-api.test.mjs
git commit -m "feat(threads-auto-reply): add Meta Threads API client"
```

---

### Task 4: Gemini 3.8 Flash Client & Adaptive Pronoun Prompt

**Files:**
- Create: `threads-auto-reply/gemini.mjs`
- Test: `threads-auto-reply/test/gemini.test.mjs`

**Interfaces:**
- Produces in `threads-auto-reply/gemini.mjs`:
  - `createGeminiClient({ apiKey: string, model: string, fetchImpl?: typeof fetch }) -> GeminiClient`
    where `GeminiClient` exposes:
    - `generateCommentDecision({ postText: string, commentText: string, authorUsername?: string }) -> Promise<{ action: 'reply' | 'escalate' | 'skip', reason: string, detectedPair: string, replyText: string }>`

- [ ] **Step 1: Write the failing test in `threads-auto-reply/test/gemini.test.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiClient } from '../gemini.mjs';

test('generateCommentDecision sends x-goog-api-key header, JSON mimeType, and parses structured output', async () => {
  let captured;
  const client = createGeminiClient({
    apiKey: 'gm_secret',
    model: 'gemini-3.8-flash',
    fetchImpl: async (url, opts) => {
      captured = { url, opts };
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      action: 'reply',
                      reason: 'ok',
                      detected_pair: 'mình-mom',
                      reply_text: 'Ngủ ít mệt lắm mom ơi, chịu khó kê thêm gối ôm dưới bụng xem đỡ hơn hông nè',
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 }
      );
    },
  });

  const out = await client.generateCommentDecision({
    postText: 'Bầu tuần 28 mất ngủ quá',
    commentText: 'mình cũng vậy luôn mom ơi',
    authorUsername: 'me_bi',
  });
  assert.equal(captured.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.equal(captured.opts.headers['x-goog-api-key'], 'gm_secret');
  assert.equal(out.action, 'reply');
  assert.equal(out.detectedPair, 'mình-mom');
  assert.match(out.replyText, /mom/);
});

test('generateCommentDecision rejects invalid JSON or unknown action cleanly', async () => {
  const client = createGeminiClient({
    apiKey: 'gm_secret',
    model: 'gemini-3.8-flash',
    fetchImpl: async () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] }), { status: 200 }),
  });

  await assert.rejects(() =>
    client.generateCommentDecision({ postText: 'a', commentText: 'b' })
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test threads-auto-reply/test/gemini.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` (`../gemini.mjs` missing)

- [ ] **Step 3: Implement `createGeminiClient` in `threads-auto-reply/gemini.mjs`**

Call `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent` with `x-goog-api-key` header, `responseMimeType: "application/json"`, `responseSchema` enforcing `{ action, reason, detected_pair, reply_text }`, `temperature: 0.7`, `AbortSignal.timeout(20000)`. System instruction encodes Section 4 verbatim: mirror commenter's Vietnamese pronouns (`chị-em`, `tui-bà`, `mình-mom`, fallback `mình-mom`), folksy texting tone 1–2 short sentences, max 1 light emoji, no AI clichés, no links/affiliate/Bio mentions, no medical prescriptions, escalate on emergency/medication/grief. Normalize JSON parsing (strip accidental markdown fences) and validate `action` in `['reply', 'escalate', 'skip']`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test threads-auto-reply/test/gemini.test.mjs`
Expected: PASS (2/2 tests passing)

- [ ] **Step 5: Commit**

```bash
git add threads-auto-reply/gemini.mjs threads-auto-reply/test/gemini.test.mjs
git commit -m "feat(threads-auto-reply): add Gemini 3.8 Flash client with folksy prompt"
```

---

### Task 5: Notifier & Tick Orchestrator (`runTick`)

**Files:**
- Create: `threads-auto-reply/notify.mjs`
- Create: `threads-auto-reply/worker.mjs`
- Test: `threads-auto-reply/test/worker.test.mjs`

**Interfaces:**
- Produces in `threads-auto-reply/notify.mjs`:
  - `createNotifier({ telegramBotToken?: string, telegramChatId?: string, logFile: string, fetchImpl?: typeof fetch, logger?: Pick<Console, 'log' | 'warn' | 'error'> }) -> { notify(event: { level: 'info' | 'warn' | 'escalate' | 'dry_run', title: string, message: string, permalink?: string }): Promise<void> }`
- Consumes from Tasks 1–4: `state.mjs`, `filters.mjs`, `threads-api.mjs`, `gemini.mjs`
- Produces in `threads-auto-reply/worker.mjs`:
  - `runTick(deps: { config: Config, state: State, threads: ThreadsClient, gemini: GeminiClient, notifier: Notifier, nowSec?: () => number, randomInt?: (min: number, max: number) => number }) -> Promise<{ refreshed: boolean, enqueued: number, processed: number, sent: number, dryRunCount: number, escalated: number, skipped: number, failed: number }>`

- [ ] **Step 1: Write the failing test in `threads-auto-reply/test/worker.test.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEmptyState } from '../state.mjs';
import { createNotifier } from '../notify.mjs';
import { ThreadsApiError } from '../threads-api.mjs';
import { runTick } from '../worker.mjs';

function makeBaseDeps(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'th-worker-'));
  const state = createEmptyState();
  state.auth = { user_id: 'me1', username: 'mebau.vn', access_token: 'tok', expires_at: 2_000_000, init_token_hash: 'h', last_refresh_attempt_at: 0 };
  const alerts = [];
  const notifier = createNotifier({
    logFile: path.join(dir, 'escalations.log'),
    logger: { log() {}, warn() {}, error() {} },
    fetchImpl: async (_url, opts) => { alerts.push(JSON.parse(opts.body)); return new Response('{"ok":true}'); },
    telegramBotToken: 'tg_tok',
    telegramChatId: '123',
  });
  const config = {
    delayMinSec: 60,
    delayMaxSec: 300,
    maxRepliesPerHour: 20,
    maxRepliesPerDay: 100,
    maxQueueAgeSec: 2700,
    postLookbackDays: 7,
    dryRun: false,
  };
  return { dir, state, alerts, notifier, config, ...overrides };
}

test('Pha A refreshes token when <14 days remain and guards against double refresh within 24h', async () => {
  let refreshedCalls = 0;
  const { state, notifier, config } = makeBaseDeps();
  state.auth.expires_at = 1_000_000 + 10 * 86400;
  const threads = {
    getMe: async () => ({ id: 'me1', username: 'mebau.vn' }),
    getUserThreads: async () => [],
    getReplies: async () => [],
    replyToComment: async () => ({ id: 'r1' }),
    refreshLongLivedToken: async () => { refreshedCalls++; return { access_token: 'new_tok', expires_in: 5184000 }; },
  };
  const gemini = { generateCommentDecision: async () => ({ action: 'skip', reason: '', detectedPair: '', replyText: '' }) };

  await runTick({ config, state, threads, gemini, notifier, nowSec: () => 1_000_000 });
  assert.equal(refreshedCalls, 1);
  assert.equal(state.auth.access_token, 'new_tok');

  // Second tick immediately after does NOT refresh again
  state.auth.expires_at = 1_000_060 + 10 * 86400;
  await runTick({ config, state, threads, gemini, notifier, nowSec: () => 1_000_060 });
  assert.equal(refreshedCalls, 1);
});

test('Pha B skips self comments, nested replies, and 2nd comment from same user on same post, and escalates medical risk', async () => {
  const { state, alerts, notifier, config } = makeBaseDeps();
  const now = 1_000_000;
  const threads = {
    getMe: async () => ({ id: 'me1', username: 'mebau.vn' }),
    getUserThreads: async () => [{ id: 'p1', text: 'Thai kỳ tuần 20', permalink: 'https://threads.net/p1', timestamp: new Date((now - 3600) * 1000).toISOString() }],
    getReplies: async () => [
      { id: 'c_self', text: 'Bình luận của mình', username: 'MeBau.vn', timestamp: new Date(now * 1000).toISOString(), replied_to: { id: 'p1' } },
      { id: 'c_nested', text: 'Trả lời bạn kia', username: 'u2', timestamp: new Date(now * 1000).toISOString(), replied_to: { id: 'c_other' } },
      { id: 'c_med', text: 'ra máu nâu tuần 8 có sao ko', username: 'u3', timestamp: new Date(now * 1000).toISOString(), replied_to: { id: 'p1' } },
      { id: 'c_ok1', text: 'mình cũng tuần 20 nè mom', username: 'U4', timestamp: new Date(now * 1000).toISOString(), replied_to: { id: 'p1' } },
      { id: 'c_ok2', text: 'hỏi thêm câu nữa nè', username: 'u4', timestamp: new Date(now * 1000).toISOString(), replied_to: { id: 'p1' } },
    ],
    replyToComment: async () => ({ id: 'r1' }),
    refreshLongLivedToken: async () => ({ access_token: 'tok', expires_in: 5184000 }),
  };
  const gemini = { generateCommentDecision: async () => ({ action: 'reply', reason: '', detectedPair: 'mình-mom', replyText: 'Cố lên nha mom, giữ sức khỏe nhé' }) };

  const res = await runTick({ config, state, threads, gemini, notifier, nowSec: () => now, randomInt: () => 120 });
  assert.equal(state.comments['c_self'], undefined);
  assert.equal(state.comments['c_nested'], undefined);
  assert.equal(state.comments['c_med'].status, 'escalated');
  assert.equal(alerts.length, 1);
  assert.equal(state.comments['c_ok1'].status, 'pending');
  assert.equal(state.comments['c_ok1'].scheduled_at, now + 120);
  assert.equal(state.comments['c_ok2'], undefined);
  assert.equal(res.escalated, 1);
  assert.equal(res.enqueued, 1);
});

test('Pha C performs manual-reply dedup, enforces DRY_RUN, blocks post-LLM URL leaks, and drops deleted comments without crashing', async () => {
  const { state, alerts, notifier, config } = makeBaseDeps();
  const now = 1_000_200;
  state.watched_posts['p1'] = { post_id: 'p1', post_text: 'Mẹ bầu ngủ ngon', permalink: 'https://threads.net/p1', published_at: now - 500, last_polled_at: now - 10 };
  state.comments['c_manual'] = { comment_id: 'c_manual', post_id: 'p1', author_key: 'u_a', author_username: 'u_a', comment_text: 'mình mất ngủ quá', status: 'pending', scheduled_at: now - 10, attempts: 0, created_at: now - 200 };
  state.comments['c_deleted'] = { comment_id: 'c_deleted', post_id: 'p1', author_key: 'u_b', author_username: 'u_b', comment_text: 'mình 15w nè', status: 'pending', scheduled_at: now - 5, attempts: 0, created_at: now - 200 };
  state.comments['c_send'] = { comment_id: 'c_send', post_id: 'p1', author_key: 'u_c', author_username: 'u_c', comment_text: 'mom ơi 22w đau lưng quá', status: 'pending', scheduled_at: now - 1, attempts: 0, created_at: now - 200 };

  let sentCount = 0;
  const threads = {
    getMe: async () => ({ id: 'me1', username: 'mebau.vn' }),
    getUserThreads: async () => [],
    getReplies: async (id) => {
      if (id === 'c_manual') return [{ id: 'my_hand_reply', username: 'mebau.vn' }];
      if (id === 'c_deleted') throw new ThreadsApiError('Not found', { status: 404, retryable: false });
      return [];
    },
    replyToComment: async () => { sentCount++; return { id: 'r_ok' }; },
  };
  const gemini = {
    generateCommentDecision: async () => ({ action: 'reply', reason: 'ok', detectedPair: 'mình-mom', replyText: 'Thương mom nè, chịu khó chườm ấm nhẹ với kê gối sau lưng thử xem nha' }),
  };

  // First verify DRY_RUN mode marks dry_run without posting
  config.dryRun = true;
  const dryRes = await runTick({ config, state, threads, gemini, notifier, nowSec: () => now });
  assert.equal(state.comments['c_manual'].status, 'skipped_manual');
  assert.equal(state.comments['c_deleted'].status, 'failed');
  assert.equal(state.comments['c_send'].status, 'dry_run');
  assert.equal(sentCount, 0);
  assert.equal(dryRes.dryRunCount, 1);
  assert.ok(alerts.some((a) => a.text.includes('DRY_RUN')));

  // Re-arm c_send as live and test live send
  config.dryRun = false;
  state.comments['c_send'].status = 'pending';
  const liveRes = await runTick({ config, state, threads, gemini, notifier, nowSec: () => now });
  assert.equal(state.comments['c_send'].status, 'sent');
  assert.equal(state.replied_pairs['p1:u_c'], true);
  assert.equal(sentCount, 1);
  assert.equal(liveRes.sent, 1);
});

test('Pha C expires stale items waiting > 45 minutes', async () => {
  const { state, notifier, config } = makeBaseDeps();
  const now = 1_005_000;
  state.watched_posts['p1'] = { post_id: 'p1', post_text: 'Test', permalink: 'https://threads.net/p1', published_at: now - 5000, last_polled_at: now };
  state.comments['c_stale'] = { comment_id: 'c_stale', post_id: 'p1', author_key: 'u_z', comment_text: 'chào mom', status: 'pending', scheduled_at: now - 2500, attempts: 0, created_at: now - 2800 };

  const threads = { getMe: async () => ({ id: 'me1', username: 'mebau.vn' }), getUserThreads: async () => [], getReplies: async () => [] };
  const gemini = { generateCommentDecision: async () => { throw new Error('must not call gemini on stale item'); } };

  await runTick({ config, state, threads, gemini, notifier, nowSec: () => now });
  assert.equal(state.comments['c_stale'].status, 'skipped_rule');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test threads-auto-reply/test/worker.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` (`../notify.mjs` / `../worker.mjs` missing)

- [ ] **Step 3: Implement `threads-auto-reply/notify.mjs` and `threads-auto-reply/worker.mjs`**

1. `notify.mjs`: Ensure `path.dirname(logFile)` exists, write formatted timestamped line to `logFile` for `'warn' | 'escalate' | 'dry_run'`, log to `logger`, and if `telegramBotToken && telegramChatId`, POST JSON to `https://api.telegram.org/bot${token}/sendMessage` inside `try/catch` (errors logged to `logger.error`, never thrown).
2. `worker.mjs`:
   - Normalize `normalizeUsername(u) = String(u || '').trim().replace(/^@/, '').toLowerCase()`.
   - Resolve `state.auth.user_id` + `state.auth.username` via `threads.getMe()` if either is empty.
   - Pha A: if `expires_at - now < 14 * 86400` and `now - last_refresh_attempt_at >= 86400`: update `last_refresh_attempt_at = now`, call `refreshLongLivedToken`, update `access_token` + `expires_at`; on error or if `< 5 * 86400`, notify `'escalate'`.
   - Pha B: sync user threads every `300s` (`now - last_posts_sync_at >= 300`), keeping posts with `published_at >= now - postLookbackDays * 86400`. Poll up to 5 watched posts sorted by `(published_at > now - 86400 ? 0 : 1), last_polled_at ASC`. For each reply:
     - Skip if `authorKey` matches `auth.username` or `auth.user_id`, or missing `authorKey`.
     - Skip if nested (`reply.replied_to?.id && reply.replied_to.id !== post.post_id`).
     - Skip if `state.comments[reply.id]` exists, or `state.replied_pairs[pairKey]`, or another `pending` comment exists for `pairKey`.
     - Run `preFilterComment`: `'skip'` -> store `skipped_rule`; `'escalate'` -> store `escalated` + `notifier.notify`; `'pass'` -> store `pending` with `scheduled_at = now + randomInt(delayMinSec, delayMaxSec)`.
   - Pha C: iterate `pending` items with `scheduled_at <= now` sorted by `scheduled_at ASC`, capped at `3` items per tick:
     - If `now - item.created_at > maxQueueAgeSec`: mark `skipped_rule` (`'expired_45m'`), continue.
     - Check `canSendReply`: if `!allowed`, stop processing further `pending` items this tick.
     - Wrap per-item execution in `try/catch`:
       - Fetch `threads.getReplies(item.comment_id)`; if any child reply belongs to `auth.username` or `auth.user_id` -> mark `skipped_manual`, continue.
       - Call `gemini.generateCommentDecision`; if `action === 'escalate'` -> mark `escalated` + notify; if `action === 'skip'` -> mark `skipped_rule`; else validate `validateGeneratedReply(decision.replyText)` -> if `!ok`, mark `skipped_rule` (or `escalated` if medical leak) and notify `'warn'`.
       - If `config.dryRun`: mark `dry_run`, store `reply_text`, notify `'dry_run'`. Else call `threads.replyToComment`, mark `sent`, record `reply_id`, set `replied_pairs[pairKey] = true`, push `now` to `hourly_sent_timestamps`.
       - On error: if `err instanceof ThreadsApiError && !err.retryable` -> mark `failed` immediately + notify `'warn'`; else increment `attempts`, reschedule `+120s` if `attempts < 3`, else mark `failed` + notify `'escalate'`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test threads-auto-reply/test/worker.test.mjs`
Expected: PASS (4/4 tests passing)

- [ ] **Step 5: Commit**

```bash
git add threads-auto-reply/notify.mjs threads-auto-reply/worker.mjs threads-auto-reply/test/worker.test.mjs
git commit -m "feat(threads-auto-reply): add notifier and sequential tick orchestrator"
```

---

### Task 6: CLI Entrypoint, `--once` Mode & Setup Documentation

**Files:**
- Create: `threads-auto-reply/index.mjs`
- Create: `threads-auto-reply/README.md`
- Test: `threads-auto-reply/test/cli.test.mjs`

**Interfaces:**
- Produces in `threads-auto-reply/index.mjs`:
  - `main(argv?: string[], deps?: Partial<{ loadConfig, loadState, saveState, acquireLock, runTick }>) -> Promise<void>`
  - Guarded entrypoint (`import.meta.url === pathToFileURL(process.argv[1]).href`) so importing `index.mjs` in tests never auto-starts the daemon loop.

- [ ] **Step 1: Write the failing test in `threads-auto-reply/test/cli.test.mjs`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../index.mjs';

test('main --once acquires lock, syncs token, runs 1 tick, saves state, and releases lock', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'th-cli-'));
  let saved = false;
  let ticked = false;
  const lockFile = path.join(dir, 'worker.pid');
  const stateFile = path.join(dir, 'state.json');

  await main(['--once'], {
    loadConfig: () => ({
      initThreadsToken: 'tok_1',
      geminiApiKey: 'gm_1',
      geminiModel: 'gemini-3.8-flash',
      dryRun: true,
      pollIntervalSec: 60,
      delayMinSec: 60,
      delayMaxSec: 300,
      maxRepliesPerHour: 20,
      maxRepliesPerDay: 100,
      maxQueueAgeSec: 2700,
      postLookbackDays: 7,
      dataDir: dir,
      stateFile,
      lockFile,
      logFile: path.join(dir, 'escalations.log'),
    }),
    createThreadsClient: () => ({ getMe: async () => ({ id: 'u1', username: 'me' }), getUserThreads: async () => [], getReplies: async () => [] }),
    createGeminiClient: () => ({ generateCommentDecision: async () => ({ action: 'skip', reason: '', detectedPair: '', replyText: '' }) }),
    runTick: async ({ state }) => { ticked = true; assert.equal(state.auth.access_token, 'tok_1'); return { refreshed: false, enqueued: 0, processed: 0, sent: 0, dryRunCount: 0, escalated: 0, skipped: 0, failed: 0 }; },
    onSavedState: () => { saved = true; },
  });

  assert.equal(ticked, true);
  assert.equal(saved, true);
  assert.equal(fs.existsSync(stateFile), true);
  assert.equal(fs.existsSync(lockFile), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test threads-auto-reply/test/cli.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` (`../index.mjs` missing)

- [ ] **Step 3: Implement `threads-auto-reply/index.mjs` and write `threads-auto-reply/README.md`**

1. `index.mjs`: Resolve default `.env` relative to `threads-auto-reply/.env`; acquire PID lock; load/sync/prune state; run `runTick` in a `try/finally` that always calls `saveState` (even if tick threw after partial progress) and always releases lock on exit; if `--once` is present exit after 1 tick, otherwise sleep `pollIntervalSec * 1000` with abortable timer triggered immediately on `SIGINT`/`SIGTERM`.
2. `README.md`: Concise Vietnamese operator guide covering:
   - Meta Developer App setup (Development Mode -> add Threads API -> add own account as Threads Tester -> accept invite on Threads -> generate long-lived token + verify exact Graph endpoint/scopes).
   - Google AI Studio `GEMINI_API_KEY` + confirming `GEMINI_MODEL` string.
   - Optional Telegram `@BotFather` token + chat ID.
   - Running first check: `cp threads-auto-reply/.env.example threads-auto-reply/.env`, test `node threads-auto-reply/index.mjs --once` (`DRY_RUN=true`), inspect output/`data/escalations.log`, then switch `DRY_RUN=false` and run `node threads-auto-reply/index.mjs` (plus optional macOS `launchd` snippet).

- [ ] **Step 4: Run full test suite**

Run: `node --test threads-auto-reply/test/*.test.mjs`
Expected: PASS (all tests across `state`, `filters`, `threads-api`, `gemini`, `worker`, `cli` pass)

- [ ] **Step 5: Commit**

```bash
git add threads-auto-reply/index.mjs threads-auto-reply/README.md threads-auto-reply/test/cli.test.mjs
git commit -m "feat(threads-auto-reply): add local CLI daemon, --once mode, and setup guide"
```

---

## Self-Review Checklist (Author Verified)

1. **Spec coverage:**
   - Official Threads API (Development Mode + Threads Tester + 60-day auto-refresh <14d + Telegram alert <5d): Task 1 (`syncInitToken`), Task 3, Task 5 (Pha A), Task 6 (`README.md`).
   - Polling own posts (7-day window, top 5 posts/tick, direct replies only, 1–5 min random delay): Task 5 (Pha B).
   - Hard pre-filters (empty, emoji, `@mention`, URL/phone spam, pregnancy emergencies/medication/grief with NFD normalization): Task 2.
   - Gemini 3.8 Flash single-call JSON + adaptive pronouns + post-LLM guardrails: Task 2 & Task 4.
   - Last-second manual reply dedup, 20/hour & 100/day caps, 45-min queue expiry, `DRY_RUN=true` default, optional Telegram + `escalations.log`: Task 1, Task 5, Task 6.
   - Atomic `state.json` + PID lock + zero npm dependencies: Task 1, Task 6.
2. **Consistency check:** Config property names (`delayMinSec`, `delayMaxSec`, `maxRepliesPerHour`, `maxRepliesPerDay`, `maxQueueAgeSec`, `postLookbackDays`, `dryRun`), `state.auth` fields (`user_id`, `username`, `access_token`, `expires_at`, `init_token_hash`, `last_refresh_attempt_at`), and `ThreadsApiError` match identically across Tasks 1–6.
3. **Review Focus check:** All 5 failure modes (`username` vs `owner.id`, non-retryable 400/404 deleted comment isolation, Unicode NFD + case-insensitive matching, self-reply/nested-reply filtering, PID lock + atomic save) have dedicated test assertions in Tasks 1, 2, 3, and 5.
