import type { DocSearchOptions } from '@workspace/lib/types/doc-search';
import {
    InputGroup,
    InputGroupAddon,
    InputGroupButton,
    InputGroupInput,
    InputGroupText,
} from '@workspace/ui/components/input-group';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar/tooltip-button';
import { Toggle } from '@workspace/ui/components/toggle';
import { Tooltip, TooltipContent, TooltipTrigger } from '@workspace/ui/components/tooltip';
import { cn } from '@workspace/ui/lib/utils';
import {
    ALargeSmall,
    ArrowDown,
    ArrowUp,
    CaseSensitive,
    ChevronDown,
    ChevronRight,
    type LucideIcon,
    Regex,
    WholeWord,
    X,
} from 'lucide-react';
import type React from 'react';

export type FindReplaceBarProps = {
    query: string;
    options: DocSearchOptions;
    matchCount: number;
    activeIndex: number; // 0-based; -1 when no matches
    inputRef?: React.Ref<HTMLInputElement>; // provider focuses/re-focuses it (⌘F opens+selects; ⌘G reopens without stealing focus)
    onQueryChange: (q: string) => void;
    onToggleOption: (key: keyof DocSearchOptions) => void;
    onNext: () => void;
    onPrev: () => void;
    onClose: () => void;
    // v1.5 replace row — rendered only when `mode === 'replace'` AND the surface `canReplace`.
    mode: 'search' | 'replace';
    replacement: string;
    preserveCase: boolean;
    canReplace: boolean;
    replacedCount: number | null; // transient "Replaced N" after Replace All; the provider clears it
    onReplacementChange: (r: string) => void;
    onTogglePreserveCase: () => void;
    onToggleMode: () => void;
    onReplace: () => void;
    onReplaceAll: () => void;
    // Route the surface's own undo/redo out of the bar (⌘Z / ⇧⌘Z / Ctrl+Y). Focus lives in the bar's
    // input after Replace, so the editor keymap never sees the key — without this the browser applies
    // useless native input-undo. Absent → default behaviour (search-only surfaces don't wire them).
    onUndo?: () => void;
    onRedo?: () => void;
};

// Compact icon toggle for a search/replace option. onMouseDown-preventDefault keeps the input focused
// so toggling a filter never interrupts typing (the repo's preventFocusLoss idiom). Pressed styling
// keys off aria-pressed, NOT data-[state=on]: TooltipTrigger asChild overwrites data-state
// (open/closed) on this same element, so Toggle's own on-state selector can never match here.
function OptionToggle({
    pressed,
    label,
    icon: Icon,
    onToggle,
}: {
    pressed: boolean;
    label: string;
    icon: LucideIcon;
    onToggle: () => void;
}) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Toggle
                    size="sm"
                    pressed={pressed}
                    aria-label={label}
                    onMouseDown={(e) => e.preventDefault()}
                    onPressedChange={onToggle}
                    className="size-6 min-w-0 rounded-[calc(var(--radius)-5px)] px-0 aria-pressed:bg-primary/15 aria-pressed:text-primary aria-pressed:hover:bg-primary/20 aria-pressed:hover:text-primary"
                >
                    <Icon className="size-3.5" />
                </Toggle>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
        </Tooltip>
    );
}

