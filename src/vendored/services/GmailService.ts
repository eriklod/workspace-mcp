/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { google, gmail_v1 } from 'googleapis';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AuthManager } from '../auth/AuthManager';
import { logToFile } from '../utils/logger';
import { MimeHelper } from '../utils/MimeHelper';
import {
  GMAIL_SEARCH_MAX_RESULTS,
  GMAIL_BATCH_MODIFY_MAX_IDS,
  GMAIL_NO_LABEL_CHANGES_MESSAGE,
} from '../utils/constants';
import { gaxiosOptions } from '../utils/GaxiosConfig';
import { emailArraySchema, gmailAttachmentSchema } from '../utils/validation';
import { z, ZodError } from 'zod';
import { simpleParser } from 'mailparser';

// Extension to MIME type map for common file types
const EXTENSION_MIME_MAP: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
};

// Maximum total raw (pre-encoding) size for all attachments, checked against
// the bytes on disk. Gmail's 25MB limit applies to the entire MIME message,
// and base64 encoding inflates binary data by ~33%: 18MB of raw bytes becomes
// ~24MB after encoding, leaving ~1MB of headroom under the 25MB cap for
// message headers and body.
const MAX_TOTAL_ATTACHMENT_SIZE_BYTES = 18 * 1024 * 1024;

function assertWithinAttachmentSizeLimit(totalSize: number): void {
  if (totalSize > MAX_TOTAL_ATTACHMENT_SIZE_BYTES) {
    throw new Error(
      `Total attachment size (${(totalSize / 1024 / 1024).toFixed(2)}MB) exceeds the maximum allowed limit of ${MAX_TOTAL_ATTACHMENT_SIZE_BYTES / 1024 / 1024}MB.`,
    );
  }
}

function getMimeTypeFromExtension(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_MIME_MAP[ext] ?? 'application/octet-stream';
}

// Derived from the shared zod schema (also used for the MCP tool input in
// index.ts) so the runtime validation and this type cannot drift apart.
type AttachmentInput = z.infer<typeof gmailAttachmentSchema>;

// Type definitions for email parameters
type SendEmailParams = {
  to: string | string[];
  subject: string;
  body: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  isHtml?: boolean;
  threadId?: string;
};

type CreateDraftParams = SendEmailParams & {
  attachments?: AttachmentInput[];
};

type ForwardParams = {
  messageId: string;
  to: string | string[];
  subject?: string;
  body?: string;
  includeOriginalText?: boolean;
};

const FORWARD_SEPARATOR = '---------- Doorgestuurd bericht ----------';

// Prefix the original subject with "Fwd: " unless it already carries a
// forward marker, so forwarding a forward does not stack "Fwd: Fwd: ".
export function forwardSubject(original: string | undefined): string {
  const subject = (original ?? '').trim();
  return /^(fwd?|fw)\s*:/i.test(subject) ? subject : `Fwd: ${subject}`;
}

// Accepts one address, a comma-separated string, or an array of addresses.
function splitRecipients(to: string | string[]): string[] {
  const list = Array.isArray(to) ? to : to.split(',');
  return list.map((addr) => addr.trim()).filter((addr) => addr.length > 0);
}

interface GmailAttachment {
  filename: string | null | undefined;
  mimeType: string | null | undefined;
  attachmentId: string | null | undefined;
  size: number | null | undefined;
}

// Inline attachment rendering for remote callers, which have no access to the
// server's filesystem. Text-like types come back as text, PDFs as extracted text
// (falling back to base64 when extraction fails), everything else as base64.
const INLINE_TEXT_LIMIT = 200_000;

function isTextLike(mimeType: string, filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  return (
    mimeType.startsWith('text/') ||
    /[/+](json|xml|csv|yaml|x-yaml)$/i.test(mimeType) ||
    ['.txt', '.csv', '.tsv', '.json', '.xml', '.md', '.yaml', '.yml', '.ics', '.log'].includes(ext)
  );
}

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= INLINE_TEXT_LIMIT) return { text, truncated: false };
  return { text: text.slice(0, INLINE_TEXT_LIMIT), truncated: true };
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

