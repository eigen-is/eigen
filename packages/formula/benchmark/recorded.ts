// The oracle's rows mode, reused as it stands: its parser of the recorded files, its fixtures and its rule for
// when a value equals Excel's. That module keeps the rows and the rule inside, so a Bun plugin loads it with two of
// them exported, the rows each with their fixture and expected answer. The data step reads the rows once; the
// correctness run takes the rule. It runs on Bun only.

import type { Literal } from '../src/index';

// One expected value as the oracle records it: Excel's text, whether it was quoted, and TYPE where it was taken.
export type Expected = {
    readonly text: string;
    readonly quoted?: boolean;
    readonly type?: string;
    readonly element?: boolean;
    readonly exact15?: boolean;
};
// An array answer: its size, and its elements when Excel's text held them all.
export type Probe = { readonly rows: number; readonly columns: number; readonly elements: readonly Expected[] | null };
export type Cells = Readonly<Record<string, Literal>>;
export type Fixture = {
    readonly host: Cells;
    readonly hostName?: string;
    readonly others?: Readonly<Record<string, Cells>>;
};
export type RecordedRow = {
    readonly file: string;
    readonly formula: string;
    readonly excel: string;
    readonly fixture: Fixture;
    // The sheets the formula names.
    readonly named: readonly string[];
    readonly expected: Expected | Probe;
    readonly extra: { readonly isref?: string; readonly sum?: string };
};
type Oracle = {
    readonly rows: (dir: string) => readonly RecordedRow[];
    readonly equalsRecorded: (ours: Literal | null, expected: Expected) => boolean;
};

const PATCHES = [
    [
        'outcomes.push({ file: tag, section, formula, excel, ours, equal });',
        'outcomes.push({ file: tag, section, formula, excel, ours, equal, fixture, named: sheets, expected, extra });',
    ],
    [
        "return { report: lines.join('\\n'), differing: differing.join('\\n') };",
        "return { report: lines.join('\\n'), differing: differing.join('\\n'), outcomes };",
    ],
    ['\nfunction equalsRecorded(', '\nexport function equalsRecorded('],
] as const;

export async function loadOracle(): Promise<Oracle> {
    Bun.plugin({
        name: 'oracle rows',
        setup(build) {
            build.onLoad({ filter: /oracle-rows\.ts$/ }, async ({ path }) => {
                let text = await Bun.file(path).text();
                for (const [from, to] of PATCHES) {
                    if (!text.includes(from)) throw new Error(`oracle-rows changed: no ${from}`);
                    text = text.replace(from, to);
                }
                return { contents: text, loader: 'ts' };
            });
        },
    });
    const module = await import('../scripts/oracle-rows');
    return {
        rows: (dir) => Reflect.get(module.rowsMode(dir), 'outcomes'),
        equalsRecorded: Reflect.get(module, 'equalsRecorded'),
    };
}
