// Syntax-check every browser module with Node (no bundler needed).
import { readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
const files = [];
const walk = (d) => readdirSync(d).forEach((f) => { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') && files.push(p); });
walk('web/js');
let bad = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', '--input-type=module'], { input: (await import('node:fs')).readFileSync(f) }); console.log('ok  ', f); }
  catch (e) { bad++; console.error('FAIL', f, '\n', e.stderr?.toString()); }
}
process.exit(bad ? 1 : 0);
