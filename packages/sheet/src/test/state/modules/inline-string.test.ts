import { expect, test } from 'bun:test';
import { convertCssToStyleList } from '../../../state/modules/inline-string';

// The size box takes Google's half points, so a rich-text run keeps the 10.5 typed into it.
test("a run's half-point size reads whole", () => {
    expect(convertCssToStyleList('font-size:10.5pt;', {}).fs).toBe(10.5);
});
