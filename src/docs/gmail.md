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
