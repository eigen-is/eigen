// The one order every context and ⋮ menu draws its rows in; docs/LAYOUT.md § Menus draw their rows in one order lists
// each group's rows. A host passes each row to the group it belongs to; the order lives here, so no menu can drift.

import { Fragment, type ReactNode } from 'react';
import { DropdownMenuSeparator } from '../dropdown-menu';

const SECTIONS = [
    'open',
    'clipboard',
    'create',
    'organize',
    'arrange',
    'convert',
    'output',
    'collaborate',
    'destructive',
] as const;

export type MenuSectionsProps = Partial<Record<(typeof SECTIONS)[number], ReactNode>>;

// A group whose rows all render nothing still leaves its separator; DropdownMenuSeparator hides itself when it
// opens or ends the menu or follows another, so the host needs no separator logic of its own.
export function MenuSections(props: MenuSectionsProps) {
    return SECTIONS.filter((section) => props[section]).map((section, i) => (
        <Fragment key={section}>
            {i > 0 && <DropdownMenuSeparator />}
            {props[section]}
        </Fragment>
    ));
}
