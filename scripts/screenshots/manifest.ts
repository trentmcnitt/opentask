/**
 * Manifest entries for the screenshot pipeline (docs/SCREENSHOTS.md).
 *
 * Each capture step appends its entries to `<out>/manifest.parts/<step>.json`;
 * `finalize.ts` merges them into `manifest.json` and a README with each file's
 * pixel size. Kept as separate part files so a native step that runs (or
 * fails) on its own never clobbers the web step's list.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export type Theme = 'light' | 'dark' | 'n/a'

export interface ShotEntry {
  /** Path relative to the output directory. */
  file: string
  /** What the image shows. */
  shows: string
  theme: Theme
  /**
   * Where it is meant to go: `docs:<path under opentask-docs>` or
   * `portfolio:<name>`. Empty when it is a working image only.
   */
  destinations: string[]
}

export function writeManifestPart(outDir: string, step: string, entries: ShotEntry[]): void {
  const dir = path.join(outDir, 'manifest.parts')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${step}.json`), JSON.stringify(entries, null, 2) + '\n')
}

/** Width and height of a PNG, read from its IHDR chunk. */
export function pngSize(file: string): { width: number; height: number } {
  const fd = fs.openSync(file, 'r')
  try {
    const header = Buffer.alloc(24)
    fs.readSync(fd, header, 0, 24, 0)
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Downscale `src` to exactly `width` x `height` pixels as `dest` (macOS `sips`,
 * which every machine that can run the native steps already has).
 */
export function resizePng(src: string, dest: string, width: number, height: number): void {
  execFileSync('sips', ['-z', String(height), String(width), src, '--out', dest], {
    stdio: 'ignore',
  })
}
