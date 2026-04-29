import { useSuggestions } from '@workspace/ui/hooks/use-suggestions';
import type React from 'react';
import { useCallback, useContext } from 'react';
import { WorkbookContext } from '../context';
import { insertFormulaFunctionDom } from '../state';

type UseFormulaAutocompleteOptions = {
    targetRef: { readonly current: HTMLElement | null };
    enabled: boolean;
};

type UseFormulaAutocompleteResult = {
    selectedIndex: number;
    onItemsChange: (count: number, names: string[]) => void;
    insertFormula: (formulaName: string) => void;
    // Returns true when the key was consumed; callers should early-return in that case.
    handleKeyDown: (e: React.KeyboardEvent) => boolean;
};

// Wires the formula-autocomplete popup keyboard + insertion path for InputBox and FxEditor.
// Both editors share the same `context.functionCandidates` source; only the target editor element differs.
export function useFormulaAutocomplete({
    targetRef,
    enabled,
}: UseFormulaAutocompleteOptions): UseFormulaAutocompleteResult {
    const { context, setContext } = useContext(WorkbookContext);
    const candidates = context.functionCandidates;
    const visible = enabled && candidates.length > 0;

    const insertFormula = useCallback(
        (formulaName: string) => {
            const target = targetRef.current;
            if (!target || !insertFormulaFunctionDom(target, formulaName)) return;
            setContext((draftCtx) => {
                draftCtx.functionCandidates = [];
                draftCtx.functionHint = formulaName;
            });
        },
        [targetRef, setContext],
    );

    const closeSuggest = useCallback(() => {
        setContext((draftCtx) => {
            draftCtx.functionCandidates = [];
        });
    }, [setContext]);

    const suggest = useSuggestions({
        visible,
        onSelect: insertFormula,
        onEscape: closeSuggest,
    });

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent): boolean => {
            // Enter/Tab commits the highlighted candidate. Read items synchronously from context
            // to avoid the effect-driven count race in useSuggestions.
            if ((e.key === 'Enter' || e.key === 'Tab') && visible) {
                const candidate = candidates[suggest.selectedIndex];
                if (candidate) {
                    insertFormula(candidate.n);
                    e.preventDefault();
                    e.stopPropagation();
                    return true;
                }
            }
            // useSuggestions covers ArrowUp/ArrowDown (navigation) and Escape (dismiss).
            return suggest.handleKeyDown(e);
        },
        [visible, candidates, suggest.selectedIndex, suggest.handleKeyDown, insertFormula],
    );

    return {
        selectedIndex: suggest.selectedIndex,
        onItemsChange: suggest.onItemsChange,
        insertFormula,
        handleKeyDown,
    };
}
