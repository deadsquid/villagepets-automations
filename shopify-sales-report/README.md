# Shopify product sales report (Google Apps Script)

Builds a daily Google Sheet of product sales and on-hand inventory from Shopify
and saves it to a Google Drive folder. One tab per vendor, plus a combined
"Sales by SKU" tab.

- Sales come from ShopifyQL (`shopifyqlQuery`, Admin GraphQL API).
- On-hand inventory comes from the Admin GraphQL API (`productVariants`).
- Each day's report is saved as `<REPORT_NAME> - YYYY-MM-DD`; files older than 30 days go to the Drive trash.

## Setup

1. Create an app in the Shopify Dev Dashboard with the scopes `read_reports`,
   `read_products` and `read_inventory`, and install it on your store.
   `shopifyqlQuery` also needs Level 2 protected customer data access.
2. Create a new Apps Script project at script.google.com and paste in `Code.gs`.
3. Add these **Script Properties** (Project Settings). Never commit them.

   | Property | Value |
   |---|---|
   | `SHOPIFY_SHOP` | `your-store.myshopify.com` |
   | `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` | from the Dev Dashboard app (or use `SHOPIFY_TOKEN` for a legacy custom app) |
   | `DRIVE_FOLDER_ID` | the ID at the end of the Drive folder URL |
   | `VENDORS` | vendors to include, separated by `\|`: `Vendor One\|Vendor Two` |
   | `REPORT_NAME` | optional, default `Product Sales - Last 90 Days` |
   | `TIMEZONE` | optional, default `America/Vancouver` |

4. Run `buildReport` once to test, then run `installDailyTrigger` once to schedule it.

Settings that are not specific to your store (window length, API version,
colours, font) are in the `CONFIG` block at the top of `Code.gs`.
