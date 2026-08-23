# ScrapeVerse Hackathon Completion Plan

Time remaining: approximately 48 hours, with about 16 focused working hours.

## Current decision

Use **Render + the existing SQLite database** as the reliable deployment fallback. Try Supabase separately only if the migration is stable and does not risk the working SQLite flow.

SQLite on a free Render service may reset after a restart or redeploy. This is acceptable for the live demo if the database is seeded and the demo is tested immediately before presenting.

## Already completed

- Preview product name and price from visible page hints.
- Preview and Estimated badges with explanations.
- Backend collector verification and final product replacement.
- Product price normalization.
- Collector/enrichment progress statuses.
- Brand reputation caching for 30 days.
- Judge.me review summaries cached for 30 days.
- Review count check every 30 days, not every 24-hour revisit.
- Full review scrape and AI regeneration only when needed.
- Shared product recheck helper used by visitor recheck, cron, and top-bar Recheck.
- Top-bar Recheck button.
- Price-drop history and alert notification flow.
- Self-healing collector status shown in the top bar.
- Hover explanations for buttons and Preview/Estimated/Verified badges.
- Localhost protection in the extension.

## Official Scrape-Verse requirements

The official hackathon page makes these the highest-priority requirements:

- [x] Use Bright Data Scraper Studio as the core scraper platform.
- [x] Have a real collector creation and run flow that returns a `c_*` Collector ID.
- [x] Wire the Collector ID into a real downstream product: API flow, database, extension, and dashboard.
- [ ] Demonstrate self-healing with `bdata scraper heal`, ideally showing the same Collector ID continuing to return the same structured output after a layout change.
- [x] Scrape publicly available data only.
- [x] Use a coding-agent workflow and be ready to explain the technical decisions.
- [ ] Keep the repository reproducible with clear setup instructions.
- [ ] Keep API keys, `.env` files, and private credentials out of GitHub and the demo video.

The official judges score potential impact, creativity, technical excellence, use of Scraper Studio, reliability/self-healing, and presentation equally.

## Official submission checklist

Submit through the official form before the August 23, 2026 deadline:

- [ ] Public GitHub repository with visible commit history.
- [ ] Demo video.
- [ ] Short project description: problem, solution, and user impact.
- [ ] Explanation of exactly how Scraper Studio was used.
- [ ] Reproduction/setup instructions in the README.
- [ ] Demo evidence: collector creation, collector run, structured output, downstream product, and self-healing if demonstrated.

Every submission is automatically considered for the grand prize and the two main project tracks; no separate track submission is required. The LinkedIn post is a separate optional Daily Bugle track requirement.

## Immediate tasks, in priority order

### 1. Test more stores — approximately 1.5 hours — DONE

Test two or three additional Shopify stores besides Japam. Confirm product detection, preview values, verified collector data, price normalization, reputation/review behavior, recheck updates, alerts, and purchase metrics. Record store-specific failures without expanding into a universal-platform rewrite.

### 2. Capture collector proof in the backend logs — HIGH PRIORITY

Do not build a separate proof page. At the exact point where the Bright Data CLI response reaches our backend, log:

- Store domain and product URL.
- Bright Data `c_*` Collector ID returned during creation.
- Raw product JSON returned by the collector, before normalization or database writes.
- Clear run markers so the raw response can be shown in the local terminal or Render logs.

Use the existing admin tables to show the same Collector ID in `stores`, the saved raw JSON in `products.latest_data`, and the run status in `collector_scrape_runs`. Use the extension top bar to show the downstream verified result. Never expose API keys or private user data.

### 3. Create a controlled demo store — HIGH PRIORITY

Create a two-product Shopify-compatible demo storefront on Netlify using public `/products/demo-product` and `/products/demo-product-2` paths, Netlify Functions, and Netlify Blobs. Keep the existing Render service as the ScrapeVerse backend. The first product is the collector baseline; the second product is the same store/domain's self-healing target. Include a small demo control page whose state-changing requests are token-protected, where the judge can:

- Change the product price, name, or compare-at price.
- Select either product and toggle its layout to simulate a store redesign.
- Return to the product page and click Recheck.

Both demo products must also serve Shopify-compatible `.json` responses so the existing price/recheck flow can observe price changes. Keep the demo deterministic and make sure the Netlify URL is publicly reachable by Bright Data and the judge.

