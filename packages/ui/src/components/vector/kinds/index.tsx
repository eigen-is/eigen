// The React half of the element registry. ELEMENT_KINDS answers what a kind is: its fields, geometry, paint and search
// text. This answers how a kind is presented: the icon and label every surface shows, the tool shortcut, the dialog a
// kind opens when it is edited on the canvas, and the panel rows the capability rows do not cover. Text is edited in
// place for every kind that holds it, so the rich-text editor serves them all. Adding a kind adds one entry here.

import type { LetterKey, NumberKey } from '@tanstack/react-hotkeys';
import type { NewVectorElement, VectorElement, VectorElementPatch, VectorElementType } from '@workspace/lib/vector';
import { isTextBox } from '@workspace/lib/vector';
import type { LucideIcon } from 'lucide-react';
import {
    ChartColumn,
    ChartPie,
    Circle,
    Diamond,
    Image as ImageIcon,
    Minus,
    MoveUpRight,
    Pencil,
    Spline,
    Square,
} from 'lucide-react';
import type { ComponentType } from 'react';
import { ArrowPanelSection } from './arrow';
import { ChartEditDialog, ChartPanelSection } from './chart';
import { ImagePanelSection } from './image';

// Rows for a selection of elements that are all this kind. `onChange` applies one patch to every selected element, and
// `onChangeEach` a patch computed per element, such as a font size one step up from each element's own. The panel seals
// each into one undo step. `scene` resolves an element the selection does not hold, such as an arrow's bound shape.
// `onReplace` swaps a sole selected element for new ones and selects them in one undo step, as a chart's Convert to
// shapes does. `slideWidth` is the deck's, so a size can show in pt. A drawing has none.
export type KindPanelSectionProps = {
    elements: VectorElement[];
    scene: Map<string, VectorElement>;
    slideWidth?: number;
    onChange: (fields: VectorElementPatch) => void;
    onChangeEach: (patch: (el: VectorElement) => VectorElementPatch) => void;
    onReplace: (elements: NewVectorElement[]) => void;
};

// What a double-click opens for a kind edited in a dialog rather than in place (a chart's data).
// `onChange` is one sealed write; `onClose` ends it, saved or not.
export type KindEditDialogProps = {
    element: VectorElement;
    onChange: (fields: VectorElementPatch) => void;
    onClose: () => void;
};

type ElementKindUi = {
    icon: LucideIcon;
    label: string;
    // Present exactly on the kinds a tool can create. An image arrives by upload, so it has none. The letters are
    // Excalidraw's, and `digit` picks the same tool from the number row.
    shortcut?: { letter: LetterKey; digit: NumberKey };
    EditDialog?: ComponentType<KindEditDialogProps>;
    PanelSection?: ComponentType<KindPanelSectionProps>;
};

export const ELEMENT_KIND_UI: Record<VectorElementType, ElementKindUi> = {
    rectangle: { icon: Square, label: 'Rectangle', shortcut: { letter: 'R', digit: '2' } },
    diamond: { icon: Diamond, label: 'Diamond', shortcut: { letter: 'D', digit: '3' } },
    ellipse: { icon: Circle, label: 'Ellipse', shortcut: { letter: 'O', digit: '4' } },
    pie: { icon: ChartPie, label: 'Pie' },
    path: { icon: Spline, label: 'Freeform' },
    chart: { icon: ChartColumn, label: 'Chart', EditDialog: ChartEditDialog, PanelSection: ChartPanelSection },
    arrow: {
        icon: MoveUpRight,
        label: 'Arrow',
        shortcut: { letter: 'A', digit: '5' },
        PanelSection: ArrowPanelSection,
    },
    line: { icon: Minus, label: 'Line', shortcut: { letter: 'L', digit: '6' } },
    freedraw: { icon: Pencil, label: 'Draw', shortcut: { letter: 'P', digit: '7' } },
    image: { icon: ImageIcon, label: 'Image', PanelSection: ImagePanelSection },
};

// A text box is a rectangle that fits its text, not a kind, so its name lives beside the kinds' own: the Text tool and
// every text box show it.
export const TEXT_BOX_LABEL = 'Text';

// The name an element shows, such as the panel's title or a comment's anchor.
export function elementLabel(el: VectorElement): string {
    return isTextBox(el) ? TEXT_BOX_LABEL : ELEMENT_KIND_UI[el.type].label;
}
