import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

// Relative links of the Markdown documents, checked down to the heading they point at
// (add-windows-packaging task 6.3). Limits: only inline links `[text](target)` are checked, not
// reference-style links or HTML `href` attributes (readme-docs.test.ts checks the README's `href`
// files, without anchors); and a heading that contains a link, an image or an HTML entity gets the
// anchor of its literal text here, which may differ from GitHub's.

/** `text` without its fenced code blocks, so that `# comment` lines in a block are not headings. */
function withoutCodeBlocks(text: string): string {
  return text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, '')
}

/** The anchor GitHub gives a heading: lower case, punctuation dropped, spaces as hyphens. */
export function headingAnchor(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')
}

/** Every anchor of a document's headings, a repeated heading numbered as GitHub numbers it. */
export function headingAnchors(text: string): Set<string> {
  const anchors = new Set<string>()
  const seen = new Map<string, number>()
  for (const [, heading = ''] of withoutCodeBlocks(text).matchAll(/^#{1,6}[ \t]+(.+?)[ \t#]*$/gm)) {
    const base = headingAnchor(heading)
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    anchors.add(count === 0 ? base : `${base}-${count}`)
  }
  return anchors
}

export interface Link {
  /** The link as written. */
  readonly raw: string
  /** The target file, relative to the repository root ('' for a link to the same document). */
  readonly file: string
  /** The anchor after `#`, or undefined. */
  readonly anchor: string | undefined
}

/** The relative Markdown links of `file` (relative to `root`), outside code blocks. */
export function relativeLinks(root: string, file: string): Link[] {
  const text = withoutCodeBlocks(readFileSync(join(root, file), 'utf8'))
  const links: Link[] = []
  for (const [, raw = ''] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue
    const [path = '', anchor] = raw.split('#', 2)
    links.push({ raw, file: path === '' ? file : relative(root, join(root, dirname(file), path)), anchor })
  }
  return links
}

/** The relative links of `file` whose target file or heading does not exist, as `file: link`. */
export function brokenLinks(root: string, file: string): string[] {
  const broken: string[] = []
  for (const link of relativeLinks(root, file)) {
    const target = join(root, link.file)
    if (link.file.startsWith('..') || !existsSync(target)) {
      broken.push(`${file}: ${link.raw} (no such file)`)
      continue
    }
    if (link.anchor === undefined) continue
    if (!link.file.endsWith('.md') || !headingAnchors(readFileSync(target, 'utf8')).has(link.anchor)) {
      broken.push(`${file}: ${link.raw} (no such heading)`)
    }
  }
  return broken
}
