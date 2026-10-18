// Regression suite for the lesson themes. Builds the worked example with each theme into a temp dir and
// runs that theme's suite from scripts/theme-tests/<theme>.mjs.
// Usage: node scripts/test-template.mjs [theme ...]   (no argument = every theme that has a suite)
import { execFileSync } from 'child_process';
import { existsSync, mkdtempSync, readdirSync } from 'fs'; import { tmpdir } from 'os'; import { join, dirname } from 'path'; import { fileURLToPath } from 'url';
const here = dirname(fileURLToPath(import.meta.url)), root = join(here, '..');
const all = readdirSync(join(root, 'assets', 'themes')).filter(f => f.endsWith('.html')).map(f => f.slice(0, -5));
const themes = process.argv.length > 2 ? process.argv.slice(2) : all;
const out = mkdtempSync(join(tmpdir(), 'lens-themes-'));
let failed = 0;
for (const theme of themes) {
  const suite = join(here, 'theme-tests', `${theme}.mjs`);
  if (!existsSync(suite)) { console.log(`== ${theme}: no suite in scripts/theme-tests/ (add one)`); failed++; continue; }
  const html = join(out, `jw-ask-flow.${theme}.html`);
  execFileSync('python3', [join(here, 'build.py'), join(root, 'examples', 'jw-ask-flow.json'), html, '--theme', theme], { stdio: 'ignore' });
  console.log(`== ${theme}`);
  try { execFileSync('node', [suite, html], { stdio: 'inherit' }); } catch { failed++; }
}
process.exit(failed ? 1 : 0);
