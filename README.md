# villagepets-automations

Small automation routines for the business. Each routine lives in its own folder
with its own README and setup steps.

| Routine | What it does |
|---|---|
| [`shopify-sales-report`](shopify-sales-report/) | Google Apps Script that builds a daily Google Sheet of product sales and on-hand inventory from Shopify and saves it to a Drive folder. |

## Conventions

- **No secrets or store details in the repo.** Tokens, store addresses, folder IDs and
  vendor lists live in each routine's configuration (for Apps Script: Script Properties).
- Each routine has a README that lists the settings it needs.
