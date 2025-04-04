"use client"

import React, {useEffect} from "react";
import {mailApi} from "@workspace/lib/api.js";
import {toast} from 'sonner';
import {useQueryClient} from '@tanstack/react-query';
import {emailKeys, mailboxKeys} from "@workspace/lib/mail";
import type {EigenNotification} from "@apps/api-server/types/notification";

export function NotificationProvider({children}: { children: React.ReactNode }) {
    const queryClient = useQueryClient();

    useEffect(() => {
        // Create watcher once on component mount
        const watcher = mailApi.watch.subscribe();

        watcher.subscribe((event) => {
            const body = event.data as unknown as EigenNotification;
            if (body?.type === 'mail') {
                // Handle notifications here
                toast(body?.title, {
                    description: body?.description,
                    action: {
                        label: 'Open inbox',
                        onClick: () => {
                            document.location.href = `${import.meta.env.VITE_APP_MAIL_URL}/box/inbox`
                        }
                    }
                });
                queryClient.invalidateQueries({queryKey: emailKeys.list('inbox')});
                queryClient.invalidateQueries({queryKey: mailboxKeys.lists()});
            }
            watcher.send('pong');
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
