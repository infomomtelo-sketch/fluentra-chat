// Supabase Edge Function: ownsite-build  (deploy to the nwlhs project, Verify JWT on)
// Multi-page static site builder. Two actions, both POST with Authorization: Bearer <user JWT>:
//   { action:"plan", idea }            -> { buildId, plan, estimate, reserved, remaining, usage }
//                                         or { handoff:true, reason } (too big for a static site)
//                                         or { code:"short", need, remaining }
//   { action:"page", buildId, file }   -> { file, html, usage, done }
// Anti-trap rules: the quote is shown before anything is built; the user can never be charged more
// than `reserved` (125% of the quote); only pages that were actually delivered are charged;
// anything beyond the reserve is absorbed by us.
// Secrets: ANTHROPIC_API_KEY (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are built in)
// Tables: ownsite_builds, ownsite_credits (see supabase/ownsite_builds.sql and ownsite_credits.sql)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const MODEL = "claude-sonnet-5-5";
const FREE_LIMIT = 30000;       // free tokens per month; bought credits are used after these
const PAGE_EST = 7000;          // tokens (input + output) quoted per page
const RESERVE_FACTOR = 1.25;    // most a user can be charged = quote x 1.25
const HARD_CAP_FACTOR = 2;      // we stop trying after the AI has used quote x 2 (we absorb the extra)
const MAX_PAGES = 6;
const MAX_IDEA_CHARS = 4000;
const PLAN_MAX_TOKENS = 2500;
const PAGE_MAX_TOKENS = 12000;
const KEEPALIVE_MS = 10000;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "Content-Type": "application/json" } });

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const RULES =
  "Hard rules for all content: never invent testimonials, reviews, statistics, awards, licenses, certifications, prices, " +
  "addresses, phone numbers or claims. Where real information is needed use clear placeholders in square brackets such as " +
  "[YOUR BUSINESS NAME] or [YOUR PHONE]. No fake photos: use CSS shapes, gradients or emoji-free text design instead of images. " +
  "No legal, tax or medical claims.";

const PLAN_SYSTEM =
  "You are the planner for OwnSite, which builds small STATIC websites (plain HTML, CSS and a little JavaScript, no server, " +
  "no database, no logins, no payments). Read the user's idea and reply with ONLY one JSON object, no prose, no code fence:\n" +
  '{"title":"short site name","summary":"one sentence","too_big":false,"reason":"","css":"...","pages":[{"file":"index.html","title":"Home","purpose":"what this page contains"}]}\n' +
  "Rules:\n" +
  "- pages: 1 to " + MAX_PAGES + " pages. First must be index.html. File names are lowercase letters, numbers and hyphens, ending .html. Choose the fewest pages that serve the idea.\n" +
  "- css: ONE compact shared stylesheet (under 2500 characters) with CSS variables for colors and fonts, a responsive nav, buttons, sections, cards and footer, mobile-first, readable text sizes, accessible contrast. Every page will include it verbatim.\n" +
  "- too_big: set true (and give a one-sentence reason, pages may be empty) when the idea truly needs user accounts or logins, a database, payments, server code, or more than " + MAX_PAGES + " pages.\n" +
  RULES;

const pageSystem = (title: string, css: string, pages: { file: string; title: string }[]) =>
  "You are OwnSite. Write ONE complete HTML page of a small static website. Output ONLY the HTML, starting with <!doctype html> and ending with </html>. No explanation, no code fence.\n" +
  "Site: " + title + "\n" +
  "All pages (use exactly these relative links in the nav and footer, same nav on every page):\n" +
  pages.map((p) => "- " + p.file + " : " + p.title).join("\n") + "\n" +
  "Put this shared CSS verbatim inside one <style> tag in <head>, and you may add a few page-specific rules after it:\n" + css + "\n" +
  "Include <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">. Keep CSS and JS compact and finish the page completely. " +
  RULES;

async function allowance(uid: string) {
  const period = new Date(); period.setUTCDate(1);
  const [{ data: row }, { data: cr }] = await Promise.all([
    admin.from("ownsite_usage").select("tokens_used")
      .eq("user_id", uid).eq("period", period.toISOString().slice(0, 10)).maybeSingle(),
    admin.from("ownsite_credits").select("tokens").eq("user_id", uid).maybeSingle(),
  ]);
  const used = Number(row?.tokens_used ?? 0);
  const credits = Number(cr?.tokens ?? 0);
  return { used, credits, available: Math.max(0, FREE_LIMIT - used) + credits };
}

