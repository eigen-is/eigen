import { useMutation, useQueryClient } from '@tanstack/react-query';
import { spaceApi } from '@workspace/lib/api';
import { useAuth, useIsGuest } from '@workspace/lib/auth';
import type { DriveSortDir, DriveSortKey, DriveViewMode, DriveViewPreferences } from '@workspace/lib/types/drive';
import type { UserSettings } from '@workspace/lib/types/settings';
import { AppError, onMutationError } from '../../api-error';
import { invalidateSpaceSettings, spaceKeys } from '../../space/hooks/keys';
import { useSpaceSettings } from '../../space/hooks/use-space-settings';

const DEFAULTS: DriveViewPreferences = { mode: 'list', sortKey: 'name', sortDir: 'asc' };

// In-memory mirror of the localStorage cache so renders don't re-hit localStorage/JSON.parse.
const memCache = new Map<string, DriveViewPreferences>();

const cacheKeyFor = (ownerId: string) => `eigen-drive-view:${ownerId || 'anon'}`;

function readCache(key: string): DriveViewPreferences {
    const hit = memCache.get(key);
    if (hit) return hit;
    if (typeof window === 'undefined') return DEFAULTS;
    let prefs = DEFAULTS;
    try {
        const v = JSON.parse(window.localStorage.getItem(key) || '');
        prefs = {
            mode: v.mode === 'grid' ? 'grid' : 'list',
            sortKey: v.sortKey === 'modified' || v.sortKey === 'size' ? v.sortKey : 'name',
            sortDir: v.sortDir === 'desc' ? 'desc' : 'asc',
        };
    } catch {}
    memCache.set(key, prefs);
    return prefs;
}

function writeCache(key: string, p: DriveViewPreferences) {
    memCache.set(key, p);
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(key, JSON.stringify(p));
    } catch {}
}

export function useDriveViewPreferences() {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const isGuest = useIsGuest();
    const ownerId = user?.id || '';
    const cacheKey = cacheKeyFor(ownerId);
    const { data: settings } = useSpaceSettings();

    const cached = readCache(cacheKey);
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
            if (res.error) throw new AppError(res);
            return res.data;
        },
        onMutate: async (next) => {
            const prevCache = readCache(cacheKey);
            writeCache(cacheKey, next);
            await queryClient.cancelQueries({ queryKey: spaceKeys.settings(ownerId) });
            const prev = queryClient.getQueryData<UserSettings>(spaceKeys.settings(ownerId));
            queryClient.setQueryData<UserSettings>(spaceKeys.settings(ownerId), (old) => ({
                ...(old ?? {}),
                driveView: next,
            }));
            return { prev, prevCache };
        },
        onError: (error, _next, context) => {
            if (context) {
                writeCache(cacheKey, context.prevCache);
                if (context.prev !== undefined) queryClient.setQueryData(spaceKeys.settings(ownerId), context.prev);
            }
            onMutationError(error);
        },
        // Refetch server truth after any write attempt (also cleans up when prev was empty).
        onSettled: () => {
            if (ownerId && !isGuest) invalidateSpaceSettings(queryClient, ownerId);
        },
    });

    const apply = (next: DriveViewPreferences) => {
        if (next.mode === prefs.mode && next.sortKey === prefs.sortKey && next.sortDir === prefs.sortDir) return;
        mutation.mutate(next);
    };
    return {
        mode: prefs.mode,
        sortKey: prefs.sortKey,
        sortDir: prefs.sortDir,
        setMode: (mode: DriveViewMode) => apply({ ...prefs, mode }),
        setSort: (sortKey: DriveSortKey, sortDir: DriveSortDir) => apply({ ...prefs, sortKey, sortDir }),
    };
}
