import type { Transaction } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/react';
import type { RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';

export type SelectionPanel = 'document' | 'figure' | 'chart' | 'textBox' | 'equation' | 'table';

type SelectionPanelState = {
    selectionPanel: SelectionPanel;
    equationFieldRef: RefObject<HTMLTextAreaElement | null>;
    // Opens the selected equation's panel, its field focused.
    editEquation: () => void;
    // None on a phone, which has no right-side panel to edit an equation in.
    insertEquation: (() => void) | undefined;
};

// The properties panel the selection opens. An equation sits in prose, where an arrow passing it would open and close
// its panel, sliding the page each time, so a click on it, Insert › Equation or Enter on it opens its panel, which
// stays while the equation is selected. `editor` is the one that has the selection, a band's or an open note's, and
// is read again when it changes, so a panel another editor's selection opened closes.
export function useSelectionPanel(editor: Editor, isMobile: boolean, closePanels: () => void): SelectionPanelState {
    const [selectionPanel, setSelectionPanel] = useState<SelectionPanel>('document');
    const equationFieldRef = useRef<HTMLTextAreaElement>(null);
    // A new equation's panel mounts in the render its selection causes, so its field takes focus after that render.
    const [focusEquationField, setFocusEquationField] = useState(false);

    useEffect(() => {
        const read = (equation: boolean): SelectionPanel => {
            if (editor.isActive('figure')) return 'figure';
            if (editor.isActive('chart')) return 'chart';
            if (editor.isActive('textBox')) return 'textBox';
            if (editor.isActive('equation') && equation) return 'equation';
            if (editor.isActive('table')) return 'table';
            return 'document';
        };
        setSelectionPanel(read(false));
        const onUpdate = ({ transaction }: { transaction: Transaction }) => {
            setSelectionPanel((open) => read(open === 'equation' || !!transaction.getMeta('pointer')));
        };
        editor.on('selectionUpdate', onUpdate);
        return () => {
            editor.off('selectionUpdate', onUpdate);
        };
    }, [editor]);

    useEffect(() => {
        if (!focusEquationField) return;
        setFocusEquationField(false);
        equationFieldRef.current?.focus();
    }, [focusEquationField]);

    const editEquation = () => {
        setSelectionPanel('equation');
        setFocusEquationField(true);
    };

    // The comments panel would hold the slot the new equation's panel needs. No editor focus: Tiptap's comes a frame
    // after the field's.
    const insertEquation = () => {
        closePanels();
        editor.commands.insertEquation();
        editEquation();
    };

    return { selectionPanel, equationFieldRef, editEquation, insertEquation: isMobile ? undefined : insertEquation };
}
