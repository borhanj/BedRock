/**
 * Contrast gate for the Bedrock palette.
 *
 * The ink & teal palette has a trap: #0e8f8f and #c25a44 look like text colours
 * but land near 4:1 on white, which passes for large text and UI chrome and
 * fails for body copy. The deep variants exist for that case. This script
 * fails the build if any pairing is used below its threshold.
 *
 * Note the canvas is tinted (#f2f6f7), so a colour can clear AA on white and
 * miss it on the page. Every text token is therefore checked against both.
 *
 * Usage: npm run check:contrast
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const TOKENS = join(HERE, '..', 'src', 'styles', 'tokens.css')

// WCAG 2.1 minimums.
const AA_BODY = 4.5
const AA_LARGE = 3.0 // >= 18.66px bold or >= 24px, and UI components

function srgbToLinear(channel) {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) throw new Error(`Not a 6-digit hex colour: ${hex}`)
  const n = parseInt(m[1], 16)
  const r = srgbToLinear((n >> 16) & 255)
  const g = srgbToLinear((n >> 8) & 255)
  const b = srgbToLinear(n & 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/** Pull `--bd-name: value;` pairs out of the :root block, ignoring @media. */
function readTokens() {
  const css = readFileSync(TOKENS, 'utf8')
  const root = css.slice(css.indexOf(':root'), css.indexOf('@media'))
  const tokens = {}
  for (const [, name, value] of root.matchAll(/--(bd-[\w-]+):\s*([^;]+);/g)) {
    tokens[name] = value.trim()
  }
  return tokens
}

const t = readTokens()

/** [foreground, background, minimum, description] */
const PAIRS = [
  [t['bd-text'], t['bd-surface'], AA_BODY, 'body text on a card'],
  [t['bd-text'], t['bd-canvas'], AA_BODY, 'body text on the page'],
  // Muted carries 10-12px labels throughout the dashboard, so it is body text.
  [t['bd-muted'], t['bd-surface'], AA_BODY, 'muted label on a card'],
  [t['bd-muted'], t['bd-canvas'], AA_BODY, 'muted label on the page'],
  [t['bd-primary-deep'], t['bd-surface'], AA_BODY, 'teal small text / links'],
  [t['bd-expense-text'], t['bd-surface'], AA_BODY, 'expense small text'],
  [t['bd-positive'], t['bd-surface'], AA_BODY, 'positive small text'],
  [t['bd-attention'], t['bd-surface'], AA_BODY, 'attention small text'],
  [t['bd-primary'], t['bd-surface'], AA_LARGE, 'teal fills and large figures'],
  [t['bd-expense'], t['bd-surface'], AA_LARGE, 'expense fills and large figures'],
  // Solid buttons take the deep teal, never the base hue.
  [t['bd-surface'], t['bd-primary-deep'], AA_BODY, 'white text on a teal button'],
  [t['bd-surface'], t['bd-primary-deeper'], AA_BODY, 'white text on button hover'],
  [t['bd-surface'], t['bd-ink'], AA_BODY, 'white text on the ink button'],
  // The inverted Feast report.
  [t['bd-report-text'], t['bd-report-bg'], AA_BODY, 'report body on dark'],
  [t['bd-report-muted'], t['bd-report-bg'], AA_LARGE, 'report muted on dark'],
  [t['bd-report-accent'], t['bd-report-bg'], AA_BODY, 'report accent on dark'],
  [t['bd-report-inflow'], t['bd-report-bg'], AA_BODY, 'report inflow figure'],
  [t['bd-report-outflow'], t['bd-report-bg'], AA_BODY, 'report outflow figure'],
]

/** rgba(...) tokens are resolved against a known backdrop before measuring. */
function flatten(value, backdrop) {
  const m = /^rgba?\(([^)]+)\)$/.exec(value)
  if (!m) return value
  const [r, g, b, a = '1'] = m[1].split(',').map((s) => s.trim())
  const alpha = Number(a)
  const bd = /^#?([0-9a-f]{6})$/i.exec(backdrop)
  const n = parseInt(bd[1], 16)
  const mix = (fg, bgc) => Math.round(Number(fg) * alpha + bgc * (1 - alpha))
  const out = [
    mix(r, (n >> 16) & 255),
    mix(g, (n >> 8) & 255),
    mix(b, n & 255),
  ]
  return '#' + out.map((c) => c.toString(16).padStart(2, '0')).join('')
}

let failures = 0
console.log('\n  Bedrock palette — WCAG 2.1 contrast\n')

for (const [rawFg, bg, min, label] of PAIRS) {
  if (!rawFg || !bg) {
    console.log(`  ??  ${label} — token missing from tokens.css`)
    failures++
    continue
  }
  const fg = flatten(rawFg, bg)
  const ratio = contrast(fg, bg)
  const ok = ratio >= min
  if (!ok) failures++
  const mark = ok ? 'ok  ' : 'FAIL'
  console.log(
    `  ${mark} ${ratio.toFixed(2).padStart(5)}:1  (min ${min.toFixed(1)})  ${label}`,
  )
}

console.log('')
if (failures > 0) {
  console.error(`  ${failures} pairing(s) below the WCAG AA minimum.\n`)
  process.exit(1)
}
console.log('  All pairings pass.\n')
