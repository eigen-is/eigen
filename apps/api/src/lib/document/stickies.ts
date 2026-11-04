// A stickies board's text for Drive's content search: the title and description of each card and the
// title of each column. The content reindex queue reads it when a board is due, the way it extracts any
// other document. It reads the board's data.db while it loads the Yjs state, and lets go of it then.

import { getItemMapRoot } from '@workspace/lib/collab/yjs-utils';
import type { DrivePath } from '@workspace/lib/types/drive';
import * as Y from 'yjs';
import { COLLAB_DB_CONFIG } from '../collab/db-config';
import { loadYjsState } from '../collab/yjs-loader';
import type { Mount } from '../mount';
import { CONTAINER_DATA_DB } from '../mount/container-dbs';

export type StickiesContent = {
    tasks: { title?: string; description?: string }[];
    columns: { title?: string }[];
};

export async function readStickiesContent(mount: Mount, drivePath: DrivePath): Promise<StickiesContent> {
    const dataDbPath = await mount.getChildByName(drivePath.id, CONTAINER_DATA_DB);
    if (!dataDbPath) throw new Error('eigenstickies data.db missing');

    const { doc } = await mount.withDatabase(COLLAB_DB_CONFIG, dataDbPath.id, async (managedDb) =>
        loadYjsState(managedDb),
    );

    const tasks: StickiesContent['tasks'] = [];
    for (const [, card] of getItemMapRoot(doc, 'tasks')) {
        if (card instanceof Y.Map)
            tasks.push({ title: stringField(card, 'title'), description: stringField(card, 'description') });
    }

    const columns: StickiesContent['columns'] = [];
    for (const [, column] of getItemMapRoot(doc, 'columns')) {
        if (column instanceof Y.Map) columns.push({ title: stringField(column, 'title') });
    }

    return { tasks, columns };
}

// The fields of a card or column are untyped in the Y.Map root. This reader keeps only the ones the
// editor writes as plain strings.
function stringField(item: Y.Map<unknown>, field: string): string | undefined {
    const value = item.get(field);
    return typeof value === 'string' ? value : undefined;
}
