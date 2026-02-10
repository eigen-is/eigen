"use client"

import React, {useCallback} from 'react';
import {toast} from "sonner";
import {type SSEvent, type SSEventNotification, useSSE} from "@workspace/lib/sse";

interface SSEProviderProps {
    children: React.ReactNode;
}

export function SSEProvider({children}: SSEProviderProps) {
    const showToast = useCallback((event: SSEvent & SSEventNotification) => {
        const truncatedTitle = event.title.length > 50
            ? event.title.slice(0, 50) + '…'
            : event.title;
        const truncatedBody = event.body.length > 120
            ? event.body.slice(0, 120) + '…'
            : event.body;

        toast(truncatedTitle, {
            description: truncatedBody,
            action: event.link ? {
                label: 'Open',
                onClick: (e) => {
                    e.preventDefault();
                    window.open(event.link, "_blank");
                }
            } : undefined
        });
    }, []);

    useSSE({onNotification: showToast});

    return <>{children}</>;
}
