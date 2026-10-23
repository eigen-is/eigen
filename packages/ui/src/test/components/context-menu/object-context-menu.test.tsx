// The object menu draws the canvas' rows in one order, and a host without a clipboard or duplicate (Sheets) drops
// those rows and adds its own after the object actions; a viewer sees only the download rows.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { createElement } = await import('react');
const { DropdownMenuItem } = await import('../../../components/dropdown-menu');
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
            onArrange: noop,
            onDelete: noop,
            ...props,
        }),
    ));
    const menu = document.querySelector('[role="menu"]');
    if (!menu) throw new Error('no menu');
    return [...menu.children].map((row) =>
        row.getAttribute('role') === 'separator' ? '—' : (row.textContent?.trim() ?? ''),
    );
}

const ARRANGE = ['Bring to front', 'Bring forward', 'Send backward', 'Send to back'];

test("the canvas' menu keeps its rows and their order", async () => {
    const rows = await openMenu({
        onCopy: noop,
        onCut: noop,
        onPaste: noop,
        onDuplicate: noop,
        onConvertToShapes: noop,
    });
    expect(rows).toEqual([
        ...ARRANGE,
        '—',
        'Copy',
        'Cut',
        'Paste',
        '—',
        'Duplicate',
        'Delete',
        '—',
        'Convert to shapes',
    ]);
});

test('a host without clipboard or duplicate rows gets Arrange, Delete and its own rows, each group once', async () => {
    const rows = await openMenu({
        children: createElement(DropdownMenuItem, { children: 'Edit chart' }),
    });
    expect(rows).toEqual([...ARRANGE, '—', 'Delete', '—', 'Edit chart']);
});

test("a viewer sees the host's rows without Arrange or Delete", async () => {
    const rows = await openMenu({
        canEdit: false,
        children: createElement(DropdownMenuItem, { children: 'Download chart' }),
    });
    expect(rows).toEqual(['Download chart']);
});
