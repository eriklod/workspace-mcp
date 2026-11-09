import { simpleParser } from 'mailparser'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { messagesGet, messagesSend } = vi.hoisted(() => ({
  messagesGet: vi.fn(),
  messagesSend: vi.fn()
}))

vi.mock('../../auth/credential-state.js', () => ({
  getAuth: () => ({ getAuthenticatedClient: async () => ({}) })
}))

vi.mock('googleapis', () => ({
  google: { gmail: () => ({ users: { messages: { get: messagesGet, send: messagesSend } } }) }
}))

import { AuthManager } from '../auth/AuthManager.js'
import { forwardSubject, GmailService } from './GmailService.js'

const PDF_BYTES = Buffer.from('%PDF-1.4\n% fake factuur 1043\n%%EOF\n')

function rawOriginal(): string {
  const boundary = 'orig_boundary_123'
  const pdfB64 = PDF_BYTES.toString('base64')
  const lines = [
    'From: Leverancier <facturen@leverancier.nl>',
    'To: Erik <erik@example.com>',
    'Date: Mon, 2 Nov 2026 10:15:00 +0100',
    'Subject: Factuur 1043',
    'Message-ID: <orig-1043@leverancier.nl>',
    'In-Reply-To: <vraag-1042@example.com>',
    'References: <start-1041@example.com> <vraag-1042@example.com>',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Beste Erik, in de bijlage de factuur.',
    `--${boundary}`,
    'Content-Type: application/pdf; name="factuur-1043.pdf"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="factuur-1043.pdf"',
    '',
    pdfB64,
    `--${boundary}--`,
    ''
  ]
  return Buffer.from(lines.join('\r\n')).toString('base64url')
}

async function sentMessage() {
  const raw = messagesSend.mock.calls[0][0].requestBody.raw as string
  return simpleParser(Buffer.from(raw, 'base64url'))
}

function parseResult(result: { content: { text: string }[] }) {
  return JSON.parse(result.content[0].text)
}

describe('GmailService.forward', () => {
  let service: GmailService

  beforeEach(() => {
    messagesGet.mockReset()
    messagesSend.mockReset()
    messagesGet.mockResolvedValue({ data: { id: 'orig-1', threadId: 'thread-orig', raw: rawOriginal() } })
    messagesSend.mockResolvedValue({ data: { id: 'new-1', threadId: 'thread-orig' } })
    service = new GmailService(new AuthManager(['scope']))
  })

  it('forwards the message with the pdf attachment, To, Fwd subject and body', async () => {
    const result = await service.forward({
      messageId: 'orig-1',
      to: 'boekhouding@example.com, accountant@example.com',
      body: 'Zie bijgaande factuur.'
    })

    expect(messagesGet).toHaveBeenCalledWith({ userId: 'me', id: 'orig-1', format: 'raw' })
    const request = messagesSend.mock.calls[0][0]
    expect(request.userId).toBe('me')
    expect(request.requestBody.threadId).toBe('thread-orig')

    const sent = await sentMessage()
    expect(sent.subject).toBe('Fwd: Factuur 1043')
    expect(sent.to && !Array.isArray(sent.to) ? sent.to.text : '').toBe(
      'boekhouding@example.com, accountant@example.com'
    )
    expect(sent.inReplyTo).toBe('<orig-1043@leverancier.nl>')
    expect(sent.references).toEqual([
      '<start-1041@example.com>',
      '<vraag-1042@example.com>',
      '<orig-1043@leverancier.nl>'
    ])
    expect(sent.text).toContain('Zie bijgaande factuur.')
    expect(sent.text).toContain('---------- Doorgestuurd bericht ----------')
    expect(sent.text).toContain('Van: Leverancier <facturen@leverancier.nl>')
    expect(sent.text).toContain('Datum: Mon, 2 Nov 2026 10:15:00 +0100')
    expect(sent.text).toContain('Onderwerp: Factuur 1043')
    expect(sent.text).toContain('Aan: Erik <erik@example.com>')
    expect(sent.text).toContain('Beste Erik, in de bijlage de factuur.')
    expect(sent.attachments).toHaveLength(1)
    expect(sent.attachments[0].filename).toBe('factuur-1043.pdf')
    expect(sent.attachments[0].contentType).toBe('application/pdf')
    expect(sent.attachments[0].content.equals(PDF_BYTES)).toBe(true)

    expect(parseResult(result)).toEqual({
      id: 'new-1',
      threadId: 'thread-orig',
      to: 'boekhouding@example.com, accountant@example.com',
      subject: 'Fwd: Factuur 1043',
      attachments: [{ filename: 'factuur-1043.pdf', mimeType: 'application/pdf', size: PDF_BYTES.length }]
    })
  })

  it('sends a standalone message with inThread: false', async () => {
    messagesSend.mockResolvedValue({ data: { id: 'new-2', threadId: 'thread-new' } })
    const result = await service.forward({ messageId: 'orig-1', to: 'a@example.com', inThread: false })

    const request = messagesSend.mock.calls[0][0]
    expect(request.requestBody).not.toHaveProperty('threadId')
    const raw = Buffer.from(request.requestBody.raw, 'base64url').toString()
    expect(raw).not.toMatch(/^In-Reply-To:/im)
    expect(raw).not.toMatch(/^References:/im)
    const sent = await sentMessage()
    expect(sent.subject).toBe('Fwd: Factuur 1043')
    expect(sent.text).toContain('---------- Doorgestuurd bericht ----------')
    expect(sent.attachments).toHaveLength(1)
    expect(parseResult(result).threadId).toBe('thread-new')
  })

  it('omits the original text when includeOriginalText is false and honours a custom subject', async () => {
    await service.forward({
      messageId: 'orig-1',
      to: 'a@example.com',
      subject: 'Ter info',
      includeOriginalText: false
    })
    const sent = await sentMessage()
    expect(sent.subject).toBe('Ter info')
    expect(sent.text ?? '').not.toContain('Doorgestuurd bericht')
    expect(sent.attachments).toHaveLength(1)
  })

  it('rejects a missing messageId or to without calling Gmail', async () => {
    const noId = parseResult(await service.forward({ messageId: '', to: 'a@example.com' }))
    expect(noId.error).toMatch(/messageId is required/)
    const noTo = parseResult(await service.forward({ messageId: 'orig-1', to: '' }))
    expect(noTo.error).toMatch(/to is required/)
    expect(messagesGet).not.toHaveBeenCalled()
    expect(messagesSend).not.toHaveBeenCalled()
  })

  it('rejects an invalid recipient address', async () => {
    const out = parseResult(await service.forward({ messageId: 'orig-1', to: 'not-an-address' }))
    expect(out.error).toBe('Invalid email address format')
    expect(messagesSend).not.toHaveBeenCalled()
  })

  it('passes the Gmail error through when the message does not exist', async () => {
    messagesGet.mockRejectedValue(new Error('Requested entity was not found.'))
    const out = parseResult(await service.forward({ messageId: 'missing', to: 'a@example.com' }))
    expect(out).toEqual({ error: 'Requested entity was not found.' })
    expect(messagesSend).not.toHaveBeenCalled()
  })
})

describe('forwardSubject', () => {
  it('prefixes Fwd: once', () => {
    expect(forwardSubject('Factuur')).toBe('Fwd: Factuur')
    expect(forwardSubject('Fwd: Factuur')).toBe('Fwd: Factuur')
    expect(forwardSubject('FW: Factuur')).toBe('FW: Factuur')
    expect(forwardSubject(undefined)).toBe('Fwd: ')
  })
})
