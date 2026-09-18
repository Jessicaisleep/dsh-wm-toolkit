import { spawnSync } from 'node:child_process';
const files = process.argv.slice(2);
let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  const ok = r.status === 0;
  if (!ok) bad++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${f} status=${r.status}`);
  if (!ok) console.log((r.stderr || '').split('\n').slice(0, 12).join('\n'));
}
console.log(bad === 0 ? 'ALL-OK' : `${bad} FAILED`);
