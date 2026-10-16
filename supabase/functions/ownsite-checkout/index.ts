// Supabase Edge Function: ownsite-checkout  (deploy to the nwlhs project, Verify JWT on)
// Buy OwnSite tokens: ONE-TIME payment, no subscription, nothing renews.
// Request:  POST { dollars }  (whole dollars, 5 to 100)  with  Authorization: Bearer <user JWT>
// Response: { url } (Stripe Checkout) or { error, code }
// Rate: $20 per 1,000,000 tokens  ->  50,000 tokens per dollar. Tokens never expire.
// Secrets: OWNSITE_STRIPE_KEY (restricted key: Checkout Sessions Write)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SITE = "https://ownsite.app/";
// The builder also runs at tello.live/build, so the buyer returns to the page they started from.
const RETURN_PAGES = new Set(["https://ownsite.app/", "https://tello.live/build"]);
const TOKENS_PER_DOLLAR = 50000;
const MIN_DOLLARS = 5;
const MAX_DOLLARS = 100;

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const key = (Deno.env.get("OWNSITE_STRIPE_KEY") || "").trim();
  if (!key) return json({ error: "Checkout is not set up yet.", code: "server" }, 500);

  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Sign in first.", code: "auth" }, 401);
  const { data: u, error: uerr } = await admin.auth.getUser(jwt);
  if (uerr || !u?.user) return json({ error: "Session expired. Sign in again.", code: "auth" }, 401);
  const uid = u.user.id;
  const email = u.user.email ?? "";

  let dollars = 0, back = SITE;
  try {
    const b = await req.json();
    dollars = Number(b?.dollars);
    if (typeof b?.return_to === "string" && RETURN_PAGES.has(b.return_to)) back = b.return_to;
  } catch { /* fall through */ }
  if (!Number.isInteger(dollars) || dollars < MIN_DOLLARS || dollars > MAX_DOLLARS) {
    return json({ error: `Choose a whole-dollar amount from $${MIN_DOLLARS} to $${MAX_DOLLARS}.`, code: "input" }, 400);
  }
  const tokens = dollars * TOKENS_PER_DOLLAR;

  const f = new URLSearchParams();
  f.set("mode", "payment");
  f.set("line_items[0][price_data][currency]", "usd");
  f.set("line_items[0][price_data][unit_amount]", String(dollars * 100));
  f.set("line_items[0][price_data][product_data][name]", `OwnSite tokens (${(tokens / 1000).toLocaleString("en-US")}k)`);
  f.set("line_items[0][price_data][product_data][description]", "One-time purchase. Tokens never expire. No subscription.");
  f.set("line_items[0][quantity]", "1");
  f.set("client_reference_id", uid);
  if (email) f.set("customer_email", email);
  f.set("success_url", back + "?bought=1");
  f.set("cancel_url", back);
  f.set("metadata[app]", "ownsite");
  f.set("metadata[user_id]", uid);
  f.set("metadata[tokens]", String(tokens));
  f.set("payment_intent_data[metadata][app]", "ownsite");
  f.set("payment_intent_data[metadata][user_id]", uid);
  f.set(
    "custom_text[submit][message]",
    "One-time payment. No subscription and nothing renews. Tokens never expire.",
  );

  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/x-www-form-urlencoded" },
    body: f,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.url) {
    console.error("stripe checkout error", r.status, JSON.stringify(d?.error ?? d));
    return json({ error: "Could not start checkout. Try again.", code: "upstream" }, 502);
  }
  return json({ url: d.url });
});
