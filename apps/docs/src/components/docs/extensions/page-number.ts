// The Docs editor's page number field: the shared node with a view that draws it as a chip naming its kind, as
// Google does while editing. Every docs editor registers it, and the page numbers menu names the fields the same way.

import type { PageNumberKind } from '@workspace/lib/docs/eigendoc';
import { PAGE_NUMBER_TEXT, PageNumberNode, readPageNumberKind } from '@workspace/lib/docs/eigendoc';

// Google's names for the two fields, on the chip and in the Page numbers submenu.
export const PAGE_NUMBER_FIELD_NAMES: Record<PageNumberKind, string> = { page: 'Page number', pages: 'Page count' };

// A gray chip, as Google draws a field while editing, that names its kind after the #, as both kinds show #. The name is
// the chip's alone: the field's text, its HTML and the browser's print keep the #.
export const PageNumber = PageNumberNode.extend({
    addNodeView() {
        return ({ node }) => {
            const kind = readPageNumberKind(node.attrs.kind);
            const dom = document.createElement('span');
            dom.className = 'rounded-sm bg-muted px-0.5 text-muted-foreground';
            dom.setAttribute('role', 'img');
            dom.setAttribute('aria-label', PAGE_NUMBER_FIELD_NAMES[kind]);
            dom.title = `${PAGE_NUMBER_FIELD_NAMES[kind]}: shows the number when printed or downloaded as PDF or Word`;
            const name = document.createElement('span');
            name.className = 'print:hidden';
            name.textContent = kind;
            dom.append(PAGE_NUMBER_TEXT, name);
            return { dom };
        };
    },
});
