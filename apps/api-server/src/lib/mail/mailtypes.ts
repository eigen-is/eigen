import type { ParsedMail } from "./mail-parser";

// Define the types we need since mailparser module might not be directly available
export interface AddressObject {
  name?: string;
  address: string;
}

export interface Attachment {
  filename: string;
  contentType: string;
  content: Buffer;
  size: number;
  contentId: string;
  messageId?: string;
}

export interface AttachmentCommon {
  filename: string;
  contentType: string;
  contentDisposition: string;
  checksum: string;
  size: number;
  headers: Map<string, string>;
  contentId?: string;
  cid?: string;
  related?: boolean;
}

export interface AttachmentStream extends AttachmentCommon {
  content: NodeJS.ReadableStream;
}


export type Email = ParsedMail & {
  _path: string;
  _filename: string;
  id: string;
  isRead: boolean;
  flags: string[];
};


