// Multi-select value merging for properties panels. Extracted verbatim from slides'
// slide-properties-panel (its second consumer is the vector panel). A getter reads one field
// off every selected object: all-equal collapses to the value, any disagreement is MIXED, an
// empty/all-undefined selection is undefined. Panels render MIXED as '—' (number inputs, color
// swatches, select placeholders) or a data-mixed attribute (toggles).

export const MIXED = 'mixed' as const;
export type MergedValue<T> = T | typeof MIXED | undefined;

export function getMergedValue<O, T>(objects: O[], getter: (obj: O) => T | undefined): MergedValue<T> {
    const values = objects.map(getter).filter((v): v is T => v !== undefined);
    if (values.length === 0) return undefined;
    if (values.every((v) => v === values[0])) return values[0];
    return MIXED;
}

export function isMixed<T>(v: MergedValue<T>): v is typeof MIXED {
    return v === MIXED;
}
