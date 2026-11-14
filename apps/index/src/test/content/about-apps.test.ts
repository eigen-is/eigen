import { describe, expect, test } from 'bun:test';
import { aboutApps } from '../../content/about-apps';

describe('aboutApps', () => {
    test('are the ten apps without Space, in the registry order', () => {
        expect(aboutApps.map((app) => app.slug)).toEqual([
            'mail',
            'drive',
            'calendar',
            'docs',
            'sheets',
            'slides',
            'vector',
            'stickies',
            'chat',
            'contacts',
        ]);
    });
});
