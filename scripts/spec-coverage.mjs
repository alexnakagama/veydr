#!/usr/bin/env node
// Spec traceability (design D14). Lists every scenario in the OpenSpec specs
// and the tests that reference it with `[spec:<capability>/<scenario-slug>]`.
//
//   node scripts/spec-coverage.mjs                 required (the default since L9, used by `npm run
//                                                  verify`): exits 1 if any scenario is unmapped
//   node scripts/spec-coverage.mjs --informational lists unmapped scenarios but exits 0 for them
//
// `--required` (the earlier opt-in) is still accepted; any other argument is an error.
// A tag naming a scenario that does not exist is a typo and fails in both modes.
//
// A requirement that an active (unarchived) change REMOVES in its delta no longer needs tests for
// its main-spec scenarios, and a tag still naming one of them fails as unknown, so a test cannot
// keep claiming a removed scenario. The exemption lasts only while the change is active: archive the
// change once it is merged (which removes the requirement from the main specs), or delete an
// abandoned change, whose removal would otherwise keep hiding those scenarios. A requirement that a
// delta both removes and adds again by the same name keeps its scenarios through the delta's copy.
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const unknownArgs = args.filter((arg) => arg !== '--required' && arg !== '--informational')
if (unknownArgs.length > 0 || (args.includes('--required') && args.includes('--informational'))) {
  console.error(`usage: spec-coverage.mjs [--required | --informational] (got: ${args.join(' ')})`)
  process.exit(2)
}
const required = !args.includes('--informational')

export function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

function walk(dir, accept, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'archive') continue
      walk(full, accept, out)
    } else if (accept(full)) {
      out.push(full)
    }
  }
  return out
}

const mainSpecDir = join(root, 'openspec/specs')
const changesDir = join(root, 'openspec/changes')
const isSpec = (f) => f.endsWith('/spec.md')
const capabilityOf = (file) => file.split('/').at(-2)

/**
 * Requirements an active (unarchived) change removes, as `<capability>/<requirement name>`. Their
 * scenarios in the main specs no longer need a test while the change is active: the change's own
 * delta says what replaces them, and archiving the change removes them from the main specs.
 */
/** The lines of a Markdown file outside fenced code blocks (``` or ~~~). */
function proseLines(file) {
  const lines = []
  let fence = null
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker !== undefined && (fence === null || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence === null ? marker : null
      continue
    }
    if (fence === null) lines.push(line)
  }
  return lines
}

function removedRequirements() {
  const removed = new Set()
  for (const file of walk(changesDir, isSpec)) {
    let section = null
    for (const line of proseLines(file)) {
      const heading = /^##\s+(\w+)\s+Requirements\s*$/.exec(line)
      if (heading !== null) section = heading[1]
      else if (/^##\s/.test(line)) section = null
      const requirement = /^###\s+Requirement:\s*(.+?)\s*$/.exec(line)
      if (requirement !== null && section === 'REMOVED') removed.add(`${capabilityOf(file)}/${requirement[1]}`)
    }
  }
  return removed
}

/** Every scenario of the main specs (minus removed requirements) and of the active changes' deltas. */
function scenarios() {
  const removed = removedRequirements()
  const found = new Map()
  const files = [...walk(mainSpecDir, isSpec).map((file) => ({ file, main: true })), ...walk(changesDir, isSpec).map((file) => ({ file, main: false }))]
  for (const { file, main } of files) {
    const capability = capabilityOf(file)
    let requirement = null
    for (const line of proseLines(file)) {
      const heading = /^###\s+Requirement:\s*(.+?)\s*$/.exec(line)
      if (heading !== null) requirement = heading[1]
      const match = /^####\s+Scenario:\s*(.+?)\s*$/.exec(line)
      if (match === null) continue
      if (main && requirement !== null && removed.has(`${capability}/${requirement}`)) continue
      const id = `${capability}/${slugify(match[1])}`
      if (!found.has(id)) found.set(id, { id, title: match[1], file: relative(root, file) })
    }
  }
  return found
}

function references() {
  const tests = walk(join(root, 'test'), (f) => /\.(ts|tsx|mjs|cjs)$/.test(f) && !f.includes('/lint-fixtures/'))
  const refs = new Map()
  for (const file of tests) {
    for (const match of readFileSync(file, 'utf8').matchAll(/\[spec:([a-z0-9-]+\/[a-z0-9-]+)\]/g)) {
      const list = refs.get(match[1]) ?? []
      list.push(relative(root, file))
      refs.set(match[1], list)
    }
  }
  return refs
}

const all = scenarios()
const refs = references()
const mapped = [...all.values()].filter((s) => refs.has(s.id))
const unmapped = [...all.values()].filter((s) => !refs.has(s.id))
const unknown = [...refs.keys()].filter((id) => !all.has(id))

console.log(`spec-coverage (${required ? 'required' : 'informational'} mode)`)
console.log(`  scenarios: ${all.size}  mapped: ${mapped.length}  unmapped: ${unmapped.length}`)
if (mapped.length > 0) {
  console.log('\nMapped scenarios:')
  for (const s of mapped) console.log(`  ✓ ${s.id}  (${[...new Set(refs.get(s.id))].join(', ')})`)
}
if (unmapped.length > 0) {
  console.log('\nUnmapped scenarios:')
  for (const s of unmapped) console.log(`  · ${s.id}`)
}
if (unknown.length > 0) {
  console.log('\nTags referencing unknown scenarios:')
  for (const id of unknown) console.log(`  ✗ ${id}  (${[...new Set(refs.get(id))].join(', ')})`)
}

if (unknown.length > 0 || (required && unmapped.length > 0)) process.exitCode = 1
