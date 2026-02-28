export {useSSE} from './hooks/use-sse';
export type {
    SSEvent, SSEventBase, SSEventNotification, SSEventDrive, SSEventMail, SSEventChat
} from '@workspace/lib/types/sse';
export {SSEventType, isSSEventNotification} from '@workspace/lib/types/sse';
