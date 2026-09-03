import { describe, expect, test } from 'bun:test';
import {
    gradientVector,
    isColorToken,
    isTransparentFill,
    parseBackgroundFill,
    parseFill,
    serializeBackgroundFill,
    serializeFill,
    solidFill,
    withFillPaint,
    withFillStyle,
} from '../../vector/fill';

describe('parseFill', () => {
    test('empty and malformed strings read back as the transparent solid fill', () => {
        for (const bad of ['', 'nonsense', '{', '[]', '{"type":"image","mediaName":"a.png","fit":"cover"}']) {
            expect(parseFill(bad)).toEqual({ type: 'solid', color: 'transparent', style: 'solid' });
        }
    });

    test('a solid fill round-trips and rejects non-colour tokens', () => {
        expect(parseFill(serializeFill({ type: 'solid', color: '#ff0000', style: 'zigzag' }))).toEqual({
            type: 'solid',
            color: '#ff0000',
            style: 'zigzag',
        });
        expect(parseFill('{"type":"solid","color":"url(http://x/y.svg)"}')).toEqual({
            type: 'solid',
            color: 'transparent',
            style: 'solid',
        });
    });

    test('a gradient round-trips, normalizes its angle and rejects bad stops', () => {
        const fill = { type: 'gradient', from: '#000000', to: '#ffffff', angle: 45, style: 'cross-hatch' } as const;
        expect(parseFill(serializeFill(fill))).toEqual(fill);
        expect(parseFill('{"type":"gradient","from":"#000000","to":"#ffffff","angle":-90}')).toEqual({
            type: 'gradient',
            from: '#000000',
            to: '#ffffff',
            angle: 270,
            style: 'solid',
        });
        expect(parseFill('{"type":"gradient","from":"red","to":"#ffffff","angle":0}')).toEqual({
            type: 'solid',
            color: 'transparent',
            style: 'solid',
        });
    });

    test('the hatch style is half of the fill: unknown and missing ones read as the default', () => {
        expect(parseFill('{"type":"solid","color":"#ff0000","style":"hachure"}').style).toBe('hachure');
        expect(parseFill('{"type":"solid","color":"#ff0000","style":"tartan"}').style).toBe('solid');
        expect(parseFill('{"type":"solid","color":"#ff0000"}').style).toBe('solid');
        expect(solidFill('#ff0000', 'zigzag')).toBe('{"type":"solid","color":"#ff0000","style":"zigzag"}');
    });

    test('each half is edited without disturbing the other', () => {
        const gradient = parseFill('{"type":"gradient","from":"#000000","to":"#ffffff","angle":45,"style":"zigzag"}');
        expect(withFillPaint(gradient, { type: 'solid', color: '#ff0000' })).toEqual({
            type: 'solid',
            color: '#ff0000',
            style: 'zigzag',
        });
        expect(withFillStyle(gradient, 'hachure')).toEqual({
            type: 'gradient',
            from: '#000000',
            to: '#ffffff',
            angle: 45,
            style: 'hachure',
        });
    });

    test('solidFill and isTransparentFill agree on the no-fill sentinel', () => {
        expect(parseFill(solidFill('transparent'))).toEqual({
            type: 'solid',
            color: 'transparent',
            style: 'solid',
        });
        expect(isTransparentFill(parseFill(''))).toBe(true);
        expect(isTransparentFill({ type: 'gradient', from: '#000000', to: '#ffffff', angle: 0, style: 'solid' })).toBe(
            false,
        );
    });
});

describe('parseBackgroundFill', () => {
    test('accepts the image variant frames need and round-trips null as the empty string', () => {
        const image = { type: 'image', mediaName: 'bg.png', fit: 'cover' } as const;
        expect(parseBackgroundFill(serializeBackgroundFill(image))).toEqual(image);
        expect(serializeBackgroundFill(null)).toBe('');
        expect(parseBackgroundFill('')).toBeNull();
        expect(parseBackgroundFill('{"type":"image","mediaName":"../evil","fit":"cover"}')).toBeNull();
        // A frame background is the paint alone: an element's hatch style means nothing to it.
        expect(parseBackgroundFill(solidFill('#ff0000', 'zigzag'))).toEqual({ type: 'solid', color: '#ff0000' });
    });
});

describe('gradientVector', () => {
    test('0deg paints bottom-to-top and 90deg left-to-right, in objectBoundingBox units', () => {
        expect(gradientVector(0)).toEqual({ x1: 0.5, y1: 1, x2: 0.5, y2: 0 });
        expect(gradientVector(90)).toEqual({ x1: 0, y1: 0.5, x2: 1, y2: 0.5 });
    });
});

describe('isColorToken', () => {
    test('hex and the transparent sentinel only', () => {
        expect(isColorToken('#abc')).toBe(true);
        expect(isColorToken('#aabbccdd')).toBe(true);
        expect(isColorToken('transparent')).toBe(true);
        expect(isColorToken('rgb(1,2,3)')).toBe(false);
        expect(isColorToken(3)).toBe(false);
    });
});
