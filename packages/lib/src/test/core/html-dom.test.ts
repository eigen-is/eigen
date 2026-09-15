import { describe, expect, test } from 'bun:test';
import { sanitizeToLightEditorHtml } from '../../core/html-dom';
import { installHappyDom } from '../happy-dom';

// The sanitizer parses with DOMParser and rebuilds through `document`.
installHappyDom();

describe('sanitizeToLightEditorHtml — links', () => {
    test('a safe link opens in a new tab with the opener sealed', () => {
        // Present mode renders this markup inside the deck; a bare anchor would navigate the presenting
        // tab away from the presentation.
        // Attribute ORDER is Tiptap's own (Link merges its configured HTMLAttributes before href), so a
        // pasted box is already in canonical form and the first keystroke is not a whole-html rewrite.
        expect(sanitizeToLightEditorHtml('<p><a href="https://eigen.is">go</a></p>')).toBe(
            '<p><a target="_blank" rel="noopener noreferrer" href="https://eigen.is">go</a></p>',
        );
    });

    test('the new-tab pair is forced, never trusted from the source markup', () => {
        expect(sanitizeToLightEditorHtml('<a href="https://eigen.is" target="_self" rel="opener">x</a>')).toBe(
            '<a target="_blank" rel="noopener noreferrer" href="https://eigen.is">x</a>',
        );
    });

    test('an unsafe href still unwraps to its text, gaining no attributes', () => {
        expect(sanitizeToLightEditorHtml('<a href="javascript:alert(1)">x</a>')).toBe('x');
    });
});
