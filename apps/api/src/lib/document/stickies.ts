import type { DrivePath } from '@workspace/lib/types/drive';
import type * as Y from 'yjs';
import { COLLAB_DB_CONFIG } from '../collab/db-config';
import { loadYjsState } from '../collab/yjs-loader';
import type { Mount } from '../mount';

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
    for (const [, value] of doc.getMap('tasks')) {
        const card = value as Y.Map<unknown>;
        tasks.push({
            title: card.get('title') as string | undefined,
            description: card.get('description') as string | undefined,
        });
    }

    const columns: StickiesContent['columns'] = [];
    for (const [, value] of doc.getMap('columns')) {
        const column = value as Y.Map<unknown>;
        columns.push({ title: column.get('title') as string | undefined });
    }

    return { tasks, columns };
}