export function FindReplaceBar({
    query,
    options,
    matchCount,
    activeIndex,
    inputRef,
    onQueryChange,
    onToggleOption,
    onNext,
    onPrev,
    onClose,
    mode,
    replacement,
    preserveCase,
    canReplace,
    replacedCount,
    onReplacementChange,
    onTogglePreserveCase,
    onToggleMode,
    onReplace,
    onReplaceAll,
    onUndo,
    onRedo,
}: FindReplaceBarProps) {
    const noResults = query !== '' && matchCount === 0;
    // Empty query → no count at all (never "0 of 0"); non-empty + 0 matches → muted "No results".
    const count = query === '' ? null : noResults ? 'No results' : `${activeIndex + 1} of ${matchCount}`;
    const showReplace = mode === 'replace' && canReplace;

    return (
        <div
            className={cn(
                'flex w-full flex-col gap-1 rounded-lg border bg-popover p-1 shadow-md sm:w-96',
                'origin-top animate-in fade-in-0 slide-in-from-top-2 duration-150',
            )}
            // One handler on the root — events bubble here from both inputs and the buttons.
            onKeyDown={(e) => {
                if (!onUndo || !(e.metaKey || e.ctrlKey)) return;
                if (e.key === 'z' || e.key === 'Z') {
                    e.preventDefault();
                    if (e.shiftKey) onRedo?.();
                    else onUndo();
                } else if (e.key === 'y' || e.key === 'Y') {
                    e.preventDefault(); // Windows redo
                    onRedo?.();
                }
            }}
        >
            <div className="flex items-center gap-1">
                {canReplace && (
                    <TooltipButton
                        icon={showReplace ? ChevronDown : ChevronRight}
                        tooltipText={showReplace ? 'Hide replace' : 'Show replace'}
                        preventFocusLoss
                        onClick={onToggleMode}
                    />
                )}
                <InputGroup className="h-8 min-w-0 flex-1">
                    <InputGroupInput
                        ref={inputRef}
                        placeholder="Find"
                        value={query}
                        onChange={(e) => onQueryChange(e.target.value)}
                        onKeyDown={(e) => {
                            // Enter/Shift-Enter step; Esc closes. Wired here (not useHotkey) because
                            // single-key hotkeys ignore focused inputs by @tanstack/hotkeys default.
                            if (e.key === 'Enter') {
                                e.preventDefault();
                                if (e.shiftKey) onPrev();
                                else onNext();
                            } else if (e.key === 'Escape') {
                                e.preventDefault();
                                onClose();
                            }
                        }}
                    />
                    <InputGroupAddon align="inline-end" className="gap-0.5">
                        {count !== null && (
                            <InputGroupText
                                className={cn('mr-0.5 text-xs whitespace-nowrap tabular-nums', noResults && 'italic')}
                            >
                                {count}
                            </InputGroupText>
                        )}
                        <OptionToggle
                            pressed={options.matchCase}
                            label="Match case"
                            icon={CaseSensitive}
                            onToggle={() => onToggleOption('matchCase')}
                        />
                        <OptionToggle
                            pressed={options.wholeWord}
                            label="Whole word"
                            icon={WholeWord}
                            onToggle={() => onToggleOption('wholeWord')}
                        />
                        <OptionToggle
                            pressed={options.regex}
                            label="Regex"
                            icon={Regex}
                            onToggle={() => onToggleOption('regex')}
                        />
                    </InputGroupAddon>
                </InputGroup>
                <TooltipButton
                    icon={ArrowUp}
                    tooltipText="Previous match"
                    disabled={matchCount === 0}
                    preventFocusLoss
                    onClick={onPrev}
                />
                <TooltipButton
                    icon={ArrowDown}
                    tooltipText="Next match"
                    disabled={matchCount === 0}
                    preventFocusLoss
                    onClick={onNext}
                />
                <TooltipButton icon={X} tooltipText="Close" onClick={onClose} />
            </div>
            {showReplace && (
                <div className="flex items-center gap-1">
                    {/* aligns the replace input under the find input (past the mode chevron) */}
                    <div className="size-8 shrink-0" aria-hidden />
                    <InputGroup className="h-8 min-w-0 flex-1">
                        <InputGroupInput
                            placeholder="Replace"
                            value={replacement}
                            onChange={(e) => onReplacementChange(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    e.preventDefault();
                                    onReplace();
                                } else if (e.key === 'Escape') {
                                    e.preventDefault();
                                    onClose();
                                }
                            }}
                        />
                        <InputGroupAddon align="inline-end" className="gap-0.5">
                            <OptionToggle
                                pressed={preserveCase}
                                label="Preserve case"
                                icon={ALargeSmall}
                                onToggle={onTogglePreserveCase}
                            />
                        </InputGroupAddon>
                    </InputGroup>
                    <InputGroupButton
                        size="sm"
                        aria-label="Replace"
                        disabled={matchCount === 0}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={onReplace}
                    >
                        Replace
                    </InputGroupButton>
                    <InputGroupButton
                        size="sm"
                        aria-label="Replace all"
                        disabled={matchCount === 0}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={onReplaceAll}
                    >
                        All
                    </InputGroupButton>
                    {replacedCount != null && (
                        <InputGroupText className="px-1 text-xs whitespace-nowrap">
                            Replaced {replacedCount}
                        </InputGroupText>
                    )}
                </div>
            )}
        </div>
    );
}
