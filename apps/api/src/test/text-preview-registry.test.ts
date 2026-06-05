import { describe, expect, test } from 'bun:test';
import { getTextPreviewMode } from '@workspace/lib/constants';
import { isInlineEditable } from '@workspace/lib/types/drive';

// Characterization tests locking the behavior of the text/code file registries
// (isInlineEditable + getTextPreviewMode) so the shared-extension-corpus refactor
// stays behavior-preserving.

describe('isInlineEditable', () => {
    test('code extensions are editable', () => {
        expect(isInlineEditable('', 'app.ts')).toBe(true);
        expect(isInlineEditable('', 'data.csv')).toBe(true);
        expect(isInlineEditable('', 'config.env')).toBe(true);
        expect(isInlineEditable('', 'query.graphql')).toBe(true);
    });

    test('markdown and plain text are editable', () => {
        expect(isInlineEditable('', 'readme.md')).toBe(true);
        expect(isInlineEditable('', 'notes.txt')).toBe(true);
    });

    test('editable MIME types win regardless of name', () => {
        expect(isInlineEditable('text/x-python', 'noext')).toBe(true);
        expect(isInlineEditable('application/json', 'whatever')).toBe(true);
    });

    test('binary files are not editable', () => {
        expect(isInlineEditable('image/png', 'photo.png')).toBe(false);
        expect(isInlineEditable('', 'archive.zip')).toBe(false);
    });

    test('multi-dot names match only the final suffix', () => {
        // '.env.local' is a dead Set entry — only the trailing '.local' is ever
        // tested, and it is not editable. Locks that removing the entry is a no-op.
        expect(isInlineEditable('', 'project.env.local')).toBe(false);
    });
});

describe('getTextPreviewMode', () => {
    test('eigen-doc MIME types map to their own modes', () => {
        expect(getTextPreviewMode('application/eigendoc', 'x')).toBe('eigendoc');
        expect(getTextPreviewMode('application/eigenslides', 'x')).toBe('eigenslides');
        expect(getTextPreviewMode('application/eigensheets', 'x')).toBe('eigensheets');
    });

    test('markdown and plaintext take precedence over code', () => {
        expect(getTextPreviewMode('text/markdown', 'a.md')).toBe('markdown');
        expect(getTextPreviewMode('', 'a.md')).toBe('markdown');
        expect(getTextPreviewMode('text/plain', 'a.txt')).toBe('plaintext');
        expect(getTextPreviewMode('', 'a.txt')).toBe('plaintext');
    });

    test('code extensions preview as code', () => {
        expect(getTextPreviewMode('', 'app.ts')).toBe('code');
        expect(getTextPreviewMode('', 'data.csv')).toBe('code');
        expect(getTextPreviewMode('', 'query.graphql')).toBe('code');
    });

    test('any text/* MIME falls through to code (the prefix catch-all)', () => {
        expect(getTextPreviewMode('text/x-anything', 'unknown.xyz')).toBe('code');
    });

    test('non-text binary types have no text preview', () => {
        expect(getTextPreviewMode('image/png', 'photo.png')).toBeNull();
    });
});
