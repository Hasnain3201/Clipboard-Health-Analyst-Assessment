# Bellhaven CRM reconciliation

A daily scraper and local review queue for reconciling Bellhaven Senior Living's published communities with the Meridian CRM sandbox.

## Run the project

Use Node.js 22.13 or later. The project has no third-party dependencies.

1. Copy `.env.example` to `.env` and enter the sandbox token after `BELLHAVEN_TOKEN=`. An environment variable of the same name also works.
2. Run `npm run scan` to populate the review queue.
3. Run `npm start` and open [the review app](http://127.0.0.1:4391/). On macOS, `launch-review.command` starts the same app.

Run `npm test` for the fixture-based checks. They cover discovery of homepage-only sites, incomplete coverage, approval gating, CHOW billing preservation, a lost create response, stale billing eligibility, and decision persistence.

The app stores review decisions in `.state/review.sqlite`. Use the same project directory for future scans to keep the audit trail. The source bundle omits the token, database, and raw CRM snapshots. To use a different sandbox, use a fresh project directory and its own token and state.

## Daily run

`cron.example` contains an 8 a.m. scan in the host's time zone. Set the absolute project path before installing it. The scan reads the website and CRM and refreshes the SQLite queue. Each approval rechecks live evidence, applies the write through the CRM API, and reads the affected record back.

The scraper verifies each numbered directory page and reconciles the advertised count. It also follows distinct community links from the homepage. If a detail page is incomplete, the scan stops before refreshing the review queue. For matching, the pipeline compares the site to all CRM accounts and uses active administrator contacts as corroborating evidence.

If a create response is lost, the app looks up the reconciliation reference on the new CRM account before resuming. An uncertain create with no unique receipt needs manual inspection. In a production CRM, use API-supported idempotency keys and conditional updates when available.
