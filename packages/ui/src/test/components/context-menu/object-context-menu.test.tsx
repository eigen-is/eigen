// The object menu draws the canvas' rows in MenuSections' order, a host with one object (a Sheets chart) drops the
// rows it has no use for, and a viewer sees only the rows that write nothing.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { menuRows } from '@workspace/ui/test/menu-rows';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { createElement } = await import('react');
const { ObjectContextMenu } = await import('../../../components/context-menu/object-context-menu');

let unmount = async () => {};
afterEach(() => unmount());

const noop = () => {};
const contextMenu = {
    item: 'e1',
    position: { x: 10, y: 10 },
    isOpen: true,
    handleContextMenu: noop,
    openAt: noop,
    close: noop,
    restoreFocus: noop,
};

async function openMenu(props: Partial<Parameters<typeof ObjectContextMenu>[0]>) {
    ({ unmount } = await renderInDocument(
        createElement(ObjectContextMenu, {
            contextMenu,
            canEdit: true,
            imagePath: undefined,
            onDelete: noop,
            ...props,
        }),
    ));
    return menuRows();
}

test("the canvas' menu keeps its rows in the one menu order, Delete last", async () => {
    const rows = await openMenu({
        onArrange: noop,
        onCut: noop,
        onCopy: noop,
        onPaste: noop,
        onDuplicate: noop,
        onConvertToShapes: noop,
        onComment: noop,
    });
    expect(rows).toEqual([
        'Cut',
        'Copy',
        'Paste',
        '—',
        'Duplicate',
        '—',
        'Order',
        '—',
        'Convert to shapes',
        '—',
        'Add comment',
        '—',
        'Delete',
    ]);
});

test('a host without clipboard or duplicate rows draws only the groups it has, each once', async () => {
    const rows = await openMenu({ onDownloadImage: noop });
    expect(rows).toEqual(['Download image', '—', 'Delete']);
});

test('a viewer sees the rows that write nothing, without Order or Delete', async () => {
    const rows = await openMenu({ canEdit: false, onArrange: noop, onDownloadImage: noop });
    expect(rows).toEqual(['Download image']);
});
