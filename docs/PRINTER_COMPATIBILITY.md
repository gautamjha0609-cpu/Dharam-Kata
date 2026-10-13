# Printer compatibility & reliability notes

## Slip types
- **Pre-printed form** (`preprinted`): the software prints only the variable values at calibrated positions.
- **Blank paper** (`blank`): the software also draws title, company name, rules and boxes ("Static elements" in the designer).
- Layouts are saved as named profiles: all sites, one site, or one specific printer. Resolution order: printer -> site -> tenant. The website preview uses the same order as the server.

## What the Print Agent does
- **Calibration sheet**: rulers (1 mm ticks), 10 mm grid, print-area frame with corner marks, 100 mm measuring bar, line-spacing block, clearly labelled TEST.
- **Per-printer X/Y offset** (Settings -> Printing), **copies** (1-5, per layout) and an optional **DUPLICATE / REPRINT / COPY mark on reprints**. A reprint is a new job on the SAME invoice; the invoice number and amounts never change.
- **Pre-flight status**: Windows printer status (offline / paper out / jam) is checked BEFORE anything is sent. These failures are retried automatically with a growing delay (up to 6 attempts). Nothing was sent, so no duplicate is possible.
- **Never auto-resent**: a job that reached "submitting" and then lost its acknowledgement becomes UNKNOWN and needs a person to check the paper. Unknown driver errors (`driver_failure`) also need a person.
- **Text that does not fit** at a readable size is refused (`layout_overflow`) instead of being printed cut off. The operator preview warns first.
- Persistent queue on the server, local journal on the PC, lease/claim, restart recovery, revoke.

## What is NOT claimed
- No application can guarantee zero failures on every dot-matrix model. "Sent to Windows print queue" is not proof that paper came out.
- Windows printer-status flags depend on the driver. Some dot-matrix drivers never report paper-out or jam, so those cases are only noticed by the operator seeing a missing slip.
- A model counts as **supported only after** this checklist passes on that exact model and driver:
  1. continuous-feed form size accepted by the driver;
  2. calibration sheet within +/-1 mm;
  3. sample invoice approved and saved as a profile;
  4. long text, 2 copies;
  5. paper-out and offline handled;
  6. USB unplugged mid-job;
  7. internet drop;
  8. PC restart.
- Tested so far: Windows virtual printers on one PC only. No Epson or TVS model has been tested.

## Printer model catalog (dropdown)
The Settings -> Printing screen offers a model dropdown, auto-selected from the Windows printer name. Choosing a model applies its "environment": preferred smallest text size (9-pin 10 pt, 24-pin 8 pt, thermal 7 pt), recommended font, and the Windows driver set-up steps.

Confirmed from sources: Epson LX-310 (9-pin, 80 col, 1+4), LQ-310 (24-pin, 80 col, 1+3), LQ-590II (24-pin, 80 col, 1+6); TVS MSP 240 (9-pin, 80 col, 1+3), MSP 250 (9-pin, 80 col, 1+4), MSP 270 Classic Plus (9-pin, 80 col), RP 3160 Gold (thermal, 80 mm); WeP/Wipro 800 DX (9-pin, 80 col, 1+3), DSI 810 (24-pin, 80 col); OKI Microline 3320 (9-pin, 80 col).
Listed but UNCONFIRMED (shown as "specs unconfirmed" in the app): Epson LX-350, LX-300+II, LQ-2190; TVS MSP 345 (sources disagree on columns), MSP 255, MSP 460.
Sources were manufacturer pages, Indian retailer pages and GeM listings; they sometimes disagree, so confirm on the actual unit.
