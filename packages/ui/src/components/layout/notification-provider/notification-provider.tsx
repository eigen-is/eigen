"use client"

import React, {useCallback} from 'react';
import {toast} from "sonner";
import {useNotifications, type EigenNotification} from "@workspace/lib/notifications";

interface NotificationProviderProps {
    children: React.ReactNode;
}

export function NotificationProvider({children}: NotificationProviderProps) {
    const showToast = useCallback((notification: EigenNotification) => {
        const truncatedTitle = notification.title.length > 50 
            ? notification.title.slice(0, 50) + '…' 
            : notification.title;
        const truncatedBody = notification.body.length > 120 
            ? notification.body.slice(0, 120) + '…' 
            : notification.body;

        toast(truncatedTitle, {
            description: truncatedBody,
            action: notification.link ? {
                label: 'Open',
                onClick: (event) => {
                    event.preventDefault();
                    window.open(notification.link, "_blank");
                }
            } : undefined
        });
    }, []);

    useNotifications({onNotification: showToast});

    return <>{children}</>;
}
