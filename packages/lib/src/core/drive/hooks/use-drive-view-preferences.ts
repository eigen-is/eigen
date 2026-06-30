import { useMutation, useQueryClient } from '@tanstack/react-query';
import { spaceApi } from '@workspace/lib/api';
import { useAuth, useIsGuest } from '@workspace/lib/auth';
import type { DriveSortDir, DriveSortKey, DriveViewMode, DriveViewPreferences } from '@workspace/lib/types/drive';
import type { UserSettings } from '@workspace/lib/types/settings';
import { spaceKeys, useSpaceSettings } from '../../space/hooks/use-space-settings';

const DEFAULTS: DriveViewPreferences = { mode: 'list', sortKey: 'name', sortDir: 'asc' };
const CACHE_KEY = 'eigen-drive-view';

function readCache(): DriveViewPreferences {
    if (typeof window === 'undefined') return DEFAULTS;
    try {
        const v = JSON.parse(window.localStorage.getItem(CACHE_KEY) || '');
        return {
            mode: v.mode === 'grid' ? 'grid' : 'list',
            sortKey: v.sortKey === 'modified' || v.sortKey === 'size' ? v.sortKey : 'name',
            sortDir: v.sortDir === 'desc' ? 'desc' : 'asc',
        };
    } catch {
        return DEFAULTS;
    }
}

function writeCache(p: DriveViewPreferences) {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(CACHE_KEY, JSON.stringify(p));
    } catch {}
}

export function useDriveViewPreferences() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const isGuest = useIsGuest();
    const ownerId = user?.id || '';
    const { data: settings } = useSpaceSettings();

    const cached = readCache();
    const sv = settings?.driveView;
    const prefs: DriveViewPreferences = {
        mode: sv?.mode ?? cached.mode,
        sortKey: sv?.sortKey ?? cached.sortKey,
        sortDir: sv?.sortDir ?? cached.sortDir,
    };

    const mutation = useMutation({
        mutationFn: async (next: DriveViewPreferences) => {
            if (!ownerId || isGuest) return; // guests: cache-only, no server write
            const res = await spaceApi({ ownerId }).settings.put({ driveView: next });
            if (res.error) throw new Error('Failed to save drive view preference');
            return res.data;
        },
        onMutate: async (next) => {
            writeCache(next);
            await queryClient.cancelQueries({ queryKey: spaceKeys.settings(ownerId) });
            const prev = queryClient.getQueryData<UserSettings>(spaceKeys.settings(ownerId));
            queryClient.setQueryData<UserSettings>(spaceKeys.settings(ownerId), (old) => ({
                ...(old ?? {}),
                driveView: next,
            }));
            return { prev };
        },
        onError: (_e, _next, context) => {
            if (context?.prev !== undefined) {
                queryClient.setQueryData(spaceKeys.settings(ownerId), context.prev);
                writeCache({ ...DEFAULTS, ...context.prev.driveView });
            }
        },
    });

    const apply = (next: DriveViewPreferences) => mutation.mutate(next);
    return {
        mode: prefs.mode,
        sortKey: prefs.sortKey,
        sortDir: prefs.sortDir,
        setMode: (mode: DriveViewMode) => apply({ ...prefs, mode }),
        setSort: (sortKey: DriveSortKey, sortDir: DriveSortDir) => apply({ ...prefs, sortKey, sortDir }),
    };
}
