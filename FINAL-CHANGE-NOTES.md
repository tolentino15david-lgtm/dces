# DCES Final Change Batch

This package is based on the latest `DCES-GPB-Final-Review-Update.zip` source and includes the final requested UI, encoding, export, and accomplishment-report changes.

## Included

- Activity ID format: department code + department reference number + sequence, e.g. `ANE01-1`.
- Responsible Unit is assigned from the signed-in user's department and enforced by the server.
- Department-scoped activity, budget, and utilization access for encoder accounts.
- Itemized Budget and Utilization forms and export worksheets/pages.
- Patient Expense type dropdown; patient expense total uses patient count × quantity per patient × unit price.
- Export menu with PDF/Excel choice, activity selection, preview, selected totals, and expandable itemized preview.
- GAAD Activity masterlist/export separated from Accomplishment Report.
- Accomplishment Report has its own page/editor and CSV export; PDF and Excel include it as a separate page/sheet.
- Status indicator: justification = Finished/green; On Process or progress without justification = yellow; blank = Not Started/gray.
- Accomplishment actual cost is synchronized with itemized utilization.

## Build / deployment

Run from the `DCES-Local` folder:

```bash
npm run install:all
npm run build
npm start
```

The `.env`, `node_modules`, and `dist` folders are intentionally not included in this source package.
