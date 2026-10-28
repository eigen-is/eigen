import { describe, expect, test } from 'bun:test';
import { dataUriMediaType, splitDataUri } from '../../lib/shared/data-uri';

describe('splitDataUri', () => {
    test('reads the scheme and the base64 marker in any case, as RFC 2397 allows', () => {
        expect(splitDataUri('DATA:image/PNG;BASE64,iVBO')).toEqual({ mediaType: 'image/png', base64: 'iVBO' });
        expect(splitDataUri('Data:image/png;charset=utf-8;Base64,iVBO')).toEqual({
            mediaType: 'image/png',
            base64: 'iVBO',
        });
    });

    test('is null for a URI that is not base64 or not data:', () => {
        expect(splitDataUri('data:text/plain,hello')).toBeNull();
        expect(splitDataUri('https://example.com/a.png')).toBeNull();
        expect(splitDataUri('data:image/png;base64')).toBeNull();
    });
});

describe('dataUriMediaType', () => {
    test('reads the media type of a plain-text or percent-encoded data: URI too, bare and in lower case', () => {
        expect(dataUriMediaType('DATA:Image/SVG+XML;charset=utf-8,%3Csvg%3E')).toBe('image/svg+xml');
        expect(dataUriMediaType('data:image/svg+xml,<svg/>')).toBe('image/svg+xml');
        expect(dataUriMediaType('data:image/png;base64,iVBO')).toBe('image/png');
    });

    test('is null for a value that is no data: URI or names no media type', () => {
        expect(dataUriMediaType('https://example.com/a.svg')).toBeNull();
        expect(dataUriMediaType('data:image/svg+xml')).toBeNull();
        expect(dataUriMediaType('data:;base64,iVBO')).toBeNull();
    });
});
