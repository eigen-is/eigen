const COLUMN_LABEL_BASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const COLUMN_LABEL_BASE_LENGTH = COLUMN_LABEL_BASE.length;

// Base-26 decode, e.g. "A" → 0, "Z" → 25, "AA" → 26.
export function columnLabelToIndex(label: string): number {
    const upperLabel = label.toUpperCase();
    let result = 0;
    for (let i = 0, j = upperLabel.length - 1; i < upperLabel.length; i += 1, j -= 1) {
        result += COLUMN_LABEL_BASE_LENGTH ** j * (COLUMN_LABEL_BASE.indexOf(upperLabel[i]) + 1);
    }
    return result - 1;
}

export function columnIndexToLabel(column: number): string {
    let result = '';
    let n = column;
    while (n >= 0) {
        result = COLUMN_LABEL_BASE[n % COLUMN_LABEL_BASE_LENGTH] + result;
        n = Math.floor(n / COLUMN_LABEL_BASE_LENGTH) - 1;
    }
    return result;
}
