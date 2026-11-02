// The table panel and Format › Table run the same table commands. Each surface keeps its own labels, order and
// grouping, and every row is pinned here: its label, its icon, its look, whether it is disabled, and what a click on it
// does to a 2×2 table whose caret sits in the first cell.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { Editor } = await import('@tiptap/react');
const { getDocExtensions } = await import('@workspace/lib/docs/eigendoc');
const { MenuSections } = await import('@workspace/ui/components/context-menu');
const { renderOpenMenu } = await import('@workspace/ui/test/menu-rows');
const { TablePropertiesPanel } = await import('../../../components/docs/table-properties-panel');
const { tableMenuSections } = await import('../../../components/docs/table-menu-sections');
const { EditorTable } = await import('../../../components/docs/extensions/table');
const { cellBackground, selectCellCommands } = await import('../../../components/docs/hooks/use-toolbar-state');

let unmount = async () => {};
afterEach(() => unmount());

const cell = (text: string, width: number) => ({
    type: 'tableCell',
    attrs: { colwidth: [width] },
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});
const tableRow = (...content: ReturnType<typeof cell>[]) => ({ type: 'tableRow', content });

function tableEditor() {
    const editor = new Editor({
        extensions: [...getDocExtensions({ exclude: ['table'] }), EditorTable],
        content: {
            type: 'doc',
            content: [
                {
                    type: 'table',
                    content: [tableRow(cell('a', 100), cell('b', 300)), tableRow(cell('c', 100), cell('d', 300))],
                },
                { type: 'paragraph' },
            ],
        },
    });
    // Table at 0, row at 1, cell at 2, its paragraph at 3: the caret sits before the a.
    editor.commands.setTextSelection(4);
    return editor;
}

// Selects the first row's two cells.
const selectFirstRow = (editor: InstanceType<typeof Editor>) => {
    const second = 2 + (editor.state.doc.nodeAt(2)?.nodeSize ?? 0);
    editor.commands.setCellSelection({ anchorCell: 2, headCell: second });
};

// Each row of the table, its cells as their text and width, a header cell marked with a #; no table reads as [].
const look = (editor: InstanceType<typeof Editor>) => {
    const rows: string[][] = [];
    editor.state.doc.descendants((node) => {
        if (node.type.name === 'tableRow') rows.push([]);
        if (node.type.name === 'tableCell' || node.type.name === 'tableHeader')
            rows.at(-1)?.push(
                `${node.type.name === 'tableHeader' ? '#' : ''}${node.textContent}:${node.attrs['colwidth']?.join(',')}`,
            );
    });
    return rows.map((cells) => cells.join(' | '));
};

// What each command does to the 2×2 table, a b over c d, 100 and 300 wide. Merge and Unmerge start from the first row
// selected, and Unmerge from the cells Merge joined.
const AFTER = {
    addRowBefore: [':100 | :300', 'a:100 | b:300', 'c:100 | d:300'],
    addRowAfter: ['a:100 | b:300', ':100 | :300', 'c:100 | d:300'],
    addColumnBefore: [':undefined | a:100 | b:300', ':undefined | c:100 | d:300'],
    addColumnAfter: ['a:100 | :undefined | b:300', 'c:100 | :undefined | d:300'],
    deleteRow: ['c:100 | d:300'],
    deleteColumn: ['b:300', 'd:300'],
    distributeColumns: ['a:200 | b:200', 'c:200 | d:200'],
    mergeCells: ['ab:100,300', 'c:100 | d:300'],
    splitCell: ['ab:100 | :300', 'c:100 | d:300'],
    toggleHeaderRow: ['#a:100 | #b:300', 'c:100 | d:300'],
    deleteTable: [],
};
type Command = keyof typeof AFTER;

// Readies the table for a command: Merge needs two cells, and Unmerge a merged one.
const ready = (editor: InstanceType<typeof Editor>, command: Command) => {
    if (command === 'mergeCells' || command === 'splitCell') selectFirstRow(editor);
    if (command === 'splitCell') editor.commands.mergeCells();
};

const icon = (row: Element) =>
    [...(row.querySelector('svg')?.classList ?? [])].find((name) => name.startsWith('lucide-')) ?? null;

async function renderPanel(editor: InstanceType<typeof Editor>) {
    const rendered = await renderInDocument(createElement(TablePropertiesPanel, { editor }));
    unmount = async () => {
        await rendered.unmount();
        editor.destroy();
    };
}

// The title of the panel section a button sits in; Delete table sits below them all.
const section = (button: Element) => button.closest('.border-b')?.querySelector('h4')?.textContent ?? '';

// The panel's buttons as a user sees them: its section, label, icon, variant and whether it is disabled.
const panelButtons = () =>
    [...document.querySelectorAll('button')].map((button) => [
        section(button),
        button.textContent?.trim(),
        icon(button),
        button.dataset['variant'],
        button.disabled,
    ]);

