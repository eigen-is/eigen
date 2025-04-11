import {KeyboardEvent, useCallback, useRef, useState} from 'react';
import {Input} from '@workspace/ui/components/input';
import {useContactSuggestions} from './use-contact-suggestions';
import {ContactAutosuggestProps, ContactSuggestion} from './types';
import {UserItem} from '../user-item';

export function ContactAutosuggest({
                                       initialValue = '',
                                       value: controlledValue,
                                       onChange,
                                       appendMode = false,
                                       onlyEigenIsMails = false,
                                       maxSuggestions = 5,
                                       className = '',
                                       suggestionsClassName = '',
                                       inputClassName = '',
                                       placeholder = '',
                                       disabled = false,
                                       autoComplete = 'off',
                                       id,
                                       name,
                                       required,
                                       inputRef: externalInputRef
                                   }: ContactAutosuggestProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const suggestionsRef = useRef<HTMLUListElement>(null);

    // Handle controlled vs uncontrolled state
    const [internalValue, setInternalValue] = useState(initialValue);
    const inputValue = controlledValue !== undefined ? controlledValue : internalValue;

    const {suggestions, isLoading} = useContactSuggestions(
        inputValue,
        onlyEigenIsMails
    );

    const displayedSuggestions = suggestions.slice(0, maxSuggestions);

    const handleSelect = useCallback((suggestion: ContactSuggestion) => {
        const formattedContact = `${suggestion.displayName} <${suggestion.email}>`;

        let newValue: string;
        if (appendMode) {
            newValue = inputValue
                ? [...inputValue.trim().split(',').slice(0, -1), formattedContact].join(', ') + ', '
                : formattedContact;
        } else {
            newValue = formattedContact;
        }

        setInternalValue(newValue);
        setSelectedIndex(0);
        onChange?.(newValue);

        setIsOpen(appendMode);
        inputRef.current?.focus();
    }, [inputValue, onChange, appendMode]);

    const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const newValue = e.target.value;
        setInternalValue(newValue);
        onChange?.(newValue);
    }, [onChange]);

    const handleKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
        if (!isOpen || displayedSuggestions.length === 0) return;

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                setSelectedIndex(prev => prev < displayedSuggestions.length - 1 ? prev + 1 : prev);
                break;

            case 'ArrowUp':
                e.preventDefault();
                setSelectedIndex(prev => prev > 0 ? prev - 1 : 0);
                break;

            case 'Enter':
                e.preventDefault();
                if (displayedSuggestions[selectedIndex]) {
                    handleSelect(displayedSuggestions[selectedIndex]);
                }
                break;

            case 'Escape':
                e.preventDefault();
                setIsOpen(false);
                break;
        }
    }, [isOpen, displayedSuggestions, selectedIndex, handleSelect]);

    const handleFocus = useCallback(() => {
        setIsOpen(true);
    }, []);

    const handleBlur = useCallback(() => {
        setTimeout(() => {
            if (!suggestionsRef.current?.contains(document.activeElement)) {
                setIsOpen(false);
            }
        }, 150);
    }, []);

    return (
        <div className={`relative ${className}`}>
            <Input
                id={id}
                name={name}
                ref={elm => {
                    // Handle both internal ref and external ref if provided
                    if (typeof externalInputRef === 'function') {
                        externalInputRef(elm);
                    } else if (externalInputRef) {
                        (externalInputRef as React.MutableRefObject<HTMLInputElement | null>).current = elm;
                    }

                    // Always update our internal ref
                    inputRef.current = elm;
                }}
                value={inputValue}
                onChange={handleInputChange}
                onFocus={handleFocus}
                onBlur={handleBlur}
                onKeyDown={handleKeyDown}
                className={inputClassName}
                placeholder={placeholder}
                disabled={disabled}
                autoComplete={autoComplete}
                required={required}
            />

            {isOpen && displayedSuggestions.length > 0 && (
                <ul
                    ref={suggestionsRef}
                    className={`absolute z-10 w-full bg-white mt-1 border rounded-md shadow-lg overflow-y-auto max-h-60 ${suggestionsClassName}`}
                    role="listbox"
                    tabIndex={-1}
                >
                    {displayedSuggestions.map((suggestion, index) => (
                        <li
                            key={suggestion.id}
                            className={`px-3 py-2 eigen-list-item ${
                                index === selectedIndex
                                    ? 'eigen-list-item-active'
                                    : ''
                            }`}
                            onClick={() => handleSelect(suggestion)}
                            role="option"
                            aria-selected={index === selectedIndex}
                        >
                            <UserItem
                                name={suggestion.displayName}
                                email={suggestion.email}
                                userId={suggestion.id}
                            />
                        </li>
                    ))}
                </ul>
            )}

            {isOpen && isLoading && (
                <div className="absolute z-10 w-full bg-white mt-1 border rounded-md shadow-lg p-3 text-center">
                    Loading...
                </div>
            )}
        </div>
    );
}
