#!/usr/bin/env node
/**
 * map-connect.mjs — connect this machine's OMS to the in-house map server.
 *
 *   npm run map:check     is the map server reachable, and does it accept our key?   (read-only, safe anytime)
 *   npm run map:tunnel    keep an SSH tunnel to the map server open (reconnects by itself)
 *   npm run map:config    show the settings in use (the key is masked)
 *
 * Settings come from backend/.env, the same file the backend reads. Real environment variables win over the file.
 *
 *   MAP_SERVER_URL         where the OMS backend reaches the map server, e.g. http://127.0.0.1:8095
 *   MAP_API_KEY            this developer's own map key (created on the map server with: node scripts/map-keys.mjs create NAME)
 *
 *   Only for "tunnel" (the map server listens on its own machine, so a developer's laptop reaches it through SSH):
 *   MAP_SSH_HOST           the map server's address
 *   MAP_SSH_USER           the tunnel-only login on that machine (e.g. mapdev)
 *   MAP_SSH_KEY            private key file (optional; defaults to your normal SSH key)
 *   MAP_SSH_PORT           SSH port on the server (default 22)
 *   MAP_SSH_REMOTE_PORT    port of the map server on that machine (default 8095)
 *
 * No dependencies. Needs Node 20+ and, for "tunnel", the OpenSSH client (built into Windows 10/11, macOS and Linux).
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, 'backend', '.env');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const expandHome = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

// ---- settings -------------------------------------------------------------------------------------------------

// Reads KEY=VALUE lines like dotenv does: comments, quotes, "export ", and Windows (CRLF) line endings.
export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length > 1) || (v.startsWith("'") && v.endsWith("'") && v.length > 1)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, ''); // a trailing comment on an unquoted value
    out[m[1]] = v;
  }
  return out;
}

export function loadSettings(envFile = ENV_FILE, env = process.env) {
  let fromFile = {};
  try { fromFile = parseEnv(fs.readFileSync(envFile, 'utf8')); } catch { /* no file yet: environment variables still work */ }
  const pick = (k) => (env[k] !== undefined && env[k] !== '' ? env[k] : fromFile[k]);
  const s = {};
  for (const k of ['MAP_SERVER_URL', 'MAP_API_KEY', 'MAP_SSH_HOST', 'MAP_SSH_USER', 'MAP_SSH_KEY', 'MAP_SSH_PORT', 'MAP_SSH_REMOTE_PORT', 'PORT']) s[k] = pick(k);
  s.fileFound = fs.existsSync(envFile);
  s.urlWasDefault = !s.MAP_SERVER_URL;
  s.MAP_SERVER_URL = (s.MAP_SERVER_URL || 'http://127.0.0.1:8095').replace(/\/+$/, '');
  return s;
}

const mask = (k) => (k ? `${k.slice(0, 6)}… (${k.length} characters)` : '(not set)');

// ---- helpers --------------------------------------------------------------------------------------------------

const say = (m = '') => console.log(m);
const ok = (m) => say(`  OK    ${m}`);
const bad = (m) => say(`  FAIL  ${m}`);
const hint = (m) => say(`        ${m}`);

function tcpProbe(host, port, ms = 4000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (r) => { s.destroy(); resolve(r); };
    s.setTimeout(ms, () => done({ ok: false, code: 'ETIMEDOUT' }));
    s.once('connect', () => done({ ok: true }));
    s.once('error', (e) => done({ ok: false, code: e.code || e.message }));
  });
}

async function get(url, headers = {}, ms = 8000) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(ms) });
    let body = null;
    try { body = await res.json(); } catch { /* not json */ }
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, error: e?.cause?.code || e?.name || String(e) };
  }
}

// ---- config ---------------------------------------------------------------------------------------------------

function cmdConfig(s) {
  say(`\nSettings in use  (file: ${ENV_FILE}${s.fileFound ? '' : '  <- not found'}; real environment variables override it)\n`);
  say(`  MAP_SERVER_URL       ${s.MAP_SERVER_URL}${s.urlWasDefault ? '   (default; not set)' : ''}`);
  say(`  MAP_API_KEY          ${mask(s.MAP_API_KEY)}`);
  say(`  MAP_SSH_HOST         ${s.MAP_SSH_HOST || '(not set)'}`);
  say(`  MAP_SSH_USER         ${s.MAP_SSH_USER || '(not set)'}`);
  say(`  MAP_SSH_KEY          ${s.MAP_SSH_KEY || '(default key)'}`);
  say(`  MAP_SSH_PORT         ${s.MAP_SSH_PORT || '22'}`);
  say(`  MAP_SSH_REMOTE_PORT  ${s.MAP_SSH_REMOTE_PORT || '8095'}\n`);
  return 0;
}

// ---- check ----------------------------------------------------------------------------------------------------