// Free monthly tokens first, then bought credits; never below zero (extra is absorbed by us).
async function charge(uid: string, tokens: number) {
  if (tokens <= 0) return null;
  const { data, error } = await admin.rpc("ownsite_charge", { p_user: uid, p_tokens: tokens, p_free_limit: FREE_LIMIT });
  if (error) { console.error("charge failed", error.message); return null; }
  const row = Array.isArray(data) ? data[0] : data;
  return { used: Number(row?.out_used ?? 0), credits: Number(row?.out_credits ?? 0) };
}

const usageOf = (used: number, credits: number) => ({ used, limit: FREE_LIMIT, plan: "free", credits });

async function claude(system: string, user: string, maxTokens: number) {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return { error: "Server is missing ANTHROPIC_API_KEY.", code: "server" } as const;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  if (!r.ok) {
    console.error("Anthropic error", r.status, await r.text().catch(() => ""));
    return { error: r.status === 429 ? "Busy right now. Try again in a moment." : "AI service unavailable. Try again.", code: "upstream" } as const;
  }
  const d = await r.json();
  const text = (d.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("");
  const spent = (d.usage?.input_tokens ?? 0) + (d.usage?.output_tokens ?? 0);
  return { text, spent, stop: d.stop_reason as string } as const;
}

type PlanPage = { file: string; title: string; purpose: string };
type Plan = { title: string; summary: string; too_big: boolean; reason: string; css: string; pages: PlanPage[] };

function parsePlan(text: string): Plan | null {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const p = JSON.parse(text.slice(a, b + 1));
    const pages: PlanPage[] = (Array.isArray(p.pages) ? p.pages : []).slice(0, MAX_PAGES).map((x: PlanPage) => ({
      file: String(x?.file ?? "").toLowerCase(),
      title: String(x?.title ?? "").slice(0, 60),
      purpose: String(x?.purpose ?? "").slice(0, 300),
    }));
    const seen = new Set<string>();
    for (const x of pages) {
      if (!/^[a-z0-9-]{1,30}\.html$/.test(x.file) || seen.has(x.file)) return null;
      seen.add(x.file);
    }
    const tooBig = !!p.too_big;
    if (!tooBig && (pages.length === 0 || pages[0].file !== "index.html")) return null;
    return {
      title: String(p.title ?? "Your site").slice(0, 80),
      summary: String(p.summary ?? "").slice(0, 300),
      too_big: tooBig,
      reason: String(p.reason ?? "").slice(0, 300),
      css: String(p.css ?? "").slice(0, 3500),
      pages,
    };
  } catch { return null; }
}

async function doPlan(uid: string, idea: string) {
  const a = await allowance(uid);
  if (a.available <= 0) {
    return { error: "You're out of tokens.", code: "limit", usage: usageOf(a.used, a.credits) };
  }
  const r = await claude(PLAN_SYSTEM, idea, PLAN_MAX_TOKENS);
  if ("error" in r) return r;
  const after = await charge(uid, r.spent);                 // the plan itself is small and is charged normally
  const used = after?.used ?? a.used;
  const credits = after?.credits ?? a.credits;
  const usage = usageOf(used, credits);
  const plan = parsePlan(r.text);
  if (!plan) return { error: "Could not plan that. Try describing it a little differently.", code: "plan", usage };
  if (plan.too_big) return { handoff: true, reason: plan.reason || "This needs more than a static site.", usage };

  const estimate = plan.pages.length * PAGE_EST;
  const reserved = Math.ceil(estimate * RESERVE_FACTOR);
  const remaining = Math.max(0, FREE_LIMIT - used) + credits;
  if (remaining < reserved) {
    return { code: "short", error: "Not enough tokens left for this build.", need: reserved, remaining, estimate, plan, usage };
  }
  const { data, error } = await admin.from("ownsite_builds")
    .insert({ user_id: uid, idea, plan, estimate, reserved }).select("id").single();
  if (error || !data) {
    console.error("build insert failed", error?.message);
    return { error: "Could not start the build. Try again.", code: "server", usage };
  }
  return { buildId: data.id, plan, estimate, reserved, remaining, usage };
}

