import type { DrivePath, DriveSearchParams } from '@workspace/lib/types/drive';
import type { LucideIcon } from 'lucide-react';
import type { ComponentType } from 'react';

export type EigenDocCreateDialogProps = {
    path: DrivePath;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCancel?: () => void;
    onAfterAction?: (actionType: string, data: Record<string, unknown>) => void;
};

export type EigenDocAppConfig = {
    appName: string;
    mimeType: string;
    driveType: string;
    icon: LucideIcon;
    newLabel: string;
    allLabel: string;
    createDialog: ComponentType<EigenDocCreateDialogProps>;
};

export function eigenDocValidateSearch(search: Record<string, unknown>): DriveSearchParams {
    const pid = typeof search.pid === 'string' ? search.pid : undefined;
    const uid = typeof search.uid === 'string' ? search.uid : undefined;
    const mid = typeof search.mid === 'string' ? search.mid : undefined;
    return { pid, uid, mid } as DriveSearchParams;
}
