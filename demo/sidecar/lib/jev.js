// Jev AI proxy: forwards to https://api.typesafe.ai, or synthesizes
// deterministic answers when no credentials are available at all.

import { mulberry32, hashSeed } from './prng.js';

const UPSTREAM = 'https://api.typesafe.ai';

// Live mode is enabled by TYPESAFE_API_KEY. Without it (demo mode) answers are
// always synthesized, even when the caller sends its own Authorization header
// (e.g. a placeholder key in a demo secret) — forwarding a demo key upstream
// would just 401. The placeholder 'Bearer demo' that the web app sends when no
// key is entered is treated as absent in both modes.
function jevAuth(incoming) {
  const own = incoming && incoming !== 'Bearer demo' ? incoming : null;
  if (!process.env.TYPESAFE_API_KEY) return null;
  if (own) return own;
  return `Bearer ${process.env.TYPESAFE_API_KEY}`;
}

export function jevHasAuth(incoming) {
  return jevAuth(incoming) !== null;
}

export async function jevProxy(path, method, incomingAuth, body) {
  const headers = { authorization: jevAuth(incomingAuth) };
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const res = await fetch(`${UPSTREAM}${path}`, { method, headers, body: payload });
  const text = await res.text();
  return { status: res.status, body: text };
}

// ---- synthetic mode ----

function round4(x) {
  return Math.round(x * 10000) / 10000;
}

function normalizedProbs(rand, keys) {
  const raw = keys.map(() => 0.05 + rand());
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((r) => round4(r / sum));
}

function synthAnswer(name, q, bodyKey) {
  const rand = mulberry32(hashSeed(bodyKey, name));
  const type = q?.type;
  if (type === 'choice') {
    const options = Object.keys(q.criteria || {});
    if (options.length === 0) return { choice: '', probabilities: {}, confidence: 0 };
    const probs = normalizedProbs(rand, options);
    let pick = rand();
    let idx = 0;
    for (let i = 0; i < probs.length; i++) {
      pick -= probs[i];
      if (pick <= 0) {
        idx = i;
        break;
      }
    }
    const probabilities = Object.fromEntries(options.map((o, i) => [o, probs[i]]));
    return { choice: options[idx], probabilities, confidence: probs[idx] };
  }
  if (type === 'score') {
    const rubric = Array.isArray(q.criteria) ? q.criteria : [];
    const max = Math.max(rubric.length - 1, 0);
    const probs = normalizedProbs(rand, rubric.length ? rubric : [0]);
    const score = max === 0 ? 0 : round4(rand() * max);
    const idx = Math.min(Math.round(score), probs.length - 1);
    return {
      score,
      legend: rubric,
      probabilities: probs,
      confidence: probs[Math.max(idx, 0)] ?? 0,
    };
  }
  if (type === 'noul') {
    return { noul: round4(rand()) };
  }
  return { noul: round4(rand()) };
}

export function jevSynthSystemone(rawBody) {
  let parsed = {};
  try {
    parsed = JSON.parse(rawBody || '{}');
  } catch {
    /* keep empty */
  }
  const questions = parsed.questions && typeof parsed.questions === 'object' ? parsed.questions : {};
  const answers = {};
  for (const [name, q] of Object.entries(questions)) {
    answers[name] = synthAnswer(name, q, rawBody || '');
  }
  const answersJson = JSON.stringify(answers);
  return {
    model: 'jev-1.13.0',
    answers,
    usage: {
      input_tokens: Math.ceil((rawBody || '').length / 4),
      output_tokens: Math.ceil(answersJson.length / 4),
    },
  };
}

export function jevSynthModels() {
  return [{ id: 'jev-latest' }];
}
