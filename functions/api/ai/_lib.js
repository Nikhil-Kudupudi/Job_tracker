/* ════════════════════════════════════════════════════════════════
   Shared logic for the Cloudflare Pages Functions under /api/ai/*.

   Files starting with "_" are not routed, so this is a plain module.

   ⚠ This mirrors the same prompt, schema and normalisation in
   server.py, which serves these identical routes for local
   development. Change one, change the other.
   ════════════════════════════════════════════════════════════════ */

export const SYSTEM = `You extract structured data from job postings.

Rules:
- Extract only what the posting actually states. Use null when it is absent or unclear. Never guess, never infer from the company's reputation, never fill a field with a plausible default.
- "company" is the hiring employer, not a staffing agency posting on its behalf, and not the job board.
- "title" is the role title alone, stripped of location, req IDs, and employment type — "Senior Data Engineer, Remote (R12345)" becomes "Senior Data Engineer". Keep seniority words that belong to the title (Junior, Senior, Staff, Principal, Lead, I/II/III); they distinguish genuinely different roles.
- "location" is the primary city and region, e.g. "Boston, MA". For a fully remote role with no city, use "Remote". For several locations, take the first.
- "jobType" needs evidence. "Hybrid" requires an explicit mention of splitting time or required days on site. If the posting only names a city with no arrangement stated, return null rather than assuming.
- "experience" is the stated requirement, kept short and close to the source: "3+ years", "5-7 years", "Entry level".
- "skills" are concrete, named technical skills and tools — languages, frameworks, databases, platforms, methods. At most 12, most central first, in the posting's own spelling. Exclude soft skills, degrees, and generic phrases like "strong communication".
- "platform" is where this posting was found: "LinkedIn" only if the text clearly comes from LinkedIn, "Company site" if it is the employer's own careers page. Otherwise null.
- "url" only if an application URL appears literally in the text.`;

export const SCHEMA = {
  type: 'object',
  properties: {
    company:    { type: ['string', 'null'] },
    title:      { type: ['string', 'null'] },
    location:   { type: ['string', 'null'] },
    jobType:    { type: ['string', 'null'], enum: ['Remote', 'Hybrid', 'On site', null] },
    experience: { type: ['string', 'null'] },
    skills:     { type: 'array', items: { type: 'string' } },
    platform:   { type: ['string', 'null'], enum: ['LinkedIn', 'Company site', null] },
    url:        { type: ['string', 'null'] },
  },
  required: ['company', 'title', 'location', 'jobType', 'experience',
             'skills', 'platform', 'url'],
  additionalProperties: false,
};

const JOB_TYPES = ['Remote', 'Hybrid', 'On site'];
const PLATFORMS = ['LinkedIn', 'Company site'];
const EMPTYISH = new Set(['null', 'none', 'n/a', 'na', 'not specified', 'unspecified',
                          'unknown', 'not stated', 'not mentioned', '']);

export const MAX_CHARS = 24000;

/* ─────────────────────────── config ─────────────────────────── */

export function settings(env) {
  const key = (env.ANTHROPIC_API_KEY || env.AI_API_KEY || '').trim();
  const model = (env.AI_MODEL || '').trim();
  const upstream = (env.AI_UPSTREAM_URL || '').trim();
  const explicit = (env.AI_PROVIDER || '').trim().toLowerCase();

  let provider = 'openai';
  if (explicit === 'anthropic' || explicit === 'openai') provider = explicit;
  else if (key.startsWith('sk-ant-') || model.startsWith('claude-')) provider = 'anthropic';

  return { key, model, upstream, provider };
}

export function readiness(env) {
  const s = settings(env);
  if (!s.key) {
    return { ready: false, reason:
      'No API key configured on the server. In the Cloudflare dashboard, add ' +
      'AI_API_KEY under Settings → Variables and secrets, then redeploy.' };
  }
  if (!s.model) {
    return { ready: false, reason: 'Set AI_MODEL in the Cloudflare environment variables.' };
  }
  if (s.provider === 'openai' && !s.upstream) {
    return { ready: false, reason:
      "Set AI_UPSTREAM_URL to your provider's /chat/completions endpoint." };
  }
  return { ready: true, reason: '' };
}

export const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

/* ─────────────────────── prompt & cleanup ───────────────────── */

