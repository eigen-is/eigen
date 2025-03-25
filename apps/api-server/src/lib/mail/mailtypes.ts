// Re-export all types from mail-parser
export * from "./mail-parser";

// Import ParsedMail for the Email type definition
import type { ParsedMail } from "./mail-parser";

// Define the Email type that extends ParsedMail with additional fields needed for maildir
export type Email = ParsedMail & {
  _path: string;      // Path to the mailbox containing the message
  _filename: string;  // Filename of the message
  id: string;         // Unique message ID
  isRead: boolean;    // Whether the message has been read
  flags: string[];    // IMAP flags for the message
};
