import { getItemMapRoot } from '@workspace/lib/collab/yjs-utils';
import type { DrivePath } from '@workspace/lib/types/drive';
import type * as Y from 'yjs';
import { COLLAB_DB_CONFIG } from '../collab/db-config';
import { loadYjsState } from '../collab/yjs-loader';
import type { Mount } from '../mount';

// Card and column fields are untyped in the Y.Map root; this reader only wants the
// ones the editor writes as plain strings.
function stringField(item: Y.Map<unknown>, field: string): string | undefined {
    const value = item.get(field);
    return typeof value === 'string' ? value : undefined;
}

export type StickiesContent = {
    tasks: { title?: string; description?: string }[];
    columns: { title?: string }[];
};

export async function readStickiesContent(mount: Mount, drivePath: DrivePath): Promise<StickiesContent> {
    const dataDbPath = await mount.getChildByName(drivePath.id, 'data.db');
    if (!dataDbPath) throw new Error('eigenstickies data.db missing');

    const managedDb = await mount.openDatabase(COLLAB_DB_CONFIG, dataDbPath.id);
    const { doc } = loadYjsState(managedDb);

    const tasks: StickiesContent['tasks'] = [];
    for (const [, card] of getItemMapRoot(doc, 'tasks')) {
        tasks.push({ title: stringField(card, 'title'), description: stringField(card, 'description') });
    }

    const columns: StickiesContent['columns'] = [];
    for (const [, column] of getItemMapRoot(doc, 'columns')) {
        columns.push({ title: stringField(column, 'title') });
    }

    return { tasks, columns };
}
