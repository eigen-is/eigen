import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { eigendocToDocx } from '../../lib/export/doc/to-docx';
import {
    auditImported,
    auditSource,
    compareRuns,
    compareTallies,
    type Feature,
    runAudit,
    type Tally,
} from '../../scripts/docx-audit';
import { buildAllFeaturesDocJson, buildAllFeaturesDocMedia } from '../fixtures/golden-documents';
import { buildDocxWithBody } from '../fixtures/golden-docx';

// The audit decides whether Eigen's own docx reader replaces mammoth, so what it counts is pinned here: Word's
// semantics on the source side, the eigendoc JSON on the other, and one measure for both importers.

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-audit-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

const HEADING_STYLES =
    '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Heading 2"/><w:basedOn w:val="Heading1"/></w:style>';

const BOLD_STYLES = `<w:style w:type="paragraph" w:styleId="Loud"><w:name w:val="Loud"/><w:rPr><w:b/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Louder"><w:name w:val="Louder"/><w:basedOn w:val="Loud"/></w:style>
<w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style>`;

// Numbered from 1 with a visible label; numId 8 shares its counters, numId 9 restarts them at 5.
const NUMBERING = `<w:abstractNum w:abstractNumId="7"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%1.%2)"/><w:suff w:val="space"/></w:lvl></w:abstractNum>
<w:num w:numId="7"><w:abstractNumId w:val="7"/></w:num>
<w:num w:numId="8"><w:abstractNumId w:val="7"/></w:num>
<w:num w:numId="9"><w:abstractNumId w:val="7"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="5"/></w:lvlOverride></w:num>`;

async function source(body: string, styles = ''): Promise<Tally> {
    return auditSource(await buildDocxWithBody(body, '', styles, NUMBERING));
}

function count(tally: Tally, feature: Feature): number {
    return tally.counts.get(feature) ?? 0;
}

const run = (text: string, rPr = '') =>
    `<w:r>${rPr && `<w:rPr>${rPr}</w:rPr>`}<w:t xml:space="preserve">${text}</w:t></w:r>`;

const paragraph = (text: string, pPr = '') => `<w:p>${pPr && `<w:pPr>${pPr}</w:pPr>`}${text && run(text)}</w:p>`;

const styled = (style: string, text: string, pPr = '') => paragraph(text, `<w:pStyle w:val="${style}"/>${pPr}`);

const item = (numId: number, text: string, ilvl = 0) =>
    paragraph(text, `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`);

