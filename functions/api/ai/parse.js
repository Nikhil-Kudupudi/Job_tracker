import { json, readiness, parseJob } from './_lib.js';

export async function onRequestPost({ request, env }) {
  const state = readiness(env);
  if (!state.ready) return json(503, { error: state.reason });

  let body;
  try { body = await request.json(); }
  catch { return json(400, { error: 'Request body is not valid JSON.' }); }

  try {
    return json(200, await parseJob(env, body.text, body.known || {}));
  } catch (err) {
    return json(err.userError ? 400 : 502, { error: err.message });
  }
}

/* Anything other than POST on this path. */
export const onRequest = ({ request }) =>
  request.method === 'POST' ? undefined : json(405, { error: 'Use POST.' });
