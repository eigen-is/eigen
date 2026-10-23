// The object menu draws the canvas' rows in MenuSections' order, a host with one object (a Sheets chart) drops the
// rows it has no use for and adds its own to their groups, and a viewer sees only the rows that write nothing.
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
            onDelete: noop,
            ...props,
        }),
    ));
    const menu = document.querySelector('[role="menu"]');
    if (!menu) throw new Error('no menu');
    // The label alone: a shortcut reads per platform.
    return [...menu.children].map((row) =>
        row.getAttribute('role') === 'separator'
            ? '—'
            : (row.textContent ?? '')
                  .replace(row.querySelector('[data-slot="dropdown-menu-shortcut"]')?.textContent ?? '', '')
                  .trim(),
    );
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

test('a host without clipboard or duplicate rows gets its own rows in their groups, each group once', async () => {
    const rows = await openMenu({
        hostSections: {
            create: createElement(DropdownMenuItem, { children: 'Edit chart' }),
            output: createElement(DropdownMenuItem, { children: 'Download chart' }),
        },
    });
    expect(rows).toEqual(['Edit chart', '—', 'Download chart', '—', 'Delete']);
});

test("a viewer sees the host's rows that write nothing, without Order or Delete", async () => {
    const rows = await openMenu({
        canEdit: false,
        onArrange: noop,
        hostSections: {
            create: createElement(DropdownMenuItem, { children: 'Edit chart' }),
            output: createElement(DropdownMenuItem, { children: 'Download chart' }),
        },
    });
    expect(rows).toEqual(['Download chart']);
});