describe('source side', () => {
    test('bold from a paragraph style counts through basedOn, and direct formatting wins over it', async () => {
        const tally = await source(
            `<w:p><w:pPr><w:pStyle w:val="Louder"/></w:pPr>${run('Loud words')}${run(' quiet', '<w:b w:val="0"/>')}</w:p>`,
            BOLD_STYLES,
        );
        expect(tally.marks.get('bold')).toEqual(['Loud', 'words']);
    });

    test('a bold character style in a bold paragraph style toggles bold off, as Word does', async () => {
        const tally = await source(
            `<w:p><w:pPr><w:pStyle w:val="Loud"/></w:pPr>${run('both', '<w:rStyle w:val="Strong"/>')}${run(' one')}</w:p><w:p>${run('strong', '<w:rStyle w:val="Strong"/>')}</w:p>`,
            BOLD_STYLES,
        );
        expect(tally.marks.get('bold')).toEqual(['one', 'strong']);
    });

    test('deleted and moved-away text and field instructions are no text; inserted text and field results are', async () => {
        const field = (instruction: string) =>
            `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve">${instruction}</w:instrText></w:r>`;
        const separate = '<w:r><w:fldChar w:fldCharType="separate"/></w:r>';
        const end = '<w:r><w:fldChar w:fldCharType="end"/></w:r>';
        const tally = await source(
            `<w:p>${run('Kept ')}<w:del w:id="1" w:author="a"><w:r><w:delText>gone</w:delText></w:r></w:del><w:ins w:id="2" w:author="a">${run('added ')}</w:ins><w:moveFrom w:id="3" w:author="a">${run('moved')}</w:moveFrom></w:p>
<w:p><w:moveTo w:id="4" w:author="a">${run('moved')}</w:moveTo></w:p>
<w:p>${run('Page ')}${field(' PAGE ')}${separate}${run('7')}${end}</w:p>
<w:p>${field(' IF ')}${field(' PAGE ')}${separate}${run('1')}${end}<w:r><w:instrText xml:space="preserve"> = 1 "one" "many" </w:instrText></w:r>${separate}${run('one')}${end}</w:p>`,
        );
        expect(tally.words).toEqual(['Kept', 'added', 'moved', 'Page', '7', 'one']);
    });

    test('a merged cell counts once', async () => {
        const cell = (tcPr: string, text: string) =>
            `<w:tc><w:tcPr>${tcPr}</w:tcPr><w:p>${text && run(text)}</w:p></w:tc>`;
        const tally = await source(
            `<w:tbl><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>
<w:tr>${cell('<w:vMerge w:val="restart"/>', 'A')}${cell('', 'B')}</w:tr>
<w:tr>${cell('<w:vMerge/>', '')}${cell('', 'C')}</w:tr>
<w:tr>${cell('<w:gridSpan w:val="2"/>', 'D')}</w:tr></w:tbl><w:p/>`,
        );
        expect([
            count(tally, 'tables'),
            count(tally, 'cells'),
            count(tally, 'rowspanCells'),
            count(tally, 'colspanCells'),
        ]).toEqual([1, 4, 1, 1]);
    });

    test('a mark counts the words it touches, however Word splits the runs', async () => {
        const tally = await source(`<w:p>${run('bo', '<w:b/>')}${run('ld x', '<w:b/>')}${run(' plain')}</w:p>`);
        const imported = auditImported({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'bold x', marks: [{ type: 'bold' }] },
                        { type: 'text', text: ' plain' },
                    ],
                },
            ],
        });
        expect([tally.marks.get('bold'), imported.marks.get('bold')]).toEqual([
            ['bold', 'x'],
            ['bold', 'x'],
        ]);
    });

    test('small text is noticeably smaller than the body, not a point smaller', async () => {
        // No size in the styles: Word's 10 pt body.
        const tally = await source(
            `<w:p>${run('body', '<w:sz w:val="18"/>')}${run(' small', '<w:sz w:val="16"/>')}</w:p>`,
        );
        expect(tally.marks.get('small')).toEqual(['small']);
    });

    test("a footnote's marker is no text on either side", async () => {
        const tally = await source(
            `<w:p>${run('Ouch')}<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="1"/></w:r>${run('.')}</w:p>`,
        );
        // As mammoth writes it.
        const imported = auditImported({
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'Ouch' },
                        {
                            type: 'text',
                            text: '[1]',
                            marks: [{ type: 'superscript' }, { type: 'link', attrs: { href: '#footnote-1' } }],
                        },
                        { type: 'text', text: '.' },
                    ],
                },
            ],
        });
        expect([tally.words, count(tally, 'footnotes')]).toEqual([['Ouch', '.'], 1]);
        expect([imported.words, count(imported, 'footnotes'), count(imported, 'superscript')]).toEqual([
            ['Ouch', '.'],
            1,
            0,
        ]);
    });

    test('a numbered heading is a heading whose number is its text, not a list item', async () => {
        const tally = await source(
            `${styled('Heading1', 'Scope', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr>')}${styled('Heading2', 'Aims', '<w:numPr><w:ilvl w:val="1"/><w:numId w:val="7"/></w:numPr>')}${styled('Heading1', '2023 Budget')}`,
            HEADING_STYLES,
        );
        expect([count(tally, 'numberedHeadings'), count(tally, 'listItems'), count(tally, 'heading1')]).toEqual([
            2, 0, 2,
        ]);
        expect(tally.headings).toEqual([
            { line: '1. Scope', numbered: true },
            { line: '1.a) Aims', numbered: true },
            { line: '2023 Budget', numbered: false },
        ]);
        // Word shows the number, so it is text.
        expect(tally.words.slice(0, 2)).toEqual(['1.', 'Scope']);
    });

    test('a numbered heading is kept when the imported heading starts with the number Word shows', async () => {
        const tally = await source(
            `${styled('Heading1', 'Scope', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="7"/></w:numPr>')}${styled('Heading1', '2023 Budget')}`,
            HEADING_STYLES,
        );
        const imported = (...texts: string[]) =>
            auditImported({
                type: 'doc',
                content: texts.map((text) => ({
                    type: 'heading',
                    attrs: { level: 1 },
                    content: [{ type: 'text', text }],
                })),
            });
        expect(compareTallies(tally, imported('1. Scope', '2023 Budget')).features['numberedHeadings']).toEqual({
            source: 1,
            imported: 2,
            matched: 1,
            invented: 0,
            kept: 1,
        });
        // A heading that starts with a number of its own is no number Word shows.
        expect(compareTallies(tally, imported('Scope', '2023 Budget')).features['numberedHeadings']).toEqual({
            source: 1,
            imported: 1,
            matched: 0,
            invented: 0,
            kept: 0,
        });
        expect(compareTallies(tally, imported('1. Scope', '2. Budget')).features['numberedHeadings']).toEqual({
            source: 1,
            imported: 2,
            matched: 1,
            invented: 1,
            kept: 1,
        });
    });

    // MS-OI29500 2.1.100 on ECMA-376 17.3.2.40: with no w:val, Word takes the style hierarchy's underline, else none.
    test('an underline without w:val inherits, and is none where nothing underlines', async () => {
        const tally = await source(
            `<w:p>${run('bare', '<w:u/>')}${run(' single', '<w:u w:val="single"/>')}</w:p><w:p><w:pPr><w:pStyle w:val="Under"/></w:pPr>${run('inherited', '<w:u/>')}${run(' off', '<w:u w:val="none"/>')}</w:p>`,
            '<w:style w:type="paragraph" w:styleId="Under"><w:name w:val="Under"/><w:rPr><w:u w:val="single"/></w:rPr></w:style>',
        );
        expect(tally.marks.get('underline')).toEqual(['single', 'inherited']);
    });

    test('a box is no quote and no rule; a left border alone is a quote, a lone bottom border on an empty paragraph a rule', async () => {
        const border = (...sides: string[]) =>
            `<w:pPr><w:pBdr>${sides.map((side) => `<w:${side} w:val="single" w:sz="4" w:space="1" w:color="auto"/>`).join('')}</w:pBdr></w:pPr>`;
        const tally = await source(
            [
                styled('Box', 'Do this'),
                styled('Box', ''),
                styled('Box', 'then that'),
                paragraph('Plain'),
                styled('Box', ''),
                paragraph('Plain'),
                styled('SideHeading', 'Chapter'),
                paragraph('Plain'),
                styled('Ruled', ''),
                paragraph('Plain'),
                styled('Ruled', ''),
                styled('Ruled', ''),
                paragraph('Plain'),
                styled('Aside', 'quoted'),
            ].join(''),
            `${HEADING_STYLES}
<w:style w:type="paragraph" w:styleId="Box"><w:name w:val="Box"/>${border('top', 'left', 'bottom', 'right')}</w:style>
<w:style w:type="paragraph" w:styleId="SideHeading"><w:name w:val="Side Heading"/><w:basedOn w:val="Heading1"/>${border('left')}</w:style>
<w:style w:type="paragraph" w:styleId="Ruled"><w:name w:val="Ruled"/>${border('bottom')}</w:style>
<w:style w:type="paragraph" w:styleId="Aside"><w:name w:val="Aside"/>${border('left')}</w:style>`,
        );
        expect([count(tally, 'blockquotes'), count(tally, 'rules'), count(tally, 'heading1')]).toEqual([1, 1, 1]);
    });

    test('a TOC Heading at outline level 9 is body text, though based on Heading 1', async () => {
        const tally = await source(
            `${styled('TOCHeading', 'Contents')}${styled('Heading1', 'Intro')}`,
            '<w:style w:type="paragraph" w:styleId="TOCHeading"><w:name w:val="TOC Heading"/><w:basedOn w:val="Heading1"/><w:pPr><w:outlineLvl w:val="9"/></w:pPr></w:style>',
        );
        expect([count(tally, 'heading1'), count(tally, 'paragraphs')]).toEqual([1, 2]);
    });

    test("an indent in docDefaults is every paragraph's: a body paragraph still ends the list, a further indented one doesn't", async () => {
        const defaults =
            '<w:docDefaults><w:pPrDefault><w:pPr><w:ind w:left="86"/></w:pPr></w:pPrDefault></w:docDefaults>';
        const ended = await source(
            `${item(7, 'one')}${item(7, 'two')}${paragraph('Between')}${item(7, 'three')}`,
            defaults,
        );
        const continued = await source(
            `${item(7, 'one')}${item(7, 'two')}${paragraph('More of two', '<w:ind w:left="720"/>')}${item(7, 'three')}`,
            defaults,
        );
        expect([count(ended, 'orderedLists'), count(continued, 'orderedLists')]).toEqual([2, 1]);
    });

    test('a start override restarts its list once', async () => {
        const tally = await source(`${item(7, 'one')}${item(7, 'two')}${item(9, 'five')}${item(9, 'six')}`);
        expect([tally.numbers, count(tally, 'orderedLists'), count(tally, 'orderedStarts')]).toEqual([
            [1, 2, 5, 6],
            2,
            1,
        ]);
    });

    test('lists sharing an abstract definition number on across a paragraph between them', async () => {
        const tally = await source(`${item(7, 'one')}${item(7, 'two')}${paragraph('Between')}${item(8, 'three')}`);
        expect([tally.numbers, count(tally, 'orderedLists'), count(tally, 'orderedStarts')]).toEqual([[1, 2, 3], 2, 1]);
    });
});

