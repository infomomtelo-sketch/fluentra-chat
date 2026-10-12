// Supabase Edge Function: ownsite-checkout  (deploy to the nwlhs project)
// Request:  POST {}  with  Authorization: Bearer <user JWT>
// Response: { url } (Stripe Checkout) or { error, code }
// Secrets: OWNSITE_STRIPE_KEY (restricted key: Checkout Sessions Write, Customers Write)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const PRICE_ID = "price_1UPVEkAH9qPFLg89OVEmuLOh"; // OwnSite Pro, $19 / month
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

  const key = Deno.env.get("OWNSITE_STRIPE_KEY");
  if (!key) return json({ error: "Checkout is not set up yet.", code: "server" }, 500);

  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ error: "Sign in first.", code: "auth" }, 401);
  const { data: u, error: uerr } = await admin.auth.getUser(jwt);
  if (uerr || !u?.user) return json({ error: "Session expired. Sign in again.", code: "auth" }, 401);
  const uid = u.user.id;
  const email = u.user.email ?? "";

  const { data: prof } = await admin.from("profiles").select("ownsite_pro").eq("id", uid).maybeSingle();
  if (prof?.ownsite_pro) return json({ error: "You already have OwnSite Pro.", code: "already" });

  const f = new URLSearchParams();
  f.set("mode", "subscription");
  f.set("line_items[0][price]", PRICE_ID);
  f.set("line_items[0][quantity]", "1");
  f.set("client_reference_id", uid);
  if (email) f.set("customer_email", email);
  f.set("success_url", SITE + "?upgraded=1");
  f.set("cancel_url", SITE);
  f.set("metadata[app]", "ownsite");
  f.set("metadata[user_id]", uid);
  f.set("subscription_data[metadata][app]", "ownsite");
  f.set("subscription_data[metadata][user_id]", uid);
  f.set(
    "custom_text[submit][message]",
    "OwnSite Pro is $19 per month and renews automatically each month until you cancel. You can cancel at any time.",
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
