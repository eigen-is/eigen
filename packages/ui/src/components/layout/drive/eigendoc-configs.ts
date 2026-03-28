import { DRIVE_TYPE_DOC, DRIVE_TYPE_SHEETS, DRIVE_TYPE_SLIDES, DRIVE_TYPE_STICKIES } from '@workspace/lib/types/drive';
import { FileText, Presentation, Sheet, StickyNote } from 'lucide-react';
import { DriveCreateDoc } from './drive-create-doc';
import { DriveCreateSheets } from './drive-create-sheets';
import { DriveCreateSlides } from './drive-create-slides';
import { DriveCreateStickies } from './drive-create-stickies';
import type { EigenDocAppConfig } from './eigendoc-config';

export const DOCS_CONFIG: EigenDocAppConfig = {
    appName: 'docs',
    mimeType: 'application-eigendoc',
    driveType: DRIVE_TYPE_DOC,
    icon: FileText,
    newLabel: 'New document',
    allLabel: 'All docs',
    createDialog: DriveCreateDoc,
};

export const STICKIES_CONFIG: EigenDocAppConfig = {
    appName: 'stickies',
    mimeType: 'application-eigenstickies',
    driveType: DRIVE_TYPE_STICKIES,
    icon: StickyNote,
    newLabel: 'New stickies',
    allLabel: 'All stickies',
    createDialog: DriveCreateStickies,
};

export const SLIDES_CONFIG: EigenDocAppConfig = {
    appName: 'slides',
    mimeType: 'application-eigenslides',
    driveType: DRIVE_TYPE_SLIDES,
    icon: Presentation,
    newLabel: 'New slides',
    allLabel: 'All slides',
    createDialog: DriveCreateSlides,
};

export const SHEETS_CONFIG: EigenDocAppConfig = {
    appName: 'sheets',
    mimeType: 'application-eigensheets',
    driveType: DRIVE_TYPE_SHEETS,
    icon: Sheet,
    newLabel: 'New sheet',
    allLabel: 'All sheets',
    createDialog: DriveCreateSheets,
};
