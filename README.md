# Ledger

A private, single-owner personal and business finance tracker. It's a static site (plain HTML/JS, no build step) backed by Supabase.

- **Code (this repo):** generic app logic only. It holds no financial data, names, balances or bank details.
- **Data (Supabase):** every table uses row-level security, so only the signed-in owner can read or write rows. Receipts go in a private storage bucket. Once two-step sign-in is enabled, the database refuses any session that hasn't passed it.
- **Sign-ups:** the first account created becomes the owner. After that, the database rejects all new sign-ups.

## Hosting on GitHub Pages
Settings → Pages → Deploy from branch → `main` / root.
