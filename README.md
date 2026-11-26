# DCES — Data Consolidation and Encoding System

## Local development (Windows PowerShell)

Requirements: Node.js 20+ (Node.js 22 LTS recommended).

```powershell
npm run install:all
npm run dev
```

Open `http://localhost:5173`. The API runs on port 4000. Local SQLite data is stored in `backend/data/dces.db`.

## Initial accounts

- Admin: `admin` / `admin123`
- Encoder: `user` / `user123`

Change the default admin password before using real information or publishing the app.

## Annual workspaces

The system starts with reporting year **2027**. Admins can select **Create New Year** to create a blank annual workspace. Records are separated by year and previous years remain available in the year selector. The new workspace starts empty; it does not copy old activities.

## User management

Only accounts with the `admin` role can see and use User Management. Admin can create accounts, edit display names, reset passwords, enable/disable accounts, delete other accounts, and export the account list. The API also enforces the admin role.

## FREE Render deployment — DEMO / TESTING ONLY

This project can be deployed as one Render Free Web Service using SQLite, but this configuration is **not suitable for real, official, personal, or confidential records**. Render Free has an ephemeral filesystem and does not provide a persistent disk. The SQLite database is stored under `/tmp/dces-demo-data/dces.db`; records can disappear after a restart, redeploy, service replacement, or other platform lifecycle event. Do not rely on this deployment as a backup or system of record.

The free service may spin down after inactivity and take time to wake. Session login state is also temporary and users may need to sign in again after a restart.

### Deploy using Render Blueprint

1. Push the contents of this folder to a GitHub repository. Do not commit `.env`, `node_modules`, `dist`, or any local database file.
2. In Render, choose **New → Blueprint** and connect the repository containing `render.yaml`.
3. Review the service. It must use the **Free** plan.
4. When prompted, set `INITIAL_ADMIN_PASSWORD` to a unique password of at least 12 characters. Do not use `admin123` for the public deployment.
5. Let Render generate `SESSION_SECRET` automatically.
6. Deploy and wait for the `/api/health` check to pass.
7. Sign in with username `admin` and the `INITIAL_ADMIN_PASSWORD` you configured. Create encoder accounts from User Management.

### Render settings (if configuring manually)

- Runtime: Node
- Plan: Free
- Build command: `npm run install:all && npm run build`
- Start command: `npm start`
- `NODE_ENV=production`
- `NODE_VERSION=22.23.5`
- `DATA_DIR=/tmp/dces-demo-data`
- `SESSION_SECRET`: generate a unique secret (at least 32 characters)
- `INITIAL_ADMIN_PASSWORD`: unique password (at least 12 characters)

The production app refuses to create the first administrator if `INITIAL_ADMIN_PASSWORD` is missing or too short. Local development still uses `admin` / `admin123` and `user` / `user123`.

### Data-loss precautions

- Treat every record entered on the public free demo as disposable test data.
- Export CSV reports regularly for testing snapshots, but note that CSV exports do not back up the full database or user accounts.
- Keep the original local SQLite database and any test backups on your own computer.
- Never upload a real database, `.env`, passwords, or confidential school/government information to GitHub.
- For reliable long-term storage, migrate to a managed persistent database or paid hosting with persistent storage before real use.

## Supplied workbook references

The original `GPB 2027 Consolidated.xlsx` and `GPB Encoding Template.xlsx` files are retained in `reference-workbooks/` for comparison while completing formula and report validation.

## Important scope note

This source currently contains the working core for annual GAD activity records, budget lines, monthly utilization, summary totals, CSV exports, login, and admin account management. It is not yet a verified cell-for-cell reproduction of every formula and layout in the supplied Excel workbooks. Validate all workbook calculations and reporting outputs before using it for official submissions.


## Salary Grade auto-fill (updated)

The supplied GPB Consolidated workbook contains an active Salary Grade reference schedule for **2026**. DCES imports the 27 listed positions and their salary/hourly-rate values into `salary_rates`.

For PS (Personnel Services) budget and utilization lines:
1. Select a position from the reference dropdown.
2. Salary Grade, Basic Salary, Monthly Salary, and Hourly Rate fill automatically.
3. Enter staff count and hours; enter patients/participants only when the sheet's computation is per patient.
4. Total Rate = Hourly Rate × Hours.
5. Total PS / Utilization = Total Rate × Staff Count × Patients (when patients is greater than zero; otherwise × 1).

The backend recalculates PS amounts before saving, so manually altered browser values are not trusted. The current uploaded workbook's active salary schedule is 2026, **not a verified 2027 salary schedule**. The interface displays this source year and asks the encoder to verify the applicable schedule before official submission. Replace/import an approved 2027 schedule when it is provided.

Non-PS MOOE entries remain manually entered because the source template uses different item/quantity/cost structures for materials, venue/food, patient expenses, and honoraria. Those fields need their own quantity/unit-cost inputs to reproduce each category's sheet formulas accurately.

## GPB workflow and role update (November 2026)

