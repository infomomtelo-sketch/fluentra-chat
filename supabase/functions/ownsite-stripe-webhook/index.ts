// Supabase Edge Function: ownsite-stripe-webhook  (deploy to the nwlhs project)
// IMPORTANT: turn OFF "Verify JWT" for this function (Stripe does not send one).
// Stripe endpoint URL: https://nwlhsshvqmbhemhxcran.supabase.co/functions/v1/ownsite-stripe-webhook
// Events to send: checkout.session.completed, customer.subscription.deleted
// Secrets: OWNSITE_STRIPE_WEBHOOK_SECRET (whsec_...). SUPABASE_URL / SERVICE_ROLE are built in.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const ok = (o: unknown = { received: true }) =>
  new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });
const fail = (msg: string, status: number) =>
  new Response(JSON.stringify({ error: msg }), { status, headers: { "Content-Type": "application/json" } });

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function verify(raw: string, header: string, secret: string): Promise<boolean> {
  const parts = Object.fromEntries(
    header.split(",").map((p) => { const i = p.indexOf("="); return [p.slice(0, i).trim(), p.slice(i + 1)]; }),
  );
  const t = parts["t"];
  const sigs = header.split(",").filter((p) => p.trim().startsWith("v1=")).map((p) => p.trim().slice(3));
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${t}.${raw}`)));
  return sigs.some((s) => s.length === expected.length && [...s].reduce((a, c, i) => a | (c.charCodeAt(0) ^ expected.charCodeAt(i)), 0) === 0);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return fail("POST only", 405);
  const secret = Deno.env.get("OWNSITE_STRIPE_WEBHOOK_SECRET");
  if (!secret) return fail("not configured", 500);

  const raw = await req.text();
  const sig = req.headers.get("stripe-signature") ?? "";
  if (!(await verify(raw, sig, secret))) return fail("bad signature", 400);

  let ev: any;
  try { ev = JSON.parse(raw); } catch { return fail("bad json", 400); }
  const obj = ev?.data?.object ?? {};

  if (ev.type === "checkout.session.completed") {
    if (obj.metadata?.app !== "ownsite") return ok({ received: true, ignored: "not ownsite" });
    if (obj.mode !== "subscription" || !["paid", "no_payment_required"].includes(obj.payment_status)) {
      return ok({ received: true, ignored: "not paid" });
    }
    const uid = obj.client_reference_id ?? obj.metadata?.user_id;
    if (!uid) return ok({ received: true, ignored: "no user" });
    const { data, error } = await admin.from("profiles")
      .update({ ownsite_pro: true, ownsite_subscription_id: obj.subscription ?? null })
      .eq("id", uid).select("id");
    if (error || !data?.length) {
      console.error("activate failed", uid, error?.message ?? "no profile row");
      return fail("could not activate", 500); // Stripe will retry
    }
    return ok();
  }

  if (ev.type === "customer.subscription.deleted") {
    if (!obj.id) return ok({ received: true, ignored: "no id" });
    // Only touches the row that holds this exact OwnSite subscription id.
    const { error } = await admin.from("profiles")
      .update({ ownsite_pro: false }).eq("ownsite_subscription_id", obj.id);
    if (error) { console.error("deactivate failed", error.message); return fail("could not deactivate", 500); }
    return ok();
  }

  return ok({ received: true, ignored: ev.type });
});
