// The Custom date and time formats dialog: the format is a row of segments, such as a day, a month or a
// literal, each with its variant, previewed on a fixed sample date and applied to the selection.

import {
    ChoiceMenuItems,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { is_date } from '../../engine/format';
import { DATE_FORMAT_PRESETS } from '../../state';
import { FormatDialog, PatternPreview, PresetList, PresetRow } from './format-dialog';
import type { FormatSegment } from './format-pattern';
import {
    DATE_TOKEN_IDS,
    DATE_TOKENS,
    DATETIME_SAMPLE_SERIAL,
    previewPattern,
    serializeSegments,
    tokenizePattern,
} from './format-pattern';
import { useAnchorCell } from './useAnchorCell';

const TOKEN_GROUPS: { label: string; group: 'date' | 'time' | 'duration' }[] = [
    { label: 'Date', group: 'date' },
    { label: 'Time', group: 'time' },
    { label: 'Duration', group: 'duration' },
];

function TokenChip({
    segment,
    onVariantChange,
    onDelete,
}: {
    segment: Extract<FormatSegment, { kind: 'token' }>;
    onVariantChange: (pattern: string) => void;
    onDelete: () => void;
}) {
    const token = DATE_TOKENS[segment.token];
    const variant = token.variants.find((v) => v.pattern === segment.pattern);

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground whitespace-nowrap"
                >
                    {token.label}
                    {variant?.example ? ` (${variant.example})` : ''}
                    <ChevronDown className="size-3 opacity-50" />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="sheet-mousedown-cancel">
                <ChoiceMenuItems
                    value={segment.pattern}
                    options={token.variants.map((v) => ({ value: v.pattern, label: `${v.label} (${v.example})` }))}
                    onChange={onVariantChange}
                />
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" inset onClick={onDelete}>
                    Delete
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

export function CustomDateTimeFormats() {
    const anchor = useAnchorCell();
    const anchorFa = anchor?.ct?.fa;
    const [segments, setSegments] = useState<FormatSegment[]>(() =>
        tokenizePattern(anchorFa && is_date(anchorFa) ? anchorFa : 'dd/MM/yyyy'),
    );

    const pattern = serializeSegments(segments);
    const preview = pattern ? previewPattern(pattern, DATETIME_SAMPLE_SERIAL) : { ok: true as const, text: '' };

    const replaceSegment = (index: number, segment: FormatSegment) => {
        setSegments((prev) => prev.map((s, i) => (i === index ? segment : s)));
    };

    return (
        <FormatDialog title="Custom date and time formats" pattern={pattern} canSubmit={!!pattern && preview.ok}>
            <div className="flex flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-1 rounded-md border border-input px-2 py-1.5 min-h-9">
                    {segments.map((segment, index) =>
                        segment.kind === 'token' ? (
                            <TokenChip
                                // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and have no identity
                                key={`token-${index}`}
                                segment={segment}
                                onVariantChange={(p) => replaceSegment(index, { ...segment, pattern: p })}
                                onDelete={() => setSegments((prev) => prev.filter((_, i) => i !== index))}
                            />
                        ) : (
                            <input
                                // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and have no identity
                                key={`literal-${index}`}
                                aria-label="Separator text"
                                className="h-5 bg-transparent text-sm outline-none"
                                style={{ width: `${Math.max(segment.text.length, 1)}ch` }}
                                value={segment.text}
                                onChange={(e) => replaceSegment(index, { kind: 'literal', text: e.target.value })}
                            />
                        ),
                    )}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                type="button"
                                aria-label="Insert token"
                                className="ml-auto inline-flex items-center rounded-md px-1 py-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                            >
                                <ChevronDown className="size-4" />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent className="sheet-mousedown-cancel" align="end">
                            {TOKEN_GROUPS.map(({ label, group }) => (
                                <div key={group}>
                                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                                        {label}
                                    </DropdownMenuLabel>
                                    {DATE_TOKEN_IDS.filter((id) => DATE_TOKENS[id].group === group).map((id) => (
                                        <DropdownMenuItem
                                            key={id}
                                            onClick={() =>
                                                setSegments((prev) => [
                                                    ...prev,
                                                    {
                                                        kind: 'token',
                                                        token: id,
                                                        pattern: DATE_TOKENS[id].insertPattern,
                                                    },
                                                ])
                                            }
                                        >
                                            {DATE_TOKENS[id].label}
                                        </DropdownMenuItem>
                                    ))}
                                </div>
                            ))}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                                onClick={() => setSegments((prev) => [...prev, { kind: 'literal', text: '' }])}
                            >
                                Separator text
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
                <PatternPreview preview={preview} />
            </div>
            <PresetList>
                {DATE_FORMAT_PRESETS.map(({ name, value }) => (
                    <PresetRow
                        key={value}
                        active={value === pattern}
                        onPick={() => setSegments(tokenizePattern(value))}
                    >
                        <span>{name}</span>
                        <span className="text-muted-foreground font-mono">{value}</span>
                    </PresetRow>
                ))}
            </PresetList>
        </FormatDialog>
    );
}