The updated source retains the existing `encoder` database role and presents it in the interface as **Program Implementer**. Two roles were added:

- `admin`: user management, activity editing, approval, and send-back.
- `encoder` (Program Implementer): create and edit own draft/returned activities, encode budget lines, and submit for review.
- `finance`: view all activity records, review budget details, and submit finance feedback. Admin approval is blocked until finance feedback exists.
- `technical`: read-only access to activity records and reports.

The database startup migration expands the SQLite `users.role` constraint while retaining existing account IDs, usernames, password hashes, active flags, and creation dates. Existing non-admin users remain `encoder` accounts.

### GPB fields and spreadsheet view

The activity record includes the existing GPB fields plus Org Focus, Client Focus Activity, Attributable Programs, PS Budget, and MOOE Budget. The activity masterlist is rendered as a wide spreadsheet-style grid with horizontal scrolling, frozen identifier columns, wrapped cell content, and mobile navigation. On phones, the sheet remains horizontally scrollable rather than shrinking all columns to unreadable widths.

PS and MOOE totals are recalculated from budget lines when a line is added or removed. PS uses the salary schedule effective for the selected reporting year. MOOE is the sum of non-PS budget categories.

### Review flow

1. Program Implementer saves a draft and submits it.
2. Finance reviews the record and saves feedback.
3. Admin may approve only after Finance feedback exists, or send the record back with a reason.
4. A returned record can be edited by its Program Implementer and submitted again.

### Salary schedule administration

Admin > Salary Rates lets the administrator copy the currently applicable salary rates into a new schedule, edit positions/grades/monthly and hourly rates, and assign an effectivity date. Saving creates a new schedule version; previous schedules and their rate rows are preserved. Budget entries store the hourly rate used at the time of encoding.

### Deployment notes

Keep the existing Render environment variables (`INITIAL_ADMIN_PASSWORD`, `SESSION_SECRET`, `NODE_ENV`, and `DATA_DIR`). No new required secret was introduced. Existing account data is preserved by the SQLite role migration when the database file itself persists. This Render Free demo still stores SQLite under `/tmp`, which is ephemeral; it is for testing only and must not contain real, personal, or confidential records.


## GPB review updates (November 2026)

- User accounts now require a department selected from the supplied `REFERENCE` worksheet. Department codes are seeded in the database; existing demo accounts are migrated to the GAD-TWG (`GAD`) department so they can continue to log in and encode.
- New Activity IDs are generated by the server using the assigned department's three-letter code and a per-department sequence (for example, `GAD-001`). The ID is no longer manually entered.
- The activity masterlist displays department and provides direct Edit actions. Dashboard filters use the activity type field and no longer show duplicate Org Focus / Client Focus / Attributable detail filters.
- Dashboard budget summary totals include approved activities only.
- Budget Plan and Monthly Utilization are separate tabs. Budget categories are presented as category tabs; Materials, Venue/Food, and Patient Expense calculate Quantity × Unit Price; Honoraria calculates Rate per Hour × Number of Hours; PS continues to use the salary schedule calculation. Changing category does not clear the current draft fields.
- Budget allocation lines can be edited or deleted by an authorized activity editor while the activity is still editable.
- Added PDF and XLSX exports. The XLSX export preserves the supplied `GPB (To Print)` workbook sheet and includes a complete DCES Export Data worksheet. The PDF is a landscape A3 GPB-formatted report with the official form's main section labels and columns.
- Save/update messages are displayed as a prominent confirmation toast.

### Export and form fidelity note

The official `GAD GPB AND AR TEMPLATE.xlsx` is included under `reference-workbooks`. The XLSX export retains its print-form worksheet and also includes a complete data sheet so records are not omitted. The generated PDF follows the official form's major sections and information fields, but should be checked against the latest agency-issued print instructions before formal submission.


## Final review-comment implementation updates

- Budget Plan and Monthly Utilization now load consolidated, reporting-year-wide entries without opening each activity. Entries are filterable by budget/utilization category and include Activity ID, department, and activity name.
- Activity type is stored explicitly in the activity record and backfilled for existing demo records; dashboard filtering uses that value. Department filtering uses the assigned department name.
- Dashboard activity rows now expose the Edit action to authorized roles.
- Create/update and budget/utilization actions display an additional confirmation dialog as well as the page notification.
- The GPB PDF export uses the official GPB section order and main field headings in a landscape A3 table layout, including NEP, GAA, and accomplishment-report fields. Review the generated PDF visually against the latest issued workbook before presenting it as an exact reproduction.
- XLSX export retains the official GPB print worksheet, includes a complete DCES Export Data worksheet, and sends records beyond the fixed example-row capacity of the official print sheet to a GPB Continued worksheet so they are not silently omitted.


## Local installation (Node.js 22.x)

From the project root, install all root, backend, and frontend dependencies with one command:

```powershell
npm install
npm run dev
```

The root npm workspaces configuration installs `backend` and `frontend` dependencies together. If npm blocks native dependency install scripts, approve `better-sqlite3` and rerun its rebuild from the root or backend workspace.
