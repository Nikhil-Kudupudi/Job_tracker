import { json, settings } from './_lib.js';

/** Lists what the configured key can actually reach. */
export async function onRequestGet({ env }) {
  const s = settings(env);
  if (s.provider === 'anthropic') {
    return json(200, { note: 'Anthropic model ids are fixed — set AI_MODEL ' +
      '(claude-haiku-4-5, claude-sonnet-5, claude-opus-5).' });
  }
  if (!s.upstream) return json(400, { error: 'No AI_UPSTREAM_URL configured.' });

  const url = s.upstream.replace(/\/(chat\/completions|responses)$/, '/models');
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${s.key}` } });
    return new Response(await res.text(), {
      status: res.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    return json(502, { error: `Could not reach the provider: ${err.message}` });
  }
}
