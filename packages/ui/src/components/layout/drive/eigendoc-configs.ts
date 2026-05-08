import { DRIVE_TYPE_DOC, DRIVE_TYPE_SHEETS, DRIVE_TYPE_SLIDES, DRIVE_TYPE_STICKIES } from '@workspace/lib/types/drive';
import { FileText, Presentation, Sheet, SquareKanban } from 'lucide-react';
import type { EigenDocAppConfig } from './eigendoc-config';

export const DOCS_CONFIG: EigenDocAppConfig = {
    appName: 'docs',
    mimeType: 'application-eigendoc',
    driveType: DRIVE_TYPE_DOC,
    icon: FileText,
    newLabel: 'New doc',
    allLabel: 'All docs',
    createType: 'doc',
};

export const STICKIES_CONFIG: EigenDocAppConfig = {
    appName: 'stickies',
    mimeType: 'application-eigenstickies',
    driveType: DRIVE_TYPE_STICKIES,
    icon: SquareKanban,
    newLabel: 'New stickies',
    allLabel: 'All stickies',
    createType: 'stickies',
};

export const SLIDES_CONFIG: EigenDocAppConfig = {
    appName: 'slides',
    mimeType: 'application-eigenslides',
    driveType: DRIVE_TYPE_SLIDES,
    icon: Presentation,
    newLabel: 'New slide',
    allLabel: 'All slides',
    createType: 'slides',
};

export const SHEETS_CONFIG: EigenDocAppConfig = {
    appName: 'sheets',
    mimeType: 'application-eigensheets',
    driveType: DRIVE_TYPE_SHEETS,
    icon: Sheet,
    newLabel: 'New sheet',
    allLabel: 'All sheets',
    createType: 'sheets',
};
