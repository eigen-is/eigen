import type { DriveSearchParams } from '@workspace/lib/types/drive';
import type { LucideIcon } from 'lucide-react';

export type EigenDocType = 'doc' | 'stickies' | 'slides' | 'sheets' | 'chat';

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
    return { pid, uid, mid } as DriveSearchParams;
}