async function cmdCheck(s) {
  say(`\nChecking the map server at ${s.MAP_SERVER_URL}\n`);
  let url;
  try { url = new URL(s.MAP_SERVER_URL); } catch { bad(`MAP_SERVER_URL is not a valid address: ${s.MAP_SERVER_URL}`); return 1; }
  if (s.urlWasDefault) hint('MAP_SERVER_URL is not set, so the default is used. Set it in backend/.env.');
  if (!s.MAP_API_KEY) bad('MAP_API_KEY is not set in backend/.env. Ask whoever runs the map server for your own key.');

  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  const tcp = await tcpProbe(url.hostname, port);
  if (!tcp.ok) {
    bad(`Cannot connect to ${url.hostname}:${port} (${tcp.code}).`);
    const local = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
    if (local && tcp.code === 'ECONNREFUSED') {
      hint(s.MAP_SSH_HOST
        ? 'Nothing is listening here, so the tunnel is not open. Start it in another terminal:  npm run map:tunnel'
        : 'Nothing is listening here. If the map server is on another machine, set MAP_SSH_HOST / MAP_SSH_USER and run:  npm run map:tunnel');
    } else {
      hint('The address did not answer. Check the address, your VPN / network, and any firewall in between.');
    }
    return 1;
  }
  ok(`reached ${url.hostname}:${port}`);

  const prefix = url.pathname.replace(/\/+$/, '').endsWith('/api/map') ? '' : '/api/map';
  const base = s.MAP_SERVER_URL;
  const health = await get(`${url.origin}${url.pathname.replace(/\/+$/, '').replace(/\/api\/map$/, '')}/health`);
  if (health.status === 200 && health.body?.ok) ok(`map server is up (map file ${health.body.tiles}, zoom ${health.body.minzoom}-${health.body.maxzoom})`);
  else if (health.status === 404) hint('(/health not found: this looks like the OMS address rather than the map server; that is fine)');
  else { bad(`the address answered, but not like the map server (HTTP ${health.status || health.error}).`); hint('Is MAP_SERVER_URL pointing at the map server port (usually 8095)?'); return 1; }

  const info = await get(`${base}${prefix}/info`, s.MAP_API_KEY ? { 'x-api-key': s.MAP_API_KEY } : {});
  if (info.status === 200) {
    const i = info.body;
    ok(`key accepted. Map version ${i.version}, covers lon ${i.bounds[0].toFixed(1)}..${i.bounds[2].toFixed(1)}, lat ${i.bounds[1].toFixed(1)}..${i.bounds[3].toFixed(1)}`);
    if (i.serviceArea) ok(`crew service area is set (${i.serviceArea.join(', ')})`);
  } else if (info.status === 401) {
    bad('the map server REFUSED this key.');
    hint('It may be mistyped, revoked or expired. Ask for a new one:  node scripts/map-keys.mjs create NAME  (on the map server)');
    return 1;
  } else {
    bad(`could not read the map details (HTTP ${info.status || info.error}).`);
    hint('The address answered, but not like the map server. Is MAP_SERVER_URL the map server itself (usually http://127.0.0.1:8095)?');
    return 1;
  }

  const style = await get(`${base}/style.json`);
  if (style.status === 200 && style.body?.layers?.length) ok(`map style available (${style.body.layers.length} drawing layers)`);
  else { bad(`map style not available (HTTP ${style.status || style.error}).`); return 1; }

  const oms = await get(`http://127.0.0.1:${s.PORT || 14000}/api/health`, {}, 2500);
  if (oms.status === 200) ok(`OMS backend is running on port ${s.PORT || 14000} (its map calls need a login, so they are not tested here)`);
  else hint(`(OMS backend is not running on port ${s.PORT || 14000}; that is fine for this check. Start the app with: npm start)`);

  say('\nThe connection works. The OMS backend can now serve the map to the web and crew apps.\n');
  return 0;
}

// ---- tunnel ---------------------------------------------------------------------------------------------------

