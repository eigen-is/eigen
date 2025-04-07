// TypeScript interfaces for the contact autosuggest component
import { Ref } from 'react';

/**
 * Properties for the ContactAutosuggest component
 */
export interface ContactAutosuggestProps {
  initialValue?: string;
  value?: string;
  onChange?: (value: string) => void;
  appendMode?: boolean;
  onlyEigenIsMails?: boolean;
  maxSuggestions?: number;
  className?: string;
  suggestionsClassName?: string;
  inputClassName?: string;
  placeholder?: string;
  disabled?: boolean;
  autoComplete?: string;
  id?: string;
  name?: string;
  required?: boolean;
  inputRef?: Ref<HTMLInputElement>;
}

/**
 * A contact suggestion item
 */
export interface ContactSuggestion {
  id: string;
  displayName: string;
  email: string;
  allEmails: string[];
}