### 4. Demonstrate self-healing — HIGH PRIORITY

Capture the official proof:

1. Create and run a collector; save the initial structured output.
2. Toggle the demo store layout so core fields are missing or moved.
3. Run the same collector and show the failure or degraded output.
4. Run `bdata scraper heal` against the same `c_*` Collector ID with the repair reason.
5. Rerun the unchanged Collector ID and show repaired JSON.
6. Show the extension/database continuing to use that same Collector ID downstream.

Remember: the extension's self-healing status requires repeated missing core fields across recent collector runs; a Shopify `.json` recheck alone does not trigger it.

## Final-phase tasks

### 5. Deploy the backend to Render — approximately 2 hours

- Create a Render Web Service using the `backend` directory for the ScrapeVerse API, Bright Data calls, SQLite data, price alerts, and extension integration.
- Use `npm install` for build and `npm start` for start.
- Let Render provide the `PORT` value.
- Update `extension/content.js` to use the deployed Render HTTPS URL.
- Reload the extension and test the deployed backend from a real product page.

### 6. Try the Supabase migration experimentally

- Work in a separate branch or backup copy.
- Keep the working SQLite flow as the immediate fallback.
- Only switch the deployed demo to Supabase if the migration is stable and does not break collector, product, review, brand, history, alert, or purchase flows.

### 7. Configure Render environment variables — approximately 30 minutes

Required variables:

```text
BRIGHTDATA_API_KEY=...
LLM_API_KEY=...
LLM_PROVIDER=gemini
RESEND_API_KEY=...
RESEND_FROM_EMAIL=ScrapeVerse Alerts <verified-sender@example.com>
TRAFFIC_UPLIFT_PERCENT=50
```

Email uses Resend, not Gmail. `DATABASE_URL` is not a completed Postgres migration. Never commit real API keys to GitHub.

### 8. Verify the final deployed scraper and stores

Test the exact deployed URL on two or three stores. Verify collector creation/run, the proof JSON, product replacement, brand reputation, reviews, recheck, and the extension's final status flow.

### 9. Verify email alerts — final if time permits

- Configure Resend and subscribe one test email.
- Change the demo price below the target and click Recheck.
- Confirm the email arrives and the UI/backend logs show the alert result.

### 10. Verify purchase tracking and Sold metrics — final if time permits

- Complete a test purchase or use the demo order-confirmation page.
- Confirm the thank-you URL, `POST /api/purchases/track`, `user_purchases` row, product link, quantity, and total amount.
- Reopen the product page and verify `real_orders`, `lifetime_purchases`, `purchases_30d`, and Sold metrics.

The displayed Sold number may be rounded or combined with the review-based estimate, so verify that the real order count increases even if the visible badge does not change by one purchase.

### 11. Publish the ScrapeVerse homepage — final if time permits

The homepage is already done locally. Publish it only after the core demo is stable. Include the extension download link, Chrome installation steps, demo-store link, feature cards, and demo video link.

### 12. Create the GitHub repository and README — REQUIRED before submission

Include the project overview, problem/solution, demo flow, architecture, extension installation, local setup, Render setup, environment variables, refresh schedules, self-healing logic, SQLite/Supabase decision, known limitations, demo links, and video. Exclude secrets, local databases, and `node_modules`.

### 13. Record the final demo video — REQUIRED before submission

Show the two product pages, verified collector data, the backend/Render log lines with the `c_*` ID and raw JSON, extension statuses, price/recheck flow, layout change on the second product, same-ID self-healing, and the final downstream result. Target 90 seconds to 3 minutes.

### 14. Create the public product catalog — OPTIONAL FINAL TASK

If time remains, publish a simple read-only catalog backed by the existing database. Support product/brand/store search, category filters, product details, source links, loading/empty/error states, and no private fields or API keys.

## Recommended schedule (priority order, not a strict time budget)

| Time | Work |
|---:|---|
| Done | Test two or three other stores |
| 1.5–2 h | Add and verify raw Collector ID + JSON evidence in backend/Render logs |
| 3–4 h | Build the controlled demo store and layout toggle |
| 1–2 h | Demonstrate self-healing and capture evidence |
| 2 h | Deploy Render and update the extension backend URL |
| 0.5 h | Try the Supabase experiment only if the SQLite fallback remains safe |
| 0.5 h | Configure Render environment variables |
| 1.5 h | GitHub repository and README |
| 2 h | Record the final demo video |
| 0.5 h | Final deployed-store verification |
| 0.5 h | Email and purchase tests if time remains |
| 2–3 h | Optional homepage and public product catalog polish |

