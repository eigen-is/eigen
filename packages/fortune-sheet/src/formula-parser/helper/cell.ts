export interface CellCoordinate {
  index: number;
  label: string;
  isAbsolute: boolean;
}

/**
 * Convert row label to index.
 *
 * @param label Row label (eq. '1', '5')
 * @returns Returns -1 if label is not recognized otherwise proper row index.
 */
export function rowLabelToIndex(label: string): number {
  let result = parseInt(label, 10);

  if (isNaN(result)) {
    result = -1;
  } else {
    result = Math.max(result - 1, -1);
  }

  return result;
}

/**
 * Convert row index to label.
 *
 * @param row Row index.
 * @returns Returns row label (eq. '1', '7').
 */
export function rowIndexToLabel(row: number): string {
  let result = "";

  if (row >= 0) {
    result = `${row + 1}`;
  }

  return result;
}

const COLUMN_LABEL_BASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const COLUMN_LABEL_BASE_LENGTH = COLUMN_LABEL_BASE.length;

/**
 * Convert column label to index.
 *
 * @param label Column label (eq. 'ABB', 'CNQ')
 * @returns Returns -1 if label is not recognized otherwise proper column index.
 */
export function columnLabelToIndex(label: string): number {
  let result = 0;

  if (typeof label === "string") {
    const upperLabel = label.toUpperCase();

    for (let i = 0, j = upperLabel.length - 1; i < upperLabel.length; i += 1, j -= 1) {
      result +=
        Math.pow(COLUMN_LABEL_BASE_LENGTH, j) *
        (COLUMN_LABEL_BASE.indexOf(upperLabel[i]) + 1);
    }
  }
  --result;

  return result;
}

/**
 * Convert column index to label.
 *
 * @param column Column index.
 * @returns Returns column label (eq. 'ABB', 'CNQ').
 */
export function columnIndexToLabel(column: number): string {
  let result = "";

  while (column >= 0) {
    result =
      String.fromCharCode((column % COLUMN_LABEL_BASE_LENGTH) + 97) + result;
    column = Math.floor(column / COLUMN_LABEL_BASE_LENGTH) - 1;
  }

  return result.toUpperCase();
}

const simpleSheetName = "[A-Za-z0-9_\\u00C0-\\u02AF]+";
const quotedSheetName = "'(?:(?!').|'')*'";
const sheetNameRegexp = `(${simpleSheetName}|${quotedSheetName})!`;
const LABEL_EXTRACT_REGEXP = new RegExp(
  `^(?:${sheetNameRegexp})?([$])?([A-Za-z]*)([$])?([0-9]*)$`
);

/**
 * Extract cell coordinates.
 *
 * @param label Cell coordinates (eq. 'A1', '$B6', '$N$98').
 * @returns Returns an array of objects.
 */
export function extractLabel(label: string): [CellCoordinate | null, CellCoordinate | null, string | null] {
  if (typeof label !== "string" || !LABEL_EXTRACT_REGEXP.test(label)) {
    return [null, null, null];
  }
  const match = label.toUpperCase().match(LABEL_EXTRACT_REGEXP);
  if (!match) return [null, null, null];
  const [, sheetNameStr, columnAbs, column, rowAbs, row] = match;
  if (column == null && row == null) return [null, null, null];
  const sheetName =
    sheetNameStr == null
      ? null
      : label
          .slice(0, sheetNameStr.length)
          .replace(/^'|'$/g, "")
          .replace(/''/g, "'");

  return [
    {
      index: rowLabelToIndex(row),
      label: row,
      isAbsolute: rowAbs === "$",
    },
    {
      index: columnLabelToIndex(column),
      label: column,
      isAbsolute: columnAbs === "$",
    },
    sheetName,
  ];
}

/**
 * Convert row and column indexes into cell label.
 *
 * @param row Object with `index` and `isAbsolute` properties.
 * @param column Object with `index` and `isAbsolute` properties.
 * @returns Returns cell label.
 */
export function toLabel(row: CellCoordinate, column: CellCoordinate): string {
  const rowLabel = (row.isAbsolute ? "$" : "") + rowIndexToLabel(row.index);
  const columnLabel =
    (column.isAbsolute ? "$" : "") + columnIndexToLabel(column.index);

  return columnLabel + rowLabel;
}
