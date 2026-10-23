// Every menu draws its groups in one order, whatever order a host passes them in, with one separator between two
// groups that are there and none around a group that is not.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { createElement } = await import('react');
const { DropdownMenuItem } = await import('../../../components/dropdown-menu');
const { ContextMenuAnchor } = await import('../../../components/context-menu/context-menu-anchor');
const { MenuSections } = await import('../../../components/context-menu/menu-sections');

let unmount = async () => {};
afterEach(() => unmount());

const noop = () => {};
const contextMenu = { isOpen: true, position: { x: 10, y: 10 }, close: noop, restoreFocus: noop };
const row = (label: string) => createElement(DropdownMenuItem, { children: label });

async function rowsOf(sections: Parameters<typeof MenuSections>[0]) {
    ({ unmount } = await renderInDocument(
        createElement(ContextMenuAnchor, { contextMenu, children: createElement(MenuSections, sections) }),
    ));
    const menu = document.querySelector('[role="menu"]');
    if (!menu) throw new Error('no menu');
    return [...menu.children].map((child) =>
        child.getAttribute('role') === 'separator' ? '—' : (child.textContent?.trim() ?? ''),
    );
}

test('the groups come out in the fixed order, one separator between each two', async () => {
    const rows = await rowsOf({
        destructive: row('Delete'),
        collaborate: row('Add comment'),
        output: row('Download'),
        convert: row('Convert to shapes'),
        arrange: row('Order'),
        organize: row('Move to…'),
        create: row('Duplicate'),
        clipboard: row('Cut'),
        open: row('Open'),
    });
    expect(rows).toEqual([
        'Open',
        '—',
        'Cut',
        '—',
        'Duplicate',
        '—',
        'Move to…',
        '—',
        'Order',
        '—',
        'Convert to shapes',
        '—',
        'Download',
        '—',
        'Add comment',
        '—',
        'Delete',
    ]);
});

test('an empty group leaves no separator behind', async () => {
    const rows = await rowsOf({ clipboard: row('Copy'), output: undefined, create: false, destructive: row('Delete') });
    expect(rows).toEqual(['Copy', '—', 'Delete']);
});
