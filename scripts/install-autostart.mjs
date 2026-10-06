/**
 * Fill in com.slackcode.app.plist and install it as a LaunchAgent.
 *
 * The committed plist is a template: real paths are machine specific and do not
 * belong in the repo, but a plist full of placeholders would load and then fail
 * in ways launchd reports poorly. This resolves them from the running
 * environment instead of asking anyone to hand-edit XML.
 *
 *   node scripts/install-autostart.mjs            install and load
 *   node scripts/install-autostart.mjs --uninstall  unload and remove
 *   node scripts/install-autostart.mjs --print      print the resolved plist
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'com.slackcode.app';
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = homedir();
const user = userInfo().username;
const agentsDir = join(home, 'Library', 'LaunchAgents');
const target = join(agentsDir, `${LABEL}.plist`);

function resolved() {
  return readFileSync(join(appDir, `${LABEL}.plist`), 'utf8')
    .replaceAll('__APP_DIR__', appDir)
    .replaceAll('__HOME__', home)
    .replaceAll('__USER__', user);
}

function launchctl(...args) {
  try {
    execFileSync('launchctl', args, { stdio: 'pipe' });
  } catch {
    // unload of something that was never loaded is not an error worth reporting
  }
}

const mode = process.argv[2];

if (mode === '--print') {
  process.stdout.write(resolved());
  process.exit(0);
}

if (mode === '--uninstall') {
  launchctl('unload', target);
  if (existsSync(target)) rmSync(target);
  console.log(`Removed ${target}`);
  process.exit(0);
}

const electron = join(appDir, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');
if (!existsSync(electron)) {
  console.error('Electron is not installed yet. Run "npm install" first.');
  process.exit(1);
}
if (!existsSync(join(appDir, 'out', 'main'))) {
  console.error('No build found. Run "npm run build" first, or the agent will start an app with no main process.');
  process.exit(1);
}

mkdirSync(agentsDir, { recursive: true });
writeFileSync(target, resolved());
execFileSync('plutil', ['-lint', target], { stdio: 'pipe' });

// Reload rather than load, so re-running this picks up an edited template.
launchctl('unload', target);
execFileSync('launchctl', ['load', target], { stdio: 'inherit' });

console.log(`Installed ${target}`);
console.log(`  app:  ${appDir}`);
console.log(`  user: ${user}`);
console.log('  logs: ~/Library/Logs/slack-code/slack-code.log');
console.log('');
console.log('Remove it again with:  npm run autostart:uninstall');
