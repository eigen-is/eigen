import { useContactSuggestions } from '@workspace/lib/contacts';
import type { ContactSuggestion } from '@workspace/lib/types/contact';
import { Input } from '@workspace/ui/components/input';
import { cn } from '@workspace/ui/lib/utils';
import { type KeyboardEvent, useCallback, useRef, useState } from 'react';
import { ContactSuggestList } from './contact-suggest-list';
import type { ContactAutosuggestProps } from './types';

export function ContactAutosuggest({
    initialValue = '',
    value: controlledValue,
    onChange,
    appendMode = false,
    onlyInternalMails = false,
    excludeEmails,
    className = '',
    suggestionsClassName = '',
    inputClassName = '',
    placeholder = '',
    disabled = false,
    autoComplete = 'one-time-code',
    id,
    name,
    required,
    inputRef: externalInputRef,
    onSubmit,
    onEmptyEnter,
}: ContactAutosuggestProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);

    // Handle controlled vs uncontrolled state
    const [internalValue, setInternalValue] = useState(initialValue);
    const inputValue = controlledValue !== undefined ? controlledValue : internalValue;

    const { suggestions, isLoading } = useContactSuggestions(inputValue, onlyInternalMails, excludeEmails);

    const handleSelect = useCallback(
        (suggestion: ContactSuggestion) => {
            const formattedContact = `${suggestion.displayName} <${suggestion.email}>`;

            let newValue: string;
            if (appendMode) {
                newValue = inputValue
                    ? `${[...inputValue.trim().split(',').slice(0, -1), formattedContact].join(', ')}, `
                    : formattedContact;
            } else {
                newValue = formattedContact;
            }

            setInternalValue(newValue);
            setSelectedIndex(0);
            onChange?.(newValue);

            setIsOpen(appendMode);
            inputRef.current?.focus();
        },
        [inputValue, onChange, appendMode],
    );

    const handleInputChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const newValue = e.target.value;
            setInternalValue(newValue);
            setIsOpen(true);
            onChange?.(newValue);
        },
        [onChange],
    );

    const handleKeyDown = useCallback(
        (e: KeyboardEvent<HTMLInputElement>) => {
            if (!isOpen || suggestions.length === 0) return;

            switch (e.key) {
                case 'ArrowDown':
                    e.preventDefault();
                    setSelectedIndex((prev) => (prev < suggestions.length - 1 ? prev + 1 : prev));
                    break;

                case 'ArrowUp':
                    e.preventDefault();
                    setSelectedIndex((prev) => (prev > 0 ? prev - 1 : 0));
                    break;

                case 'Enter':
                case 'Tab':
                    e.preventDefault();
                    if (suggestions[selectedIndex]) {
                        handleSelect(suggestions[selectedIndex]);
                    }
                    break;

                case 'Escape':
                    e.preventDefault();
                    setIsOpen(false);
                    break;
            }
        },
        [isOpen, suggestions, selectedIndex, handleSelect],
    );

    const handleKeyDownSubmit = (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key !== 'Enter' || event.defaultPrevented) return;
        // Empty-input Enter runs the caller's primary action instead of a no-op submit.
        if (!inputValue.trim() && onEmptyEnter) {
            event.preventDefault();
            onEmptyEnter();
            return;
        }
        if (onSubmit) {
            event.preventDefault();
            onSubmit(inputValue);
        }
    };

    const handleFocus = useCallback(() => {
        setIsOpen(true);
    }, []);

    const handleBlur = useCallback(() => {
        setTimeout(() => {
            if (inputRef.current !== document.activeElement) {
                setIsOpen(false);
            }
        }, 300);
    }, []);

    return (
        <div className={cn('relative', className)}>
            <Input
                id={id}
                name={name}
                ref={(elm) => {
                    if (typeof externalInputRef === 'function') {
                        externalInputRef(elm);
                    } else if (externalInputRef) {
                        (externalInputRef as React.MutableRefObject<HTMLInputElement | null>).current = elm;
                    }
                    inputRef.current = elm;
                }}
                value={inputValue}
                onChange={handleInputChange}
                onFocus={handleFocus}
                onBlur={handleBlur}
                onKeyDown={(e) => {
                    handleKeyDown(e);
                    handleKeyDownSubmit(e);
                }}
                className={inputClassName}
                placeholder={placeholder}
                disabled={disabled}
                autoComplete={autoComplete}
                required={required}
            />

            {isOpen && (
                <ContactSuggestList
                    items={suggestions}
                    selectedIndex={selectedIndex}
                    onSelect={handleSelect}
                    className={cn('w-full mt-1', suggestionsClassName)}
                />
            )}

            {isOpen && isLoading && (
                <div className="absolute z-10 w-full bg-background mt-1 border rounded-md shadow-lg p-3 text-center">
                    Loading...
                </div>
            )}
        </div>
    );
}
