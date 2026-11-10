// Catches a render error anywhere in an app's pages and shows ErrorState's standard sentence with a
// reload button, instead of a blank screen. EigenApp wraps every app's routes in it, and the error goes
// to the console.

import type { ReactNode } from 'react';
import React from 'react';
import { ErrorState } from './error-state';

type ErrorBoundaryProps = {
    children: ReactNode;
};

type ErrorBoundaryState = {
    hasError: boolean;
};

// A class, because React catches render errors only in a class component's lifecycle methods.
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
    public state: ErrorBoundaryState = { hasError: false };

    public static getDerivedStateFromError(): ErrorBoundaryState {
        return { hasError: true };
    }

    public componentDidCatch(error: Error, info: React.ErrorInfo) {
        console.error('[ErrorBoundary]', error, info.componentStack);
    }

    public render() {
        if (!this.state.hasError) return this.props.children;
        return (
            <ErrorState
                action={
                    <button
                        className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground cursor-pointer"
                        onClick={() => window.location.reload()}
                    >
                        Reload page
                    </button>
                }
            />
        );
    }
}
