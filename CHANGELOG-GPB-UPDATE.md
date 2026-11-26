# DCES GPB Update — 2026-11-17

- Kept `encoder` as the database role and labelled it Program Implementer in the UI.
- Added `technical` (viewer) and `finance` (reviewer) roles with server-side permission checks.
- Added Program Implementer submission, Finance feedback, and Admin approve/send-back workflow.
- Added Org Focus, Client Focus Activity, Attributable Programs, PS Budget, MOOE Budget, and GAD Agenda Subgoals fields.
- Expanded the activity masterlist into a wide spreadsheet-style table with mobile horizontal scrolling and frozen identifiers.
- Added PS/MOOE totals based on budget line categories.
- Added Admin-managed, effectivity-dated salary schedule versions and rate audit records.
- Added a safe SQLite users-table migration to preserve existing account details while allowing the new roles.


## November 2026 — Reviewer comments
- Added required department assignment to user accounts and automatic department-coded Activity IDs.
- Added department display, direct dashboard editing, simplified Activity Type filtering, and approved-only dashboard budget totals.
- Separated Budget Plan and Monthly Utilization views and added category-specific calculations.
- Added budget allocation edit/delete actions and prominent save confirmations.
- Added PDF and XLSX export using the official GPB/AR workbook as the print-form reference.

## Final reviewer-comment pass (November 2026)

- Added explicit `activity_type` storage with a migration/backfill for existing demo records. Dashboard type filtering now uses the stored value, and department filtering uses the assigned department.
- Added consolidated year-wide Budget Plan and Monthly Utilization read APIs and tables, with category filtering and row-level edit availability for authorized users.
- Budget-line updates now recalculate category amounts server-side, including PS schedule calculations.
- Dashboard activity table now passes its Edit handler, so authorized users can edit directly from the dashboard.
- Added a confirmation dialog for activity and budget/utilization create, update, and delete actions.
- Updated PDF export to use the official GPB section order and the main NEP, GAA, and accomplishment-report fields in an A3 landscape form-style table.
- Updated XLSX export to clear the official template's sample rows, populate the accomplishment-report columns, and retain overflow records in a continuation sheet as well as the complete data sheet.

## DCES final change batch — 2026-11-26

- Activity IDs now use the department code + reference number + per-unit sequence (example: `ANE01-1`). Existing IDs remain unchanged when editing.
- Responsible Unit is sourced from the logged-in account and is not editable in activity encoding; the server enforces the assignment.
- Encoder activity, budget, and utilization visibility/editing is scoped to the assigned department rather than only the account that originally created the activity.
- Budget and utilization exports include itemized line sheets/pages. Venue/Food labels use packs and price per pack; Patient Expense includes an expense-type selector and preserves its type in the item description.
- Export menu is consolidated to one Export action with PDF/Excel choice, activity selection, a preview list, selected budget/utilization totals, and an expandable itemized preview.
- Accomplishment Report is separated from the GAAD activity encoder/masterlist and exported as a distinct report section/page/sheet. Accomplishment status is calculated: justification = Finished (green); On Process/progress without justification = On Process (yellow); blank = Not Started (gray).
- Accomplishment report can be edited from its own module and exported separately as CSV.
- Patient Expense amount now calculates as patients × quantity per patient × unit price (when a patient count is entered); the patient expense type is retained in the saved line description.
- Accomplishment Report actual cost is synchronized from the activity's itemized utilization total to avoid duplicate manual entry.
