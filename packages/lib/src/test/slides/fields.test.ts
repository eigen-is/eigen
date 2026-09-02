import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { yMapToObject } from '../../slides/fields';

describe('yMapToObject', () => {
    test('normalizes commentCardIds — plain array kept, missing key becomes []', () => {
        const doc = new Y.Doc();
        const objects = doc.getMap('objects');

        const withIds = new Y.Map();
        withIds.set('id', 'obj-1');
        withIds.set('commentCardIds', ['card-1', 'card-2']);
        objects.set('obj-1', withIds);

        const without = new Y.Map();
        without.set('id', 'obj-2');
        objects.set('obj-2', without);

        expect(yMapToObject(withIds).commentCardIds).toEqual(['card-1', 'card-2']);
        expect(yMapToObject(without).commentCardIds).toEqual([]);
    });
});
