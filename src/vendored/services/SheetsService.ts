/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { google, sheets_v4 } from 'googleapis';
import { AuthManager } from '../auth/AuthManager';
import { logToFile } from '../utils/logger';
import { extractDocId } from '../utils/IdUtils';
import { gaxiosOptions } from '../utils/GaxiosConfig';

export class SheetsService {
  constructor(private authManager: AuthManager) {}

  private async getSheetsClient(): Promise<sheets_v4.Sheets> {
    const auth = await this.authManager.getAuthenticatedClient();
    const options = { ...gaxiosOptions, auth };
    return google.sheets({ version: 'v4', ...options });
  }

  /**
   * A1 range covering a whole sheet. The name is wrapped in single quotes, so a
   * literal quote inside it has to be doubled ('It''s here') or the range is
   * unparseable and that tab reads as an error.
   */
  private static sheetRange(sheetName: string): string {
    return `'${sheetName.replace(/'/g, "''")}'`;
  }

  /**
   * Reads every named sheet, preferring ONE `values.batchGet` over N
   * `values.get`. batchGet is all-or-nothing -- a single unreadable range
   * rejects the whole request -- so a failed batch falls back to reading tab by
   * tab, which is what preserves partial success: one bad tab must not cost the
   * other tabs their data. A `values` of null marks a tab that could not be read.
   */
  private async readAllSheets(
    sheets: sheets_v4.Sheets,
    spreadsheetId: string,
    sheetNames: string[],
  ): Promise<Array<{ sheetName: string; values: any[][] | null }>> {
    if (sheetNames.length === 0) {
      return [];
    }

    const ranges = sheetNames.map((name) => SheetsService.sheetRange(name));

    try {
      const response = await sheets.spreadsheets.values.batchGet({
        spreadsheetId,
        ranges,
      });
      const valueRanges = response.data.valueRanges;
      // The API answers in request order, which is what lets us map back by
      // index. A length mismatch would silently hand one tab another tab's
      // rows, so treat it as a failed batch rather than trusting the order.
      if (!valueRanges || valueRanges.length !== ranges.length) {
        throw new Error(
          `batchGet returned ${valueRanges?.length ?? 0} value ranges for ${ranges.length} sheets`,
        );
      }
      return sheetNames.map((sheetName, index) => ({
        sheetName,
        values: valueRanges[index].values || [],
      }));
    } catch (batchError) {
      logToFile(
        `[SheetsService] batchGet failed, falling back to per-sheet reads: ${batchError}`,
      );
    }

    const results = await Promise.all(
      sheetNames.map(async (sheetName) => {
        try {
          const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: SheetsService.sheetRange(sheetName),
          });
          return { sheetName, values: response.data.values || [] };
        } catch (sheetError) {
          logToFile(
            `[SheetsService] Error reading sheet ${sheetName}: ${sheetError}`,
          );
          return { sheetName, values: null };
        }
      }),
    );
    return results;
  }

  public getText = async ({
    spreadsheetId,
    format = 'text',
  }: {
    spreadsheetId: string;
    format?: 'text' | 'csv' | 'json';
  }) => {
    logToFile(
      `[SheetsService] Starting getText for spreadsheet: ${spreadsheetId} with format: ${format}`,
    );
    try {
      const id = extractDocId(spreadsheetId) || spreadsheetId;

      const sheets = await this.getSheetsClient();
      // Get spreadsheet metadata
      const spreadsheet = await sheets.spreadsheets.get({
        spreadsheetId: id,
        includeGridData: false,
      });

      let content = '';
      const jsonData: Record<string, any[][]> = {};

      // Add spreadsheet title (except for JSON format)
      if (spreadsheet.data.properties?.title && format !== 'json') {
        content += `Spreadsheet Title: ${spreadsheet.data.properties.title}\n\n`;
      }

      // Get all sheet names
      const sheetNames =
        spreadsheet.data.sheets
          ?.map((sheet) => sheet.properties?.title)
          .filter((title): title is string => !!title) || [];

      // Get data from all sheets
      const sheetResults = await this.readAllSheets(sheets, id, sheetNames);

      for (const { sheetName, values } of sheetResults) {
        if (values === null) {
          if (format === 'json') {
            // For JSON format, we'll skip sheets with errors
            logToFile(
              `[SheetsService] Skipping sheet ${sheetName} in JSON output due to error`,
            );
          } else {
            content += `Sheet Name: ${sheetName}\n(Error reading sheet)\n\n`;
          }
          continue;
        }

        if (format === 'json') {
          // Collect data for JSON structure
          jsonData[sheetName] = values;
        } else {
          // Add sheet name as context
          content += `Sheet Name: ${sheetName}\n`;

          if (values.length === 0) {
            content += '(Empty sheet)\n';
          } else {
            // Process each row
            // PERFORMANCE: Replace values.forEach/row.map/join with traditional loops
            // to prevent high memory allocations and GC pressure on large sheets
            if (format === 'csv') {
              for (let i = 0; i < values.length; i++) {
                const row = values[i];
                for (let j = 0; j < row.length; j++) {
                  if (j > 0) content += ',';
                  let cellStr = String(row[j] || '');
                  if (
                    cellStr.includes(',') ||
                    cellStr.includes('"') ||
                    cellStr.includes('\n')
                  ) {
                    cellStr = `"${cellStr.replace(/"/g, '""')}"`;
                  }
                  content += cellStr;
                }
                content += '\n';
              }
            } else {
              for (let i = 0; i < values.length; i++) {
                const row = values[i];
                for (let j = 0; j < row.length; j++) {
                  if (j > 0) content += ' | ';
                  content += row[j] || '';
                }
                content += '\n';
              }
            }
          }
          content += '\n';
        }
      }

      if (format === 'json') {
        // Generate clean JSON output from collected data
        content = JSON.stringify(jsonData, null, 2);
      }

      logToFile(`[SheetsService] Finished getText for spreadsheet: ${id}`);
      return {
        content: [
          {
            type: 'text' as const,
            text: content.trim(),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logToFile(`[SheetsService] Error during sheets.getText: ${errorMessage}`);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: errorMessage }),
          },
        ],
      };
    }
  };

  public getRange = async ({
    spreadsheetId,
    range,
  }: {
    spreadsheetId: string;
    range: string;
  }) => {
    logToFile(
      `[SheetsService] Starting getRange for spreadsheet: ${spreadsheetId}, range: ${range}`,
    );
    try {
      const id = extractDocId(spreadsheetId) || spreadsheetId;

      const sheets = await this.getSheetsClient();
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: id,
        range: range,
      });

      const values = response.data.values || [];

      logToFile(`[SheetsService] Finished getRange for spreadsheet: ${id}`);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              range: response.data.range,
              values: values,
            }),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logToFile(
        `[SheetsService] Error during sheets.getRange: ${errorMessage}`,
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: errorMessage }),
          },
        ],
      };
    }
  };

  private fail(method: string, error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logToFile(`[SheetsService] Error during sheets.${method}: ${errorMessage}`);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ error: errorMessage }) }],
    };
  }

  private static assertValues(values: unknown): string[][] {
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      !values.every((row) => Array.isArray(row))
    ) {
      throw new Error(
        'values must be a non-empty array of rows, each row an array of cell values, e.g. [["A1","B1"],["A2","B2"]].',
      );
    }
    return values.map((row: unknown[]) =>
      row.map((cell) => (cell === null || cell === undefined ? '' : String(cell))),
    );
  }

  /**
   * Writes a block of values starting at the top-left cell of `range`. Cells
   * are parsed as if typed by the user (USER_ENTERED), so "=SUM(A1:A3)" becomes
   * a formula and "12-03-2026" a date. Pass valueInputOption "RAW" to store
   * strings verbatim.
   */
  public updateRange = async ({
    spreadsheetId,
    range,
    values,
    valueInputOption = 'USER_ENTERED',
  }: {
    spreadsheetId: string;
    range: string;
    values: unknown;
    valueInputOption?: 'USER_ENTERED' | 'RAW';
  }) => {
    logToFile(
      `[SheetsService] Starting updateRange for spreadsheet: ${spreadsheetId}, range: ${range}`,
    );
    try {
      const id = extractDocId(spreadsheetId) || spreadsheetId;
      if (!range) throw new Error('range is required (A1 notation, e.g. "Blad1!A2:C2").');
      const rows = SheetsService.assertValues(values);
      const sheets = await this.getSheetsClient();
      const response = await sheets.spreadsheets.values.update({
        spreadsheetId: id,
        range,
        valueInputOption,
        requestBody: { values: rows },
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              updatedRange: response.data.updatedRange,
              updatedRows: response.data.updatedRows,
              updatedColumns: response.data.updatedColumns,
              updatedCells: response.data.updatedCells,
            }),
          },
        ],
      };
    } catch (error) {
      return this.fail('updateRange', error);
    }
  };

  /**
   * Appends rows below the last non-empty row of the table that `range`
   * points at (a sheet name such as "Blad1" appends to that tab).
   */
  public appendRows = async ({
    spreadsheetId,
    range,
    values,
    valueInputOption = 'USER_ENTERED',
  }: {
    spreadsheetId: string;
    range: string;
    values: unknown;
    valueInputOption?: 'USER_ENTERED' | 'RAW';
  }) => {
    logToFile(
      `[SheetsService] Starting appendRows for spreadsheet: ${spreadsheetId}, range: ${range}`,
    );
    try {
      const id = extractDocId(spreadsheetId) || spreadsheetId;
      if (!range) throw new Error('range is required (a sheet name or A1 range, e.g. "Blad1" or "Blad1!A:D").');
      const rows = SheetsService.assertValues(values);
      const sheets = await this.getSheetsClient();
      const response = await sheets.spreadsheets.values.append({
        spreadsheetId: id,
        range,
        valueInputOption,
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: rows },
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              updatedRange: response.data.updates?.updatedRange,
              updatedRows: response.data.updates?.updatedRows,
              updatedCells: response.data.updates?.updatedCells,
            }),
          },
        ],
      };
    } catch (error) {
      return this.fail('appendRows', error);
    }
  };

  /** Clears the values in `range`; formatting stays. */
  public clearRange = async ({
    spreadsheetId,
    range,
  }: {
    spreadsheetId: string;
    range: string;
  }) => {
    logToFile(
      `[SheetsService] Starting clearRange for spreadsheet: ${spreadsheetId}, range: ${range}`,
    );
    try {
      const id = extractDocId(spreadsheetId) || spreadsheetId;
      if (!range) throw new Error('range is required (A1 notation).');
      const sheets = await this.getSheetsClient();
      const response = await sheets.spreadsheets.values.clear({
        spreadsheetId: id,
        range,
        requestBody: {},
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ clearedRange: response.data.clearedRange }),
          },
        ],
      };
    } catch (error) {
      return this.fail('clearRange', error);
    }
  };

  /** Creates a new spreadsheet, optionally with named tabs. */
  public create = async ({
    title,
    sheetTitles,
  }: {
    title: string;
    sheetTitles?: string[];
  }) => {
    logToFile(`[SheetsService] Starting create: ${title}`);
    try {
      if (!title) throw new Error('title is required.');
      const sheets = await this.getSheetsClient();
      const response = await sheets.spreadsheets.create({
        requestBody: {
          properties: { title },
          sheets: Array.isArray(sheetTitles) && sheetTitles.length
            ? sheetTitles.map((t) => ({ properties: { title: String(t) } }))
            : undefined,
        },
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              spreadsheetId: response.data.spreadsheetId,
              spreadsheetUrl: response.data.spreadsheetUrl,
              sheets: response.data.sheets?.map((s) => s.properties?.title),
            }),
          },
        ],
      };
    } catch (error) {
      return this.fail('create', error);
    }
  };

  public getMetadata = async ({ spreadsheetId }: { spreadsheetId: string }) => {
    logToFile(
      `[SheetsService] Starting getMetadata for spreadsheet: ${spreadsheetId}`,
    );
    try {
      const id = extractDocId(spreadsheetId) || spreadsheetId;

      const sheets = await this.getSheetsClient();
      const spreadsheet = await sheets.spreadsheets.get({
        spreadsheetId: id,
        includeGridData: false,
      });

      const metadata = {
        spreadsheetId: spreadsheet.data.spreadsheetId,
        title: spreadsheet.data.properties?.title,
        sheets: spreadsheet.data.sheets?.map((sheet) => ({
          sheetId: sheet.properties?.sheetId,
          title: sheet.properties?.title,
          index: sheet.properties?.index,
          rowCount: sheet.properties?.gridProperties?.rowCount,
          columnCount: sheet.properties?.gridProperties?.columnCount,
        })),
        locale: spreadsheet.data.properties?.locale,
        timeZone: spreadsheet.data.properties?.timeZone,
      };

      logToFile(`[SheetsService] Finished getMetadata for spreadsheet: ${id}`);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(metadata),
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logToFile(
        `[SheetsService] Error during sheets.getMetadata: ${errorMessage}`,
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: errorMessage }),
          },
        ],
      };
    }
  };
}
