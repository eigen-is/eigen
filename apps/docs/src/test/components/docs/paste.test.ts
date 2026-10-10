import { describe, expect, test } from 'bun:test';
import { createDocument, getSchema } from '@tiptap/core';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { getFontName } = await import('@workspace/lib/constants/fonts');
const { cleanPastedHTML } = await import('../../../components/docs/paste');
const { getDocExtensions } = await import('@workspace/lib/docs/eigendoc');

const schema = getSchema(getDocExtensions());

// The name the textStyle mark's parseHTML reads from the pasted stack.
function pastedFont(fontFamily: string): string {
    const html = cleanPastedHTML(`<p><span style="font-family: ${fontFamily}">x</span></p>`, 600);
    const span = new DOMParser().parseFromString(html, 'text/html').querySelector('span');
    if (!span) throw new Error('span gone');
    return getFontName(span.style.fontFamily);
}

describe('paste maps foreign fonts onto the bundled ones', () => {
    test.each([
        ['Times New Roman', 'Source Serif 4'],
        ['Georgia', 'Source Serif 4'],
        ['Palatino', 'Source Serif 4'],
        ['Palatino Linotype', 'Source Serif 4'],
        ['Courier New', 'JetBrains Mono'],
        ['Consolas', 'JetBrains Mono'],
        ['Comic Sans MS', 'Excalifont'],
    ])('%s pastes as %s', (font, bundled) => {
        expect(pastedFont(`'${font}'`)).toBe(bundled);
    });

    test.each([
        ['Garamond', 'Source Serif 4'],
        ['Lora', 'Source Serif 4'],
        ['Menlo', 'JetBrains Mono'],
        ['Source Serif 4', 'Source Serif 4'],
    ])('%s pastes as %s through the shared font map', (font, bundled) => {
        expect(pastedFont(`'${font}'`)).toBe(bundled);
    });

    test.each(['Arial', 'Calibri', 'Roboto', 'Inter', 'Wingdings', "'Times New Roman', serif"])(
        '%s pastes in the document font',
        (font) => {
            expect(pastedFont(font)).toBe('');
        },
    );
});

// Word's clipboard spells caps as CSS on the run's span, beside the font the cleaner rewrites.
describe('paste keeps caps', () => {
    test.each([
        ["font-family:'Times New Roman';text-transform:uppercase", 'all'],
        ['font-family:Calibri;font-variant:small-caps', 'small'],
        ['font-variant:normal;text-transform:none', null],
    ])('%s pastes as caps %s', (style, caps) => {
        const html = cleanPastedHTML(`<p><span style="${style}">x</span></p>`, 600);
        const marks = createDocument(html, schema).firstChild?.firstChild?.marks ?? [];
        expect(marks.find((mark) => mark.type.name === 'textStyle')?.attrs['caps'] ?? null).toBe(caps);
    });
});
