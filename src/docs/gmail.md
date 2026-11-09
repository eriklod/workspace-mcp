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
- forward
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

## forward

Forwards an existing message, attachments included, the way Gmail's own "Forward" does: in the sender's mailbox the forward lands in the same conversation as the original (Gmail shows the forward arrow there), while at the recipient it always starts a new conversation, since they never had that thread. The server sends it with the original's `threadId` and sets `In-Reply-To` to the original's Message-ID and `References` to the original's References plus that Message-ID. The original is read raw; every real attachment (pdf, docx, ...) is carried over with its original filename and content type. Inline images that belong to the HTML body are dropped.

Parameters:
- messageId (required): the message to forward
- to (required): one address or a comma-separated list
- subject (optional): defaults to "Fwd: " + the original subject (no second "Fwd:" when it already starts with one)
- body (optional): cover text placed above the forwarded message
- includeOriginalText (optional, default true): append the original plain text under `---------- Doorgestuurd bericht ----------` with Van/Datum/Onderwerp/Aan
- inThread (optional, default true): file the forward in the original's conversation in the sender's mailbox. `false` sends a standalone message: no threadId, no In-Reply-To/References

Result: `{ id, threadId, to, subject, attachments: [{ filename, mimeType, size }] }` (`threadId` equals the original's thread unless `inThread: false`).

Example:
```
{ "action": "forward", "messageId": "18f...", "to": "boekhouding@example.com", "body": "Zie bijgaande factuur." }
{ "action": "forward", "account": "werk@example.com", "messageId": "18f...", "to": "a@example.com, b@example.com", "includeOriginalText": false }
{ "action": "forward", "messageId": "18f...", "to": "a@example.com", "inThread": false }
```

## modify / batchModify / modifyThread

- modify: messageId + addLabelIds / removeLabelIds
- batchModify: messageIds (array) + addLabelIds / removeLabelIds — one call per mailbox (`account`)
- modifyThread: threadId + addLabelIds / removeLabelIds

Archiving is `removeLabelIds: ["INBOX"]`; marking read is `removeLabelIds: ["UNREAD"]`. Nothing is deleted by these actions.