async function cmdTunnel(s) {
  const missing = ['MAP_SSH_HOST', 'MAP_SSH_USER'].filter((k) => !s[k]);
  if (missing.length) {
    say(`\n  FAIL  ${missing.join(' and ')} not set in backend/.env.`);
    hint('Add, for example:   MAP_SSH_HOST=<map server address>   MAP_SSH_USER=mapdev   (see docs/MAP_SERVER_INTEGRATION.md)\n');
    return 1;
  }
  let url;
  try { url = new URL(s.MAP_SERVER_URL); } catch { say(`\n  FAIL  MAP_SERVER_URL is not a valid address: ${s.MAP_SERVER_URL}\n`); return 1; }
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
    say(`\n  FAIL  A tunnel only makes sense when MAP_SERVER_URL points at THIS machine (127.0.0.1), but it is ${url.hostname}.\n`);
    return 1;
  }
  const localPort = Number(url.port);
  const remotePort = Number(s.MAP_SSH_REMOTE_PORT || 8095);
  if (!localPort) { say('\n  FAIL  MAP_SERVER_URL needs a port, e.g. http://127.0.0.1:8095\n'); return 1; }
  if (spawnSync('ssh', ['-V']).error) {
    say('\n  FAIL  The OpenSSH client ("ssh") was not found.');
    hint('Windows: Settings > Apps > Optional features > add "OpenSSH Client". macOS/Linux have it already.\n');
    return 1;
  }
  if ((await tcpProbe('127.0.0.1', localPort, 1500)).ok) {
    say(`\n  FAIL  Port ${localPort} on this machine is already in use. Is another tunnel (or a local map server) already running?\n`);
    return 1;
  }

  const args = [
    '-N', '-T',
    '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new', // trusts a server the first time, refuses if its identity later changes
    '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    '-p', String(s.MAP_SSH_PORT || 22),
    ...(s.MAP_SSH_KEY ? ['-i', expandHome(s.MAP_SSH_KEY)] : []),
    `${s.MAP_SSH_USER}@${s.MAP_SSH_HOST}`,
  ];
  say(`\nOpening a tunnel:  http://127.0.0.1:${localPort}  ->  ${s.MAP_SSH_HOST}:${remotePort}`);
  say(`Command: ssh ${args.join(' ')}`);
  say('If your key has a passphrase, type it below. Leave this window open while you work; press Ctrl+C to close the tunnel.\n');

  let child = null;
  let stopping = false;
  const stop = () => { stopping = true; try { child?.kill(); } catch { /* already gone */ } };
  process.on('SIGINT', () => { stop(); say('\nTunnel closed.'); process.exit(0); });
  process.on('SIGTERM', () => { stop(); process.exit(0); });

  let quickFailures = 0;
  let backoff = 1000;
  while (!stopping) {
    const startedAt = Date.now();
    const announce = (async () => {
      for (let i = 0; i < 90 && !stopping; i++) {
        await sleep(1000);
        if ((await tcpProbe('127.0.0.1', localPort, 800)).ok) { say(`[${new Date().toLocaleTimeString()}] tunnel is up. In another terminal run:  npm run map:check`); return; }
        if (!child || child.exitCode !== null) return;
      }
    })();
    const code = await new Promise((resolve) => {
      child = spawn('ssh', args, { stdio: 'inherit' });
      child.on('error', (e) => { say(`  FAIL  could not start ssh: ${e.message}`); resolve(-1); });
      child.on('exit', (c, sig) => resolve(sig ? `signal ${sig}` : c));
    });
    await announce;
    if (stopping) break;
    const ranFor = Date.now() - startedAt;
    quickFailures = ranFor < 15000 ? quickFailures + 1 : 0;
    say(`\n[${new Date().toLocaleTimeString()}] the tunnel closed (${code}) after ${Math.round(ranFor / 1000)}s.`);
    if (quickFailures >= 5) {
      say('\n  FAIL  The tunnel keeps failing right away, so I am stopping. Run the command shown above by hand with -v added to see why. Usual causes:');
      hint('- the public key was not added to the tunnel-only login on the server, or the login was removed');
      hint('- wrong MAP_SSH_USER / MAP_SSH_KEY, or the key passphrase was mistyped');
      hint('- SSH is blocked between you and the server (try: Test-NetConnection <host> -Port 22 on Windows)\n');
      return 1;
    }
    say(`reconnecting in ${Math.round(backoff / 1000)}s ...`);
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 30000);
    if (ranFor >= 15000) backoff = 1000;
  }
  return 0;
}

// ---- main -----------------------------------------------------------------------------------------------------

const HELP = `map-connect — connect this machine's OMS to the in-house map server

  npm run map:check     is the map server reachable, and does it accept our key?
  npm run map:tunnel    keep an SSH tunnel to the map server open (reconnects by itself)
  npm run map:config    show the settings in use (the key is masked)

Settings live in backend/.env: MAP_SERVER_URL, MAP_API_KEY and, for the tunnel, MAP_SSH_HOST, MAP_SSH_USER
(optional: MAP_SSH_KEY, MAP_SSH_PORT, MAP_SSH_REMOTE_PORT). See docs/MAP_SERVER_INTEGRATION.md.
`;

const isMain = process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const cmd = process.argv[2];
  const s = loadSettings();
  const run = { check: cmdCheck, tunnel: cmdTunnel, config: cmdConfig }[cmd];
  if (!run) { say(HELP); process.exit(cmd ? 2 : 0); }
  Promise.resolve(run(s)).then((code) => process.exit(code), (e) => { console.error(`\nUnexpected error: ${e?.message || e}`); process.exit(1); });
}
