import type { Command } from '@workspace/lib/types/command-palette';
import { Calendar, FileText, FolderPlus, Presentation, StickyNote, Table, Upload, UserPlus } from 'lucide-react';

export const createCommands: Command[] = [
    {
        id: 'create.doc',
        title: 'New document',
        keywords: ['eigendoc', 'create'],
        icon: FileText,
        baseRank: 12,
        run: (ctx) => ctx.openDriveCreate('doc'),
    },
    {
        id: 'create.sheet',
        title: 'New spreadsheet',
        keywords: ['eigensheets', 'create'],
        icon: Table,
        baseRank: 12,
        run: (ctx) => ctx.openDriveCreate('sheet'),
    },
    {
        id: 'create.slides',
        title: 'New presentation',
        keywords: ['eigenslides', 'create', 'deck'],
        icon: Presentation,
        baseRank: 12,
        run: (ctx) => ctx.openDriveCreate('slides'),
    },
    {
        id: 'create.stickies',
        title: 'New stickies board',
        keywords: ['eigenstickies', 'kanban', 'create'],
        icon: StickyNote,
        baseRank: 12,
        run: (ctx) => ctx.openDriveCreate('stickies'),
    },
    {
        id: 'create.contact',
        title: 'New contact',
        keywords: ['person', 'address'],
        icon: UserPlus,
        baseRank: 10,
        run: (ctx) => ctx.openDriveCreate('contact'),
    },
    {
        id: 'create.event',
        title: 'New event',
        keywords: ['calendar', 'meeting'],
        icon: Calendar,
        baseRank: 10,
        run: (ctx) => ctx.openDriveCreate('event'),
    },
    {
        id: 'create.folder',
        title: 'New folder',
        keywords: ['drive'],
        icon: FolderPlus,
        baseRank: 8,
        run: (ctx) => ctx.openDriveCreate('folder'),
    },
    {
        id: 'create.upload',
        title: 'Upload file',
        keywords: ['drive'],
        icon: Upload,
        baseRank: 8,
        run: (ctx) => ctx.openDriveCreate('upload'),
    },
];