describe('both sides', () => {
    // The writer's mapping read back: what the doc holds, the audit finds in its docx. A Word drawing always has a
    // size, so the photo the doc leaves at its own width has one there.
    test("the writer's docx holds what its doc holds", async () => {
        const json = buildAllFeaturesDocJson();
        const docx = await eigendocToDocx(json, buildAllFeaturesDocMedia(), 'Report.eigendoc', undefined);
        const written = await auditSource(docx);
        const held = auditImported(json);
        expect(Object.fromEntries(written.counts)).toEqual({
            ...Object.fromEntries(held.counts),
            imageWidths: count(held, 'images'),
        });
        expect(written.words.toSorted()).toEqual(held.words.toSorted());
        expect(written.numbers.toSorted()).toEqual(held.numbers.toSorted());
        const marked = (tally: Tally) =>
            Object.fromEntries([...tally.marks].map(([mark, words]) => [mark, words.toSorted()]));
        expect(marked(written)).toEqual(marked(held));
        expect(written.headings).toEqual(held.headings);
    });
});

describe('comparing', () => {
    test('a mark an importer adds where Word has none is invented, and a misplaced one is no keep', async () => {
        const tally = await source(`<w:p>${run('Loud', '<w:b/>')}${run(' quiet words')}</w:p>`);
        const bolded = (bold: (word: string) => boolean) =>
            auditImported({
                type: 'doc',
                content: [
                    {
                        type: 'paragraph',
                        content: ['Loud', ' quiet', ' words'].map((text) => ({
                            type: 'text',
                            text,
                            marks: bold(text.trim()) ? [{ type: 'bold' }] : [],
                        })),
                    },
                ],
            });
        expect(
            compareTallies(
                tally,
                bolded(() => true),
            ).features['bold'],
        ).toEqual({
            source: 1,
            imported: 3,
            matched: 1,
            invented: 2,
            kept: 1,
        });
        expect(
            compareTallies(
                tally,
                bolded((word) => word !== 'Loud'),
            ).features['bold'],
        ).toEqual({
            source: 1,
            imported: 2,
            matched: 0,
            invented: 2,
            kept: 0,
        });
    });

    test('a counted feature invents what the import holds beyond the source', async () => {
        const tally = await source(paragraph('Only text'));
        const imported = auditImported({
            type: 'doc',
            content: [
                { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Only' }] },
                { type: 'paragraph', content: [{ type: 'text', text: 'text' }] },
            ],
        });
        const { features } = compareTallies(tally, imported);
        expect([features['heading1'], features['paragraphs'], features['text']]).toEqual([
            { source: 0, imported: 1, matched: 0, invented: 1, kept: null },
            { source: 1, imported: 2, matched: 1, invented: 1, kept: 1 },
            { source: 2, imported: 2, matched: 2, invented: 0, kept: 1 },
        ]);
    });
});

describe('runs', () => {
    async function corpus(name: string, files: Record<string, ArrayBuffer>): Promise<string> {
        const dir = path.join(scratch, name);
        for (const [file, bytes] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
            await Bun.write(path.join(dir, file), bytes);
        }
        return dir;
    }

    test('a crash and a timeout are results, and compare names the files the importers differ on', async () => {
        const dir = await corpus('mixed', {
            'hang.docx': await buildDocxWithBody(`<w:p>${run('HANG')}</w:p>`),
            'nested/throw.docx': await buildDocxWithBody(
                `<w:p>${run('strong', '<w:rStyle w:val="Strong"/>')}</w:p>`,
                '',
                BOLD_STYLES,
            ),
        });
        const stub = path.join(scratch, 'stub-importer.ts');
        await Bun.write(
            stub,
            `export async function docxToPmJson(buffer) {
                if (buffer.toString('latin1').includes('HANG')) while (true) {}
                throw new Error('stub refuses');
            }`,
        );
        const stubOut = path.join(scratch, 'out-stub');
        const stubRun = await runAudit({ corpus: dir, out: stubOut, importer: stub, name: 'stub', timeoutMs: 1000 });
        expect([stubRun.files, stubRun.crashes, stubRun.timeouts]).toEqual([2, 1, 1]);
        const crashed = JSON.parse(fs.readFileSync(path.join(stubOut, 'files/nested/throw.docx.json'), 'utf8'));
        expect([crashed.import, crashed.error, crashed.features.bold]).toEqual([
            'crash',
            'stub refuses',
            { source: 1, imported: 0, matched: 0, invented: 0, kept: 0 },
        ]);
        expect(fs.readFileSync(path.join(stubOut, 'summary.md'), 'utf8')).toContain(
            '| Bold (words) | 1 | 1 | 0 | 0.0% | 0 |',
        );

        // mammoth maps the Strong run style to bold, which the source side counts too: kept, not invented.
        const mammothOut = path.join(scratch, 'out-mammoth');
        const mammothRun = await runAudit({ corpus: dir, out: mammothOut, name: 'mammoth', timeoutMs: 30_000 });
        expect([mammothRun.crashes, mammothRun.timeouts]).toEqual([0, 0]);
        const kept = JSON.parse(fs.readFileSync(path.join(mammothOut, 'files/nested/throw.docx.json'), 'utf8'));
        expect(kept.features.bold).toEqual({ source: 1, imported: 1, matched: 1, invented: 0, kept: 1 });

        const comparison = compareRuns(stubOut, mammothOut);
        expect(comparison).toContain('| Bold (words) | 1 | 1 | 0.0% | 100.0% | +100.0 | 0 | 0 |');
        expect(comparison).toContain('nested/throw.docx');
    }, 60_000);

    test('a worker that dies and an importer that then fails to load are crashes, and the run goes on to its summary', async () => {
        const dir = await corpus('dying', {
            'a.docx': await buildDocxWithBody(paragraph('first')),
            'b.docx': await buildDocxWithBody(paragraph('second')),
        });
        const marker = path.join(scratch, 'loaded-once');
        // Its own directory: Bun's resolver keeps a listing of scratch from the stub loaded before.
        const stub = path.join(fs.mkdtempSync(path.join(scratch, 'importer-')), 'dying.ts');
        await Bun.write(
            stub,
            `import * as fs from 'node:fs';
            if (fs.existsSync(${JSON.stringify(marker)})) throw new Error('reload refused');
            fs.writeFileSync(${JSON.stringify(marker)}, '');
            export async function docxToPmJson() {
                setTimeout(() => { throw new Error('worker dies'); });
                return new Promise(() => {});
            }`,
        );
        const out = path.join(scratch, 'out-dying');
        const meta = await runAudit({ corpus: dir, out, importer: stub, name: 'dying', timeoutMs: 5000 });
        expect([meta.files, meta.crashes, meta.sourceErrors]).toEqual([2, 2, 0]);
        const second = JSON.parse(fs.readFileSync(path.join(out, 'files/b.docx.json'), 'utf8'));
        expect([second.import, second.error, second.features.text.source]).toEqual([
            'crash',
            expect.stringContaining('reload refused'),
            1,
        ]);
        expect(fs.existsSync(path.join(out, 'summary.md'))).toBe(true);
    }, 30_000);

    test('a reply that is no eigendoc is a crash', async () => {
        const dir = await corpus('malformed', { 'a.docx': await buildDocxWithBody(paragraph('first')) });
        const stub = path.join(fs.mkdtempSync(path.join(scratch, 'importer-')), 'malformed.ts');
        await Bun.write(stub, 'export async function docxToPmJson() { return { json: null, images: [] }; }');
        const out = path.join(scratch, 'out-malformed');
        const meta = await runAudit({ corpus: dir, out, importer: stub, name: 'malformed', timeoutMs: 5000 });
        const result = JSON.parse(fs.readFileSync(path.join(out, 'files/a.docx.json'), 'utf8'));
        expect([meta.crashes, result.error]).toEqual([1, 'malformed reply']);
    }, 30_000);

    test('a corpus reached through a symlink is read, and an empty one is refused', async () => {
        const real = await corpus('real', { 'linked.docx': await buildDocxWithBody(paragraph('linked')) });
        const dir = await corpus('symlinked', {});
        fs.mkdirSync(dir, { recursive: true });
        fs.symlinkSync(real, path.join(dir, 'through'));
        const out = path.join(scratch, 'out-symlinked', 'deeper');
        const meta = await runAudit({ corpus: dir, out, name: 'mammoth', timeoutMs: 30_000 });
        expect([meta.files, fs.existsSync(path.join(out, 'files/through/linked.docx.json'))]).toEqual([1, true]);

        const empty = await corpus('empty', {});
        fs.mkdirSync(empty, { recursive: true });
        expect(runAudit({ corpus: empty, out: path.join(scratch, 'out-empty'), name: 'mammoth' })).rejects.toThrow(
            'No .docx files',
        );
    }, 60_000);
});
