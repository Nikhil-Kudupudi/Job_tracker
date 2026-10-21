/* ════════════════════════════════════════════════════════════════
   Job Tracker — job-description parser (client half)

   Thin on purpose. The prompt, the JSON schema, the provider choice and
   the API key all live in server.py, so:
     · the key never reaches the browser
     · providers don't need to send CORS headers
     · there is one place to change when you switch models

   Requires the app to be served by server.py — opening index.html as a
   file:// URL gives you everything except parsing.
   ════════════════════════════════════════════════════════════════ */
'use strict';

window.JT_AI = (function () {

  const STATUS_URL = '/api/ai/status';
  const PARSE_URL = '/api/ai/parse';

  let cached = null;

  /** Ask the server what it's configured with. Cached after the first call. */
  async function status({ refresh = false } = {}) {
    if (cached && !refresh) return cached;

    if (location.protocol === 'file:') {
      return (cached = {
        ready: false,
        reason: 'Parsing needs the local server — run "python server.py" and ' +
                'open http://127.0.0.1:5173 instead of opening the file directly.',
        provider: '', model: '',
      });
    }

    try {
      const res = await fetch(STATUS_URL);
      if (!res.ok) throw new Error(String(res.status));
      cached = await res.json();
    } catch {
      cached = {
        ready: false,
        reason: 'The local server is not answering. Start it with "python server.py".',
        provider: '', model: '',
      };
    }
    return cached;
  }

  /**
   * @param {string} text  the pasted job description
   * @param {{titles?: string[], locations?: string[]}} known  lists to reuse
   * @returns {Promise<{fields: object, truncated: boolean, model: string}>}
   */
  async function parseJobDescription(text, known = {}) {
    const body = String(text || '').trim();
    if (body.length < 40) {
      throw new Error('That is too short to parse — paste the full posting.');
    }

    let res;
    try {
      res = await fetch(PARSE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: body, known }),
      });
    } catch {
      throw new Error('Lost contact with the local server — is "python server.py" still running?');
    }

    let data;
    try { data = await res.json(); }
    catch { throw new Error(`Server returned a non-JSON response (${res.status}).`); }

    if (!res.ok) {
      // The server already phrases these as something you can act on.
      cached = null;                       // config may have changed underneath us
      throw new Error(data.error || `Parsing failed (${res.status}).`);
    }

    /* The server normalises and the schema constrains, but the form fill in
       app.js still verifies each value against its <select> before using it. */
    const f = data.fields || {};
    return {
      fields: {
        company: f.company || '',
        title: f.title || '',
        location: f.location || '',
        jobType: f.jobType || '',
        experience: f.experience || '',
        skills: Array.isArray(f.skills) ? f.skills : [],
        platform: f.platform || '',
        url: f.url || '',
      },
      truncated: !!data.truncated,
      model: data.model || '',
    };
  }

  return { status, parseJobDescription };
})();
