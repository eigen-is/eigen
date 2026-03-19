import type {ReactNode} from 'react';
import {useSSE} from "@workspace/lib/sse";

type SSEProviderProps = {
    children: ReactNode;
}

export function SSEProvider({children}: SSEProviderProps) {
    useSSE();

    return <>{children}</>;
}
