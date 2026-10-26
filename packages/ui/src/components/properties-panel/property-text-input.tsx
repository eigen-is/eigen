import { Input } from '@workspace/ui/components/input';
import { useState } from 'react';
import { useHeldGesture } from './property-gesture';

type PropertyTextInputProps = {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    maxLength?: number;
};

// The panel's text field, the number field's twin: it writes on every keystroke inside one gesture, from
// the first until the field is left or committed, so a typed title is one undo step. While focused it shows
// its own draft, so a stored value the reader normalizes, or a peer's write, never moves the caret; ⌘Z
// drops the draft, so the field shows the title the undo left.
export function PropertyTextInput({ value, onChange, placeholder, maxLength }: PropertyTextInputProps) {
    const [draft, setDraft] = useState<string | null>(null);
    const { hold, end: endGesture, undoKey } = useHeldGesture();

    return (
        <Input
            className="h-7 text-xs"
            value={draft ?? value}
            placeholder={placeholder}
            maxLength={maxLength}
            onFocus={() => setDraft(value)}
            onChange={(e) => {
                setDraft(e.target.value);
                hold();
                onChange(e.target.value);
            }}
            onKeyDown={(e) => {
                if (undoKey(e)) setDraft(null);
                else if (e.key === 'Enter' || e.key === 'Escape') endGesture();
            }}
            onBlur={() => {
                endGesture();
                setDraft(null);
            }}
        />
    );
}
