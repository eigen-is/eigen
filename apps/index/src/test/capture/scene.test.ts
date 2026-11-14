// Tests how the capture tool picks scenes from its command line: none named runs all, an unknown name throws.

import { describe, expect, test } from 'bun:test';
import type { Scene } from '../../../../../../scripts/capture/lib/scene';
import { pickScenes } from '../../../../../../scripts/capture/lib/scene';

const scene = (name: string): Scene => ({
    name,
    kind: 'still',
    theme: 'light',
    viewport: { width: 800, height: 600 },
    apps: ['space'],
    personas: ['anouk'],
    run: async () => {},
});

const scenes = [scene('drive-home'), scene('two-editors')];

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
