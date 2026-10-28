// A user's Drive view, list or grid and its sort, kept in their settings so it follows them to every device. A copy in
// this browser draws the folder before the settings load.

import type { DriveSortDir, DriveSortKey, DriveViewMode, DriveViewPreferences } from '@workspace/lib/types/drive';
import { DRIVE_SORT_KEYS } from '@workspace/lib/types/drive';
import type { SettingWithCopy } from '../../space/hooks/use-setting-with-copy';
import { useSettingWithCopy } from '../../space/hooks/use-setting-with-copy';

const DEFAULTS: DriveViewPreferences = { mode: 'list', sortKey: 'name', sortDir: 'asc' };

const DRIVE_VIEW: SettingWithCopy<DriveViewPreferences> = {
    copyKey: (ownerId) => `eigen-drive-view:${ownerId || 'anon'}`,
    read: ({ driveView }) => driveView && { ...DEFAULTS, ...driveView },
    patch: (driveView) => ({ driveView }),
    parse: (copy) => {
        try {
            const v = JSON.parse(copy);
            return {
                mode: v.mode === 'grid' ? 'grid' : 'list',
                sortKey: DRIVE_SORT_KEYS.find((key) => key === v.sortKey) ?? 'name',
                sortDir: v.sortDir === 'desc' ? 'desc' : 'asc',
            };
        } catch {
            return undefined;
        }
    },
    serialize: (prefs) => JSON.stringify(prefs),
};

export function useDriveViewPreferences(): DriveViewPreferences & {
    setMode: (mode: DriveViewMode) => void;
    setSort: (sortKey: DriveSortKey, sortDir: DriveSortDir) => void;
} {
    const { value, save } = useSettingWithCopy(DRIVE_VIEW);
    const prefs = value ?? DEFAULTS;
    const apply = (next: DriveViewPreferences) => {
        if (next.mode === prefs.mode && next.sortKey === prefs.sortKey && next.sortDir === prefs.sortDir) return;
        save(next);
    };
    return {
        mode: prefs.mode,
        sortKey: prefs.sortKey,
        sortDir: prefs.sortDir,
        setMode: (mode) => apply({ ...prefs, mode }),
        setSort: (sortKey, sortDir) => apply({ ...prefs, sortKey, sortDir }),
    };
}
