import { PAGE_NUMBER_TEXT, PageNumberNode, readPageNumberKind } from '@workspace/lib/docs/eigendoc';

const FIELD_NAMES = { page: 'Page number', pages: 'Page count' } as const;

// A grey chip, as Google draws a field while editing, named in its tooltip as both kinds show #. The export keeps the
// schema's plain span.
export const PageNumber = PageNumberNode.extend({
    addNodeView() {
        return ({ node }) => {
            const dom = document.createElement('span');
            dom.className = 'rounded-sm bg-muted px-0.5 text-muted-foreground';
            dom.textContent = PAGE_NUMBER_TEXT;
            dom.title = FIELD_NAMES[readPageNumberKind(node.attrs.kind)];
            return { dom };
        };
    },
});
