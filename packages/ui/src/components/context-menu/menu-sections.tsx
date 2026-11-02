// The one order every context and ⋮ menu draws its rows in, and the order the command palette lists a Drive
// selection's rows in. A host passes each row to the group it belongs to; the order lives here, so no menu can drift.

import type { ReactNode } from 'react';
import { Fragment } from 'react';
import { DropdownMenuSeparator } from '../dropdown-menu';

export const MENU_SECTIONS = [
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

export type MenuSectionsProps = Partial<Record<(typeof MENU_SECTIONS)[number], ReactNode>>;

// A group whose rows all render nothing still leaves its separator; DropdownMenuSeparator hides itself when it
// opens or ends the menu or follows another, so the host needs no separator logic of its own.
export function MenuSections(props: MenuSectionsProps) {
    return MENU_SECTIONS.filter((section) => props[section]).map((section, i) => (
        <Fragment key={section}>
            {i > 0 && <DropdownMenuSeparator />}
            {props[section]}
        </Fragment>
    ));
}
