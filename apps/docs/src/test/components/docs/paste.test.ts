import { describe, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { getFontName } = await import('@workspace/lib/constants/fonts');
const { cleanPastedHTML } = await import('../../../components/docs/paste');

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

    test.each(['Arial', 'Calibri', 'Inter', 'Wingdings', "'Times New Roman', serif"])(
        '%s pastes in the document font',
        (font) => {
            expect(pastedFont(font)).toBe('');
        },
    );
});
