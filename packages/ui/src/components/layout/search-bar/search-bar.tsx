import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from '@workspace/ui/components/input-group';
import { cn } from '@workspace/ui/lib/utils';
import { Search } from 'lucide-react';
import { type ChangeEvent, useEffect, useRef, useState } from 'react';

export type SearchBarProps = {
    placeholder?: string;
    value: string;
    onChange: (value: string) => void;
    className?: string;
    inputClassName?: string;
    maxWidth?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'full';
    debounceMs?: number;
};

export function SearchBar({
    placeholder = 'Search...',
    value,
    onChange,
    className,
    inputClassName,
    maxWidth = 'sm',
    debounceMs = 200,
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

    // Sync from parent only for external changes (e.g. clear button)
    if (value !== lastEmittedRef.current && value !== displayValue) {
        lastEmittedRef.current = value;
        setDisplayValue(value);
    }

    useEffect(() => () => clearTimeout(timerRef.current), []);

    const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
        const newValue = e.target.value;
        setDisplayValue(newValue);
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
            lastEmittedRef.current = newValue;
            onChange(newValue);
        }, debounceMs);
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
                    type="text"
                    placeholder={placeholder}
                    className={cn('w-full', inputClassName)}
                    value={displayValue}
                    onChange={handleChange}
                    autoComplete="one-time-code"
                />
            </InputGroup>
        </div>
    );
}
