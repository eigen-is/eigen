import { describe, expect, test } from 'bun:test';
import { backgroundCss, getBackgroundStyle } from '../../background/style';

describe('getBackgroundStyle', () => {
    test('null / undefined → empty style', () => {
        expect(getBackgroundStyle(null)).toEqual({});
        expect(getBackgroundStyle(undefined)).toEqual({});
    });

    test('solid → backgroundColor', () => {
        expect(getBackgroundStyle({ type: 'solid', color: '#ff0080' })).toEqual({
            backgroundColor: '#ff0080',
        });
    });

    test('gradient → linear-gradient backgroundImage', () => {
        expect(getBackgroundStyle({ type: 'gradient', from: '#ffffff', to: 'transparent', angle: 180 })).toEqual({
            backgroundImage: 'linear-gradient(180deg, #ffffff, transparent)',
        });
    });

    test('image with resolver → backgroundImage + size + position + no-repeat', () => {
        expect(
            getBackgroundStyle({ type: 'image', mediaName: 'pic.png', fit: 'cover' }, (name) => `https://cdn/${name}`),
        ).toEqual({
            backgroundImage: 'url(https://cdn/pic.png)',
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
        });
    });

    test('image with contain fit', () => {
        const style = getBackgroundStyle(
            { type: 'image', mediaName: 'pic.png', fit: 'contain' },
            (name) => `https://cdn/${name}`,
        );
        expect(style.backgroundSize).toBe('contain');
    });

    test('image without resolver → empty style (server-side)', () => {
        expect(getBackgroundStyle({ type: 'image', mediaName: 'pic.png', fit: 'cover' })).toEqual({});
    });

    test('image with empty mediaName (in-flight placeholder) → empty style', () => {
        expect(
            getBackgroundStyle({ type: 'image', mediaName: '', fit: 'cover' }, (name) => `https://cdn/${name}`),
        ).toEqual({});
    });
});

describe('backgroundCss', () => {
    test('is getBackgroundStyle as declarations', () => {
        expect(backgroundCss({ type: 'solid', color: '#ff0080' })).toEqual(['background-color:#ff0080']);
        expect(backgroundCss({ type: 'gradient', from: '#fff', to: 'transparent', angle: 180 })).toEqual([
            'background-image:linear-gradient(180deg, #fff, transparent)',
        ]);
    });

    test('an image fill carries every declaration, camelCase hyphenated', () => {
        expect(backgroundCss({ type: 'image', mediaName: 'p.png', fit: 'cover' }, (n) => `https://cdn/${n}`)).toEqual([
            'background-image:url(https://cdn/p.png)',
            'background-size:cover',
            'background-position:center',
            'background-repeat:no-repeat',
        ]);
    });

    test('no fill is no declarations', () => {
        expect(backgroundCss(null)).toEqual([]);
        expect(backgroundCss(undefined)).toEqual([]);
    });
});
