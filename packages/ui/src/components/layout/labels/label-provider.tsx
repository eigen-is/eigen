import {createContext, ReactNode, useContext} from 'react';
import {toast} from 'sonner';
import type {Label} from '@apps/api-server/types/label';

// Define the shape of our context
interface LabelContextType {
    addLabel: (labelData: Omit<Label, 'id'>) => Promise<void>;
    updateLabel: (label: Label) => Promise<void>;
    deleteLabel: (labelId: string) => Promise<void>;
}

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

interface LabelProviderProps {
    children: ReactNode;
    onAddLabel?: (labelData: Omit<Label, 'id'>) => Promise<void>;
    onUpdateLabel?: (label: Label) => Promise<void>;
    onDeleteLabel?: (labelId: string) => Promise<void>;
}

// The actual provider component
export function LabelProvider({
                                  children,
                                  onAddLabel,
                                  onUpdateLabel,
                                  onDeleteLabel
                              }: LabelProviderProps) {
    // These functions will be implemented by the consuming application
    // and passed to the provider via props

    const addLabel = async (labelData: Omit<Label, 'id'>) => {
        try {
            if (onAddLabel) {
                await onAddLabel(labelData);
            }
            toast.success(`Label "${labelData.name}" added`);
        } catch (error) {
            console.error('Failed to add label:', error);
            toast.error('Failed to add label');
        }
    };

    const updateLabel = async (label: Label) => {
        try {
            if (onUpdateLabel) {
                await onUpdateLabel(label);
            }
            toast.success(`Label "${label.name}" updated`);
        } catch (error) {
            console.error('Failed to update label:', error);
            toast.error('Failed to update label');
        }
    };

    const deleteLabel = async (labelId: string) => {
        try {
            if (onDeleteLabel) {
                await onDeleteLabel(labelId);
            }
            toast.success(`Label deleted`);
        } catch (error) {
            console.error('Failed to delete label:', error);
            toast.error('Failed to delete label');
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
