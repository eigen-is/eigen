export type Notification = {
    id: string;
    type: string;
    actorEmail: string | null;
    title: string;
    body: string | null;
    tag: string | null;
    read: boolean;
    createdAt: Date;
};
