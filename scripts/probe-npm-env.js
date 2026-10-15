// TEMP diagnostic for issue: npm ci runs implicit `node-gyp rebuild` for
// better-sqlite3@13 on the self-hosted runner but nowhere else.
// Prints npm config/env + any npmrc files + the packed tarball's scripts.
// DELETE after diagnosis.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const out = [];
out.push('=== npm probe: ' + process.env.npm_config_user_agent + ' on ' + os.hostname() + ' ===');

const envKeys = Object.keys(process.env)
  .filter((k) => /npm_config_|NPM_CONFIG_|npm_lifecycle/i.test(k))
  .sort();
for (const k of envKeys) {
  const v = String(process.env[k]);
  out.push(`env ${k}=${v.length > 160 ? v.slice(0, 160) + '…' : v}`);
}

for (const [label, p] of [
  ['user', path.join(os.homedir(), '.npmrc')],
  ['global', process.env.npm_config_globalconfig || '/etc/npmrc'],
  ['builtin', path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'npmrc')],
]) {
  try {
    out.push(`--- ${label} npmrc (${p}) ---\n` + fs.readFileSync(p, 'utf8').trim());
  } catch {
    out.push(`--- ${label} npmrc (${p}) --- <none>`);
  }
}

try {
  const cfg = execFileSync(
    process.env.npm_execpath ? process.execPath : 'npm',
    process.env.npm_execpath
      ? [process.env.npm_execpath, 'config', 'list']
      : ['config', 'list'],
    { encoding: 'utf8', timeout: 30000 }
  );
  out.push('--- npm config list ---\n' + cfg.trim());
} catch (e) {
  out.push('--- npm config list failed: ' + e.message);
}

console.log(out.join('\n'));

// Force npm ci to fail HERE so npm replays this script's output into the
// job log (successful script output is swallowed when a later script dies).
// Also dump what npm thinks better-sqlite3's scripts are, post-reify, via
// a marker file check + the on-disk package.json if already unpacked.
try {
  const bsPkg = path.join(process.cwd(), 'node_modules', 'better-sqlite3', 'package.json');
  if (fs.existsSync(bsPkg)) {
    const pj = JSON.parse(fs.readFileSync(bsPkg, 'utf8'));
    console.log('ondisk better-sqlite3 scripts:', JSON.stringify(pj.scripts));
  } else {
    console.log('ondisk better-sqlite3: not yet unpacked (preinstall runs pre-reify)');
  }
} catch (e) {
  console.log('ondisk read failed:', e.message);
}
process.exit(1);
