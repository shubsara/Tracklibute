/**
 * Raw Gmail REST API response shapes (v1). ONLY files in this folder may
 * import these. Everything leaving the folder is a provider-neutral domain
 * type from src/domain/email.
 */
export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailMessagePartBody {
  size?: number;
  /** base64url of the transfer-decoded part bytes. */
  data?: string;
  attachmentId?: string;
}

export interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: GmailMessagePartBody;
  parts?: GmailMessagePart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  /** Epoch milliseconds as a string. */
  internalDate?: string;
  payload?: GmailMessagePart;
}

export interface GmailMessageRef {
  id: string;
  threadId?: string;
  labelIds?: string[];
}

export interface GmailListMessagesResponse {
  messages?: GmailMessageRef[];
  nextPageToken?: string;
}

export interface GmailThread {
  id: string;
  historyId?: string;
  messages?: Array<Pick<GmailMessage, "id" | "internalDate" | "labelIds">>;
}

export interface GmailHistoryRecord {
  id: string;
  messagesAdded?: Array<{ message: GmailMessageRef }>;
  messagesDeleted?: Array<{ message: GmailMessageRef }>;
  labelsAdded?: Array<{ message: GmailMessageRef }>;
  labelsRemoved?: Array<{ message: GmailMessageRef }>;
}

export interface GmailHistoryResponse {
  history?: GmailHistoryRecord[];
  historyId?: string;
  nextPageToken?: string;
}

export interface GmailProfile {
  emailAddress: string;
  historyId: string;
}

export interface GmailErrorBody {
  error?: {
    code?: number;
    status?: string;
    errors?: Array<{ reason?: string }>;
    details?: Array<{ reason?: string }>;
  };
}
