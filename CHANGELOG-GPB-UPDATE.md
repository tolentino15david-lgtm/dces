# DCES GPB Update — 2026-11-17

- Kept `encoder` as the database role and labelled it Program Implementer in the UI.
- Added `technical` (viewer) and `finance` (reviewer) roles with server-side permission checks.
- Added Program Implementer submission, Finance feedback, and Admin approve/send-back workflow.
- Added Org Focus, Client Focus Activity, Attributable Programs, PS Budget, MOOE Budget, and GAD Agenda Subgoals fields.
- Expanded the activity masterlist into a wide spreadsheet-style table with mobile horizontal scrolling and frozen identifiers.
- Added PS/MOOE totals based on budget line categories.
- Added Admin-managed, effectivity-dated salary schedule versions and rate audit records.
- Added a safe SQLite users-table migration to preserve existing account details while allowing the new roles.
