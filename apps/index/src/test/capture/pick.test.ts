// Tests how the capture tool picks scenes from its command line: none named runs all, an unknown name throws.

import { describe, expect, test } from 'bun:test';
import { pickScenes } from '../../../capture/lib/pick';

const scenes = [{ name: 'drive-home' }, { name: 'two-editors' }];

describe('pickScenes', () => {
    test('no names picks every scene', () => {
        expect(pickScenes([], scenes)).toEqual(scenes);
    });

    test('picks the named scenes in the given order', () => {
        expect(pickScenes(['two-editors', 'drive-home'], scenes).map((s) => s.name)).toEqual([
            'two-editors',
            'drive-home',
        ]);
    });

    test('an unknown name throws, listing the known scenes', () => {
        expect(() => pickScenes(['nope'], scenes)).toThrow('Unknown scene nope. Scenes: drive-home, two-editors');
    });
});
