import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fixture } from '../support/proc'
import { expect, expectNoOutboundConnections, launchVeydr, test } from './support/fixtures'
import { sh, withLogs } from './support/logs'

// Task group L6: the output view of a running command (spec: process-logs).

const OUTPUT_ID = '6f1f8a4c-3c1e-4e55-9a7b-0d6d1f2b9a01'
const TICK_ID = '0b7c9f7e-2a64-4d1a-8f0e-5f7d8c9b1a22'
const FLOOD_ID = '3d5e7f90-1a2b-4c3d-8e4f-5a6b7c8d9e0f'
const SECRET = 'tok-1234-secret'

// Everything a hostile or careless program might print: markup, colors, and sequences that would
// change the title, write the clipboard, add hyperlinks, or move the cursor in a terminal.
const OUTPUT_SCRIPT = [
  "printf 'plain out\\n'",
  "printf 'to stderr\\n' >&2",
  "printf 'crlf line\\r\\n'",
  'printf \'<script>window.__pwned=1</script><img src=x onerror="window.__pwned=2">\\n\'',
  "printf '\\033[31mred text\\033[0m normal\\n'",
  "printf '\\033]0;evil title\\007title gone\\n'",
  "printf '\\033]52;c;ZXZpbA==\\007clipboard gone\\n'",
  "printf '\\033]8;;https://example.invalid/\\033\\\\link text\\033]8;;\\033\\\\\\n'",
  "printf 'cursor\\033[2J\\033[H moved\\n'",
  "head -c 20000 /dev/zero | tr '\\000' y; echo",
  'printf \'secret is %s\\n\' "$API_TOKEN"',
  "printf 'partial without newline'",
  'exec sleep 60',
].join('; ')

/** Line numbers of copied `lines.mjs` output (each line starts with its zero-padded number). */
const seqsOf = (text: string): number[] => text.split('\n').map((line) => Number(line.slice(0, 9)))
const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i)

const outputCommand = sh(OUTPUT_ID, 'output', OUTPUT_SCRIPT, [{ key: 'API_TOKEN', value: SECRET, secret: true }])

test('[spec:process-logs/stream-distinguished] [spec:process-logs/markup-in-output] [spec:process-logs/color-codes] [spec:process-logs/dangerous-escape-sequences] shows output as text only, with stream, capture time, and styling', async () => {
  await withLogs([outputCommand], async ({ window, view, start, renderedTexts, copyEvents }) => {
    const title = await window.title()
    expect(await copyEvents()).toBe(0)
    await start(OUTPUT_ID, 'output')
    // The partial line appears although no newline follows it [spec:process-logs/progress-output-without-newline].
    await expect(view.getByTestId('log-text').filter({ hasText: 'partial without newline' })).toHaveCount(1)

    // Order across the two streams is best effort, so the standard error line is checked apart.
    const texts = await renderedTexts()
    expect(texts).toContain('to stderr')
    expect(texts.filter((text) => text !== 'to stderr')).toEqual([
      'plain out',
      'crlf line',
      '<script>window.__pwned=1</script><img src=x onerror="window.__pwned=2">',
      'red text normal',
      'title gone',
      'clipboard gone',
      'link text',
      'cursor moved',
      'y'.repeat(16 * 1024),
      'secret is [redacted]',
      'partial without newline',
    ])

    // Stream and capture time on every line.
    const stderrRow = view.getByTestId('log-line').filter({ hasText: 'to stderr' })
    await expect(stderrRow.getByTestId('log-stream')).toHaveText('err')
    await expect(view.getByTestId('log-line').filter({ hasText: 'plain out' }).getByTestId('log-stream')).toHaveText('out')
    for (const time of await view.locator('time').allTextContents()) expect(time).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/)

    // Markup stayed text: nothing was parsed or executed.
    expect(await window.evaluate(() => (globalThis as { __pwned?: number }).__pwned)).toBeUndefined()
    await expect(view.locator('script, img, a, iframe')).toHaveCount(0)
    // The color became styling.
    const red = view.getByTestId('log-text').filter({ hasText: 'red text' }).locator('span', { hasText: 'red text' })
    expect(await red.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(224, 108, 117)')
    // The other sequences had no effect.
    expect(await window.title()).toBe(title)
    // Nothing wrote the clipboard (the only way the window can is a copy event).
    expect(await copyEvents()).toBe(0)
    const html = await view.innerHTML()
    expect(html).not.toContain('\u001b')
    expect(html).not.toContain('evil title')
    expect(html).not.toContain('example.invalid')

    // [spec:process-logs/oversized-line] The long line keeps 16 KiB and is marked.
    await expect(view.getByTestId('log-truncated')).toHaveCount(1)
    await expect(view.getByTestId('log-truncated')).toHaveText('… truncated at 16 KiB')
  })
})

