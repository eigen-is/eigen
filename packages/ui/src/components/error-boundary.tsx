import React, {type ReactNode} from 'react';

type ErrorBoundaryProps = {
    children: ReactNode;
    fallback?: ReactNode;
}

type ErrorBoundaryState = {
    hasError: boolean;
}

// React requires class components for error boundaries — no hooks equivalent exists.
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
    state: ErrorBoundaryState = {hasError: false};

    static getDerivedStateFromError(): ErrorBoundaryState {
        return {hasError: true};
    }

    componentDidCatch(error: Error, info: React.ErrorInfo) {
        console.error('[ErrorBoundary]', error, info.componentStack);
    }

    render() {
        if (this.state.hasError) {
            return this.props.fallback ?? <ErrorFallback/>;
        }
        return this.props.children;
    }
}

function ErrorFallback() {
    return (
        <div className="flex flex-col items-center justify-center h-full w-full gap-4 p-8 text-center">
            <p className="text-muted-foreground">
                Encountering the null vector: a rendezvous with nothing at all.
            </p>
            <button
                className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground cursor-pointer"
                onClick={() => window.location.reload()}
            >
                Reload page
            </button>
        </div>
    );
}
