# BUILD_NOTES — SecondShift site (2026-10-12)

## What's real
- ASP.NET Core 9 + Razor Pages, builds clean (`dotnet build -c Release`).
- All copy is plain-spoken for shop owners; no invented customers,
  testimonials, reviews, or metrics anywhere on the page.
- Promo video is the real cut: `wwwroot/media/secondshift-promo-v1.mp4`
  (1920x1080, ~33s), copied from `~/workspace/marketing/carb-video/`.
- "Book a walkthrough" CTAs point to https://www.carborundum.ai/ (real).
- The missed-call demo simulator is a scripted client-side demo, clearly
  labeled "Simulated conversation — no real call was placed." It is NOT
  connected to any voice backend.

## What's placeholder / needs Scott's confirmation
- **PRICING IS DRAFT.** The page shows "Free trial, then $500/mo" with a
  visible "Draft pricing — not final" flag. This figure came from an early
  internal discussion and was never confirmed. DO NOT treat as final —
  Scott must set real pricing before this page is shown to customers.
  (Also flagged in a Razor comment in Pages/Index.cshtml.)
- FAQ answer on calendar compatibility says "common calendars and
  scheduling tools — we'll confirm yours on the walkthrough." True but
  vague on purpose; tighten once integrations are decided.
- The demo uses a fictional shop ("Apex Heating & Air") and fictional
  caller ("Mike Torres", (713) 555-0148 — a 555 fictional number).
- No backend, no database, no analytics, no contact form handler yet.
  The walkthrough CTA currently just links to carborundum.ai.

## Deployment
- Dockerfile (multi-stage) included; listens on 8080. Railway / Azure
  Container Apps ready. NOT deployed anywhere as of 2026-10-12 —
  deployment is Scott's call.
