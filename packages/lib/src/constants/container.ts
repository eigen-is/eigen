// The folders inside an Eigen document's container that code finds by name: the files a document or a thread holds,
// and a collab document's comment threads. The server creates and sweeps them, and an editor or a chat room looks
// them up in the container's listing, so both sides spell them here.

export const CONTAINER_MEDIA_FOLDER = 'media';
// The folder of a document's comment threads, not the folder a user's own chats go in.
export const CONTAINER_CHAT_FOLDER = 'chat';
