# Exam Scanner web app — build plan and progress

Started 2026-09-25. The spec is `../App Description.md`. The camera prototype is `../camera-test/index.html`, tested on the user's iPhone.

## Files (upload all of these except this plan to GitHub Pages)

| File | Contents |
|---|---|
| `index.html` | App shell and CSS (light and dark mode) |
| `engine.js` | Sheet detection, flattening and bubble reading; `Scanner` (live camera); `scanPhoto()` |
| `logic.js` | Mapping and roster import checks, keys, grading, review flags, item analysis, grade and change-log CSVs |
| `pdfgen.js` | PDF writer: scanned-sheet archive, printed answer keys (scannable in key-check mode) |
| `app.js` | IndexedDB storage, screens, actions, backup and restore |
| `sw.js`, `manifest.webmanifest`, `icon-192.png`, `icon-512.png`, `apple-touch-icon.png` | Offline use and Add to Home Screen |

## Status (2026-09-25): version 1.0.0 built and tested on a computer

Tested in the browser pane with fixtures in `../test-images/app/` (CSV versions of the example mapping and roster, plus 9 synthetic sheets):
- **Imports:** mapping import with all checks; roster import and update (preview of added, removed and renamed students; papers re-matched and logged).
- **Scanning:** all 9 fixture sheets, plus the 7 earlier synthetic photos and the real sheet `IMG_3698`, read correctly. Flags work for blank, double mark, not on roster, no form and duplicate.
- **Live camera loop:** tested with a fake camera stream. It captures once per sheet, and the toast shows name, form, score and a review warning.
- **Review:** resolve actions (set form, use this paper, confirm blank, keep double mark, acknowledge missing papers); tap-to-fix on the image, logged.
- **Exports:**
  - The grade CSV header matches `output headers.csv` exactly, with CRLF line endings.
  - The item analysis and change log CSVs follow the approved columns.
  - The scanned-sheets PDF has one page per paper, with papers not on the roster last.
- **Printed answer keys:** the PDF prints and scans back in key-check mode, reporting differences correctly.
- **Keys:** key edit and drop, with regrade preview, carry to all forms and are logged.
- **Backup and restore:** round trip gives identical grades, and the images come back.

Not yet tested on the iPhone:
- the real camera in Home Screen mode
- sharing several files at once
- storage persistence

## Possible follow-ups
- The bubbles are small targets for tap-to-fix on a phone (about 20 pt apart). Consider pinch-zoom on the paper image if mis-taps happen.
- Manual taps can create multi-letter answers without a flag; the change is logged and the score updates.

## Decisions made while building

- **Answers per paper:** strings, where `""` = blank, `"C"`, or `"AD"`. Manual fixes override the scan. The darkness threshold only affects new scans; it never re-reads fixed papers.
- **Keys:** the master (Form A) key and the dropped set are the source of truth. B and C keys are derived through the letter mapping, so an edit on any form carries to the others.
- **Grading:** correct if the answer is one letter contained in the key, or equals a two-letter key. A dropped question gives 2 points, `Drop`. Grade CSV columns are exactly `../output headers.csv`, numbered by the student's own form.
- **Export blocking:** grade CSV and item analysis are blocked until flags are resolved and missing papers are acknowledged. Papers from students not on the roster are left out and don't block. The image PDF and change log can be exported any time.
- **Flag resolutions:** confirm blank (→ `BNK`), confirm faint, keep a double mark (scored wrong), assign a student from the roster, choose the form, "form is correct" (wrong-form flag), "use this paper" (duplicates; the others are excluded), acknowledge a missing paper.
- **Possible wrong form:** flagged when another form's key scores at least 6 more questions correct.
- **Image PDF:** one page per paper, sorted by last name, with a header line: name, ID, form, score.
- **Testing without a camera:** the test hook `window.ES.scanImage(url)` adds a photo as a capture. Test fixtures: CSV versions of the example mapping and roster, plus synthetic sheets filled from those keys and IDs.

## Next steps

1. The user uploads the files to a new GitHub Pages repository and tests on the iPhone with real sheets.
