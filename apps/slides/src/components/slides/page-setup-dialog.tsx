// File › Page setup in Slides: Google Slides' slide size, Widescreen 16:9 or Standard 4:3, which every slide of the
// deck shares. A writer picks one and OK writes it to the deck. A viewer sees the size with only a Close button.

import type { SlideSize } from '@workspace/lib/vector';
import { oneOf, SLIDE_SIZE_KEYS } from '@workspace/lib/vector';
import { FieldLegend, FieldSet } from '@workspace/ui/components/field';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { Label } from '@workspace/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@workspace/ui/components/radio-group';
import { useState } from 'react';

type PageSetupDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    slideSize: SlideSize;
    canWrite: boolean;
    onSlideSizeChange: (size: SlideSize) => void;
};

// Google's names for the two sizes Eigen has of its four.
const SLIDE_SIZE_LABELS: Record<SlideSize, string> = {
    '16:9': 'Widescreen 16:9',
    '4:3': 'Standard 4:3',
};

// Google Slides' Page setup without 16:10 and Custom.
export function PageSetupDialog({ open, onOpenChange, slideSize, canWrite, onSlideSizeChange }: PageSetupDialogProps) {
    return (
        <FormDialog open={open} onOpenChange={onOpenChange} title="Page setup" size="sm">
            <PageSetupForm slideSize={slideSize} canWrite={canWrite} onSlideSizeChange={onSlideSizeChange} />
        </FormDialog>
    );
}

// Mounted with the dialog, so each opening starts unpicked. Until the user picks, it shows the deck's size as it is
// now, a peer's change included, and OK writes only a pick that differs from it.
function PageSetupForm({
    slideSize,
    canWrite,
    onSlideSizeChange,
}: Omit<PageSetupDialogProps, 'open' | 'onOpenChange'>) {
    const [picked, setPicked] = useState<SlideSize | null>(null);
    const size = picked ?? slideSize;

    return (
        <FormDialogForm
            submitLabel="OK"
            readOnly={!canWrite}
            onSubmit={() => {
                if (size !== slideSize) onSlideSizeChange(size);
            }}
        >
            <FieldSet>
                <FieldLegend variant="label">Slide size</FieldLegend>
                <RadioGroup
                    value={size}
                    onValueChange={(value) => setPicked(oneOf(value, SLIDE_SIZE_KEYS, size))}
                    disabled={!canWrite}
                >
                    {SLIDE_SIZE_KEYS.map((key) => (
                        <div key={key} className="flex items-center gap-2">
                            <RadioGroupItem value={key} id={`page-setup-${key}`} />
                            <Label htmlFor={`page-setup-${key}`}>{SLIDE_SIZE_LABELS[key]}</Label>
                        </div>
                    ))}
                </RadioGroup>
            </FieldSet>
        </FormDialogForm>
    );
}