const PANEL: [string, string, Command][] = [
    ['Columns', 'Before', 'addColumnBefore'],
    ['Columns', 'After', 'addColumnAfter'],
    ['Columns', 'Delete column', 'deleteColumn'],
    ['Columns', 'Distribute columns', 'distributeColumns'],
    ['Rows', 'Before', 'addRowBefore'],
    ['Rows', 'After', 'addRowAfter'],
    ['Rows', 'Delete row', 'deleteRow'],
    ['Cells', 'Merge', 'mergeCells'],
    ['Cells', 'Unmerge', 'splitCell'],
    ['Cells', 'Toggle header row', 'toggleHeaderRow'],
    ['', 'Delete table', 'deleteTable'],
];

test('the panel shows each table command in its section, with its icon, Merge and Unmerge disabled for a caret', async () => {
    await renderPanel(tableEditor());
    expect(panelButtons()).toEqual([
        ['Columns', 'Before', 'lucide-between-vertical-start', 'outline', false],
        ['Columns', 'After', 'lucide-between-vertical-end', 'outline', false],
        ['Columns', 'Delete column', 'lucide-grip-vertical', 'outline', false],
        ['Columns', 'Distribute columns', 'lucide-columns3', 'outline', false],
        ['Rows', 'Before', 'lucide-between-horizontal-start', 'outline', false],
        ['Rows', 'After', 'lucide-between-horizontal-end', 'outline', false],
        ['Rows', 'Delete row', 'lucide-grip-horizontal', 'outline', false],
        ['Cells', 'Merge', 'lucide-table-cells-merge', 'outline', true],
        ['Cells', 'Unmerge', 'lucide-table-cells-split', 'outline', true],
        ['Cells', 'Toggle header row', 'lucide-toggle-left', 'outline', false],
        ['Cells', 'None', null, undefined, false],
        ['Cells', 'All', null, 'outline', false],
        ['Cells', 'Outer', null, 'outline', false],
        ['Cells', 'None', null, 'outline', false],
        ['Cells', 'Default', null, undefined, false],
        ['', 'Delete table', 'lucide-trash2', 'destructive', false],
    ]);
});

test.each(PANEL)('the panel’s %s › %s button runs %s', async (title, label, command) => {
    const editor = tableEditor();
    ready(editor, command);
    await renderPanel(editor);
    const button = [...document.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === label && section(b) === title,
    );
    expect(button?.disabled).toBe(false);
    await act(async () => button?.click());
    expect(look(editor)).toEqual(AFTER[command]);
});

async function renderMenu(editor: InstanceType<typeof Editor>) {
    const active = { ...selectCellCommands(editor, true), cellBackground: cellBackground(editor.state) };
    const rendered = await renderOpenMenu(createElement(MenuSections, tableMenuSections(editor, active)));
    unmount = async () => {
        await rendered.unmount();
        editor.destroy();
    };
}

// The menu's command rows as a user sees them: label, icon, variant and whether it is disabled.
const menuItems = () =>
    [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((item) => [
        item.textContent?.trim(),
        icon(item),
        item.getAttribute('data-variant'),
        item.getAttribute('aria-disabled') === 'true',
    ]);

const MENU: [string, Command][] = [
    ['Insert row above', 'addRowBefore'],
    ['Insert row below', 'addRowAfter'],
    ['Insert column left', 'addColumnBefore'],
    ['Insert column right', 'addColumnAfter'],
    ['Distribute columns', 'distributeColumns'],
    ['Merge cells', 'mergeCells'],
    ['Unmerge cells', 'splitCell'],
    ['Toggle header row', 'toggleHeaderRow'],
    ['Delete row', 'deleteRow'],
    ['Delete column', 'deleteColumn'],
    ['Delete table', 'deleteTable'],
];

test('the menu shows each table command with its icon, the deletes red, Merge and Unmerge disabled for a caret', async () => {
    await renderMenu(tableEditor());
    expect(menuItems()).toEqual([
        ['Insert row above', 'lucide-between-horizontal-start', 'default', false],
        ['Insert row below', 'lucide-between-horizontal-end', 'default', false],
        ['Insert column left', 'lucide-between-vertical-start', 'default', false],
        ['Insert column right', 'lucide-between-vertical-end', 'default', false],
        ['Distribute columns', 'lucide-columns3', 'default', false],
        ['Merge cells', 'lucide-table-cells-merge', 'default', true],
        ['Unmerge cells', 'lucide-table-cells-split', 'default', true],
        ['Toggle header row', 'lucide-toggle-left', 'default', false],
        ['Cell background color', 'lucide-paint-bucket', null, false],
        ['All borders', 'lucide-grid3x3', 'default', false],
        ['Outer borders', 'lucide-square', 'default', false],
        ['No borders', 'lucide-square-dashed', 'default', false],
        ['Delete row', 'lucide-grip-horizontal', 'destructive', false],
        ['Delete column', 'lucide-grip-vertical', 'destructive', false],
        ['Delete table', 'lucide-trash2', 'destructive', false],
    ]);
});

test.each(MENU)('the menu’s %s row runs %s', async (label, command) => {
    const editor = tableEditor();
    ready(editor, command);
    await renderMenu(editor);
    const item = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find(
        (entry) => entry.textContent?.trim() === label,
    );
    expect(item?.getAttribute('aria-disabled')).not.toBe('true');
    await act(async () => item?.click());
    expect(look(editor)).toEqual(AFTER[command]);
});
