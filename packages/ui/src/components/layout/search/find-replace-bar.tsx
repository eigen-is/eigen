import type { DocSearchOptions } from '@workspace/lib/types/doc-search';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@workspace/ui/components/input-group';
import { TooltipButton } from '@workspace/ui/components/layout/toolbar/tooltip-button';
import { Toggle } from '@workspace/ui/components/toggle';
import { Tooltip, TooltipContent, TooltipTrigger } from '@workspace/ui/components/tooltip';
import { cn } from '@workspace/ui/lib/utils';
import { ArrowDown, ArrowUp, CaseSensitive, type LucideIcon, Regex, WholeWord, X } from 'lucide-react';
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
};

// Compact icon toggle for a search option. onMouseDown-preventDefault keeps the input focused so
// toggling a filter never interrupts typing (the repo's preventFocusLoss idiom).
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
                    className="size-6 min-w-0 rounded-[calc(var(--radius)-5px)] px-0"
                >
                    <Icon className="size-3.5" />
                </Toggle>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
        </Tooltip>
    );
}

// v1 renders the search row only. The flex-col wrapper is kept so the v1.5 replace plan slots a
// replace row in as a second child without reshaping this one.
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
}: FindReplaceBarProps) {
    const noResults = query !== '' && matchCount === 0;
    // Empty query → no count at all (never "0 of 0"); non-empty + 0 matches → muted "No results".
    const count = query === '' ? null : noResults ? 'No results' : `${activeIndex + 1} of ${matchCount}`;

    return (
        <div
            className={cn(
                'flex w-full flex-col gap-1 rounded-lg border bg-popover p-1 shadow-md sm:w-96',
                'origin-top animate-in fade-in-0 slide-in-from-top-2 duration-150',
            )}
        >
            <div className="flex items-center gap-1">
                <InputGroup className="h-8 flex-1">
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
        </div>
    );
}
