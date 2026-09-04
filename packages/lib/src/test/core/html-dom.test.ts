import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { sanitizeToLightEditorHtml } from '../../core/html-dom';

// The sanitizer parses with DOMParser and rebuilds through `document` — install happy-dom at module
// scope the way the clipboard test does.
const window = new Window();
Object.assign(globalThis, { DOMParser: window.DOMParser, document: window.document, Node: window.Node });

describe('sanitizeToLightEditorHtml — links', () => {
    test('a safe link opens in a new tab with the opener sealed', () => {
        // Present mode renders this markup inside the deck; a bare anchor would navigate the presenting
        // tab away from the presentation.
        expect(sanitizeToLightEditorHtml('<p><a href="https://eigen.is">go</a></p>')).toBe(
            '<p><a href="https://eigen.is" target="_blank" rel="noopener noreferrer">go</a></p>',
        );
    });

    test('the new-tab pair is forced, never trusted from the source markup', () => {
        expect(sanitizeToLightEditorHtml('<a href="https://eigen.is" target="_self" rel="opener">x</a>')).toBe(
            '<a href="https://eigen.is" target="_blank" rel="noopener noreferrer">x</a>',
        );
    });

    test('an unsafe href still unwraps to its text, gaining no attributes', () => {
        expect(sanitizeToLightEditorHtml('<a href="javascript:alert(1)">x</a>')).toBe('x');
    });
});
