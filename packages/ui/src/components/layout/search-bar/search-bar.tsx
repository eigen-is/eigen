import {
    InputGroup,
    InputGroupAddon,
    InputGroupButton,
    InputGroupInput,
    InputGroupText,
} from '@workspace/ui/components/input-group';
import { cn } from '@workspace/ui/lib/utils';
import { Search, X } from 'lucide-react';
import { type ChangeEvent, type RefObject, useEffect, useRef, useState } from 'react';

export type SearchBarProps = {
    placeholder?: string;
    value: string;
    onChange: (value: string) => void;
    className?: string;
    inputClassName?: string;
    maxWidth?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'full';
    debounceMs?: number;
    // Optional handle for imperative focus (mail's `/` shortcut). Forwarded to the input; callers
    // that don't pass it are unaffected.
    inputRef?: RefObject<HTMLInputElement | null>;
};

export function SearchBar({
    placeholder = 'Search...',
    value,
    onChange,
    className,
    inputClassName,
    maxWidth = 'sm',
    debounceMs = 200,
    inputRef,
}: SearchBarProps) {
    const maxWidthClasses = {
        xs: 'max-w-xs',
        sm: 'max-w-sm',
        md: 'max-w-md',
        lg: 'max-w-lg',
        xl: 'max-w-xl',
        full: 'max-w-full',
    };

    const [displayValue, setDisplayValue] = useState(value);
    const lastEmittedRef = useRef(value);
    const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
    const internalRef = useRef<HTMLInputElement>(null);

    // Sync from parent only for external changes (e.g. clear button)
    if (value !== lastEmittedRef.current && value !== displayValue) {
        lastEmittedRef.current = value;
        setDisplayValue(value);
    }

    useEffect(() => () => clearTimeout(timerRef.current), []);

    // Merge the optional external ref with the internal one used for the clear button's refocus.
    const setInputRef = (el: HTMLInputElement | null) => {
        internalRef.current = el;
        if (inputRef) inputRef.current = el;
    };

    const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
        const newValue = e.target.value;
        setDisplayValue(newValue);
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
            lastEmittedRef.current = newValue;
            onChange(newValue);
        }, debounceMs);
    };

    // Clear immediately (no debounce) and keep focus in the field so the user can retype.
    const handleClear = () => {
        clearTimeout(timerRef.current);
        setDisplayValue('');
        lastEmittedRef.current = '';
        onChange('');
        internalRef.current?.focus();
    };

    return (
        <div className={cn('w-full', maxWidthClasses[maxWidth], className)}>
            <InputGroup>
                <InputGroupAddon align="inline-start">
                    <InputGroupText>
                        <Search className="h-4 w-4" />
                    </InputGroupText>
                </InputGroupAddon>
                <InputGroupInput
                    ref={setInputRef}
                    type="text"
                    placeholder={placeholder}
                    className={cn('w-full', inputClassName)}
                    value={displayValue}
                    onChange={handleChange}
                    autoComplete="one-time-code"
                />
                {displayValue && (
                    <InputGroupAddon align="inline-end">
                        <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={handleClear}>
                            <X />
                        </InputGroupButton>
                    </InputGroupAddon>
                )}
            </InputGroup>
        </div>
    );
}
