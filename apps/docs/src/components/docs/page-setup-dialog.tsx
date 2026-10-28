// File › Page setup: Google Docs' two tabs, Pages and Page-less, which pick the doc's format for everyone. Pages holds
// the paper and its margins; Page-less holds the reader's own text width, which only they see. A band's Header
// format… and Footer format… open the Headers and footers dialog beside it.

import type { PageMargin, PageSetup } from '@workspace/lib/docs/eigendoc';
import {
    cmText,
    MIN_TEXT_MM,
    matchPaperSize,
    PAPER_SIZES,
    pageRecord,
    readCm,
    readPageSetup,
} from '@workspace/lib/docs/eigendoc';
import type { DocsTextWidth } from '@workspace/lib/types/settings';
import { DOCS_TEXT_WIDTHS } from '@workspace/lib/types/settings';
import { Button } from '@workspace/ui/components/button';
import { Checkbox } from '@workspace/ui/components/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Field, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet } from '@workspace/ui/components/field';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@workspace/ui/components/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@workspace/ui/components/tabs';
import { useState } from 'react';
import { TEXT_WIDTHS } from './page-setup';

// The reader's text width and its write; none on a phone, whose column is the screen.
type TextWidthProps = { textWidth?: DocsTextWidth; onTextWidthChange?: (width: DocsTextWidth) => void };

type PageSetupDialogProps = TextWidthProps & {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    setup: PageSetup;
    canWrite: boolean;
    onSetupChange: (from: PageSetup, to: PageSetup) => void;
};

const MARGIN_FIELDS: { side: keyof PageMargin; label: string }[] = [
    { side: 'top', label: 'Top' },
    { side: 'bottom', label: 'Bottom' },
    { side: 'left', label: 'Left' },
    { side: 'right', label: 'Right' },
];

const CUSTOM = 'Custom';

// The cm fields step by 0.01 and show that many decimals while nobody types in them, as Google's 2.00 cm; the browser
// writes the decimal separator of the reader's locale. What is typed stays as typed until the field is left.
const CM_STEP = '0.01';
const CM_DECIMALS = 2;

type CmInputProps = { id: string; value: string; onValueChange: (value: string) => void; disabled?: boolean };

function CmInput({ id, value, onValueChange, disabled }: CmInputProps) {
    const [typing, setTyping] = useState(false);
    const number = Number(value);
    const shown = typing || value.trim() === '' || !Number.isFinite(number) ? value : number.toFixed(CM_DECIMALS);
    return (
        <Input
            id={id}
            type="number"
            step={CM_STEP}
            className="w-24"
            value={shown}
            onChange={(e) => {
                setTyping(true);
                onValueChange(e.target.value);
            }}
            onBlur={() => setTyping(false)}
            disabled={disabled}
        />
    );
}

// Margins to 0.01 cm, as Google shows 0.75 in as 1.91 cm.
const marginText = (mm: number) => cmText(mm, CM_DECIMALS);
// Portrait first, as Google lists every paper.
const paperLabel = (name: string, width: number, height: number) =>
    `${name} (${(Math.min(width, height) / 10).toFixed(1)} cm × ${(Math.max(width, height) / 10).toFixed(1)} cm)`;

// Google Docs' Page setup without Apply to, Page colour and Set as default: a doc has one page and no page colour.
export function PageSetupDialog({
    open,
    onOpenChange,
    setup,
    canWrite,
    onSetupChange,
    textWidth,
    onTextWidthChange,
}: PageSetupDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent size="md" showCloseButton={false} aria-describedby={undefined}>
                <DialogHeader>
                    <DialogTitle>Page setup</DialogTitle>
                </DialogHeader>
                <PageSetupForm
                    setup={setup}
                    canWrite={canWrite}
                    onSubmit={onSetupChange}
                    onDone={() => onOpenChange(false)}
                    textWidth={textWidth}
                    onTextWidthChange={onTextWidthChange}
                />
            </DialogContent>
        </Dialog>
    );
}

type PageSetupFormProps = TextWidthProps & {
    setup: PageSetup;
    canWrite: boolean;
    onSubmit: (from: PageSetup, to: PageSetup) => void;
    onDone: () => void;
};

const PAGES = 'pages';
const PAGELESS = 'pageless';

