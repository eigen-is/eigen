import type { ReactNode } from 'react';

// A menu's rows as a user sees them, a separator as '—': dropped where DropdownMenuSeparator's classes hide it (opening
// the menu, after another, or with no row after it), which happy-dom, drawing no CSS, cannot.
export function collapseSeparators(rows: (string | undefined)[]): (string | undefined)[] {
    return rows.filter(
        (row, i) => row !== '—' || (i > 0 && rows[i - 1] !== '—' && rows.slice(i).some((r) => r !== '—')),
    );
}

// The open menu's rows, each label without its shortcut, which reads per platform. A group's rows (a radio group's)
// read one by one.
export function menuRows(): (string | undefined)[] {
    return collapseSeparators(
        [...(document.querySelector('[role="menu"]')?.children ?? [])]
            .flatMap((row) => (row.getAttribute('role') === 'group' ? [...row.children] : [row]))
            .map((row) =>
                row.getAttribute('role') === 'separator'
                    ? '—'
                    : (row.textContent ?? '')
                          .replace(row.querySelector('[data-slot="dropdown-menu-shortcut"]')?.textContent ?? '', '')
                          .trim(),
            ),
    );
}

// Renders `rows` in an open menu, as a user sees it once its trigger is clicked.
export async function renderOpenMenu(rows: ReactNode): Promise<{ unmount: () => Promise<void> }> {
    const { createElement } = await import('react');
    const { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } = await import('../components/dropdown-menu');
    const { renderInDocument } = await import('./render-in-document');
    return renderInDocument(
        createElement(
            DropdownMenu,
            { open: true },
            createElement(DropdownMenuTrigger, null, 'Menu'),
            createElement(DropdownMenuContent, null, rows),
        ),
    );
}

// Opens the submenu whose row reads `label` with Enter, which opens a desktop submenu and drills into a phone's page.
export async function openSubmenu(label: string): Promise<void> {
    const { act } = await import('react');
    const trigger = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find(
        (row) => row.textContent?.trim() === label,
    );
    await act(async () => {
        trigger?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
    });
}

const lastMenu = () => [...document.querySelectorAll('[role="menu"]')].at(-1);

// The last-opened menu's choice and toggle rows, each with its aria-checked: 'true', 'false' or 'mixed'.
export function checkRows(): [string, string | null][] {
    return [...(lastMenu()?.querySelectorAll('[role="menuitemradio"], [role="menuitemcheckbox"]') ?? [])].map((row) => [
        row.textContent?.trim() ?? '',
        row.getAttribute('aria-checked'),
    ]);
}

// Clicks the last-opened menu's row that reads `label`.
export async function clickRow(label: string): Promise<void> {
    const { act } = await import('react');
    const row = [...(lastMenu()?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])].find(
        (entry) => entry.textContent?.trim() === label,
    );
    await act(async () => row?.click());
}
