// Find Playwright's chromium wherever it is installed. Returns null when none is found (callers print `skip`).
// Order: $LENS_PLAYWRIGHT (path to playwright-core's index.mjs), the `playwright` or `playwright-core` npm
// package (local or global install), then gstack's bundled copy.
import { existsSync, readdirSync } from 'fs';
import { createRequire } from 'module';
import { execSync } from 'child_process';
import { join } from 'path';
const home = process.env.HOME || '';

async function fromPackage() {
  const roots = [process.cwd()];
  try { roots.push(execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()); } catch {}
  for (const root of roots) for (const name of ['playwright', 'playwright-core']) {
    try { return (await import(createRequire(join(root, 'noop.js')).resolve(name))); } catch {}
  }
  return null;
}

export async function getChromium() {
  const candidates = [process.env.LENS_PLAYWRIGHT, `${home}/.claude/skills/gstack/node_modules/playwright-core/index.mjs`].filter(Boolean);
  let mod = process.env.LENS_PLAYWRIGHT && existsSync(process.env.LENS_PLAYWRIGHT) ? await import(process.env.LENS_PLAYWRIGHT) : await fromPackage();
  if (!mod) { const f = candidates.find(existsSync); if (f) mod = await import(f); }
  const chromium = mod?.chromium || mod?.default?.chromium;
  if (!chromium) return null;
  // Prefer an already-downloaded headless shell; otherwise let Playwright use its own default browser.
  const cache = `${home}/.cache/ms-playwright`;
  const shell = existsSync(cache) && readdirSync(cache).filter(d => d.startsWith('chromium_headless_shell-')).sort().pop();
  const exe = shell && `${cache}/${shell}/chrome-headless-shell-linux64/chrome-headless-shell`;
  return { chromium, launch: (opts = {}) => chromium.launch(exe && existsSync(exe) ? { executablePath: exe, ...opts } : opts) };
}
