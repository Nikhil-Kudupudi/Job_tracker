import { json, readiness, settings } from './_lib.js';

export function onRequestGet({ env }) {
  const s = settings(env);
  return json(200, { ...readiness(env), provider: s.provider, model: s.model });
}
