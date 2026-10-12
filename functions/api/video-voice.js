// Cloudflare Pages Function: POST /api/video-voice
// Turns one short line of narration into natural-sounding speech with Workers AI, so the videos do not
// use the robotic built-in browser voice. Returns { audio: "data:audio/mpeg;base64,..." }.
// Nothing is stored. If the AI binding is missing or fails, the player falls back to the device voice.

const hits = new Map(); // best-effort per-IP limiter (per isolate)
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

function limited(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (list.length >= 80) { hits.set(ip, list); return true; }
  list.push(now); hits.set(ip, list);
  if (hits.size > 500) for (const k of hits.keys()) { hits.delete(k); if (hits.size < 250) break; }
  return false;
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Warm, natural voice first; a second model as a backup.
async function speak(ai, text) {
  try {
    const out = await ai.run('@cf/deepgram/aura-1', { text, speaker: 'luna' }, { returnRawResponse: true });
    const buf = out instanceof Response ? new Uint8Array(await out.arrayBuffer()) : out instanceof ArrayBuffer ? new Uint8Array(out) : out && out.audio ? null : null;
    if (buf && buf.length > 500) return 'data:audio/mpeg;base64,' + toBase64(buf);
    if (out && typeof out.audio === 'string' && out.audio.length > 500) return 'data:audio/mpeg;base64,' + out.audio;
  } catch (e) { console.error('video-voice aura', e && e.message); }
  try {
    const out = await ai.run('@cf/myshell-ai/melotts', { prompt: text, lang: 'en' });
    const a = out && (out.audio || (typeof out === 'string' ? out : ''));
    if (typeof a === 'string' && a.length > 500) return 'data:audio/mpeg;base64,' + a;
  } catch (e) { console.error('video-voice melo', e && e.message); }
  return null;
}

export async function onRequestPost({ request, env }) {
  if (!env || !env.AI) return json({ error: 'voice_off' }, 503);
  const ip = request.headers.get('CF-Connecting-IP') || 'x';
  if (limited(ip)) return json({ error: 'Too many requests. Please wait a few minutes.' }, 429);
  let body;
  try { const raw = await request.text(); if (raw.length > 2000) return json({ error: 'Too long.' }, 413); body = JSON.parse(raw); } catch (e) { return json({ error: 'Bad request.' }, 400); }
  const text = String((body && body.text) || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 320);
  if (text.length < 2) return json({ error: 'Nothing to say.' }, 400);
  const audio = await speak(env.AI, text);
  if (!audio) return json({ error: 'voice_failed' }, 503);
  return json({ audio });
}
export const onRequest = () => json({ error: 'Use POST.' }, 405);
