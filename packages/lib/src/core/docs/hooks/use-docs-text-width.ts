// The reader's own text width on a page-less doc, Narrow, Medium, Wide or Full, which the Docs editor draws its text
// column at. It lives in the user's settings, so it follows them to every device and every page-less doc, and never
// in the doc, so a collaborator keeps their own. A copy in this browser draws the column before the settings load,
// and is all a guest has.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { spaceApi } from '@workspace/lib/api';
import { useAuth, useIsGuest } from '@workspace/lib/auth';
import type { DocsTextWidth, UserSettings } from '@workspace/lib/types/settings';
import { DOCS_TEXT_WIDTHS, docsTextWidth } from '@workspace/lib/types/settings';
import { AppError, onMutationError } from '../../api-error';
import { invalidateSpaceSettings, spaceKeys } from '../../space/hooks/keys';
import { useSpaceSettings } from '../../space/hooks/use-space-settings';

const cacheKeyFor = (ownerId: string) => `eigen-docs-text-width:${ownerId || 'anon'}`;

function readCache(key: string): DocsTextWidth | undefined {
    try {
        const cached = window.localStorage.getItem(key);
        return DOCS_TEXT_WIDTHS.find((width) => width === cached);
    } catch {
        return undefined;
    }
}

function writeCache(key: string, width: DocsTextWidth | undefined) {
    try {
        if (width) window.localStorage.setItem(key, width);
        else window.localStorage.removeItem(key);
    } catch {}
}

export function useDocsTextWidth(): { textWidth: DocsTextWidth; setTextWidth: (width: DocsTextWidth) => void } {
    const queryClient = useQueryClient();
    const { user } = useAuth();
    const isGuest = useIsGuest();
    const ownerId = user?.id || '';
    const cacheKey = cacheKeyFor(ownerId);
    const { data: settings } = useSpaceSettings();
    const textWidth = settings?.docsView?.textWidth ? docsTextWidth(settings) : (readCache(cacheKey) ?? 'narrow');

    const mutation = useMutation({
        mutationFn: async (next: DocsTextWidth) => {
            if (!ownerId || isGuest) return;
            const res = await spaceApi({ ownerId }).settings.put({ docsView: { textWidth: next } });
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
                docsView: { ...old?.docsView, textWidth: next },
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
        onSettled: () => {
            if (ownerId && !isGuest) invalidateSpaceSettings(queryClient, ownerId);
        },
    });

    return {
        textWidth,
        setTextWidth: (width) => {
            if (width !== textWidth) mutation.mutate(width);
        },
    };
}