test('[spec:process-logs/secret-printed-by-process] a printed secret is redacted in the view and in copied text', async () => {
  await withLogs([outputCommand], async ({ window, view, start, copied }) => {
    await start(OUTPUT_ID, 'output')
    await expect(view.getByTestId('log-text').filter({ hasText: 'secret is [redacted]' })).toHaveCount(1)
    await expect(view.getByTestId('log-redaction-notice')).toContainText('transformed, split, or partial values are not detected')
    expect(await window.content()).not.toContain(SECRET)

    const text = await copied(() => view.getByRole('button', { name: 'Copy visible', exact: true }).click())
    expect(text).toContain('secret is [redacted]')
    expect(text).not.toContain(SECRET)
  })
})

test('[spec:process-logs/filter-by-text] [spec:process-logs/copy] [spec:process-logs/clear] filters by text and stream, copies plain text, and clears while capture continues', async () => {
  const script = "printf 'alpha \\033[1mneedle\\033[0m one\\n'; printf 'beta\\n'; sleep 0.3; printf 'gamma needle two\\n' >&2; i=0; while :; do sleep 0.3; i=$((i+1)); printf 'tick %s\\n' \"$i\"; done"
  await withLogs([sh(TICK_ID, 'ticker', script)], async ({ window, view, start, renderedTexts, copied }) => {
    await start(TICK_ID, 'ticker')
    await expect(view.getByTestId('log-text').filter({ hasText: 'tick 1' })).toHaveCount(1)

    const filter = view.getByLabel('Filter output', { exact: true })
    await filter.fill('NEEDLE')
    await expect.poll(renderedTexts).toEqual(['alpha needle one', 'gamma needle two'])
    await view.getByLabel('Streams shown', { exact: true }).selectOption('stderr')
    await expect.poll(renderedTexts).toEqual(['gamma needle two'])
    await view.getByLabel('Streams shown', { exact: true }).selectOption('stdout')
    await expect.poll(renderedTexts).toEqual(['alpha needle one'])

    // Copy: the visible lines as plain text (no escape sequences, no time or stream labels).
    expect(await copied(() => view.getByRole('button', { name: 'Copy visible', exact: true }).click())).toBe('alpha needle one')
    await expect(view.getByRole('status')).toHaveText('Copied 1 line.')

    await filter.fill('')
    await view.getByLabel('Streams shown', { exact: true }).selectOption('all')
    // Selecting text across rows copies whole lines as plain text.
    await view.getByTestId('log-text').filter({ hasText: 'beta' }).evaluate((beta) => {
      const alpha = [...document.querySelectorAll('.log-text')].find((el) => el.textContent === 'alpha needle one')
      if (alpha === undefined) throw new Error('no alpha row')
      const range = document.createRange()
      range.setStart(alpha.firstChild ?? alpha, 0)
      range.setEnd(beta.firstChild ?? beta, 1)
      const selection = document.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    })
    await view.getByTestId('log-scroll').focus()
    expect(await copied(() => window.keyboard.press('Control+C'))).toBe('alpha needle one\nbeta')
    // Select all (the whole window) copies every shown line, not only the rendered rows.
    await view.getByTestId('log-scroll').focus()
    await window.keyboard.press('Control+A')
    const all = await copied(() => window.keyboard.press('Control+C'))
    expect(all.split('\n').slice(0, 4)).toEqual(['alpha needle one', 'beta', 'gamma needle two', 'tick 1'])
    expect(all).not.toMatch(/Filter output|Output|redacted on a best-effort/)
    await window.evaluate(() => document.getSelection()?.removeAllRanges())

    // Clear asks first, then discards what is retained; new output still arrives.
    await view.getByRole('button', { name: 'Clear', exact: true }).click()
    const dialog = window.getByTestId('confirm-dialog')
    await expect(dialog).toContainText('Clear the output of ticker?')
    await dialog.getByRole('button', { name: 'Clear output', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(async () => (await renderedTexts()).some((t) => t.includes('needle'))).toBe(false)
    const before = await renderedTexts()
    expect(before.every((t) => t.startsWith('tick '))).toBe(true)
    await expect.poll(async () => (await renderedTexts()).length, { timeout: 5_000 }).toBeGreaterThan(before.length)

    // A reload shows only what is retained since the clear.
    await window.reload()
    await window.locator(`[data-command-id="${TICK_ID}"] .command-name`).click()
    await expect.poll(async () => (await renderedTexts()).length).toBeGreaterThan(0)
    expect((await renderedTexts()).every((t) => t.startsWith('tick '))).toBe(true)
  })
})

test('[spec:process-logs/pause-following] pauses following on scroll-up, indicates new output, and resumes', async () => {
  // 2,000 numbered lines, then one line every 200 ms.
  const script = `"$0" "$1" --rate 4000 --count 2000; i=0; while :; do sleep 0.2; i=$((i+1)); printf 'later %s\\n' "$i"; done`
  const stream = { id: TICK_ID, name: 'stream', execution: { mode: 'direct' as const, file: '/bin/sh', args: ['-c', script, process.execPath, fixture('lines')] } }
  await withLogs([stream], async ({ view, start, renderedTexts }) => {
    await start(TICK_ID, 'stream')
    const scroll = view.getByTestId('log-scroll')
    await expect.poll(async () => (await renderedTexts()).some((t) => t.startsWith('later '))).toBe(true)
    await expect(scroll).toHaveAttribute('data-following', 'true')

    // Scrolling up pauses following: the view stays where it is while capture continues.
    await scroll.evaluate((el) => {
      el.scrollTop = 0
    })
    await expect(scroll).toHaveAttribute('data-following', 'false')
    await expect(view.getByRole('button', { name: 'Follow', exact: true })).toBeVisible()
    const indicator = view.getByTestId('log-new-output')
    await expect(indicator).toHaveText(/^\d+ new lines? — follow$/)
    expect(await scroll.evaluate((el) => el.scrollTop)).toBe(0)
    expect((await renderedTexts())[0]).toMatch(/^000000001 /)

    await indicator.click()
    await expect(scroll).toHaveAttribute('data-following', 'true')
    await expect(indicator).toHaveCount(0)
    await expect.poll(() => scroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(20)

    // The Pause button pauses too.
    await view.getByRole('button', { name: 'Pause', exact: true }).click()
    await expect(scroll).toHaveAttribute('data-following', 'false')
    await expect(indicator).toBeVisible({ timeout: 5_000 })
  })
})

test('[spec:process-logs/slow-view] marks lines skipped while the window is busy, stays responsive, and fetches them on request', async () => {
  // 8,000 lines in total: all of them stay retained, so skipped lines can be fetched.
  const flood = { id: FLOOD_ID, name: 'flood', execution: { mode: 'direct' as const, file: process.execPath, args: [fixture('lines'), '--rate', '1000', '--seconds', '8'] } }
  await withLogs([flood], async ({ window, view, start, renderedTexts }) => {
    await start(FLOOD_ID, 'flood')
    await expect.poll(async () => (await renderedTexts()).length).toBeGreaterThan(0)
    // The renderer is busy for 2.5 s: it cannot handle or acknowledge batches meanwhile.
    await window.evaluate(() => {
      const until = Date.now() + 2_500
      while (Date.now() < until) {
        // busy
      }
    })
    // Only gaps are shown for a filter that matches no line.
    await view.getByLabel('Filter output', { exact: true }).fill('no line contains this')
    const gap = view.locator('[data-testid="log-gap"][data-reason="skipped"]')
    await expect(gap.first()).toBeVisible()
    await expect(gap.first()).toHaveText(/^[\d,]+ lines? skipped in the live view/)
    const from = Number(await gap.first().getAttribute('data-from'))
    const to = Number(await gap.first().getAttribute('data-to'))
    expect(to).toBeGreaterThanOrEqual(from)

    // The window responds to input right away.
    const typed = Date.now()
    await view.getByLabel('Filter output', { exact: true }).fill('')
    await expect.poll(async () => (await renderedTexts()).length).toBeGreaterThan(0)
    expect(Date.now() - typed).toBeLessThan(2_000)

    // Show fetches the skipped lines (all still retained here).
    await view.getByLabel('Filter output', { exact: true }).fill('no line contains this')
    await gap.first().getByRole('button', { name: 'Show', exact: true }).click()
    await expect(view.locator(`[data-testid="log-gap"][data-from="${from}"]`)).toHaveCount(0)
    await view.getByLabel('Filter output', { exact: true }).fill(String(from).padStart(9, '0'))
    await expect.poll(renderedTexts).toEqual([expect.stringMatching(new RegExp(`^${String(from).padStart(9, '0')} x+$`))])
  })
})

test('[spec:process-logs/retention-limit-reached] keeps the newest 10,000 lines and says that older output was discarded', async () => {
  const flood = { id: FLOOD_ID, name: 'flood', execution: { mode: 'direct' as const, file: process.execPath, args: [fixture('lines'), '--rate', '200000', '--count', '12000'] } }
  await withLogs([flood], async ({ window, view, start, copied }) => {
    await start(FLOOD_ID, 'flood')
    await expect(window.locator(`[data-command-id="${FLOOD_ID}"]`).getByTestId('command-status')).toHaveText('Exited', { timeout: 15_000 })
    await window.reload()
    await window.locator(`[data-command-id="${FLOOD_ID}"] .command-name`).click()
    await expect(view.getByTestId('log-discarded')).toHaveText('Older output was discarded: Veydr keeps the newest 10,000 lines or 8 MiB of each run.')
    const text = await copied(() => view.getByRole('button', { name: 'Copy visible', exact: true }).click())
    await expect(view.getByRole('status')).toHaveText('Copied 10,000 lines.')
    expect(seqsOf(text)).toEqual(range(2001, 12_000))
  })
})

test('[spec:process-logs/output-not-persisted] output is kept in memory only: not shown after a restart and not written to disk', async () => {
  const marker = crypto.randomUUID()
  // The printed text (`printed-<marker>`) differs from the configured value (`<marker>`).
  const command = sh(TICK_ID, 'marker', `printf 'printed-%s\\n' "$MARKER"; exec sleep 60`, [{ key: 'MARKER', value: marker, secret: false }])
  await withLogs([command], async ({ start, renderedTexts, seeded, veydr }) => {
    await start(TICK_ID, 'marker')
    await expect.poll(renderedTexts).toEqual([`printed-${marker}`])
    expectNoOutboundConnections(await veydr.close())

    // Everything Veydr writes (configuration, ledger, Chromium profile) is under its config home.
    const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)]))
    expect(files(seeded.configHome).filter((file) => readFileSync(file).includes(`printed-${marker}`))).toEqual([])

    // A new session shows no output from the previous one.
    const again = await launchVeydr({ configHome: seeded.configHome })
    try {
      await again.window.locator(`[data-command-id="${TICK_ID}"] .command-name`).click()
      await expect(again.window.getByTestId('log-empty')).toHaveText('No output yet. Start the command to see its output here.')
      expectNoOutboundConnections(await again.close())
    } finally {
      await again.app.close().catch(() => undefined)
      rmSync(again.workDir, { recursive: true, force: true })
    }
    return 'closed'
  })
})

