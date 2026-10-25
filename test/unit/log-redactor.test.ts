import { describe, expect, it } from 'vitest'
import { createRedactor, redactableSecrets } from '../../src/main/logs/redactor'
import { MAX_LINE_BYTES, MIN_REDACTED_SECRET_LENGTH, REDACTION_MARKER } from '../../src/shared/logs/limits'

describe('redactor', () => {
  it('[spec:process-logs/secret-printed-by-process] replaces every exact occurrence of a secret value', () => {
    const r = createRedactor(['hunter2-token'])
    expect(r.redact('token=hunter2-token, again hunter2-token.', false)).toEqual({ text: `token=${REDACTION_MARKER}, again ${REDACTION_MARKER}.`, truncated: false })
    expect(r.redact('nothing here', false)).toEqual({ text: 'nothing here', truncated: false })
  })

  it('treats secret values literally (no pattern syntax) and replaces a containing secret as a whole', () => {
    const r = createRedactor(['a.b*', 'pass', 'password1'])
    expect(r.redact('axb a.b* password1 pass', false).text).toBe(`axb ${REDACTION_MARKER} ${REDACTION_MARKER} ${REDACTION_MARKER}`)
    expect(createRedactor(['$&$1']).redact('x $&$1 y', false).text).toBe(`x ${REDACTION_MARKER} y`)
  })

  it(`does not redact values shorter than ${MIN_REDACTED_SECRET_LENGTH} characters`, () => {
    const r = createRedactor(['abc', ''])
    expect(r.redact('abc abc', false).text).toBe('abc abc')
    expect(redactableSecrets({ env: [{ key: 'A', value: 'abc', secret: true }, { key: 'B', value: 'abcd', secret: true }, { key: 'C', value: 'public-value', secret: false }] })).toEqual(['abcd'])
  })

  it('redacts each line of a secret value that spans several lines (L6-02)', () => {
    const pem = '-----BEGIN KEY-----\r\nMIIBVwIBADANBg\nabc\n-----END KEY-----\n'
    const secrets = redactableSecrets({ env: [{ key: 'KEY', value: pem, secret: true }] })
    expect(secrets).toEqual(['-----BEGIN KEY-----', '-----END KEY-----', 'MIIBVwIBADANBg'])
    const r = createRedactor(secrets)
    expect(['-----BEGIN KEY-----', 'MIIBVwIBADANBg', 'abc'].map((line) => r.redact(line, false).text)).toEqual([REDACTION_MARKER, REDACTION_MARKER, 'abc'])
  })

  it('does not detect transformed, split, or partial values (documented limitation)', () => {
    const r = createRedactor(['hunter2-token'])
    expect(r.redact('HUNTER2-TOKEN', false).text).toBe('HUNTER2-TOKEN')
    expect(r.redact('hunter2-', false).text).toBe('hunter2-')
    expect(r.redact('aHVudGVyMi10b2tlbg==', false).text).toBe('aHVudGVyMi10b2tlbg==')
  })

  it('masks the cut-off start of a secret at the end of a truncated line', () => {
    const r = createRedactor(['hunter2-token'])
    expect(r.redact('prefix hunter2-to', true)).toEqual({ text: `prefix ${REDACTION_MARKER}`, truncated: true })
    // Shorter than the minimum: kept (at most MIN-1 characters of a secret can remain visible).
    expect(r.redact('prefix hun', true).text).toBe('prefix hun')
    // Only for truncated lines: a complete line that ends like a secret's start is not a secret.
    expect(r.redact('prefix hunter2-to', false).text).toBe('prefix hunter2-to')
  })

  it('keeps a redacted line within the line limit, marking it truncated when it had to be cut', () => {
    const r = createRedactor(['abcd'])
    const out = r.redact('abcd'.repeat(MAX_LINE_BYTES / 4), false)
    expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(MAX_LINE_BYTES)
    expect(out.truncated).toBe(true)
    expect(out.text).not.toContain('abcd')
  })
})
