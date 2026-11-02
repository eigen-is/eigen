import { describe, expect, test } from 'bun:test';
import type { Border } from '../../../../docs/eigendoc';
import { borderValue, readBorder } from '../../../../docs/eigendoc';

describe('readBorder', () => {
    test.each<[unknown, Border | null]>([
        ['0.67px solid #000000', { width: 0.67, style: 'solid', color: '#000000' }],
        ['1PX DASHED #CFE2F3', { width: 1, style: 'dashed', color: '#cfe2f3' }],
        ['8px double #1f3864', { width: 8, style: 'double', color: '#1f3864' }],
        ['0.5px dotted #ffffff', { width: 0.5, style: 'dotted', color: '#ffffff' }],
        ['none', 'none'],
        ['0.4px solid #000000', null],
        ['9px solid #000000', null],
        ['1e9px solid #000000', null],
        ['1px solid red', null],
        ['1px groove #000000', null],
        ['1px solid #000000; background: url(x)', null],
        ['<script>', null],
        ['inherit', null],
        [3, null],
        [null, null],
    ])('%p reads as %p', (value, border) => {
        expect(readBorder(value)).toEqual(border);
    });

    test('a border writes back as the value it was read from', () => {
        expect(borderValue({ width: 0.67, style: 'solid', color: '#000000' })).toBe('0.67px solid #000000');
        expect(borderValue('none')).toBe('none');
    });
});
