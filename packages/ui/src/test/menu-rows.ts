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
