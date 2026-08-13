import { useSSE } from '@workspace/lib/sse';
import type { ReactNode } from 'react';

type SSEProviderProps = {
    children: ReactNode;
};

export function SSEProvider({ children }: SSEProviderProps) {
    useSSE();

    return <>{children}</>;
}
