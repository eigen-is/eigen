import type { Command } from '@workspace/lib/types/command-palette';
import { FileText, FolderPlus, MessageSquare, Presentation, Sheet, SquareKanban } from 'lucide-react';

// "New …" actions hand off to the shared DriveCreateEigenDoc and DriveCreateFolder
// dialogs mounted in app-shell's PaletteRunner. `openDriveCreate(kind)` toggles them
// open; the user picks the location via the same DriveLocationPicker that the Drive
// sidebar's New menu uses. Labels and icons mirror that menu (drive-new-menu.tsx)
// so the palette and the sidebar stay consistent at a glance.
export const createCommands: Command[] = [
    {
        id: 'create.doc',
        title: 'New doc',
        keywords: ['eigendoc', 'document', 'create'],
        icon: FileText,
        baseRank: 12,
        run: (ctx) => ctx.openDriveCreate('doc'),
    },
    {
        id: 'create.stickies',
        title: 'New stickies',
        keywords: ['eigenstickies', 'kanban', 'create'],
        icon: SquareKanban,
        baseRank: 12,
        run: (ctx) => ctx.openDriveCreate('stickies'),
    },
    {
        id: 'create.chat',
        title: 'New chat',
        keywords: ['eigenchat', 'create'],
        icon: MessageSquare,
        baseRank: 12,
        run: (ctx) => ctx.openDriveCreate('chat'),
    },
    {
        id: 'create.slides',
        title: 'New slide',
        keywords: ['eigenslides', 'presentation', 'deck', 'create'],
        icon: Presentation,
        baseRank: 12,
        run: (ctx) => ctx.openDriveCreate('slides'),
    },
    {
        id: 'create.sheets',
        title: 'New sheet',
        keywords: ['eigensheets', 'spreadsheet', 'create'],
        icon: Sheet,
        baseRank: 12,
        run: (ctx) => ctx.openDriveCreate('sheets'),
    },
    {
        id: 'create.folder',
        title: 'New folder',
        keywords: ['drive', 'create'],
        icon: FolderPlus,
        baseRank: 8,
        run: (ctx) => ctx.openDriveCreate('folder'),
    },
];
