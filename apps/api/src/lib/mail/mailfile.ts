import type {AddressObject} from "@workspace/lib/types/mail"

export type EmlInput = {
    id: string
    from?: AddressObject
    to?: AddressObject
    cc?: AddressObject
    bcc?: AddressObject
    subject: string
    text: string
    html: string
    date?: Date
}

function formatAddresses(field: AddressObject | undefined): string {
    if (!field?.value || !Array.isArray(field.value)) return ''
    return field.value.map(addr => {
        if (addr.name && addr.address) return `${addr.name.trim()} <${addr.address.trim()}>`
        return addr.address || addr.name || ''
    }).join(', ')
}

export function createEmlContent(input: EmlInput): string {
    const date = input.date ? input.date.toUTCString() : new Date().toUTCString()

    const headers = [
        `From: ${formatAddresses(input.from)}`,
        `To: ${formatAddresses(input.to)}`,
        `CC: ${formatAddresses(input.cc)}`,
        `BCC: ${formatAddresses(input.bcc)}`,
        `Subject: ${input.subject || ''}`,
        `Date: ${date}`,
        `Message-ID: <${input.id}@eigen.local>`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/alternative; boundary="boundary-string"`
    ]

    const body = [
        ``,
        `--boundary-string`,
        `Content-Type: text/plain; charset=utf-8`,
        ``,
        input.text || '',
        ``,
        `--boundary-string`,
        `Content-Type: text/html; charset=utf-8`,
        ``,
        input.html || '',
        ``,
        `--boundary-string--`
    ]

    return [...headers, ...body].join('\r\n')
}
