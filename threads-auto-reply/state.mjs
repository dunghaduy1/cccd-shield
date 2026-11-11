import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DAY_SEC = 86400;

export function createEmptyState() {
  return {
    auth: {
      user_id: '',
      username: '',
      access_token: '',
      expires_at: 0,
      init_token_hash: '',
      last_refresh_attempt_at: 0,
    },
    last_posts_sync_at: 0,
    watched_posts: {},
    comments: {},
    replied_pairs: {},
    hourly_sent_timestamps: [],
  };
}

export function loadState(stateFile) {
  if (!fs.existsSync(stateFile)) return createEmptyState();
  const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const base = createEmptyState();
  return {
    ...base,
    ...parsed,
    auth: { ...base.auth, ...(parsed.auth || {}) },
    watched_posts: parsed.watched_posts || {},
    comments: parsed.comments || {},
    replied_pairs: parsed.replied_pairs || {},
    hourly_sent_timestamps: Array.isArray(parsed.hourly_sent_timestamps)
      ? parsed.hourly_sent_timestamps
      : [],
  };
}

export function saveState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmpFile = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpFile, stateFile);
}

export function syncInitToken(state, initToken, nowSec = Math.floor(Date.now() / 1000)) {
  const hash = crypto.createHash('sha256').update(initToken).digest('hex');
  if (state.auth?.access_token && state.auth.init_token_hash === hash) {
    return { state, changed: false, source: 'state' };
  }
  state.auth = {
    user_id: '',
    username: '',
    access_token: initToken,
    expires_at: nowSec + 60 * DAY_SEC,
    init_token_hash: hash,
    last_refresh_attempt_at: 0,
  };
  return { state, changed: true, source: 'init' };
}

export function pruneState(state, nowSec = Math.floor(Date.now() / 1000)) {
  const postCutoff = nowSec - 7 * DAY_SEC;
  const commentCutoff = nowSec - 14 * DAY_SEC;
  const dayCutoff = nowSec - DAY_SEC;

  for (const [postId, post] of Object.entries(state.watched_posts)) {
    if ((post?.published_at || 0) < postCutoff) {
      delete state.watched_posts[postId];
    }
  }

  const activePostIds = new Set(Object.keys(state.watched_posts));
  for (const [commentId, c] of Object.entries(state.comments)) {
    if ((c?.created_at || 0) < commentCutoff) {
      delete state.comments[commentId];
    } else if (c?.post_id) {
      activePostIds.add(c.post_id);
    }
  }

  for (const pairKey of Object.keys(state.replied_pairs)) {
    const postId = pairKey.split(':')[0];
    if (!activePostIds.has(postId)) {
      delete state.replied_pairs[pairKey];
    }
  }

  state.hourly_sent_timestamps = state.hourly_sent_timestamps.filter((ts) => ts >= dayCutoff);
  return state;
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export function acquireLock(lockFile, pid = process.pid) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      try {
        fs.writeFileSync(fd, String(pid));
      } finally {
        fs.closeSync(fd);
      }
      return () => {
        try {
          if (fs.existsSync(lockFile) && fs.readFileSync(lockFile, 'utf8').trim() === String(pid)) {
            fs.unlinkSync(lockFile);
          }
        } catch {
          // Ignore cleanup errors on exit
        }
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const existingRaw = fs.existsSync(lockFile) ? fs.readFileSync(lockFile, 'utf8').trim() : '';
      const existingPid = Number(existingRaw);
      if (Number.isInteger(existingPid) && existingPid > 0 && isPidAlive(existingPid)) {
        throw new Error(`Worker already running (PID ${existingPid})`);
      }
      try {
        fs.unlinkSync(lockFile);
      } catch {
        // Race with another process
      }
    }
  }
  throw new Error(`Failed to acquire lock at ${lockFile}`);
}

export function canSendReply(state, maxPerHour, maxPerDay, nowSec = Math.floor(Date.now() / 1000)) {
  const hourCutoff = nowSec - 3600;
  const dayCutoff = nowSec - DAY_SEC;
  let hourCount = 0;
  let dayCount = 0;
  for (const ts of state.hourly_sent_timestamps) {
    if (ts >= dayCutoff) {
      dayCount++;
      if (ts >= hourCutoff) hourCount++;
    }
  }
  if (maxPerHour > 0 && hourCount >= maxPerHour) {
    return { allowed: false, reason: `hourly cap reached (${hourCount}/${maxPerHour})` };
  }
  if (maxPerDay > 0 && dayCount >= maxPerDay) {
    return { allowed: false, reason: `daily cap reached (${dayCount}/${maxPerDay})` };
  }
  return { allowed: true };
}
