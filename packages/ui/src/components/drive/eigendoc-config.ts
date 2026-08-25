import {
    getDocsAppUrl,
    getSheetsAppUrl,
    getSlidesAppUrl,
    getStickiesAppUrl,
    getVectorAppUrl,
} from '@workspace/lib/api';
import { EIGEN_DOC_ICONS } from '@workspace/lib/eigendoc-icons';
import { type DriveSearchParams, EIGEN_DOC_TYPE_INFO, type EigenDocType } from '@workspace/lib/types/drive';
import type { LucideIcon } from 'lucide-react';

export type EigenDocAppConfig = {
    appName: string;
    mimeType: string;
    icon: LucideIcon;
    newLabel: string;
    allLabel: string;
    labelPlural: string;
    type: EigenDocType;
    // The app that owns this type's list view, or null when Drive hosts it.
    appUrl: (() => string) | null;
};

// Sidebar/nav order — deliberately not registry order — mapped to the app that owns each
// type's list view. `chat` has none: the chat app opens one conversation, so Drive hosts
// "All chats". A new eigendoc type is a compile error until it's placed here.
const APP_URLS: Record<EigenDocType, (() => string) | null> = {
    doc: getDocsAppUrl,
    stickies: getStickiesAppUrl,
    chat: null,
    slides: getSlidesAppUrl,
    sheets: getSheetsAppUrl,
    vector: getVectorAppUrl,
};

// Per-app config consumed by the EigenDoc app shell (EigenDocRoot, EigenDocListView,
// EigenDocSharedView, EigenDocNewButton) and by the shared sidebar's filter rows. Both
// metadata and icons derive from shared registries so adding a new app type is a
// single-source edit.
//
// `mimeType` is historically the route-safe url-slug (`application-eigendoc`) —
// the `/drive/.../mime/:slug` route reverses dash→slash server-side.
function buildConfig(type: EigenDocType): EigenDocAppConfig {
    const info = EIGEN_DOC_TYPE_INFO[type];
    return {
        appName: info.appName,
        mimeType: info.urlSlug,
        icon: EIGEN_DOC_ICONS[type],
        newLabel: `New ${info.label.toLowerCase()}`,
        allLabel: `All ${info.labelPlural.toLowerCase()}`,
        labelPlural: info.labelPlural,
        type: info.type,
        appUrl: APP_URLS[type],
    };
}

// Every type in nav order, for surfaces that list them all (the shared sidebar's filters).
export const EIGEN_DOC_APP_CONFIGS: ReadonlyArray<EigenDocAppConfig> = Object.keys(APP_URLS).map((type) =>
    buildConfig(type as EigenDocType),
);

export const DOCS_CONFIG: EigenDocAppConfig = buildConfig('doc');
export const STICKIES_CONFIG: EigenDocAppConfig = buildConfig('stickies');
export const SLIDES_CONFIG: EigenDocAppConfig = buildConfig('slides');
export const SHEETS_CONFIG: EigenDocAppConfig = buildConfig('sheets');
export const VECTOR_CONFIG: EigenDocAppConfig = buildConfig('vector');

// "Docs shared by me" — the sidebar row and the shared page's title must read alike, so
// both build the phrase here. Without a plural (Drive's own rows) → "Shared by me".
export function eigenDocSharedTitle(direction: 'by' | 'with', labelPlural?: string): string {
    return labelPlural ? `${labelPlural} shared ${direction} me` : `Shared ${direction} me`;
}

export function eigenDocValidateSearch(search: Record<string, unknown>): DriveSearchParams {
    const pid = typeof search.pid === 'string' ? search.pid : undefined;
    const uid = typeof search.uid === 'string' ? search.uid : undefined;
    const mid = typeof search.mid === 'string' ? search.mid : undefined;
    return { pid, uid, mid };
}

// The EigenDoc editor routes (doc/slide/board/sheet/vector) share one validator for the optional
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
