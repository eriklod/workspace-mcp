# Sheets Tool

## Actions
- getText (spreadsheetId): text dump of every tab
- getRange (spreadsheetId, range): values of one A1 range
- getMetadata (spreadsheetId): tabs, sizes, locale
- updateRange (spreadsheetId, range, values, valueInputOption?): write a block of values starting at the top-left cell of range
- appendRows (spreadsheetId, range, values, valueInputOption?): append rows below the last filled row of the table at range (a tab name such as "Blad1" works)
- clearRange (spreadsheetId, range): clear values, keep formatting
- create (title, sheetTitles?): new spreadsheet; returns spreadsheetId and URL

## Parameters

- account (optional): email of the Google account to use; defaults to the primary account.
- spreadsheetId: the id or the full Google Sheets URL.
- range: A1 notation, tab name in single quotes when it has spaces: `'Omzet 2026'!A2:D10`.
- values: array of rows, each an array of cells: `[["Datum","Bedrag"],["2026-11-05","120,50"]]`. Numbers may be passed as numbers or strings.
- valueInputOption: `USER_ENTERED` (default) parses like typing in the UI — `=SUM(A1:A3)` becomes a formula, `12-03-2026` a date; `RAW` stores text verbatim.

## Examples
```
{ "action": "getMetadata", "spreadsheetId": "1AbC...", "account": "erik@elnino.nl" }
{ "action": "appendRows", "spreadsheetId": "1AbC...", "range": "Blad1", "values": [["2026-11-05", "Leverancier X", 120.5]] }
{ "action": "updateRange", "spreadsheetId": "1AbC...", "range": "Blad1!B2", "values": [["=SUM(C2:C20)"]] }
```
