# ScrapeVerse controlled demo store

This is a two-product Shopify-compatible storefront for the ScrapeVerse hackathon demonstration. Both products are on the same demo store domain, so ScrapeVerse can create one collector for the store and run it against a second product URL after that page changes layout. It is intentionally separate from the Render backend:

- Netlify serves the public product page and demo controls.
- Netlify Blobs stores independent price, compare-at price, title, layout, and revision state for both product pages.
- The existing Render backend calls Bright Data against the Netlify product URL, stores product data in SQLite, and powers the extension, alerts, and self-healing workflow.

## Netlify setup

Use `demo-site` as the Netlify base directory, publish directory `.`, and functions directory `netlify/functions`.

Public URLs after deployment:

```text
https://YOUR-SITE.netlify.app/
https://YOUR-SITE.netlify.app/products/demo-product
https://YOUR-SITE.netlify.app/products/demo-product.json
https://YOUR-SITE.netlify.app/products/demo-product-2
https://YOUR-SITE.netlify.app/products/demo-product-2.json
https://YOUR-SITE.netlify.app/demo-control.html
```

The control page is intentionally public for the hackathon demo. The public product pages, read-only `.json` endpoints, and state-changing demo controls are all open so the judge can change the layout and price without setup.

## Local testing

```bash
npm install
npm run dev
```

Use Netlify Dev so the Functions and Blobs runtime are emulated. The normal product page must be publicly deployed before Bright Data can scrape it.

## Demo sequence

1. Open `/products/demo-product` with the extension. This is the baseline URL used while creating the store collector.
2. Open `/products/demo-product-2` with the extension. It is the same brand/domain, so the backend reuses the same stored `c_*` collector.
3. Subscribe through Notify on Drop on either product if showing the alert flow.
4. Change the price of the selected product in `/demo-control.html`, click Recheck in the extension, and verify price history/email.
5. Select the self-healing target in `/demo-control.html` and switch only it to **Small theme refresh**. The refresh changes a product block, classes, and IDs while preserving Shopify JSON-LD and product data.
6. Run the same collector against `/products/demo-product-2` with `force_refresh`. One changed-page scrape that reports a missing core field now starts Bright Data heal. The normal extension Recheck intentionally uses the Shopify-compatible `.json` endpoint for the price-drop flow.

## What “Shopify-compatible JSON” means

`/products/demo-product.json` and `/products/demo-product-2.json` are Netlify Functions. Each function reads the selected product from Netlify Blobs and returns a Shopify-shaped response such as `{ "product": { "title": "...", "variants": [{ "price": "..." }] } }`. This is enough for the existing Render recheck code to consume the same URL shape it expects from a Shopify store; it is not pretending that Netlify itself is Shopify.

## Why the control page is public

This is a disposable hackathon demo store, so `/demo-control.html` can update the public price and layout directly. No private token or Netlify secret is required.
