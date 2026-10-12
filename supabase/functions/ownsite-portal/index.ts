// Supabase Edge Function: ownsite-portal  (deploy to the nwlhs project, Verify JWT on)
// Request:  POST {}  with  Authorization: Bearer <user JWT>
// Response: { url } (Stripe Customer Portal: cancel, update card, invoices) or { error, code }
// Secrets: OWNSITE_STRIPE_KEY (restricted key needs: Subscriptions Read, Customer portal Write)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SITE = "https://ownsite.app/";

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
  if (!key) return json({ error: "Billing is not set up yet.", code: "server" }, 500);

  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Sign in first.", code: "auth" }, 401);
  const { data: u, error: uerr } = await admin.auth.getUser(jwt);
  if (uerr || !u?.user) return json({ error: "Session expired. Sign in again.", code: "auth" }, 401);

  const { data: prof } = await admin
    .from("profiles").select("ownsite_subscription_id").eq("id", u.user.id).maybeSingle();
  const subId = prof?.ownsite_subscription_id;
  if (!subId) return json({ error: "No active subscription found.", code: "none" });

  const auth = { Authorization: "Bearer " + key };
  const sr = await fetch("https://api.stripe.com/v1/subscriptions/" + encodeURIComponent(subId), { headers: auth });
  const sub = await sr.json().catch(() => ({}));
  const customer = typeof sub?.customer === "string" ? sub.customer : sub?.customer?.id;
  if (!sr.ok || !customer) {
    console.error("stripe subscription lookup error", sr.status, JSON.stringify(sub?.error ?? sub));
    return json({ error: "Could not open billing. Try again.", code: "upstream" }, 502);
  }

  const f = new URLSearchParams();
  f.set("customer", customer);
  f.set("return_url", SITE);
  const pr = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/x-www-form-urlencoded" },
    body: f,
  });
  const p = await pr.json().catch(() => ({}));
  if (!pr.ok || !p.url) {
    console.error("stripe portal error", pr.status, JSON.stringify(p?.error ?? p));
    return json({ error: "Could not open billing. Try again.", code: "upstream" }, 502);
  }
  return json({ url: p.url });
});
