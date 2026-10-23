// The rows of the open menu as a user sees them: a separator as '—', dropped where DropdownMenuSeparator's classes
// hide it (opening the menu, after another, or with no row after it), and each label without its shortcut, which
// reads per platform.
export function menuRows(): string[] {
    const rows = [...(document.querySelector('[role="menu"]')?.children ?? [])].map((row) =>
        row.getAttribute('role') === 'separator'
            ? '—'
            : (row.textContent ?? '')
                  .replace(row.querySelector('[data-slot="dropdown-menu-shortcut"]')?.textContent ?? '', '')
                  .trim(),
    );
    return rows.filter(
        (row, i) => row !== '—' || (i > 0 && rows[i - 1] !== '—' && rows.slice(i).some((r) => r !== '—')),
    );
}
