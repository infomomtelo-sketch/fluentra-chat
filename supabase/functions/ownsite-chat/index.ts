// Supabase Edge Function: ownsite-chat  (deploy to the nwlhs project)
// Request:  POST { system, userMessage, mode? }  with  Authorization: Bearer <user JWT>
//           mode "handoff" (Claude Code prompt writer) needs at least one token purchase.
// Response: JSON { text, usage:{used,limit,plan,credits} }  or  { error, code }
// Tokens: 30,000 free every month (used first), then bought credits (never expire).
// Secrets: ANTHROPIC_API_KEY  (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are built in)
// Needs: supabase/ownsite_credits.sql
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const MODEL = "claude-sonnet-5-5";
const MAX_TOKENS = 16000;
const MAX_SYSTEM_CHARS = 30000;
const MAX_USER_CHARS = 8000;
const KEEPALIVE_MS = 10000;
const FREE_LIMIT = 30000;   // free tokens per month

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

const BUILD_NOTE =
  "\n\nWhen you output a full HTML page, always finish it completely: keep CSS and JS compact and end with </html>.";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

async function run(uid: string, system: string, userMessage: string) {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return { error: "Server is missing ANTHROPIC_API_KEY.", code: "server" };

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: system + BUILD_NOTE,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  if (!r.ok) {
    console.error("Anthropic error", r.status, await r.text().catch(() => ""));
    return { error: r.status === 429 ? "Busy right now. Try again in a moment." : "AI service unavailable. Try again.", code: "upstream" };
  }
  const data = await r.json();
  const text = (data.content ?? [])
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("");
  if (!text) return { error: "Empty reply. Try again.", code: "empty" };

  const spent = (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0);
  const { data: bal, error } = await admin.rpc("ownsite_charge", { p_user: uid, p_tokens: spent, p_free_limit: FREE_LIMIT });
  if (error) console.error("charge failed", error.message);
  const row = Array.isArray(bal) ? bal[0] : bal;
  return { text, usage: { used: Number(row?.out_used ?? 0), limit: FREE_LIMIT, plan: "free", credits: Number(row?.out_credits ?? 0) } };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Sign in to use OwnSite.", code: "auth" }, 401);
  const { data: u, error: uerr } = await admin.auth.getUser(jwt);
  if (uerr || !u?.user) return json({ error: "Session expired. Sign in again.", code: "auth" }, 401);
  const uid = u.user.id;

  let system = "", userMessage = "", mode = "";
  try {
    const b = await req.json();
    system = typeof b?.system === "string" ? b.system.slice(0, MAX_SYSTEM_CHARS) : "";
    userMessage = typeof b?.userMessage === "string" ? b.userMessage.slice(0, MAX_USER_CHARS) : "";
    mode = typeof b?.mode === "string" ? b.mode : "";
  } catch { /* fall through */ }
  if (!userMessage.trim()) return json({ error: "No message provided.", code: "input" }, 400);

  const period = new Date(); period.setUTCDate(1);
  const [{ data: row }, { data: cr }] = await Promise.all([
    admin.from("ownsite_usage").select("tokens_used")
      .eq("user_id", uid).eq("period", period.toISOString().slice(0, 10)).maybeSingle(),
    admin.from("ownsite_credits").select("tokens, ever_bought").eq("user_id", uid).maybeSingle(),
  ]);
  const used = Number(row?.tokens_used ?? 0);
  const credits = Number(cr?.tokens ?? 0);
  const usage = { used, limit: FREE_LIMIT, plan: "free", credits };

  if (mode === "handoff" && !cr?.ever_bought) {
    return json({ error: "The Claude Code prompt unlocks with any token purchase.", code: "locked", usage });
  }
  if (used >= FREE_LIMIT && credits <= 0) {
    return json({ error: "You're out of tokens.", code: "limit", usage });
  }

  // Keep the connection alive with whitespace during long builds.
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(c) {
      const t = setInterval(() => { try { c.enqueue(enc.encode(" ")); } catch { /* closed */ } }, KEEPALIVE_MS);
      try {
        c.enqueue(enc.encode(JSON.stringify(await run(uid, system, userMessage))));
      } catch (e) {
        console.error("ownsite-chat error", e);
        c.enqueue(enc.encode(JSON.stringify({ error: "Unexpected error. Try again.", code: "server" })));
      } finally { clearInterval(t); c.close(); }
    },
  });
  return new Response(stream, { headers: { ...cors, "Content-Type": "application/json" } });
});