for (const rate of [5_000, 50_000]) {
test(`[spec:process-logs/user-interface-reloaded] a reload during a flood of ${rate.toLocaleString('en-US')} lines/s shows retained output again without duplicated or reordered lines`, async () => {
  const flood = (report: string) => ({ id: FLOOD_ID, name: 'flood', execution: { mode: 'direct' as const, file: process.execPath, args: [fixture('lines'), '--rate', String(rate), '--seconds', '6', '--report', report] } })
  let report = ''
  await withLogs([flood('report.json')], async ({ window, view, start, renderedTexts, copied, work }) => {
    report = join(work, 'report.json')
    await start(FLOOD_ID, 'flood')
    await expect.poll(async () => (await renderedTexts()).length).toBeGreaterThan(0)
    await window.waitForTimeout(1_500)
    await window.reload()
    await window.locator(`[data-command-id="${FLOOD_ID}"] .command-name`).click()
    await expect(window.locator(`[data-command-id="${FLOOD_ID}"]`).getByTestId('command-status')).toHaveText('Exited', { timeout: 20_000 })
    const produced = (JSON.parse(readFileSync(report, 'utf8')) as { lines: number }).lines
    expect(produced).toBeGreaterThan(rate * 4)
    await expect.poll(async () => (await renderedTexts()).at(-1)?.slice(0, 9)).toBe(String(produced).padStart(9, '0'))

    // Lines the view does not hold are shown as gaps; with a filter no line matches, only gaps remain.
    await view.getByLabel('Filter output', { exact: true }).fill('no line contains this')
    const gaps = await view.getByTestId('log-gap').evaluateAll((rows) => rows.map((row) => [Number(row.getAttribute('data-from')), Number(row.getAttribute('data-to'))] as const))
    await view.getByLabel('Filter output', { exact: true }).fill('')

    const seqs = seqsOf(await copied(() => view.getByRole('button', { name: 'Copy visible', exact: true }).click()))
    expect(seqs.at(-1)).toBe(produced)
    expect(seqs.length).toBeLessThanOrEqual(10_000)
    // Strictly increasing by one, except across a gap shown for exactly the missing lines.
    for (let i = 1; i < seqs.length; i++) {
      const [previous, current] = [seqs[i - 1] ?? 0, seqs[i] ?? 0]
      if (current !== previous + 1) expect(gaps, `jump ${previous} → ${current}`).toContainEqual([previous + 1, current - 1])
    }
  })
})
}

test('[spec:process-logs/secret-too-short-to-redact] warns that a secret value shorter than 4 characters is not redacted', async () => {
  await withLogs([], async ({ window }) => {
    await window.getByRole('button', { name: 'Add command to logs', exact: true }).click()
    const editor = window.getByTestId('command-editor')
    await expect(editor.getByTestId('secret-redaction-note')).toContainText('transformed, split, or partial values are not detected')
    await editor.getByRole('button', { name: 'Add variable', exact: true }).click()
    await editor.getByLabel('Variable 1 name', { exact: true }).fill('PIN')
    await editor.getByLabel('Variable 1 value', { exact: true }).fill('123')
    await expect(editor.getByTestId('short-secret-warning')).toHaveCount(0)
    await editor.getByRole('checkbox', { name: 'Secret', exact: true }).check()
    await expect(editor.getByTestId('short-secret-warning')).toHaveText("This value is shorter than 4 characters, so it will not be redacted from the command's output.")
    await editor.getByLabel('Variable 1 value', { exact: true }).fill('1234')
    await expect(editor.getByTestId('short-secret-warning')).toHaveCount(0)
  })
})