// Mounted with the dialog, so each opening starts from the doc's page as it was then. A viewer can't change the doc's
// format, but on a page-less doc still picks their own text width, which OK saves.
function PageSetupForm({ setup, canWrite, onSubmit, onDone, textWidth, onTextWidthChange }: PageSetupFormProps) {
    const [initial] = useState(setup);
    const [pageless, setPageless] = useState(initial.pageless);
    const [width, setWidth] = useState(textWidth);
    const [paper, setPaper] = useState({ width: initial.width, height: initial.height });
    const [text, setText] = useState({
        top: marginText(initial.margin.top),
        right: marginText(initial.margin.right),
        bottom: marginText(initial.margin.bottom),
        left: marginText(initial.margin.left),
    });

    const landscape = paper.width > paper.height;
    // An untouched field keeps the stored size, not its rounding.
    const margin = (side: keyof PageMargin) =>
        text[side] === marginText(initial.margin[side]) ? initial.margin[side] : readCm(text[side]);
    const candidate: PageSetup = {
        ...initial,
        ...paper,
        margin: { top: margin('top'), right: margin('right'), bottom: margin('bottom'), left: margin('left') },
        pageless,
    };
    // Valid is what the stored page would read back unchanged.
    const read = readPageSetup(pageRecord(candidate));
    const valid = MARGIN_FIELDS.every(({ side }) => read.margin[side] === candidate.margin[side]);
    const widthShown = pageless && width !== undefined && onTextWidthChange !== undefined;
    const editable = canWrite || widthShown;

    const turn = (size: { width: number; height: number }, toLandscape: boolean) =>
        setPaper(
            size.width > size.height === toLandscape
                ? { width: size.width, height: size.height }
                : { width: size.height, height: size.width },
        );

    return (
        <form
            className="flex flex-col gap-6"
            // The forms check their fields themselves; the browser's step check would refuse a margin typed to 0.001 cm.
            noValidate
            onSubmit={(e) => {
                e.preventDefault();
                if (!valid) return;
                if (canWrite) onSubmit(initial, candidate);
                if (widthShown && width !== textWidth) onTextWidthChange(width);
                onDone();
            }}
        >
            <Tabs value={pageless ? PAGELESS : PAGES} onValueChange={(value) => setPageless(value === PAGELESS)}>
                <TabsList className="w-full">
                    <TabsTrigger value={PAGES} disabled={!canWrite && pageless}>
                        Pages
                    </TabsTrigger>
                    <TabsTrigger value={PAGELESS} disabled={!canWrite && !pageless}>
                        Page-less
                    </TabsTrigger>
                </TabsList>
                <p className="text-sm text-muted-foreground">
                    Pages or page-less is the document's format: everyone who opens it sees the one chosen here.
                </p>
                <TabsContent value={PAGES} className="pt-4">
                    <div className="grid gap-6 sm:grid-cols-2">
                        <div className="flex flex-col gap-6">
                            <FieldSet>
                                <FieldLegend variant="label">Orientation</FieldLegend>
                                <RadioGroup
                                    value={landscape ? 'landscape' : 'portrait'}
                                    onValueChange={(value) => turn(paper, value === 'landscape')}
                                    disabled={!canWrite}
                                >
                                    <div className="flex items-center gap-2">
                                        <RadioGroupItem value="portrait" id="page-setup-portrait" />
                                        <Label htmlFor="page-setup-portrait">Portrait</Label>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <RadioGroupItem value="landscape" id="page-setup-landscape" />
                                        <Label htmlFor="page-setup-landscape">Landscape</Label>
                                    </div>
                                </RadioGroup>
                            </FieldSet>

                            <Field>
                                <FieldLabel htmlFor="page-setup-paper">Paper size</FieldLabel>
                                <Select
                                    value={matchPaperSize(paper) ?? CUSTOM}
                                    onValueChange={(name) => {
                                        const size = PAPER_SIZES.find((p) => p.name === name);
                                        if (size) turn(size, landscape);
                                    }}
                                    disabled={!canWrite}
                                >
                                    <SelectTrigger id="page-setup-paper" className="w-full">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {PAPER_SIZES.map(({ name, width, height }) => (
                                            <SelectItem key={name} value={name}>
                                                {paperLabel(name, width, height)}
                                            </SelectItem>
                                        ))}
                                        {!matchPaperSize(initial) && (
                                            <SelectItem value={CUSTOM} disabled>
                                                {paperLabel(CUSTOM, initial.width, initial.height)}
                                            </SelectItem>
                                        )}
                                    </SelectContent>
                                </Select>
                            </Field>
                        </div>

                        <FieldSet className="gap-3">
                            <FieldLegend variant="label">Margins (centimetres)</FieldLegend>
                            {MARGIN_FIELDS.map(({ side, label }) => (
                                <Field key={side} orientation="horizontal">
                                    <FieldLabel htmlFor={`page-setup-${side}`}>{label}</FieldLabel>
                                    <CmInput
                                        id={`page-setup-${side}`}
                                        value={text[side]}
                                        onValueChange={(value) => setText({ ...text, [side]: value })}
                                        disabled={!canWrite}
                                    />
                                </Field>
                            ))}
                            {!valid && (
                                <FieldError>
                                    Margins must be 0 cm or more and leave at least {cmText(MIN_TEXT_MM, 1)} cm for the
                                    text.
                                </FieldError>
                            )}
                        </FieldSet>
                    </div>
                </TabsContent>
                <TabsContent value={PAGELESS} className="flex flex-col gap-6 pt-4">
                    <p className="text-sm">
                        Page-less shows the document as one continuous column of text, without page breaks, headers or
                        footers. Wide tables and images can run past the text. Printing and the PDF still use the paper
                        and margins on the Pages tab.
                    </p>
                    {widthShown && (
                        <FieldSet>
                            <FieldLegend variant="label">Text width</FieldLegend>
                            <FieldDescription>
                                Your own view: it applies to every page-less document you open, and the people you share
                                with keep theirs.
                            </FieldDescription>
                            <RadioGroup
                                value={width}
                                onValueChange={(value) => setWidth(DOCS_TEXT_WIDTHS.find((w) => w === value) ?? width)}
                            >
                                {DOCS_TEXT_WIDTHS.map((value) => (
                                    <div key={value} className="flex items-center gap-2">
                                        <RadioGroupItem value={value} id={`page-setup-width-${value}`} />
                                        <Label htmlFor={`page-setup-width-${value}`}>{TEXT_WIDTHS[value].label}</Label>
                                    </div>
                                ))}
                            </RadioGroup>
                        </FieldSet>
                    )}
                </TabsContent>
            </Tabs>

            {editable ? (
                <DialogFooter>
                    <Button type="button" variant="outline" onClick={onDone}>
                        Cancel
                    </Button>
                    <Button type="submit" disabled={!valid}>
                        OK
                    </Button>
                </DialogFooter>
            ) : (
                <DialogFooter showCloseButton />
            )}
        </form>
    );
}

type HeadersAndFootersDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    setup: PageSetup;
    onSetupChange: (from: PageSetup, to: PageSetup) => void;
};

const DISTANCE_FIELDS = [
    { key: 'headerDistance', label: 'Header (centimetres from top)' },
    { key: 'footerDistance', label: 'Footer (centimetres from bottom)' },
] as const;

type DistanceKey = (typeof DISTANCE_FIELDS)[number]['key'];

// Google Docs' Headers and footers, from a band's Options: the bands' distances from the paper's edge and Different
// first page, without odd and even pages, which a doc has no bands for. Only a writer enters a band.
export function HeadersAndFootersDialog({ open, onOpenChange, setup, onSetupChange }: HeadersAndFootersDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent size="xs" showCloseButton={false} aria-describedby={undefined}>
                <DialogHeader>
                    <DialogTitle>Headers and footers</DialogTitle>
                </DialogHeader>
                <HeadersAndFootersForm setup={setup} onSubmit={onSetupChange} onDone={() => onOpenChange(false)} />
            </DialogContent>
        </Dialog>
    );
}

// Mounted with the dialog, as the page setup form is.
function HeadersAndFootersForm({ setup, onSubmit, onDone }: Omit<PageSetupFormProps, 'canWrite'>) {
    const [initial] = useState(setup);
    const [text, setText] = useState({
        headerDistance: marginText(initial.headerDistance),
        footerDistance: marginText(initial.footerDistance),
    });
    const [differentFirstPage, setDifferentFirstPage] = useState(initial.differentFirstPage);

    // An untouched field keeps the stored distance, not its rounding.
    const distance = (key: DistanceKey) => (text[key] === marginText(initial[key]) ? initial[key] : readCm(text[key]));
    const candidate: PageSetup = {
        ...initial,
        headerDistance: distance('headerDistance'),
        footerDistance: distance('footerDistance'),
        differentFirstPage,
    };
    // Valid is what the stored page would read back unchanged: each band between the paper's edge and its margin.
    const read = readPageSetup(pageRecord(candidate));
    const valid = DISTANCE_FIELDS.every(({ key }) => read[key] === candidate[key]);

    return (
        <form
            className="flex flex-col gap-6"
            // The forms check their fields themselves; the browser's step check would refuse a margin typed to 0.001 cm.
            noValidate
            onSubmit={(e) => {
                e.preventDefault();
                if (!valid) return;
                onSubmit(initial, candidate);
                onDone();
            }}
        >
            <FieldSet className="gap-3">
                <FieldLegend variant="label">Margins</FieldLegend>
                {DISTANCE_FIELDS.map(({ key, label }) => (
                    <Field key={key} orientation="horizontal">
                        <FieldLabel htmlFor={`headers-and-footers-${key}`}>{label}</FieldLabel>
                        <CmInput
                            id={`headers-and-footers-${key}`}
                            value={text[key]}
                            onValueChange={(value) => setText({ ...text, [key]: value })}
                        />
                    </Field>
                ))}
                {!valid && (
                    <FieldError>
                        The header must be 0 to {marginText(initial.margin.top)} cm from the top and the footer 0 to{' '}
                        {marginText(initial.margin.bottom)} cm from the bottom, within their margins.
                    </FieldError>
                )}
            </FieldSet>

            <FieldSet className="gap-3">
                <FieldLegend variant="label">Layout</FieldLegend>
                <div className="flex items-center gap-2">
                    <Checkbox
                        id="headers-and-footers-first-page"
                        checked={differentFirstPage}
                        onCheckedChange={(checked) => setDifferentFirstPage(checked === true)}
                    />
                    <Label htmlFor="headers-and-footers-first-page" className="font-normal">
                        Different first page
                    </Label>
                </div>
            </FieldSet>

            <DialogFooter>
                <Button type="button" variant="outline" onClick={onDone}>
                    Cancel
                </Button>
                <Button type="submit" disabled={!valid}>
                    Apply
                </Button>
            </DialogFooter>
        </form>
    );
}
