import { describe, expect, it } from 'vitest'
import { renderAttachmentInline } from './GmailService'

const part = (filename: string, mimeType: string) => ({ attachmentId: 'att-1', filename, mimeType })

describe('renderAttachmentInline', () => {
  it('returns text for text-like attachments', async () => {
    const out = await renderAttachmentInline(Buffer.from('a,b\n1,2\n'), part('data.csv', 'text/csv'))
    expect(out).toMatchObject({ encoding: 'text', text: 'a,b\n1,2\n', truncated: false, size: 8 })
  })

  it('detects text-like types by extension when the mime type is generic', async () => {
    const out = await renderAttachmentInline(Buffer.from('{"a":1}'), part('x.json', 'application/octet-stream'))
    expect(out).toMatchObject({ encoding: 'text', text: '{"a":1}' })
  })

  it('returns base64 for binary attachments', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const out = await renderAttachmentInline(bytes, part('img.png', 'image/png'))
    expect(out).toMatchObject({ encoding: 'base64', data: bytes.toString('base64'), mimeType: 'image/png' })
  })

  it('extracts text from a PDF', async () => {
    const { PDFDocument, StandardFonts } = await import('pdf-lib')
    const doc = await PDFDocument.create()
    const page = doc.addPage()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    page.drawText('Factuur 1043 totaal EUR 1250,00 vervaldatum 30-11-2026', { x: 50, y: 700, size: 12, font })
    const pdf = Buffer.from(await doc.save())
    const out = await renderAttachmentInline(pdf, part('factuur.pdf', 'application/pdf'))
    expect(out.encoding).toBe('text')
    expect(out.source).toBe('pdf-text')
    expect(String(out.text)).toContain('Factuur 1043')
  })

  it('falls back to base64 for a PDF without text', async () => {
    const out = await renderAttachmentInline(Buffer.from('not a pdf'), part('scan.pdf', 'application/pdf'))
    expect(out).toMatchObject({ encoding: 'base64' })
  })
})
