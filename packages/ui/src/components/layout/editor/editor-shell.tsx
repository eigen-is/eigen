import type { ReactNode } from 'react';

// Mimics the shadcn Input border/focus-ring so a LightEditor embedded in a form
// reads consistently next to Input/Label rows.
export function EditorShell({ children }: { children: ReactNode }) {
    return (
        <div className="rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-within:ring-[3px] focus-within:ring-ring/50">
            {children}
        </div>
    );
}
