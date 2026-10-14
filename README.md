# Carter & Company Account Detail Generator

This repository publishes the approved staff-pilot build of the Carter & Company Account Detail Generator.

The browser application maps accounts from a supported CCH trial balance to a supported general ledger, lets staff select leadcodes, and downloads account-detail workbooks. Uploaded workbooks are parsed locally in disposable browser workers. The application has no backend, upload endpoint, analytics, telemetry, or persistent browser storage.

## Privacy and access

GitHub Pages is publicly accessible. Possession of the site URL is not access control, and Microsoft 365 authentication is not implemented. Staff must follow the firm's approved pilot procedures and must not treat the public URL as a confidential sharing boundary.

No client trial balances, general ledgers, generated client workbooks, client-derived fixtures, or private validation evidence are stored in this repository.

## Supported workflow

- Preferred trial balance: published CCH Leadcode Trial Balance
- Alternate trial balance: validated seven-column flat TB
- Implemented GL parsers: Yardi, AppFolio, OneSite, FirstService, QuickBooks, and Vantaca
- FirstService and QuickBooks generation remain restricted until authoritative same-client account identity is available
- Custom mapping remains unavailable

The generated workbook contains a compact Summary worksheet followed by one leadcode detail worksheet per selection. Visible detail columns are Account Number, Account Description, Date, Reference, Name / Payee, Description, Debit, Credit, and Balance. Source-native traceability is retained in hidden columns.

## Local build

Node.js 24 and pnpm 11 are used by the deployment workflow.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm preview
```

The `main` branch deploys the static `dist` directory through GitHub Actions. The GitHub Actions environment selects the repository base path; local development retains relative asset paths.
