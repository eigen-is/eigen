import { EIGEN_DOC_ICONS } from '@workspace/lib/eigendoc-icons';
import { EIGEN_DOC_TYPE_INFO, type EigenDocType } from '@workspace/lib/types/drive';
import type { EigenDocAppConfig } from './eigendoc-config';

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
        createType: info.type,
    };
}

export const DOCS_CONFIG: EigenDocAppConfig = buildConfig('doc');
export const STICKIES_CONFIG: EigenDocAppConfig = buildConfig('stickies');
export const SLIDES_CONFIG: EigenDocAppConfig = buildConfig('slides');
export const SHEETS_CONFIG: EigenDocAppConfig = buildConfig('sheets');
