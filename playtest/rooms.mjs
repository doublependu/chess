// A p3p2 server and a room on it, for the tests and the film that play in a room: the server from a p3p2 checkout
// (in memory, gone when the process ends), or one already running; and a room made in its portal, as its owner would.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const children = [];
/** Stops every server and proxy started here. */
export const stopAll = () => { for (const c of children) c.kill('SIGTERM'); };
process.once('exit', stopAll);

export async function waitFor(url, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(url)).ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} did not answer in ${ms / 1000} s`);
}

/**
 * A p3p2 server: `server` (a URL, with the owner's password in P3P2_OWNER_PASSWORD), or one started from the
 * checkout at `p3p2` on `port`. Returns { url, password, dir }.
 */
export async function p3p2Server({ server = null, p3p2 = '../p3p2', port = 18210 } = {}) {
  if (server) {
    const password = process.env.P3P2_OWNER_PASSWORD;
    if (!password) throw new Error('--server needs the owner password in P3P2_OWNER_PASSWORD');
    return { url: String(server).replace(/\/$/, ''), password, dir: p3p2 ? resolve(String(p3p2)) : null };
  }
  const dir = resolve(String(p3p2));
  const main = join(dir, 'server', 'src', 'main.ts');
  if (!existsSync(main)) throw new Error(`No p3p2 checkout at ${dir} (give one with --p3p2, or a running server with --server)`);
  const password = 'room-playtest-' + Math.random().toString(36).slice(2, 10);
  const child = spawn(process.execPath, [main], {
    cwd: dir,
    env: {
      ...process.env, P3P2_PORT: String(port), P3P2_HOST: '127.0.0.1', P3P2_PUBLIC_URL: `http://127.0.0.1:${port}`,
      P3P2_DATA_DIR: ':memory:', P3P2_OWNER_PASSWORD: password, P3P2_LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  children.push(child);
  await waitFor(`http://127.0.0.1:${port}/healthz`);
  return { url: `http://127.0.0.1:${port}`, password, dir };
}

/** p3p2's lag proxy in front of `server`, on `listen`: 150 ms ± 50 each way, and a connection cut now and then. */
export async function lagProxy(server, listen) {
  if (!server.dir) throw new Error('--lag needs a p3p2 checkout (--p3p2) for its lag proxy');
  const to = new URL(server.url);
  const child = spawn(process.execPath, [
    join(server.dir, 'e2e', 'tools', 'lag-proxy.ts'), '--listen', String(listen), '--to', `${to.hostname}:${to.port}`,
    '--latency', '150', '--jitter', '50', '--drop-every', '45',
  ], { cwd: server.dir, stdio: ['ignore', 'ignore', 'inherit'] });
  children.push(child);
  await waitFor(`http://127.0.0.1:${listen}/healthz`);
  return listen;
}

/** The owner's side: logs in to the portal and makes a room for the game's address. Returns its invite link. */
export async function createRoom(browser, server, gameUrl, name = 'Sky Arena playtest') {
  const ctx = await browser.newContext();
  const portal = await ctx.newPage();
  // Not the server's address: once a room is on its front page, that is the front page.
  await portal.goto(`${server.url}/login`);
  await portal.getByLabel('Password').fill(server.password);
  await portal.getByRole('button', { name: 'Log in' }).click();
  await portal.getByLabel('Game URL').fill(gameUrl);
  await portal.getByLabel('Room name').fill(name);
  await portal.getByRole('button', { name: 'Create room' }).click();
  await portal.getByRole('heading', { name }).waitFor();
  const link = portal.getByLabel('Invite link', { exact: true });
  // A server before 0.2 makes no invite with the room: the owner creates it.
  if (!(await link.isVisible())) await portal.getByRole('button', { name: 'Create invite' }).click();
  const invite = await link.inputValue();
  await ctx.close();
  return invite;
}

/** What an invite carries: `?room=<server>/<code>`. */
export const roomOf = (invite) => new URL(invite).searchParams.get('room');
