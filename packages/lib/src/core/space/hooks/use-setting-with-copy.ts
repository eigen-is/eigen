// A user setting that this browser also keeps a copy of, such as the theme or the Drive view. The settings
// follow the user to every device. The copy draws the page before they load, and it is all a guest has.
// A change writes the copy and the settings at once, and puts both back when the server refuses it.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { spaceApi } from '@workspace/lib/api';
import { useAuth, useIsGuest } from '@workspace/lib/auth';
import type { UserSettings } from '@workspace/lib/types/settings';
import { useEffect, useMemo } from 'react';
import { AppError, onMutationError } from '../../api-error';
import { invalidateSpaceSettings, spaceKeys } from './keys';
import { useSpaceSettings } from './use-space-settings';

export type SettingWithCopy<T> = {
    copyKey: (ownerId: string) => string;
    // Undefined while the settings hold no value.
    read: (settings: UserSettings) => T | undefined;
    // The settings change that stores a value.
    patch: (value: T) => UserSettings;
    // Undefined when the copy holds no valid value, such as one an older build wrote.
    parse: (copy: string) => T | undefined;
    serialize: (value: T) => string;
};

// The value is undefined when neither the settings nor the copy hold one, and the caller picks the default.
export function useSettingWithCopy<T>(setting: SettingWithCopy<T>): {
    value: T | undefined;
    save: (next: T) => void;
} {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const isGuest = useIsGuest();
    const ownerId = user?.id || '';
    const copyKey = setting.copyKey(ownerId);
    const { data: settings } = useSpaceSettings();
    const stored = settings && setting.read(settings);
    const copy = useMemo(() => {
        const raw = readCopy(copyKey);
        return raw === null ? undefined : setting.parse(raw);
    }, [copyKey, setting]);
    // The settings replace the copy, so a choice made on another device is what this browser draws first next time.
    const serialized = stored === undefined ? undefined : setting.serialize(stored);
    useEffect(() => {
        if (serialized !== undefined) writeCopy(copyKey, serialized);
    }, [copyKey, serialized]);

    const mutation = useMutation({
        mutationFn: async (next: T) => {
            // A guest has no settings to write, so the copy is all that changes.
            if (!ownerId || isGuest) return;
            const res = await spaceApi({ ownerId }).settings.put(setting.patch(next));
            if (res.error) throw new AppError(res);
            return res.data;
        },
        onMutate: async (next) => {
            const prevCopy = readCopy(copyKey);
            writeCopy(copyKey, setting.serialize(next));
            await queryClient.cancelQueries({ queryKey: spaceKeys.settings(ownerId) });
            const prev = queryClient.getQueryData<UserSettings>(spaceKeys.settings(ownerId));
            queryClient.setQueryData<UserSettings>(spaceKeys.settings(ownerId), (old) => ({
                ...old,
                ...setting.patch(next),
            }));
            return { prev, prevCopy };
        },
        onError: (error, _next, context) => {
            if (context) {
                writeCopy(copyKey, context.prevCopy);
                if (context.prev !== undefined) queryClient.setQueryData(spaceKeys.settings(ownerId), context.prev);
            }
            onMutationError(error);
        },
        // The optimistic settings may lack what the server holds when none had loaded yet.
        onSettled: () => {
            if (ownerId && !isGuest) invalidateSpaceSettings(queryClient, ownerId);
        },
    });

    return { value: stored ?? copy, save: mutation.mutate };
}

// localStorage throws where the browser refuses storage, and does not exist outside a browser.
function readCopy(key: string): string | null {
    try {
        return window.localStorage.getItem(key);
    } catch {
        return null;
    }
}

function writeCopy(key: string, copy: string | null): void {
    try {
        if (copy === null) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, copy);
    } catch {}
}