async function doPage(uid: string, buildId: string, file: string) {
  const { data: b } = await admin.from("ownsite_builds").select("*").eq("id", buildId).eq("user_id", uid).maybeSingle();
  if (!b) return { error: "Build not found.", code: "notfound" };
  const plan = b.plan as Plan;
  if (!plan.pages.some((p) => p.file === file)) return { error: "Unknown page.", code: "input" };
  const files = (b.files ?? {}) as Record<string, string>;
  const a = await allowance(uid);
  const usage = usageOf(a.used, a.credits);
  const doneNow = (f: Record<string, string>) => plan.pages.every((p) => f[p.file]);

  if (files[file]) return { file, html: files[file], usage, done: doneNow(files) };           // already built: free
  if (b.actual >= b.estimate * HARD_CAP_FACTOR) {
    return { error: "This build hit its safety limit. What was finished is kept and you were not charged for the rest.", code: "cap", usage };
  }

  const p = plan.pages.find((x) => x.file === file)!;
  const r = await claude(
    pageSystem(plan.title, plan.css, plan.pages),
    "Write " + file + " now (" + p.title + "). Purpose: " + p.purpose + "\nSite idea from the owner: " + String(b.idea).slice(0, MAX_IDEA_CHARS),
    PAGE_MAX_TOKENS,
  );
  if ("error" in r) return { ...r, usage };
  // Whatever the AI used counts against our safety limit, but a page the user never received is never charged.
  const actual = b.actual + r.spent;
  let html = r.text.trim().replace(/^```(?:html)?[ \t]*\n?/i, "").replace(/\n?```\s*$/, "").trim();
  const complete = r.stop !== "max_tokens" && /<\/html>\s*$/i.test(html) && /<!doctype html/i.test(html);
  if (!complete) {
    await admin.from("ownsite_builds").update({ actual, status: "building", updated_at: new Date().toISOString() }).eq("id", buildId);
    return { error: "That page came out cut off. You were not charged for it. Try again.", code: "truncated", usage };
  }

  const chargeNow = Math.min(r.spent, Math.max(0, b.reserved - b.charged));   // never above the reserve
  files[file] = html;
  const done = doneNow(files);
  await admin.from("ownsite_builds").update({
    files, actual, charged: b.charged + chargeNow, status: done ? "done" : "building", updated_at: new Date().toISOString(),
  }).eq("id", buildId);
  const after = await charge(uid, chargeNow);
  return { file, html, usage: after ? usageOf(after.used, after.credits) : usage, done };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Sign in to use OwnSite.", code: "auth" }, 401);
  const { data: u, error: uerr } = await admin.auth.getUser(jwt);
  if (uerr || !u?.user) return json({ error: "Session expired. Sign in again.", code: "auth" }, 401);
  const uid = u.user.id;

  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try { body = await req.json(); } catch { /* fall through */ }
  const action = body?.action;
  if (action === "plan") {
    const idea = typeof body.idea === "string" ? body.idea.trim().slice(0, MAX_IDEA_CHARS) : "";
    if (!idea) return json({ error: "Describe the site you want.", code: "input" }, 400);
  } else if (action === "page") {
    if (typeof body.buildId !== "string" || typeof body.file !== "string") return json({ error: "Bad request.", code: "input" }, 400);
  } else return json({ error: "Unknown action.", code: "input" }, 400);

  // Keep the connection alive with whitespace during long AI calls.
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(c) {
      const t = setInterval(() => { try { c.enqueue(enc.encode(" ")); } catch { /* closed */ } }, KEEPALIVE_MS);
      try {
        const out = action === "plan"
          ? await doPlan(uid, String(body.idea).trim().slice(0, MAX_IDEA_CHARS))
          : await doPage(uid, body.buildId, body.file);
        c.enqueue(enc.encode(JSON.stringify(out)));
      } catch (e) {
        console.error("ownsite-build error", e);
        c.enqueue(enc.encode(JSON.stringify({ error: "Unexpected error. Try again.", code: "server" })));
      } finally { clearInterval(t); c.close(); }
    },
  });
  return new Response(stream, { headers: { ...cors, "Content-Type": "application/json" } });
});
