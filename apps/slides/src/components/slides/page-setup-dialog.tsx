import { oneOf, SLIDE_SIZE_KEYS, type SlideSize } from '@workspace/lib/vector';
import { Button } from '@workspace/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { FieldLegend, FieldSet } from '@workspace/ui/components/field';
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
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent size="sm" showCloseButton={false} aria-describedby={undefined}>
                <DialogHeader>
                    <DialogTitle>Page setup</DialogTitle>
                </DialogHeader>
                <PageSetupForm
                    slideSize={slideSize}
                    canWrite={canWrite}
                    onSubmit={onSlideSizeChange}
                    onDone={() => onOpenChange(false)}
                />
            </DialogContent>
        </Dialog>
    );
}

type PageSetupFormProps = {
    slideSize: SlideSize;
    canWrite: boolean;
    onSubmit: (size: SlideSize) => void;
    onDone: () => void;
};

// Mounted with the dialog, so each opening starts unpicked. Until the user picks, it shows the deck's size as it is
// now, a peer's change included, and OK writes only a pick that differs from it.
function PageSetupForm({ slideSize, canWrite, onSubmit, onDone }: PageSetupFormProps) {
    const [picked, setPicked] = useState<SlideSize | null>(null);
    const size = picked ?? slideSize;

    return (
        <form
            className="flex flex-col gap-6"
            onSubmit={(e) => {
                e.preventDefault();
                if (size !== slideSize) onSubmit(size);
                onDone();
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

            {canWrite ? (
                <DialogFooter>
                    <Button type="button" variant="outline" onClick={onDone}>
                        Cancel
                    </Button>
                    <Button type="submit">OK</Button>
                </DialogFooter>
            ) : (
                <DialogFooter showCloseButton />
            )}
        </form>
    );
}
