import type { DefaultConditionalFormatRule } from '@workspace/lib/sheets';

// The workbook's looks, each interned once by its canonical key as the sheets are written, then written as styles.xml
// after them. The rules of a sheet take their dxfs through it.
export type StyleRegistry = {
    dxf(format: DefaultConditionalFormatRule['format']): number;
};