## Scope rules

- Supabase is experimental: use a separate branch or backup copy and retain the working SQLite deployment as fallback.
- Do not add Gmail if Resend works.
- Do not redesign the existing extension unless a real demo bug appears.
- Keep the demo deterministic and pre-seeded.
- Test the exact deployed URL before recording the video.
- Collector proof and self-healing evidence take priority over homepage, catalog, email, and purchase polish.
- Keep the final presentation focused on the working end-to-end story.

## Deferred final demo and submission plan

### 1. Demonstrate the real first visit with Japam

Use the real Japam website to show the main product flow:

1. Open a Japam product page with the extension.
2. Show the extension calling `/api/scrape`.
3. Show the backend terminal:
   - Collector creation.
   - Returned `c_*` Collector ID.
   - Collector run.
   - Raw Bright Data JSON.
4. Show the product data appearing in:
   - Extension top bar.
   - Admin/database table.
   - Product result.
5. Show reviews being collected and summarized.
6. Show brand reputation research and its status.

Most other functionality will be presented through the visible extension badges and statuses without deep technical explanation.

### 2. Demonstrate revisit and price notification

Use the same Japam product to show:

1. Revisit the product page.
2. Explain that cached product data is used first.
3. Show the live product JSON recheck.
4. Show the price comparison and updated history.
5. Use the **Notify on Drop** feature.
6. Change the controlled demo product price below the target.
7. Click **Recheck**.
8. Show the price-drop notification result.

### 3. Demonstrate self-healing with the controlled demo store

Use the public Netlify demo store:

1. Open Product 1 in the normal layout.
2. Open Product 2 in the normal layout.
3. Show that both belong to the same store/domain and reuse the same collector.
4. Change Product 2 to the redesigned layout through `/demo-control.html`.
5. Run the same collector against Product 2.
6. Show the terminal logs:
   - Missing/degraded fields.
   - Self-healing started.
   - `bdata scraper heal`.
   - Same `c_*` Collector ID.
   - Repaired structured JSON.
7. Show the extension/database receiving the repaired result.

The console evidence must be real output from the backend, not manually written demo text.

### 4. Explain the code briefly

Use the README and selected code sections to explain the architecture:

- Extension calls `/api/scrape` with the product URL.
- Backend checks or creates the store collector.
- Bright Data creates and runs the `c_*` collector.
- Raw JSON is logged before normalization.
- SQLite stores the collector, product, history, and health records.
- Background enrichment handles reviews and brand reputation.
- Revisit uses product JSON for price checking.
- Repeated collector failures trigger Bright Data self-healing.

Show only the relevant code sections, not the entire files.

### 5. Record locally first

Record the complete working demo using:

```text
Public Netlify demo store
Local Node.js backend
Local SQLite database
Local Chrome extension
Local backend terminal logs
```

This is valid because Bright Data needs the demo product URL to be publicly reachable, but the backend and terminal can remain local.

### 6. Deploy after the local demo is proven

After recording and verifying locally:

1. Deploy the current backend to Render.
2. Keep SQLite initially as the working fallback.
3. Configure Render environment variables.
4. Change the extension backend URL from localhost to Render.
5. Test the same Japam and demo-store flow against Render.
6. Try Supabase only in a separate backup/branch if time remains.
7. Re-record the demo with Render logs only if it improves the presentation.

Supabase is optional. If it risks breaking the working system, submit with Render and SQLite.

### 7. Submission materials

Complete:

- Public GitHub repository.
- Root README with setup and architecture.
- Bright Data Scraper Studio explanation.
- Structured output example.
- Demo video.
- AI-assistant disclosure.
- No API keys, `.env` files, or private data in GitHub/video.

The final video should focus on the real product story:

```text
Project explanation
→ Japam first visit
→ Collector and raw JSON
→ Reviews and brand reputation
→ Revisit and price notification
→ Demo-store layout change
→ Same-ID self-healing
→ Brief code explanation
```

No additional feature or UI work is needed unless one of these flows fails during verification.
