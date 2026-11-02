import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Design-system conformance (Planning Docs/16 §4.7): text assertions over the web source. They need
 * no browser and no rendering, and they catch the two regressions no component test would: a hex
 * colour bypassing the token layer, and a threshold literal standing in for an ARL alert limit.
 */
const WEB = join(__dirname, '..', '..', 'web');
const SRC = join(WEB, 'src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx?|css)$/.test(name) ? [path] : [];
  });
}

const read = (path: string) => readFileSync(path, 'utf8');

/** Every `file:line: text` in `files` that matches `pattern`, for a readable failure. */
function offenders(files: string[], pattern: RegExp): string[] {
  return files.flatMap((file) =>
    read(file)
      .split('\n')
      .flatMap((line, index) => (pattern.test(line) ? [`${relative(WEB, file)}:${index + 1}: ${line.trim()}`] : [])),
  );
}

const componentsAndPages = [...sources(join(SRC, 'components')), ...sources(join(SRC, 'pages'))];
const pages = sources(join(SRC, 'pages'));

describe('token layer', () => {
  it('has no hex colour literal in components or pages', () => {
    // Colours live in index.css :root and tailwind.config.js; everything else reads var(--token).
    expect(offenders(componentsAndPages, /#[0-9a-fA-F]{3,8}\b/)).toEqual([]);
  });

  it('defines the guide tokens once, in index.css', () => {
    const css = read(join(SRC, 'index.css'));
    for (const token of ['--void', '--panel', '--panel-edge', '--elev', '--hover', '--nominal', '--caution', '--alarm', '--in-hand', '--inert', '--rta', '--mhe', '--opg', '--replay']) {
      expect(css, token).toMatch(new RegExp(`${token}:`));
    }
    expect(css).toMatch(/\.led-alert\b/);
    expect(css).toMatch(/\.telemetry-readout\b/);
  });

  it('carries the guide 11 px step as xs2', () => {
    expect(read(join(WEB, 'tailwind.config.js'))).toMatch(/xs2:\s*\['0\.6875rem'/);
  });
});

describe('alert limits', () => {
  it('compares no reading against a hard-coded threshold in pages', () => {
    // The bands come from GET /api/alert-limits/<service>; the guide's figures are illustrations.
    expect(offenders(pages, /\b(1200|348\.15)\b/)).toEqual([]);
    expect(offenders(pages, /[<>]=?\s*(15|20|25|50|75|1000)\b/)).toEqual([]);
    expect(offenders(pages, /threshold=\{\{\s*value:\s*\d/)).toEqual([]);
  });
});

describe('operator surfaces', () => {
  it('spells the replay badge and the speed pills as the guide does', () => {
    expect(read(join(SRC, 'lib', 'mode.ts'))).toContain('HISTORICAL REPLAY \\u2014');
    const replay = read(join(SRC, 'pages', 'Replay.tsx'));
    expect(replay).toMatch(/const SPEEDS = \[1, 2, 5, 10\];/);
    expect(replay).toContain('LIVE');
    expect(replay).not.toMatch(/32x|\b32\b/);
  });

  it('lists the seven audit columns in the guide order', () => {
    expect(read(join(SRC, 'pages', 'Alerts.tsx'))).toContain(
      "['Alert ID', 'Service', 'Cause', 'Raised At', 'Ack By (Timestamp)', 'Resolved By (Timestamp)', 'Notes']",
    );
  });

  it('keeps every animation in the reduced-motion list', () => {
    const css = read(join(SRC, 'index.css'));
    const reduced = css.slice(css.indexOf('prefers-reduced-motion'));
    for (const name of ['.annunciator-flash', '.led-alert', '.stow-pulse', '.soc-blink', '.pulse-trace']) {
      expect(reduced, name).toContain(name);
    }
  });
});
