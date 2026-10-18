import type { Transaction } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/react';
import { type RefObject, useEffect, useRef, useState } from 'react';

export type SelectionPanel = 'document' | 'figure' | 'chart' | 'equation' | 'table';

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
// stays while the equation is selected.
export function useSelectionPanel(
    editor: Editor | null,
    isMobile: boolean,
    closePanels: () => void,
): SelectionPanelState {
    const [selectionPanel, setSelectionPanel] = useState<SelectionPanel>('document');
    const equationFieldRef = useRef<HTMLTextAreaElement>(null);
    // A new equation's panel mounts in the render its selection causes, so its field takes focus after that render.
    const [focusEquationField, setFocusEquationField] = useState(false);

    useEffect(() => {
        if (!editor) return;
        const onUpdate = ({ transaction }: { transaction: Transaction }) => {
            setSelectionPanel((open) => {
                if (editor.isActive('figure')) return 'figure';
                if (editor.isActive('chart')) return 'chart';
                if (editor.isActive('equation') && (open === 'equation' || transaction.getMeta('pointer'))) {
                    return 'equation';
                }
                if (editor.isActive('table')) return 'table';
                return 'document';
            });
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
        editor?.commands.insertEquation();
        editEquation();
    };

    return { selectionPanel, equationFieldRef, editEquation, insertEquation: isMobile ? undefined : insertEquation };
}
