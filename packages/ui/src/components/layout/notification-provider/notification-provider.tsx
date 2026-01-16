"use client"

import React, {useEffect, useRef} from 'react';
import {wsApi} from "@workspace/lib/api";
import {toast} from "sonner";
import {useQueryClient} from "@tanstack/react-query";
import {emailKeys, mailboxKeys} from "@workspace/lib/mail";
import type {EigenNotification} from "@apps/api-server/types/notification";
import {useAuth} from "@workspace/lib/auth/auth-context.tsx"; // Fixed import path
import { driveKeys } from '@workspace/lib/drive/index.js';

interface NotificationProviderProps {
    children: React.ReactNode;
}

function notify(notification: EigenNotification) {
    const truncatedTitle = notification.title.length > 50 ? notification.title.slice(0, 50) + '…' : notification.title;
    const truncatedBody = notification.body.length > 120 ? notification.body.slice(0, 120) + '…' : notification.body;

    toast(truncatedTitle, {
        description: truncatedBody,
        action: notification.link ? {
            label: 'Open',
            onClick: (event) => {
                event.preventDefault(); // prevent the browser from focusing the Notification's tab
                window.open(notification.link, "_blank");
            }
        } : undefined
    });

    // if (!("Notification" in window)) {
    //     return;
    // } else if (Notification.permission === 'granted') {
    //     const n = new Notification(truncatedTitle, {
    //         body: truncatedBody,
    //         tag: notification.tag,
    //     });
    //     notification.link && n.addEventListener('click', (event) => {
    //         event.preventDefault(); // prevent the browser from focusing the Notification's tab
    //         window.open(notification.link, "_blank");
    //     });
    // } else {
    //     askNotificationPermission();
    // }
}

// function askNotificationPermission() {
//     if (!("Notification" in window)) {
//         return;
//     } else if (Notification.permission === 'granted') {
//         return;
//     } else if (Notification.permission !== 'denied') {
//         Notification.requestPermission().then((permission) => {
//             if (permission === 'granted') {
//                 return;
//             }
//         });
//     }
// }

export function NotificationProvider({children}: NotificationProviderProps) {
    const {isAuthenticated} = useAuth(); // Get authentication status
    const queryClient = useQueryClient();
    // Using any for WebSocket client since Eden WebSocket has a different interface
    const watcherRef = useRef<any>(null);
    const lastActivityRef = useRef<number>(Date.now());
    const expectingPongRef = useRef<boolean>(false);
    const reconnectAttemptsRef = useRef<number>(0);
    const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    // Create and set up the WebSocket connection
    const setupWatcher = () => {
        // Only proceed if authenticated
        if (!isAuthenticated) {
            return null;
        }

        try {
            console.log('Setting up notification watcher');
            const watcher = wsApi.notifications.subscribe();
            watcherRef.current = watcher;
            lastActivityRef.current = Date.now();

            watcher.subscribe((event) => {
                lastActivityRef.current = Date.now();
                reconnectAttemptsRef.current = 0; // Reset reconnect attempts on successful message

                // Handle pong message specifically
                if (event.data === 'pong') {
                    expectingPongRef.current = false;
                    return;
                }

                // Process notification
                const body = event.data as unknown as EigenNotification;
                // Handle notifications here
                notify(body);

                if (body?.type === 'mail') {
                    queryClient.invalidateQueries({queryKey: emailKeys.list('inbox')});
                    queryClient.invalidateQueries({queryKey: mailboxKeys.lists()});
                } else if (body?.type === 'acl_insert' || body?.type === 'acl_delete') {
                    queryClient.invalidateQueries({queryKey: driveKeys.shared('with-me')});
                }

                // Send pong response
                try {
                    watcher.send('pong');
                } catch (e) {
                    console.error('Failed to send pong', e);
                    reconnectWatcher();
                }
            });

            watcher.on('close', () => {
                console.log('Watcher closed, reconnecting...');
                reconnectWatcher();
            });

            watcher.on('error', (error) => {
                console.error('WebSocket error:', error);
                reconnectWatcher();
            });

            return watcher;
        } catch (error) {
            console.error('Failed to setup watcher', error);
            reconnectWatcher();
            return null;
        }
    };

    // Reconnect with exponential backoff
    const reconnectWatcher = () => {
        // Only proceed if authenticated
        if (!isAuthenticated) {
            return;
        }

        if (watcherRef.current) {
            try {
                watcherRef.current.close();
            } catch (e) {
                // Ignore close errors
            }
            watcherRef.current = null;
        }

        // Clear any existing reconnect timeout
        if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
        }

        // Calculate backoff time (max 30 seconds)
        const backoffTime = Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current), 30000);
        reconnectAttemptsRef.current++;

        console.log(`Reconnecting in ${backoffTime}ms (attempt ${reconnectAttemptsRef.current})`);

        reconnectTimeoutRef.current = setTimeout(() => {
            setupWatcher();
        }, backoffTime);
    };

    // Initial setup
    useEffect(() => {
        // Only set up the watcher if authenticated
        if (!isAuthenticated) {
            return () => {
            }; // Return empty cleanup function
        }

        // Initialize the watcher
        setupWatcher();

        // Periodic health check
        const healthInterval = setInterval(() => {
            // Skip checks if not authenticated or no watcher exists
            if (!isAuthenticated || !watcherRef.current) return;

            // Check if connection is stale (no activity for > 30 seconds)
            const now = Date.now();
            const inactiveTime = now - lastActivityRef.current;

            if (inactiveTime > 30000) { // 30 seconds threshold
                if (watcherRef.current.readyState !== 1) { // Not OPEN
                    console.log('Connection stale (not open), reconnecting...');
                    reconnectWatcher();
                } else {
                    // Connection appears open but inactive, test with ping
                    try {
                        watcherRef.current.send('ping');
                        expectingPongRef.current = true;

                        // If no pong comes back in 5 seconds, force reconnect
                        setTimeout(() => {
                            if (expectingPongRef.current) {
                                console.log('No pong response, reconnecting...');
                                expectingPongRef.current = false;
                                reconnectWatcher();
                            }
                        }, 5000);
                    } catch (e) {
                        // Send failed, reconnect
                        console.error('Failed to send ping', e);
                        reconnectWatcher();
                    }
                }
            }
        }, 15000); // Check every 15 seconds

        // Visibility change detection
        const handleVisibilityChange = () => {
            if (!isAuthenticated) return;

            if (document.visibilityState === 'visible') {
                // Page is now visible, verify connection health
                const now = Date.now();
                const inactiveTime = now - lastActivityRef.current;

                if (inactiveTime > 5000 ||
                    !watcherRef.current ||
                    watcherRef.current.readyState !== 1) {
                    console.log('Tab visible again, checking connection...');
                    reconnectWatcher();
                }
            }
        };

        document.addEventListener('visibilitychange', handleVisibilityChange);

        // Cleanup function that runs when component unmounts
        return () => {
            clearInterval(healthInterval);
            document.removeEventListener('visibilitychange', handleVisibilityChange);

            if (reconnectTimeoutRef.current) {
                clearTimeout(reconnectTimeoutRef.current);
            }

            // Just calling close on the watcher should clean everything up
            if (watcherRef.current) {
                watcherRef.current.close?.();
            }
        };
    }, [isAuthenticated]); // Add isAuthenticated as a dependency

    return <>{children}</>;
}
