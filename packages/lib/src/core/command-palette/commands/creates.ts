import { EIGEN_DOC_ICONS } from '@workspace/lib/eigendoc-icons';
import type { Command } from '@workspace/lib/types/command-palette';
import { EIGEN_DOC_TYPE_INFO } from '@workspace/lib/types/drive';
import { FolderPlus } from 'lucide-react';
import { BASE_RANKS } from './base-ranks';

// "New …" actions hand off to the shared DriveCreateEigenDoc / DriveCreateFolder
// dialogs mounted in app-shell's PaletteRunner — the same dialogs the Drive sidebar's
// New menu uses (drive-new-menu.tsx). Labels and icons derive from the EIGEN_DOC_TYPE_INFO
// + EIGEN_DOC_ICONS registries so the palette and the sidebar stay aligned by construction.
export const createCommands: Command[] = [
    ...Object.values(EIGEN_DOC_TYPE_INFO).map<Command>((info) => ({
        id: `create.${info.type}`,
        title: `New ${info.label.toLowerCase()}`,
        keywords: [`eigen${info.type}`, 'create'],
        icon: EIGEN_DOC_ICONS[info.type],
        baseRank: BASE_RANKS.CREATE_EIGENDOC,
        run: (ctx) => ctx.openDriveCreate(info.type),
    })),
    {
        id: 'create.folder',
        title: 'New folder',
        keywords: ['drive', 'create'],
        icon: FolderPlus,
        baseRank: BASE_RANKS.CREATE_FOLDER,
        run: (ctx) => ctx.openDriveCreate('folder'),
    },
];