export async function renderAttachmentInline(
  buffer: Buffer,
  part: { attachmentId: string; filename: string; mimeType: string },
): Promise<Record<string, unknown>> {
  const base = {
    attachmentId: part.attachmentId,
    filename: part.filename,
    mimeType: part.mimeType,
    size: buffer.length,
  };
  const isPdf =
    part.mimeType === 'application/pdf' ||
    path.extname(part.filename).toLowerCase() === '.pdf';
  if (isPdf) {
    try {
      const { text, truncated } = truncate(await extractPdfText(buffer));
      if (text.trim().length > 0) {
        return { ...base, encoding: 'text', source: 'pdf-text', text, truncated };
      }
    } catch (error) {
      logToFile(
        `PDF text extraction failed for ${part.filename}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return {
      ...base,
      encoding: 'base64',
      note: 'No extractable text (scanned PDF or extraction failed); content is base64.',
      data: buffer.toString('base64'),
    };
  }
  if (isTextLike(part.mimeType, part.filename)) {
    const { text, truncated } = truncate(buffer.toString('utf-8'));
    return { ...base, encoding: 'text', text, truncated };
  }
  return { ...base, encoding: 'base64', data: buffer.toString('base64') };
}

export class GmailService {
  constructor(private authManager: AuthManager) {}

  private async getGmailClient(): Promise<gmail_v1.Gmail> {
    const auth = await this.authManager.getAuthenticatedClient();
    const options = { ...gaxiosOptions, auth };
    return google.gmail({ version: 'v1', ...options });
  }

  /**
   * Helper method to handle errors consistently across all methods
   */
  private handleError(error: unknown, context: string) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logToFile(`Error during ${context}: ${errorMessage}`);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ error: errorMessage }),
        },
      ],
    };
  }

  public search = async ({
    query,
    maxResults = GMAIL_SEARCH_MAX_RESULTS,
    pageToken,
    labelIds,
    includeSpamTrash = false,
  }: {
    query?: string;
    maxResults?: number;
    pageToken?: string;
    labelIds?: string[];
    includeSpamTrash?: boolean;
  }) => {
    try {
      logToFile(`Gmail search - query: ${query}, maxResults: ${maxResults}`);

      const gmail = await this.getGmailClient();
      const response = await gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults,
        pageToken,
        labelIds,
        includeSpamTrash,
      });

      const messages = response.data.messages || [];
      const nextPageToken = response.data.nextPageToken;
      const resultSizeEstimate = response.data.resultSizeEstimate;

      logToFile(
        `Found ${messages.length} messages, estimated total: ${resultSizeEstimate}`,
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                messages: messages.map((msg) => ({
                  id: msg.id,
                  threadId: msg.threadId,
                })),
                nextPageToken,
                resultSizeEstimate,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return this.handleError(error, 'gmail.search');
    }
  };

  public get = async ({
    messageId,
    format = 'full',
  }: {
    messageId: string;
    format?: 'minimal' | 'full' | 'raw' | 'metadata';
  }) => {
    try {
      logToFile(`Getting message ${messageId} with format: ${format}`);

      const gmail = await this.getGmailClient();
      const response = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format,
      });

      const message = response.data;

      // Extract useful information based on format
      if (format === 'metadata' || format === 'full') {
        const headers = message.payload?.headers || [];
        const getHeader = (name: string) =>
          headers.find((h) => h.name === name)?.value;

        const subject = getHeader('Subject');
        const from = getHeader('From');
        const to = getHeader('To');
        const date = getHeader('Date');

        // Extract body and attachments for full format
        let body = '';
        let attachments: GmailAttachment[] = [];
        if (format === 'full' && message.payload) {
          const result = this.extractAttachmentsAndBody(message.payload);
          body = result.body;
          attachments = result.attachments;
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  id: message.id,
                  threadId: message.threadId,
                  labelIds: message.labelIds,
                  snippet: message.snippet,
                  subject,
                  from,
                  to,
                  date,
                  body: body || message.snippet,
                  attachments: attachments,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(message, null, 2),
          },
        ],
      };
    } catch (error) {
      return this.handleError(error, 'gmail.get');
    }
  };

  /**
   * Find one attachment part of a message by attachmentId or filename. Returns the
   * part's attachmentId, filename and mimeType so the download can label its result.
   */
  private async resolveAttachment(
    gmail: gmail_v1.Gmail,
    messageId: string,
    attachmentId?: string,
    filename?: string,
  ): Promise<{ attachmentId: string; filename: string; mimeType: string }> {
    const response = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });
    const { attachments } = this.extractAttachmentsAndBody(
      response.data.payload ?? {},
    );
    const match = attachments.find((a) =>
      attachmentId
        ? a.attachmentId === attachmentId
        : filename !== undefined &&
          (a.filename ?? '').toLowerCase() === filename.toLowerCase(),
    );
    if (!match || !match.attachmentId) {
      const available = attachments
        .map((a) => `${a.filename ?? '(no name)'} [${a.attachmentId ?? '?'}]`)
        .join(', ');
      throw new Error(
        `Attachment not found on message ${messageId}. Available: ${available || 'none'}.`,
      );
    }
    return {
      attachmentId: match.attachmentId,
      filename: match.filename ?? 'attachment',
      mimeType: match.mimeType ?? 'application/octet-stream',
    };
  }

  /**
   * Download one attachment. Without `localPath` (the only mode over HTTP) the
   * content comes back inline: text for text-like types, extracted text for PDFs,
   * base64 otherwise. With `localPath` (stdio only) the bytes are written to disk.
   */
  public downloadAttachment = async ({
    messageId,
    attachmentId,
    filename,
    localPath,
  }: {
    messageId: string;
    attachmentId?: string;
    filename?: string;
    localPath?: string;
  }) => {
    try {
      if (!attachmentId && !filename) {
        throw new Error(
          'Provide attachmentId or filename (both come from gmail.get with format "full").',
        );
      }
      if (localPath !== undefined && !path.isAbsolute(localPath)) {
        throw new Error('localPath must be an absolute path.');
      }

      const gmail = await this.getGmailClient();
      const part = await this.resolveAttachment(
        gmail,
        messageId,
        attachmentId,
        filename,
      );
      logToFile(
        `Downloading attachment ${part.attachmentId} (${part.filename}) from message ${messageId}`,
      );

      const response = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId: messageId,
        id: part.attachmentId,
      });

      const data = response.data.data;
      if (!data) {
        throw new Error('Attachment data is empty');
      }
      const buffer = Buffer.from(data, 'base64url');

      if (localPath !== undefined) {
        await fs.mkdir(path.dirname(localPath), { recursive: true });
        await fs.writeFile(localPath, buffer);
        logToFile(`Attachment downloaded successfully to ${localPath}`);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                message: `Attachment downloaded successfully to ${localPath}`,
                path: localPath,
                filename: part.filename,
                mimeType: part.mimeType,
                size: buffer.length,
              }),
            },
          ],
        };
      }

      const result = await renderAttachmentInline(buffer, part);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return this.handleError(error, 'gmail.downloadAttachment');
    }
  };

  public modify = async ({
    messageId,
    addLabelIds = [],
    removeLabelIds = [],
  }: {
    messageId: string;
    addLabelIds?: string[];
    removeLabelIds?: string[];
  }) => {
    try {
      logToFile(
        `Modifying message ${messageId} with addLabelIds: ${addLabelIds}, removeLabelIds: ${removeLabelIds}`,
      );

      const gmail = await this.getGmailClient();
      const response = await gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: {
          addLabelIds,
          removeLabelIds,
        },
      });

      const message = response.data;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(message, null, 2),
          },
        ],
      };
    } catch (error) {
      return this.handleError(error, 'gmail.modify');
    }
  };

  public batchModify = async ({
    messageIds,
    addLabelIds = [],
    removeLabelIds = [],
  }: {
    messageIds: string[];
    addLabelIds?: string[];
    removeLabelIds?: string[];
  }) => {
    try {
      if (addLabelIds.length === 0 && removeLabelIds.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                status: 'noop',
                message: GMAIL_NO_LABEL_CHANGES_MESSAGE,
              }),
            },
          ],
        };
      }

      if (messageIds.length > GMAIL_BATCH_MODIFY_MAX_IDS) {
        throw new Error(
          `Too many message IDs. Maximum is ${GMAIL_BATCH_MODIFY_MAX_IDS}, got ${messageIds.length}.`,
        );
      }

      logToFile(
        `Batch modifying ${messageIds.length} messages with addLabelIds: ${addLabelIds}, removeLabelIds: ${removeLabelIds}`,
      );

      const gmail = await this.getGmailClient();
      await gmail.users.messages.batchModify({
        userId: 'me',
        requestBody: {
          ids: messageIds,
          addLabelIds,
          removeLabelIds,
        },
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                modifiedCount: messageIds.length,
                addLabelIds,
                removeLabelIds,
                status: 'success',
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return this.handleError(error, 'gmail.batchModify');
    }
  };

  public modifyThread = async ({
    threadId,
    addLabelIds = [],
    removeLabelIds = [],
  }: {
    threadId: string;
    addLabelIds?: string[];
    removeLabelIds?: string[];
  }) => {
    try {
      if (addLabelIds.length === 0 && removeLabelIds.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                status: 'noop',
                message: GMAIL_NO_LABEL_CHANGES_MESSAGE,
              }),
            },
          ],
        };
      }

      logToFile(
        `Modifying thread ${threadId} with addLabelIds: ${addLabelIds}, removeLabelIds: ${removeLabelIds}`,
      );

      const gmail = await this.getGmailClient();
      const response = await gmail.users.threads.modify({
        userId: 'me',
        id: threadId,
        requestBody: {
          addLabelIds,
          removeLabelIds,
        },
      });

      const thread = response.data;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(thread, null, 2),
          },
        ],
      };
    } catch (error) {
      return this.handleError(error, 'gmail.modifyThread');
    }
  };

  /**
   * Validates recipient email addresses shared by send and createDraft.
   * Returns a structured error response when validation fails, or null when
   * all provided addresses are valid.
   */
  private validateEmailAddresses({
    to,
    cc,
    bcc,
    replyTo,
  }: {
    to: string | string[];
    cc?: string | string[];
    bcc?: string | string[];
    replyTo?: string;
  }) {
    try {
      emailArraySchema.parse(to);
      if (cc) emailArraySchema.parse(cc);
      if (bcc) emailArraySchema.parse(bcc);
      if (replyTo) emailArraySchema.parse(replyTo);
      return null;
    } catch (error) {
      // Only Zod validation failures mean the addresses were malformed;
      // anything else is an internal fault and must not be mislabeled as an
      // invalid-email error, so rethrow it for the caller's generic handler.
      if (!(error instanceof ZodError)) {
        throw error;
      }
      logToFile(`Rejected invalid email address input: ${error.message}`);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: 'Invalid email address format',
              details: error.message,
            }),
          },
        ],
      };
    }
  }

  // Looks up the last message of a thread so a new message can carry the
  // In-Reply-To / References headers that make it a real reply (Gmail's own
  // threading needs these, not just the threadId on the request body).
  private async resolveReplyHeaders(
    gmail: gmail_v1.Gmail,
    threadId: string | undefined,
  ): Promise<{ inReplyTo?: string; references?: string }> {
    if (!threadId) {
      return {};
    }
    try {
      const threadResponse = await gmail.users.threads.get({
        userId: 'me',
        id: threadId,
        format: 'metadata',
        metadataHeaders: ['Message-ID', 'References'],
      });
      const messages = threadResponse.data.messages || [];
      if (messages.length > 0) {
        const lastMessage = messages[messages.length - 1];
        const headers = lastMessage.payload?.headers || [];
        const messageIdHeader = headers.find(
          (h) => h.name?.toLowerCase() === 'message-id',
        );
        const referencesHeader = headers.find(
          (h) => h.name?.toLowerCase() === 'references',
        );
        if (messageIdHeader?.value) {
          const previousReferences = referencesHeader?.value || '';
          return {
            inReplyTo: messageIdHeader.value,
            references: previousReferences
              ? `${previousReferences} ${messageIdHeader.value}`
              : messageIdHeader.value,
          };
        }
      }
    } catch (threadError) {
      logToFile(
        `Warning: Could not fetch thread ${threadId} for reply headers: ${threadError}`,
      );
    }
    return {};
  }

  public send = async ({
    to,
    subject,
    body,
    cc,
    bcc,
    replyTo,
    isHtml = false,
    threadId,
  }: SendEmailParams) => {
    try {
      // Validate email addresses
      const validationError = this.validateEmailAddresses({
        to,
        cc,
        bcc,
        replyTo,
      });
      if (validationError) {
        return validationError;
      }

      logToFile(`Sending email to: ${to}, subject: ${subject}`);

      const gmail = await this.getGmailClient();

      // If threadId is provided, send as a reply inside that thread
      const { inReplyTo, references } = await this.resolveReplyHeaders(
        gmail,
        threadId,
      );

      // Create MIME message
      const mimeMessage = MimeHelper.createMimeMessage({
        to: Array.isArray(to) ? to.join(', ') : to,
        subject,
        body,
        cc: cc ? (Array.isArray(cc) ? cc.join(', ') : cc) : undefined,
        bcc: bcc ? (Array.isArray(bcc) ? bcc.join(', ') : bcc) : undefined,
        replyTo,
        isHtml,
        inReplyTo,
        references,
      });

      const response = await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: mimeMessage,
          ...(threadId && { threadId }),
        },
      });

      logToFile(`Email sent successfully: ${response.data.id}`);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                id: response.data.id,
                threadId: response.data.threadId,
                labelIds: response.data.labelIds,
                status: 'sent',
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return this.handleError(error, 'gmail.send');
    }
  };

  public createDraft = async ({
    to,
    subject,
    body,
    cc,
    bcc,
    replyTo,
    isHtml = false,
    threadId,
    attachments,
  }: CreateDraftParams) => {
    try {
      // Validate email addresses
      const validationError = this.validateEmailAddresses({
        to,
        cc,
        bcc,
        replyTo,
      });
      if (validationError) {
        return validationError;
      }

      logToFile(`Creating draft - to: ${to}, subject: ${subject}`);

      const gmail = await this.getGmailClient();

      // If threadId is provided, fetch the last message to get reply headers
      const { inReplyTo, references } = await this.resolveReplyHeaders(
        gmail,
        threadId,
      );

      // Create MIME message
      let mimeMessage: string;

      if (attachments && attachments.length > 0) {
        // Validate all paths are absolute and check file sizes before reading anything
        const attachmentSizes = await Promise.all(
          attachments.map(async (att) => {
            if (!path.isAbsolute(att.filePath)) {
              throw new Error(
                `Attachment filePath must be an absolute path: ${att.filePath}`,
              );
            }

            let stats;
            try {
              stats = await fs.stat(att.filePath);
            } catch (statError) {
              throw new Error(
                `Could not access attachment file ${att.filePath}: ${statError instanceof Error ? statError.message : String(statError)}`,
              );
            }

            if (!stats.isFile()) {
              throw new Error(`Attachment path is not a file: ${att.filePath}`);
            }

            return stats.size;
          }),
        );
        const totalSize = attachmentSizes.reduce((sum, size) => sum + size, 0);
        assertWithinAttachmentSizeLimit(totalSize);

        // Read each file from disk
        const resolvedAttachments = await Promise.all(
          attachments.map(async (att) => {
            let content: Buffer;
            try {
              content = await fs.readFile(att.filePath);
            } catch (readError) {
              throw new Error(
                `Could not read attachment file ${att.filePath}: ${readError instanceof Error ? readError.message : String(readError)}`,
              );
            }
            return {
              // `||` (not `??`) so empty strings also fall back to defaults —
              // an empty filename or MIME type is invalid in MIME headers.
              filename: att.filename || path.basename(att.filePath),
              content,
              contentType:
                att.mimeType || getMimeTypeFromExtension(att.filePath),
            };
          }),
        );

        // The stat-based check above is a pre-flight guard so oversized files
        // are rejected before being read into memory, but a file can change
        // between stat and read (TOCTOU). Re-check against the bytes actually
        // read so the size cap is authoritative.
        assertWithinAttachmentSizeLimit(
          resolvedAttachments.reduce((sum, att) => sum + att.content.length, 0),
        );

        mimeMessage = MimeHelper.createMimeMessageWithAttachments({
          to: Array.isArray(to) ? to.join(', ') : to,
          subject,
          body,
          cc: cc ? (Array.isArray(cc) ? cc.join(', ') : cc) : undefined,
          bcc: bcc ? (Array.isArray(bcc) ? bcc.join(', ') : bcc) : undefined,
          replyTo,
          inReplyTo,
          references,
          isHtml,
          attachments: resolvedAttachments,
        });
      } else {
        mimeMessage = MimeHelper.createMimeMessage({
          to: Array.isArray(to) ? to.join(', ') : to,
          subject,
          body,
          cc: cc ? (Array.isArray(cc) ? cc.join(', ') : cc) : undefined,
          bcc: bcc ? (Array.isArray(bcc) ? bcc.join(', ') : bcc) : undefined,
          replyTo,
          isHtml,
          inReplyTo,
          references,
        });
      }

      const response = await gmail.users.drafts.create({
        userId: 'me',
        requestBody: {
          message: {
            raw: mimeMessage,
            ...(threadId && { threadId }),
          },
        },
      });

      logToFile(`Draft created successfully: ${response.data.id}`);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                id: response.data.id,
                message: {
                  id: response.data.message?.id,
                  threadId: response.data.message?.threadId,
                  labelIds: response.data.message?.labelIds,
                },
                status: 'draft_created',
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return this.handleError(error, 'gmail.createDraft');
    }
  };

  /**
   * Forward an existing message as a new conversation. The original is
   * fetched raw and parsed, its attachments are carried over (inline images
   * that belong to the HTML body are dropped), and a fresh multipart/mixed
   * message is sent. No threadId: at the recipient this is a new thread.
   */
  public forward = async ({
    messageId,
    to,
    subject,
    body,
    includeOriginalText = true,
  }: ForwardParams) => {
    try {
      if (!messageId) {
        throw new Error(
          'messageId is required for forward (the id of the message to forward, from gmail.search or gmail.get).',
        );
      }
      const recipients = to ? splitRecipients(to) : [];
      if (recipients.length === 0) {
        throw new Error(
          'to is required for forward (one address or a comma-separated list).',
        );
      }
      const validationError = this.validateEmailAddresses({ to: recipients });
      if (validationError) {
        return validationError;
      }

      const gmail = await this.getGmailClient();
      logToFile(`Forwarding message ${messageId} to: ${recipients.join(', ')}`);

      const original = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'raw',
      });
      const raw = original.data.raw;
      if (!raw) {
        throw new Error(`Message ${messageId} has no raw content.`);
      }
      const parsed = await simpleParser(Buffer.from(raw, 'base64url'));

      const attachments = parsed.attachments
        .filter((att) => !att.related)
        .map((att) => ({
          filename: att.filename || 'attachment',
          content: att.content,
          contentType: att.contentType || 'application/octet-stream',
        }));
      assertWithinAttachmentSizeLimit(
        attachments.reduce((sum, att) => sum + att.content.length, 0),
      );

      const finalSubject = subject || forwardSubject(parsed.subject);

      const bodyParts: string[] = [];
      if (body) {
        bodyParts.push(body, '');
      }
      if (includeOriginalText) {
        const addressText = (
          value: typeof parsed.to | typeof parsed.from,
        ): string =>
          value === undefined
            ? ''
            : (Array.isArray(value) ? value : [value])
                .flatMap((v) => v.value)
                .map((a) =>
                  a.name && a.address
                    ? `${a.name} <${a.address}>`
                    : a.address || a.name || '',
                )
                .join(', ');
        const rawDate = parsed.headerLines.find(
          (line) => line.key === 'date',
        )?.line;
        const date = rawDate
          ? rawDate.replace(/^date:\s*/i, '')
          : (parsed.date?.toUTCString() ?? '');
        bodyParts.push(
          FORWARD_SEPARATOR,
          `Van: ${addressText(parsed.from)}`,
          `Datum: ${date}`,
          `Onderwerp: ${parsed.subject ?? ''}`,
          `Aan: ${addressText(parsed.to)}`,
          '',
          parsed.text ?? '',
        );
      }

      const mimeMessage = MimeHelper.createMimeMessageWithAttachments({
        to: recipients.join(', '),
        subject: finalSubject,
        body: bodyParts.join('\n'),
        attachments,
      });

      const response = await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: mimeMessage,
        },
      });

      logToFile(`Message forwarded successfully: ${response.data.id}`);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                id: response.data.id,
                threadId: response.data.threadId,
                to: recipients.join(', '),
                subject: finalSubject,
                attachments: attachments.map((att) => ({
                  filename: att.filename,
                  mimeType: att.contentType,
                  size: att.content.length,
                })),
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return this.handleError(error, 'gmail.forward');
    }
  };

  public sendDraft = async ({ draftId }: { draftId: string }) => {
    try {
      logToFile(`Sending draft: ${draftId}`);

      const gmail = await this.getGmailClient();
      const response = await gmail.users.drafts.send({
        userId: 'me',
        requestBody: {
          id: draftId,
        },
      });

      logToFile(`Draft sent successfully: ${response.data.id}`);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                id: response.data.id,
                threadId: response.data.threadId,
                labelIds: response.data.labelIds,
                status: 'sent',
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return this.handleError(error, 'gmail.sendDraft');
    }
  };

  public listLabels = async () => {
    try {
      logToFile(`Listing Gmail labels`);

      const gmail = await this.getGmailClient();
      const response = await gmail.users.labels.list({
        userId: 'me',
      });

      const labels = response.data.labels || [];

      logToFile(`Found ${labels.length} labels`);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                labels: labels.map((label) => ({
                  id: label.id,
                  name: label.name,
                  type: label.type,
                  messageListVisibility: label.messageListVisibility,
                  labelListVisibility: label.labelListVisibility,
                })),
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return this.handleError(error, 'gmail.listLabels');
    }
  };

  public createLabel = async ({
    name,
    labelListVisibility = 'labelShow',
    messageListVisibility = 'show',
  }: {
    name: string;
    labelListVisibility?: 'labelShow' | 'labelHide' | 'labelShowIfUnread';
    messageListVisibility?: 'show' | 'hide';
  }) => {
    try {
      logToFile(`Creating Gmail label: ${name}`);

      const gmail = await this.getGmailClient();

      const response = await gmail.users.labels.create({
        userId: 'me',
        requestBody: {
          name,
          labelListVisibility,
          messageListVisibility,
        },
      });

      const label = response.data;

      logToFile(`Created label: ${label.name} with id: ${label.id}`);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                id: label.id,
                name: label.name,
                type: label.type,
                messageListVisibility: label.messageListVisibility,
                labelListVisibility: label.labelListVisibility,
                status: 'created',
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      return this.handleError(error, 'gmail.createLabel');
    }
  };

  private extractAttachmentsAndBody(
    payload: gmail_v1.Schema$MessagePart,
    result: { body: string; attachments: GmailAttachment[] } = {
      body: '',
      attachments: [],
    },
  ) {
    if (!payload) return result;

    // Handle body parts
    if (payload.body?.data) {
      // If it's the main body (and not an attachment)
      if (!payload.filename || !payload.body.attachmentId) {
        if (payload.mimeType?.startsWith('text/')) {
          // Prioritize plain text over HTML for direct body extraction
          if (!result.body || payload.mimeType === 'text/plain') {
            result.body = Buffer.from(payload.body.data, 'base64').toString(
              'utf-8',
            );
          }
        }
      }
    }

    // Handle attachments and recursive parts
    if (payload.filename && payload.body?.attachmentId) {
      result.attachments.push({
        filename: payload.filename,
        mimeType: payload.mimeType,
        attachmentId: payload.body.attachmentId,
        size: payload.body.size, // Size in bytes
      });
    }

    if (payload.parts) {
      for (const part of payload.parts) {
        this.extractAttachmentsAndBody(part, result);
      }
    }
    return result;
  }
}
