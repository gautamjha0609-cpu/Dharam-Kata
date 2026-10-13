# Automatic backup on the print PC

The Print Agent (installed on the **remote print PC**, not the operator's device) keeps a local Excel backup.

**When:** after every print job (original, reprint, failed). No internet is needed for the backup step itself.

**Where (default):** `Documents\DharamKata Backup\` (change it in the agent window → "Change folder").

```
DharamKata Backup\
  FY 2026-27\                (Indian financial year, April-March)
    10 October\
      12-10-2026.xlsx        (one workbook per day, named with that day's date)
      13-10-2026.xlsx
```

**Inside each day's workbook**
- `Invoices` sheet: one row per print (S.No, time, invoice no, Original / REPRINT, vehicle, party, material, loaded / empty weight with date and time, net, charge, payment, notes, printer, print result).
- `Summary` sheet: invoices, total net weight, total charge, cash vs credit, reprints, failed prints. Each invoice is counted once, so reprints never double the totals.

**Safety**
- A hidden `.data` JSON file per day is the source of truth; the `.xlsx` is rebuilt from it. If the Excel file is open (Windows locks it), nothing is lost: it is refreshed on the next print or on restart.
- A backup problem never blocks printing.
- If Documents is synced by OneDrive, the files are also copied to the cloud. Otherwise copy the folder to a pen drive weekly.

**Limits (be honest with customers)**
- It records what was PRINTED. An invoice that was never printed (no printer set up) is not in this file; it is only in the database.
- Collections after printing are not included.
- It is a convenience backup, not a replacement for database exports. Keep taking a database export too.
