import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { restoreYjsDoc } from './yjs-utils';

describe('restoreYjsDoc', () => {
    test('restores Y.Map content into a doc that already registered the type via getMap', () => {
        const live = new Y.Doc();
        live.getMap('state').set('marker', 'V2');

        const target = new Y.Doc();
        target.getMap('state').set('marker', 'V1');

        restoreYjsDoc(live, Y.encodeStateAsUpdate(target));

        expect(live.getMap('state').get('marker')).toBe('V1');
    });

    test('restores Y.Array content into a doc that already registered the type via getArray', () => {
        const live = new Y.Doc();
        live.getArray('ops').push([1, 2, 3]);

        const target = new Y.Doc();
        target.getArray('ops').push(['a', 'b']);

        restoreYjsDoc(live, Y.encodeStateAsUpdate(target));

        expect(live.getArray('ops').toArray()).toEqual(['a', 'b']);
    });

    test('restores when types are AbstractType — live doc hydrated via Y.applyUpdate only', () => {
        // Regression: server-side CollabDocument's Y.Doc is populated by
        // loadYjsState (which is Y.applyUpdate under the hood). That leaves
        // top-level types as AbstractType, NOT Y.Map / Y.Array. The original
        // `instanceof` check failed for both branches → restoreYjsDoc was a
        // no-op for server-side restore.
        const seed = new Y.Doc();
        seed.getMap('state').set('marker', 'V2');
        seed.getArray('ops').push([1, 2, 3]);
        const live = new Y.Doc();
        Y.applyUpdate(live, Y.encodeStateAsUpdate(seed));
        // Confirm the precondition: live's share entries are AbstractType.
        for (const value of live.share.values()) {
            expect(value.constructor.name).toBe('AbstractType');
        }

        const target = new Y.Doc();
        target.getMap('state').set('marker', 'V1');
        target.getArray('ops').push(['a', 'b']);

        restoreYjsDoc(live, Y.encodeStateAsUpdate(target));

        expect(live.getMap('state').get('marker')).toBe('V1');
        expect(live.getArray('ops').toArray()).toEqual(['a', 'b']);
    });

    test('emits exactly one update event covering the whole transaction', async () => {
        const seed = new Y.Doc();
        seed.getMap('state').set('marker', 'V2');
        const live = new Y.Doc();
        Y.applyUpdate(live, Y.encodeStateAsUpdate(seed));

        const target = new Y.Doc();
        target.getMap('state').set('marker', 'V1');

        let updates = 0;
        live.on('update', () => {
            updates += 1;
        });
        restoreYjsDoc(live, Y.encodeStateAsUpdate(target));
        expect(updates).toBe(1);
    });
});
