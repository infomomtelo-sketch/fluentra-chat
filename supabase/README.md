# OwnSite backend (nwlhs project)

1. SQL editor (nwlhs): run `ownsite_usage.sql`.
2. Edge Functions: create `ownsite-chat`, paste `functions/ownsite-chat/index.ts`, deploy.
   Secrets: `ANTHROPIC_API_KEY` (SUPABASE_URL / SERVICE_ROLE are built in).
3. Auth > URL Configuration: add `https://rental-application.pages.dev/` to Redirect URLs.
   Google provider must be enabled (it already is for OwnSite).
4. In `index.html` set `OS.anonKey` to the nwlhs anon (public) key. Sign-in and the meter turn on.
5. Allowances live in `LIMITS` at the top of `ownsite-chat/index.ts` (free 30k, pro 600k tokens/month).
   Pro = `profiles.ownsite_pro = true`, which the existing Stripe webhook already sets.
