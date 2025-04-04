"use client"

import React, {useEffect} from "react";
import {mailApi} from "@workspace/lib/api.js";
import {toast} from 'sonner';
import {useQueryClient} from '@tanstack/react-query';
import {emailKeys, mailboxKeys} from "@workspace/lib/mail";

export function NotificationProvider({children}: { children: React.ReactNode }) {
    const queryClient = useQueryClient();

    useEffect(() => {
        // Create watcher once on component mount
        const watcher = mailApi.watch.subscribe();

        watcher.subscribe(() => {
            // Handle notifications here
            toast.info('New email', {
                action: {
                    label: 'Open inbox',
                    onClick: () => {
                        document.location.href = `${import.meta.env.VITE_APP_MAIL_URL}/box/inbox`
                    }
                }
            });
            queryClient.invalidateQueries({queryKey: emailKeys.list('inbox')});
            queryClient.invalidateQueries({queryKey: mailboxKeys.lists()});
        });

        watcher.on('close', () => {
            console.log('Watcher closed');
        });

        // Cleanup function that runs when component unmounts
        return () => {
            // Just calling close on the watcher should clean everything up
            watcher.close?.();
        };
    }, []); // Empty dependency array ensures this runs only once on mount

    return <>{children}</>;
}
