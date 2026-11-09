// The config of each document app, such as Docs or Sheets: its name, icon, labels and the app that owns
// its list, built from the shared type registry. The document apps' shells and the shared sidebar's filter
// rows read it, and the editor routes take their search validator from here.

import {
    getDocsAppUrl,
    getSheetsAppUrl,
    getSlidesAppUrl,
    getStickiesAppUrl,
    getVectorAppUrl,
} from '@workspace/lib/api';
import { EIGEN_DOC_ICONS } from '@workspace/lib/eigendoc-icons';
import type { EigenDocType } from '@workspace/lib/types/drive';
import { EIGEN_DOC_TYPE_INFO } from '@workspace/lib/types/drive';
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

// In sidebar order, not the registry's. Chat has no list of its own, since the chat app opens one
// conversation, so Drive hosts All chats.
const EIGEN_DOC_APP_URLS: Record<EigenDocType, (() => string) | null> = {
    doc: getDocsAppUrl,
    stickies: getStickiesAppUrl,
    chat: null,
    slides: getSlidesAppUrl,
    sheets: getSheetsAppUrl,
    vector: getVectorAppUrl,
};

// mimeType is the URL slug, such as application-eigendoc, which the server turns back into the MIME type.
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
        appUrl: EIGEN_DOC_APP_URLS[type],
    };
}

// Every type in nav order, for surfaces that list them all (the shared sidebar's filters).
export const EIGEN_DOC_APP_CONFIGS: ReadonlyArray<EigenDocAppConfig> = Object.keys(EIGEN_DOC_APP_URLS).map((type) =>
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

// Every editor route reads ?chat=, ?card= and ?q= here, so they can't drift.
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
