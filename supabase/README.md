# OwnSite backend (nwlhs project)

1. SQL editor (nwlhs): run `ownsite_usage.sql`.
2. Edge Functions: create `ownsite-chat`, paste `functions/ownsite-chat/index.ts`, deploy.
   Secrets: `ANTHROPIC_API_KEY` (SUPABASE_URL / SERVICE_ROLE are built in).
3. Auth > URL Configuration: add `https://rental-application.pages.dev/` to Redirect URLs.
   Google provider must be enabled (it already is for OwnSite).
4. In `index.html` set `OS.anonKey` to the nwlhs anon (public) key. Sign-in and the meter turn on.
5. Allowances live in `LIMITS` at the top of `ownsite-chat/index.ts` (free 30k, pro 500k tokens/month).
   Pro = `profiles.ownsite_pro = true`, which the existing Stripe webhook already sets.

## Paid plan ($19/month)
1. Stripe: restricted key with Checkout Sessions: Write + Customers: Write.
2. nwlhs > Edge Functions > Secrets: add `OWNSITE_STRIPE_KEY` (that key).
3. Deploy `ownsite-checkout` (Verify JWT can stay on).
4. Deploy `ownsite-stripe-webhook` with Verify JWT turned OFF.
5. Stripe > Developers > Webhooks > Add endpoint:
   `https://nwlhsshvqmbhemhxcran.supabase.co/functions/v1/ownsite-stripe-webhook`
   Events: `checkout.session.completed`, `customer.subscription.deleted`.
6. Add the endpoint's signing secret as nwlhs secret `OWNSITE_STRIPE_WEBHOOK_SECRET`.
7. In `index.html` set `OS.checkoutUrl` to `https://nwlhsshvqmbhemhxcran.supabase.co/functions/v1/ownsite-checkout`.
8. Manage subscription (cancel, card, invoices): Stripe > Settings > Billing > Customer portal > activate (live mode, allow cancel). Give the restricted key Subscriptions: Read + Customer portal: Write. Deploy `ownsite-portal` (Verify JWT on). `OS.portalUrl` in `index.html` points to it.
