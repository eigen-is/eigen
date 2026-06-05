import type { DriveSearchParams, EigenDocType } from '@workspace/lib/types/drive';
import type { LucideIcon } from 'lucide-react';

export type { EigenDocType } from '@workspace/lib/types/drive';

export type EigenDocAppConfig = {
    appName: string;
    mimeType: string;
    driveType: string;
    icon: LucideIcon;
    newLabel: string;
    allLabel: string;
    createType: EigenDocType;
};

export function eigenDocValidateSearch(search: Record<string, unknown>): DriveSearchParams {
    const pid = typeof search.pid === 'string' ? search.pid : undefined;
    const uid = typeof search.uid === 'string' ? search.uid : undefined;
    const mid = typeof search.mid === 'string' ? search.mid : undefined;
    return { pid, uid, mid };
}

// The four EigenDoc editor routes (doc/slide/board/sheet) all read an optional
// `?chat=` deep-link param; share one validator so they can't drift.
export function eigenDocEditorValidateSearch(search: Record<string, unknown>): { chat?: string } {
    return { chat: typeof search.chat === 'string' ? search.chat : undefined };
}
