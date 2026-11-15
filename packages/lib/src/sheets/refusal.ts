// The error the workbook throws when it refuses a batch of ops whole, such as a format that would pass the style
// budget or a merge over another merge. Tests and readers compare the stable key, never the text: the wording a person
// reads belongs to the writer that shows it.

export type RefusalKey =
    | 'too-many-cells'
    | 'too-many-formats'
    | 'too-many-records'
    | 'too-many-sheets'
    | 'grid-end'
    | 'key-too-long'
    | 'merge-overlap'
    | 'merge-cut'
    | 'last-sheet';

export class Refusal extends Error {
    public constructor(public readonly key: RefusalKey) {
        super(key);
    }
}
