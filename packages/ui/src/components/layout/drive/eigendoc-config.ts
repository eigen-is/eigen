import { EIGEN_DOC_ICONS } from '@workspace/lib/eigendoc-icons';
import {
    type DrivePathType,
    type DriveSearchParams,
    EIGEN_DOC_TYPE_INFO,
    type EigenDocType,
} from '@workspace/lib/types/drive';
import type { LucideIcon } from 'lucide-react';

export type EigenDocAppConfig = {
    appName: string;
    mimeType: string;
    driveType: DrivePathType;
    icon: LucideIcon;
    newLabel: string;
    allLabel: string;
    labelPlural: string;
    createType: EigenDocType;
};

// Per-app config consumed by the EigenDoc app shell (EigenDocRoot, EigenDocListView,
// EigenDocSharedView, EigenDocNewButton). Both metadata and icons derive from
// shared registries so adding a new app type is a single-source edit.
//
// `mimeType` is historically the route-safe url-slug (`application-eigendoc`) —
// the `/drive/.../mime/:slug` route reverses dash→slash server-side.
function buildConfig(type: EigenDocType): EigenDocAppConfig {
    const info = EIGEN_DOC_TYPE_INFO[type];
    return {
        appName: info.appName,
        mimeType: info.urlSlug,
        driveType: info.type,
        icon: EIGEN_DOC_ICONS[type],
        newLabel: `New ${info.label.toLowerCase()}`,
        allLabel: `All ${info.labelPlural.toLowerCase()}`,
        labelPlural: info.labelPlural,
        createType: info.type,
    };
}

export const DOCS_CONFIG: EigenDocAppConfig = buildConfig('doc');
export const STICKIES_CONFIG: EigenDocAppConfig = buildConfig('stickies');
export const SLIDES_CONFIG: EigenDocAppConfig = buildConfig('slides');
export const SHEETS_CONFIG: EigenDocAppConfig = buildConfig('sheets');

export function eigenDocValidateSearch(search: Record<string, unknown>): DriveSearchParams {
    const pid = typeof search.pid === 'string' ? search.pid : undefined;
    const uid = typeof search.uid === 'string' ? search.uid : undefined;
    const mid = typeof search.mid === 'string' ? search.mid : undefined;
    return { pid, uid, mid };
}

// The four EigenDoc editor routes (doc/slide/board/sheet) share one validator for the optional
// `?chat=` / `?card=` deep-link params and the `?q=` in-document search term, so they can't
// drift (only stickies reads `card` for now).
export function eigenDocEditorValidateSearch(search: Record<string, unknown>): {
    chat?: string;
    card?: string;
    q?: string;
} {
    return {
        chat: typeof search.chat === 'string' ? search.chat : undefined,
        card: typeof search.card === 'string' ? search.card : undefined,
        q: typeof search.q === 'string' ? search.q : undefined,
    };
}
