import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';
import { eigendocToDocx } from '../../lib/export/doc/to-docx';
import { auditImported, auditSource, compareRuns, type Feature, runAudit, type Tally } from '../../scripts/docx-audit';
import { buildAllFeaturesDocJson, buildAllFeaturesDocMedia } from '../fixtures/golden-documents';
import { buildDocxWithBody } from '../fixtures/golden-docx';

// The audit decides whether Eigen's own docx reader replaces mammoth, so what it counts is pinned here: Word's
// semantics on the source side, the eigendoc JSON on the other, and one measure for both importers.

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-audit-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

const BOLD_STYLES = `<w:style w:type="paragraph" w:styleId="Loud"><w:name w:val="Loud"/><w:rPr><w:b/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Louder"><w:name w:val="Louder"/><w:basedOn w:val="Loud"/></w:style>
<w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style>`;

async function source(body: string, styles = ''): Promise<Tally> {
    return auditSource(await buildDocxWithBody(body, '', styles));
}

function count(tally: Tally, feature: Feature): number {
    return tally.counts.get(feature) ?? 0;
}

const run = (text: string, rPr = '') =>
    `<w:r>${rPr && `<w:rPr>${rPr}</w:rPr>`}<w:t xml:space="preserve">${text}</w:t></w:r>`;

describe('source side', () => {
    test('bold from a paragraph style counts through basedOn, and direct formatting wins over it', async () => {
        const tally = await source(
            `<w:p><w:pPr><w:pStyle w:val="Louder"/></w:pPr>${run('Loud words')}${run(' quiet', '<w:b w:val="0"/>')}</w:p>`,
            BOLD_STYLES,
        );
        expect(count(tally, 'bold')).toBe('Loudwords'.length);
    });

    test('a bold character style in a bold paragraph style toggles bold off, as Word does', async () => {
        const tally = await source(
            `<w:p><w:pPr><w:pStyle w:val="Loud"/></w:pPr>${run('both', '<w:rStyle w:val="Strong"/>')}${run(' one')}</w:p><w:p>${run('strong', '<w:rStyle w:val="Strong"/>')}</w:p>`,
            BOLD_STYLES,
        );
        expect(count(tally, 'bold')).toBe('one'.length + 'strong'.length);
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

    test('a mark counts its characters, however Word splits the runs', async () => {
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
        expect([count(tally, 'bold'), count(imported, 'bold')]).toEqual([5, 5]);
    });

    test('small text is noticeably smaller than the body, not a point smaller', async () => {
        // No size in the styles: Word's 10 pt body.
        const tally = await source(
            `<w:p>${run('body', '<w:sz w:val="18"/>')}${run(' small', '<w:sz w:val="16"/>')}</w:p>`,
        );
        expect(count(tally, 'small')).toBe('small'.length);
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
            `<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr>${run('Scope')}</w:p>`,
        );
        const imported = (text: string) =>
            auditImported({
                type: 'doc',
                content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text }] }],
            });
        expect([count(tally, 'numberedHeadings'), count(tally, 'listItems'), count(tally, 'heading1')]).toEqual([
            1, 0, 1,
        ]);
        expect([count(imported('1. Scope'), 'numberedHeadings'), count(imported('Scope'), 'numberedHeadings')]).toEqual(
            [1, 0],
        );
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
            { source: 6, imported: 0, matched: 0, kept: 0 },
        ]);
        expect(fs.readFileSync(path.join(stubOut, 'summary.md'), 'utf8')).toContain(
            '| Bold (characters) | 1 | 6 | 0 | 0.0% |',
        );

        // mammoth maps the Strong run style to bold, which the source side counts too: kept, not invented.
        const mammothOut = path.join(scratch, 'out-mammoth');
        const mammothRun = await runAudit({ corpus: dir, out: mammothOut, name: 'mammoth', timeoutMs: 30_000 });
        expect([mammothRun.crashes, mammothRun.timeouts]).toEqual([0, 0]);
        const kept = JSON.parse(fs.readFileSync(path.join(mammothOut, 'files/nested/throw.docx.json'), 'utf8'));
        expect(kept.features.bold).toEqual({ source: 6, imported: 6, matched: 6, kept: 1 });

        const comparison = compareRuns(stubOut, mammothOut);
        expect(comparison).toContain('| Bold (characters) | 1 | 6 | 0.0% | 100.0% | +100.0 |');
        expect(comparison).toContain('nested/throw.docx');
    }, 60_000);
});
