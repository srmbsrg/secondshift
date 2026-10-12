# SecondShift

**Your second shift that never sleeps.**

SecondShift is the AI voice agent for home-service trades (HVAC, plumbing,
electrical, roofing). It answers missed calls in seconds and books the job
straight into the shop's calendar — nights, weekends, holidays.

This repo holds the marketing/product site: ASP.NET Core 9 + Razor Pages,
dark "forged under pressure" industrial theme matching carborundum.ai.

## Run it

Requires the .NET 9 SDK.

```bash
dotnet run
```

Then open http://localhost:5000 (or the HTTPS URL shown in the console).

## Build

```bash
dotnet build -c Release
```

## Docker

```bash
docker build -t secondshift .
docker run -p 8080:8080 secondshift
```

The container listens on port 8080. Suitable for Railway, Azure Container
Apps, or any container host. (Deployment is a separate decision — nothing
here auto-deploys.)

## What's on the page

- Hero with the SecondShift promo video (`wwwroot/media/secondshift-promo-v1.mp4`)
- The 9:30 PM missed-job story
- How it works (3 steps), features, FAQ
- **Interactive missed-call demo simulator** — scripted, client-side only,
  clearly labeled as a simulation
- Pricing — **DRAFT, not final** (see BUILD_NOTES.md)

## Notes

See [BUILD_NOTES.md](BUILD_NOTES.md) for what's placeholder vs. real.
