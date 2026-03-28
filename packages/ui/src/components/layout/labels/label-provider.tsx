import type {Label} from '@workspace/lib/types/label';
import {createContext, type ReactNode, useContext} from 'react';

type LabelContextType = {
    addLabel: (labelData: Omit<Label, 'id'>) => Promise<void>;
    updateLabel: (label: Label) => Promise<void>;
    deleteLabel: (labelId: string) => Promise<void>;
};

// Create the context with default values
const LabelContext = createContext<LabelContextType>({
    addLabel: async () => {
        console.error('LabelProvider not found');
    },
    updateLabel: async () => {
        console.error('LabelProvider not found');
    },
    deleteLabel: async () => {
        console.error('LabelProvider not found');
    },
});

// Hook for consuming the context
export const useLabels = () => useContext(LabelContext);

type LabelProviderProps = {
    children: ReactNode;
    onAddLabel?: (labelData: Omit<Label, 'id'>) => Promise<void>;
    onUpdateLabel?: (label: Label) => Promise<void>;
    onDeleteLabel?: (labelId: string) => Promise<void>;
};

// The actual provider component
export function LabelProvider({children, onAddLabel, onUpdateLabel, onDeleteLabel}: LabelProviderProps) {
    // These functions will be implemented by the consuming application
    // and passed to the provider via props

    const addLabel = async (labelData: Omit<Label, 'id'>) => {
        if (onAddLabel) {
            await onAddLabel(labelData);
        }
    };

    const updateLabel = async (label: Label) => {
        if (onUpdateLabel) {
            await onUpdateLabel(label);
        }
    };

    const deleteLabel = async (labelId: string) => {
        if (onDeleteLabel) {
            await onDeleteLabel(labelId);
        }
    };

    return (
        <LabelContext.Provider
            value={{
                addLabel,
                updateLabel,
                deleteLabel,
            }}
        >
            {children}
        </LabelContext.Provider>
    );
}
