// The reader's own text width on a page-less doc, which the Docs editor draws its text column at. It lives in the
// user's settings, so it follows them to every device and every page-less doc. It is never stored in the doc, so a
// collaborator keeps their own. A copy in this browser draws the column before the settings load.

import type { DocsTextWidth } from '@workspace/lib/types/settings';
import { DOCS_TEXT_WIDTHS, docsTextWidth } from '@workspace/lib/types/settings';
import type { SettingWithCopy } from '../../space/hooks/use-setting-with-copy';
import { useSettingWithCopy } from '../../space/hooks/use-setting-with-copy';

const TEXT_WIDTH: SettingWithCopy<DocsTextWidth> = {
    copyKey: (ownerId) => `eigen-docs-text-width:${ownerId || 'anon'}`,
    read: (settings) => (settings.docsView?.textWidth ? docsTextWidth(settings) : undefined),
    patch: (textWidth) => ({ docsView: { textWidth } }),
    parse: (copy) => DOCS_TEXT_WIDTHS.find((width) => width === copy),
    serialize: (width) => width,
};

export function useDocsTextWidth(): { textWidth: DocsTextWidth; setTextWidth: (width: DocsTextWidth) => void } {
    const { value, save } = useSettingWithCopy(TEXT_WIDTH);
    const textWidth = value ?? docsTextWidth(undefined);
    return {
        textWidth,
        setTextWidth: (width) => {
            if (width !== textWidth) save(width);
        },
    };
}
