export class ThreadsApiError extends Error {
  constructor(message, { status = 0, code = undefined, retryable = false } = {}) {
    super(message);
    this.name = 'ThreadsApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

function sanitizeErrorText(text) {
  return String(text || '').replace(/access_token=[^&\s]+/gi, 'access_token=[REDACTED]');
}

export function createThreadsClient({
  fetchImpl = fetch,
  baseUrl = 'https://graph.threads.net',
} = {}) {
  const root = baseUrl.replace(/\/+$/, '');

  async function request(url, { method = 'GET', accessToken, form } = {}) {
    const headers = {};
    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`;
    }
    let body;
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(form).toString();
    }

    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      throw new ThreadsApiError(
        `Threads network error: ${sanitizeErrorText(err?.message || err)}`,
        { status: 0, retryable: true }
      );
    }

    const raw = await res.text();
    let json = {};
    if (raw) {
      try {
        json = JSON.parse(raw);
      } catch {
        json = {};
      }
    }

    if (!res.ok) {
      const apiErr = json?.error || {};
      const msg = sanitizeErrorText(apiErr.message || `Threads API HTTP ${res.status}`);
      const retryable = res.status === 429 || res.status >= 500;
      throw new ThreadsApiError(msg, {
        status: res.status,
        code: apiErr.code,
        retryable,
      });
    }

    return json;
  }

  return {
    async getMe(accessToken) {
      return request(`${root}/v1.0/me?fields=id,username`, { accessToken });
    },

    async getUserThreads(userId, accessToken, limit = 25) {
      const params = new URLSearchParams({
        fields: 'id,text,permalink,timestamp',
        limit: String(limit),
      });
      const json = await request(
        `${root}/v1.0/${encodeURIComponent(userId)}/threads?${params.toString()}`,
        { accessToken }
      );
      return Array.isArray(json.data) ? json.data : [];
    },

    async getReplies(mediaId, accessToken) {
      const params = new URLSearchParams({
        fields: 'id,text,username,owner,timestamp,has_replies,replied_to',
      });
      const json = await request(
        `${root}/v1.0/${encodeURIComponent(mediaId)}/replies?${params.toString()}`,
        { accessToken }
      );
      return Array.isArray(json.data) ? json.data : [];
    },

    async replyToComment(userId, commentId, text, accessToken) {
      const uid = encodeURIComponent(userId);
      const created = await request(`${root}/v1.0/${uid}/threads`, {
        method: 'POST',
        accessToken,
        form: {
          media_type: 'TEXT',
          text,
          reply_to_id: commentId,
        },
      });
      if (!created?.id) {
        throw new ThreadsApiError('Threads create container returned no id', {
          status: 502,
          retryable: true,
        });
      }
      return request(`${root}/v1.0/${uid}/threads_publish`, {
        method: 'POST',
        accessToken,
        form: {
          creation_id: created.id,
        },
      });
    },

    async refreshLongLivedToken(accessToken) {
      const params = new URLSearchParams({
        grant_type: 'th_refresh_token',
        access_token: accessToken,
      });
      return request(`${root}/refresh_access_token?${params.toString()}`);
    },
  };
}
