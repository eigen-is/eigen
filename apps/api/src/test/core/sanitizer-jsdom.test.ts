import { describe, expect, test } from 'bun:test';
import { dirname } from 'node:path';

// isomorphic-dompurify brings its own jsdom, and DOMPurify holds one window for the life of the process.
// jsdom 30 parses every `style` attribute through css-tree + @asamuzakjp/css-color, whose module-global
// caches degrade until a single sanitize of a two-element body costs tens of seconds — and the mail reader
// sanitizes one on the main thread for every message opened. The `jsdom` resolution in the root
// package.json keeps the sanitizer on the same copy as the rest of the API; this is the guard on it.
describe('the shared sanitizer', () => {
    test('resolves the same jsdom as the rest of the API', () => {
        const ours = Bun.resolveSync('jsdom', import.meta.dir);
        const sanitizerPackage = dirname(Bun.resolveSync('isomorphic-dompurify', import.meta.dir));
        const theirs = Bun.resolveSync('jsdom', sanitizerPackage);

        expect(theirs).toBe(ours);
    });
});
