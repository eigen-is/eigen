import { getItemMapRoot } from '@workspace/lib/collab/yjs-utils';
import type { DrivePath } from '@workspace/lib/types/drive';
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
    for (const [, card] of getItemMapRoot(doc, 'tasks')) {
        tasks.push({
            title: card.get('title') as string | undefined,
            description: card.get('description') as string | undefined,
        });
    }

    const columns: StickiesContent['columns'] = [];
    for (const [, column] of getItemMapRoot(doc, 'columns')) {
        columns.push({ title: column.get('title') as string | undefined });
    }

    return { tasks, columns };
}
