# Ledger

A private, single-owner personal and business finance tracker. It's a static site (plain HTML/JS, no build step) backed by Supabase.

- **Code (this repo):** generic app logic only. It holds no financial data, names, balances or bank details.
- **Data (Supabase):** every table uses row-level security, so only the signed-in owner can read or write rows. Receipts go in a private storage bucket. Once two-step sign-in is enabled, the database refuses any session that hasn't passed it.
- **Sign-ups:** the first account created becomes the owner. After that, the database rejects all new sign-ups.

## Importing statements
Money in & out → Import statement takes a bank CSV or a PDF statement (e.g. Tide). PDFs are read in the browser with pdf.js (`vendor/pdf.min.mjs` + worker, Apache-2.0), checked against the statement's own totals and running balance, and payments already in the account are skipped. Known payees are sorted by your learned rules first, then by suggestions in `js/hints.js`; the rest go to the To categorise inbox.

## Tax page
Estimates for a single-owner Polish sp. z o.o.: CIT (9% small taxpayer / 19%), VAT from the “VAT included” field on business transactions, shareholder ZUS, board pay vs dividend comparison, and the filing calendar (moved past weekends and Polish holidays). Rates for each year live in `js/tax-rules.js`; the owner's choices are saved in `settings.tax`. Planning figures only; the accountant's numbers win.

## Hosting on GitHub Pages
Settings → Pages → Deploy from branch → `main` / root.