export function userPrompt(text, known) {
  const parts = [];
  const titles = known?.titles || [];
  const locations = known?.locations || [];
  if (titles.length) {
    parts.push("Job titles already in the user's list. Reuse one verbatim ONLY if " +
      "it matches the posting's role AND its seniority exactly; otherwise use the " +
      "posting's own title. Never drop a seniority word to force a match:\n" +
      titles.slice(0, 60).join(', '));
  }
  if (locations.length) {
    parts.push('Locations already in the list, same instruction:\n' +
      locations.slice(0, 60).join(', '));
  }
  parts.push('Job posting:\n\n' + text);
  return parts.join('\n\n');
}

const str = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v).trim();
  return EMPTYISH.has(s.toLowerCase()) ? '' : s;
};

function oneOf(value, allowed) {
  const v = str(value).toLowerCase().replace(/[\s_-]+/g, '');
  return allowed.find((a) => a.toLowerCase().replace(/[\s_-]+/g, '') === v) || '';
}

export function normalize(obj) {
  let raw = obj.skills || [];
  if (typeof raw === 'string') raw = raw.split(/[,;]/);

  const skills = [];
  const seen = new Set();
  for (const item of raw) {
    const s = str(item);
    if (!s || s.length > 40 || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    skills.push(s);
    if (skills.length >= 12) break;
  }

  let url = str(obj.url);
  if (url && !/^https?:\/\//i.test(url)) url = '';

  return {
    company: str(obj.company),
    title: str(obj.title),
    location: str(obj.location),
    jobType: oneOf(obj.jobType, JOB_TYPES),
    experience: str(obj.experience),
    skills,
    platform: oneOf(obj.platform, PLATFORMS),
    url,
  };
}

/** Providers without schema support wrap JSON in prose or fences. */
export function extractJson(raw) {
  let text = String(raw).trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) text = fenced[1].trim();
  try { return JSON.parse(text); } catch { /* fall through */ }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* fall through */ }
  }
  throw new Error("Could not read JSON out of the model's reply.");
}

/* ─────────────────────────── providers ──────────────────────── */

async function callOpenAICompatible(s, text, known) {
  const body = {
    model: s.model,
    temperature: 0,
    messages: [
      { role: 'system',
        content: SYSTEM +
          '\n\nReturn ONLY a JSON object matching this schema, no prose:\n' +
          JSON.stringify(SCHEMA) },
      { role: 'user', content: userPrompt(text, known) },
    ],
  };

  const send = (payload) => fetch(s.upstream, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${s.key}`,
    },
    body: JSON.stringify(payload),
  });

  let res = await send({ ...body, response_format: { type: 'json_object' } });

  // Not every backend behind a router accepts response_format.
  if (res.status === 400) {
    const detail = await res.text();
    if (detail.includes('response_format')) res = await send(body);
    else throw new Error(`Provider returned 400: ${detail.slice(0, 300)}`);
  }

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    if (res.status === 503) {
      throw new Error(
        `The model "${s.model}" is busy right now (503). Try again in a moment, ` +
        'or set AI_MODEL to a different one.');
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Provider rejected the API key (${res.status}). ${detail}`);
    }
    if (res.status === 404) {
      throw new Error(`Model "${s.model}" not found (404). Check AI_MODEL. ${detail}`);
    }
    if (res.status === 429) throw new Error('Rate limited (429) — wait and retry.');
    throw new Error(`Provider returned ${res.status}: ${detail}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Model returned an empty response.');
  return extractJson(content);
}

async function callAnthropic(s, text, known) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': s.key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: s.model,
      max_tokens: 2048,
      system: SYSTEM,
      messages: [{ role: 'user', content: userPrompt(text, known) }],
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    }),
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 400);
    if (detail.includes('credit balance is too low')) {
      throw new Error('Your Anthropic account has no credit. Add some under ' +
        'Plans & Billing, or switch AI_MODEL to another provider.');
    }
    if (res.status === 401) throw new Error('Anthropic rejected the API key.');
    throw new Error(`Anthropic returned ${res.status}: ${detail}`);
  }

  const data = await res.json();
  const block = (data.content || []).find((b) => b.type === 'text');
  if (!block) throw new Error('Model returned an empty response.');
  return JSON.parse(block.text);
}

export async function parseJob(env, text, known) {
  const body = String(text || '').trim();
  if (body.length < 40) {
    const err = new Error('That is too short to parse — paste the full posting.');
    err.userError = true;
    throw err;
  }

  const s = settings(env);
  const truncated = body.length > MAX_CHARS;
  const payload = truncated ? body.slice(0, MAX_CHARS) : body;

  const raw = s.provider === 'anthropic'
    ? await callAnthropic(s, payload, known)
    : await callOpenAICompatible(s, payload, known);

  return { fields: normalize(raw), truncated, model: s.model, provider: s.provider };
}
