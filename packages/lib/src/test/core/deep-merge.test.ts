import { describe, expect, test } from 'bun:test';
import { deepMerge } from '../../core/deep-merge';

type Settings = {
    tags?: string[];
    view?: { width?: string; outline?: boolean };
    mode?: string | { name?: string };
};

describe('deepMerge', () => {
    test('an array in the change replaces the stored array whole', () => {
        const target: Settings = { tags: ['a', 'b'] };
        expect(deepMerge(target, { tags: ['c'] })).toEqual({ tags: ['c'] });
    });

    test('nested records merge and keep the fields the change does not name', () => {
        const target: Settings = { tags: ['a'], view: { width: 'narrow', outline: true } };
        expect(deepMerge(target, { view: { width: 'wide' } })).toEqual({
            tags: ['a'],
            view: { width: 'wide', outline: true },
        });
    });

    test('a scalar replaces a record, and a record replaces a scalar', () => {
        expect(deepMerge<Settings>({ mode: { name: 'dark' } }, { mode: 'light' })).toEqual({ mode: 'light' });
        expect(deepMerge<Settings>({ mode: 'light' }, { mode: { name: 'dark' } })).toEqual({ mode: { name: 'dark' } });
    });

    test('changes neither input', () => {
        const target: Settings = { tags: ['a'], view: { width: 'narrow', outline: true } };
        const source: Settings = { tags: ['b'], view: { width: 'wide' } };
        const merged = deepMerge(target, source);
        expect(merged.view).not.toBe(target.view);
        expect(target).toEqual({ tags: ['a'], view: { width: 'narrow', outline: true } });
        expect(source).toEqual({ tags: ['b'], view: { width: 'wide' } });
    });
});
