# OwnSite backend (nwlhs project)

1. SQL editor (nwlhs): run `ownsite_usage.sql`.
2. Edge Functions: create `ownsite-chat`, paste `functions/ownsite-chat/index.ts`, deploy.
   Secrets: `ANTHROPIC_API_KEY` (SUPABASE_URL / SERVICE_ROLE are built in).
3. Auth > URL Configuration: add `https://rental-application.pages.dev/` to Redirect URLs.
   Google provider must be enabled (it already is for OwnSite).
4. In `index.html` set `OS.anonKey` to the nwlhs anon (public) key. Sign-in and the meter turn on.
5. Allowances live in `LIMITS` at the top of `ownsite-chat/index.ts` (free 30k, pro 500k tokens/month).
   Pro = `profiles.ownsite_pro = true`, which the existing Stripe webhook already sets.

## Tokens (one-time purchases; no subscription)
Free: 30,000 tokens every month (used first). Bought tokens never expire. Rate: $20 per 1,000,000 tokens, $5 to $100 per purchase.
1. Run `supabase/ownsite_credits.sql` in the nwlhs SQL editor (after `ownsite_usage.sql`).
2. Deploy (replace) `ownsite-chat`, `ownsite-build`, `ownsite-checkout` (Verify JWT on) and `ownsite-stripe-webhook` (Verify JWT OFF).
3. Stripe webhook `ownsite-wehook` only needs the event `checkout.session.completed`. Secrets: `OWNSITE_STRIPE_KEY` (Checkout Sessions: Write), `OWNSITE_STRIPE_WEBHOOK_SECRET`.
4. In `index.html` set `OS.checkoutUrl` to `https://nwlhsshvqmbhemhxcran.supabase.co/functions/v1/ownsite-checkout` (the Buy tokens menu item appears only when it is set).
5. The old `ownsite-portal` function and the profiles.ownsite_pro columns are no longer used and can be deleted.
The Claude Code prompt unlocks after any purchase (server-enforced in `ownsite-chat`, mode "handoff").

## Multi-page builder
1. Run `supabase/ownsite_builds.sql` in the nwlhs SQL editor.
2. Deploy `ownsite-build` (Verify JWT on). Uses the existing `ANTHROPIC_API_KEY`.
3. In `index.html` set `OS.buildUrl` to `https://nwlhsshvqmbhemhxcran.supabase.co/functions/v1/ownsite-build` (the menu item "Multi-page site" appears only when it is set).
Rules built in: cost quoted before building; max charge = 125% of the quote; only delivered pages are charged; failed or cut-off pages are free; the AI's cost beyond the reserve is absorbed.
