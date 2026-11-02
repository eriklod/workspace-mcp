# Gmail Tool

## Actions
- search
- get
- downloadAttachment
- modify
- batchModify
- modifyThread
- send
- createDraft
- sendDraft
- listLabels
- createLabel

## Parameters

- account (optional): email of the Google account to use; defaults to the primary account.
- threadId (optional, send/createDraft): reply inside an existing thread. The server reads the thread's last message and sets In-Reply-To/References, so the mail lands in the same conversation on both sides. Omit it for a new conversation.

## downloadAttachment

Fetches one attachment of a message. Identify it by `attachmentId` (preferred) or `filename`; both come from `gmail.get` with `format: "full"`, which lists `attachments: [{ filename, mimeType, attachmentId, size }]`.

Parameters:
- messageId (required)
- attachmentId or filename (one required)
- localPath (optional, local stdio only): absolute path to write the file to. Not offered over HTTP, since a remote client cannot read the server's disk.

Without `localPath` the content comes back inline as JSON:
- `encoding: "text"` with `text` for text-like attachments (txt, csv, json, xml, ...) and for PDFs (`source: "pdf-text"`, the extracted text; `truncated: true` past 200k characters)
- `encoding: "base64"` with `data` for everything else, and for PDFs without extractable text (scanned)

Always included: `attachmentId`, `filename`, `mimeType`, `size`.

Example:
```
{ "action": "get", "messageId": "18f...", "format": "full" }
{ "action": "downloadAttachment", "messageId": "18f...", "attachmentId": "ANGjdJ..." }
{ "action": "downloadAttachment", "messageId": "18f...", "filename": "factuur-2026-1043.pdf" }
```

## modify / batchModify / modifyThread

- modify: messageId + addLabelIds / removeLabelIds
- batchModify: messageIds (array) + addLabelIds / removeLabelIds — one call per mailbox (`account`)
- modifyThread: threadId + addLabelIds / removeLabelIds

Archiving is `removeLabelIds: ["INBOX"]`; marking read is `removeLabelIds: ["UNREAD"]`. Nothing is deleted by these actions.
