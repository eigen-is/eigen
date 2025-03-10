/**
 * Core type definitions for the mail application
 */

/**
 * Email type representing an email message
 */
export interface Email {
  id: string;
  read: boolean;
  starred: boolean;
  from: {
    name: string;
    email: string;
  };
  subject: string;
  preview: string;
  hasAttachment: boolean;
  date: string;
  important?: boolean;
}
