import { describe, expect, test } from 'bun:test';
import { backgroundCss, getBackgroundStyle, isSameFill } from '../../background/style';

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
            backgroundImage: `linear-gradient(180deg, #ffffff 0%, #ffffffdf 12.5%, #ffffffbf 25%, #ffffff9f 37.5%, #ffffff80 50%, #ffffff60 62.5%, #ffffff40 75%, #ffffff20 87.5%, #ffffff00 100%)`,
        });
    });

    // The transparent-end rule is a GRADIENT rule: a solid transparent paint still declares the token.
    test('a solid transparent fill is left alone', () => {
        expect(getBackgroundStyle({ type: 'solid', color: 'transparent' })).toEqual({
            backgroundColor: 'transparent',
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

describe('isSameFill', () => {
    test('null / undefined cases', () => {
        expect(isSameFill(null, null)).toBe(true);
        expect(isSameFill(undefined, undefined)).toBe(true);
        expect(isSameFill(null, undefined)).toBe(true);
        expect(isSameFill(undefined, null)).toBe(true);
        expect(isSameFill(null, { type: 'solid', color: '#fff' })).toBe(false);
        expect(isSameFill({ type: 'solid', color: '#fff' }, null)).toBe(false);
        expect(isSameFill(undefined, { type: 'solid', color: '#fff' })).toBe(false);
    });

    test('different types → false', () => {
        expect(
            isSameFill({ type: 'solid', color: '#fff' }, { type: 'gradient', from: '#fff', to: '#000', angle: 0 }),
        ).toBe(false);
    });

    test('solid equality', () => {
        expect(isSameFill({ type: 'solid', color: '#abc' }, { type: 'solid', color: '#abc' })).toBe(true);
        expect(isSameFill({ type: 'solid', color: '#abc' }, { type: 'solid', color: '#abd' })).toBe(false);
    });

    test('gradient equality', () => {
        const g = { type: 'gradient', from: '#fff', to: 'transparent', angle: 180 } as const;
        expect(isSameFill(g, { ...g })).toBe(true);
        expect(isSameFill(g, { ...g, angle: 90 })).toBe(false);
        expect(isSameFill(g, { ...g, from: '#000' })).toBe(false);
    });

    test('image equality', () => {
        const i = { type: 'image', mediaName: 'a.png', fit: 'cover' } as const;
        expect(isSameFill(i, { ...i })).toBe(true);
        expect(isSameFill(i, { ...i, fit: 'contain' })).toBe(false);
        expect(isSameFill(i, { ...i, mediaName: 'b.png' })).toBe(false);
    });
});

describe('backgroundCss', () => {
    test('is getBackgroundStyle as declarations', () => {
        expect(backgroundCss({ type: 'solid', color: '#ff0080' })).toEqual(['background-color:#ff0080']);
        expect(backgroundCss({ type: 'gradient', from: '#fff', to: 'transparent', angle: 180 })).toEqual([
            `background-image:linear-gradient(180deg, #ffffff 0%, #ffffffdf 12.5%, #ffffffbf 25%, #ffffff9f 37.5%, #ffffff80 50%, #ffffff60 62.5%, #ffffff40 75%, #ffffff20 87.5%, #ffffff00 100%)`,
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
