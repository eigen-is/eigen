import { PAGE_NUMBER_TEXT, PageNumberNode, readPageNumberKind } from '@workspace/lib/docs/eigendoc';

const FIELD_NAMES = { page: 'Page number', pages: 'Page count' } as const;

// A grey chip, as Google draws a field while editing, that names its kind after the #, as both kinds show #. The name is
// the chip's alone: the field's text, its HTML and the browser's print keep the #.
export const PageNumber = PageNumberNode.extend({
    addNodeView() {
        return ({ node }) => {
            const kind = readPageNumberKind(node.attrs.kind);
            const dom = document.createElement('span');
            dom.className = 'rounded-sm bg-muted px-0.5 text-muted-foreground';
            dom.setAttribute('role', 'img');
            dom.setAttribute('aria-label', FIELD_NAMES[kind]);
            dom.title = `${FIELD_NAMES[kind]}: shows the number when printed or downloaded as PDF or Word`;
            const name = document.createElement('span');
            name.className = 'print:hidden';
            name.textContent = kind;
            dom.append(PAGE_NUMBER_TEXT, name);
            return { dom };
        };
    },
});
