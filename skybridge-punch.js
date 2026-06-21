/**
 * skybridge-punch.js
 * SkyBridge UDP Hole Punch Layer
 *
 * Creates a physical path between two devices behind separate NATs
 * by sending simultaneous UDP packets through SkyBridge rendezvous.
 *
 * Usage:
 *   node skybridge-punch.js --device s24-ultra --peer tab-s9
 *   node skybridge-punch.js --device tab-s9 --peer s24-ultra
 */

'use strict';

const dgram  = require('dgram');
const http   = require('http');
const https  = require('https');
const crypto = require('crypto');

const args = {};
process.argv.slice(2).forEach((a, i, arr) => {
  if (a.startsWith('--')) args[a.slice(2)] = arr[i + 1];
});

const DEVICE_ID   = args.device  || 'jbvg-device';
const PEER_ID     = args.peer    || null;
const PUNCH_PORT  = parseInt(args.port || '7701');
const CORE_URL    = args.core    || 'https://core.jbventuresinc.biz';
const PUNCH_INTERVAL_MS = 500;  // punch every 500ms
const REGISTER_INTERVAL_MS = 10000; // re-register every 10s

const NODE_ID = crypto.randomBytes(8).toString('hex');

const log  = (msg) => console.log(`[SkyBridge:Punch:${DEVICE_ID}] ${msg}`);
const warn = (msg) => console.warn(`[SkyBridge:Punch:${DEVICE_ID}] WARN: ${msg}`);

// ── HTTP helper ───────────────────────────────────────────────
function post(url, body) {
  return new Promise((resolve, reject) => {
    const data   = JSON.stringify(body);
    const parsed = new URL(url);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const opts   = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };
    const req = lib.request(opts, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(raw); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── UDP socket ────────────────────────────────────────────────
const sock = dgram.createSocket('udp4');

sock.bind(PUNCH_PORT, () => {
  log(`UDP socket bound on port ${PUNCH_PORT}`);
});

sock.on('message', (msg, rinfo) => {
  try {
    const pkt = JSON.parse(msg.toString());
    if (pkt.type === 'skybridge-punch') {
      log(`HOLE OPEN -- packet received from ${rinfo.address}:${rinfo.port} (peer: ${pkt.from})`);
      // Punch is confirmed -- notify SkyBridge peer to connect
      sock.emit('hole-open', rinfo.address, rinfo.port);
    }
    if (pkt.type === 'skybridge-ping') {
      const pong = Buffer.from(JSON.stringify({ type: 'skybridge-pong', from: DEVICE_ID, ts: Date.now() }));
      sock.send(pong, rinfo.port, rinfo.address);
    }
  } catch {}
});

sock.on('error', e => warn('Socket error: ' + e.message));

// ── Register with SkyBridge rendezvous ────────────────────────
async function register() {
  try {
    const res = await post(`${CORE_URL}/fn/rendezvousWrite`, {
      deviceId: DEVICE_ID,
      port:     PUNCH_PORT,
      ttl:      60000,
      meta:     { nodeId: NODE_ID, type: 'punch' }
    });
    if (res?.result?.ok) log(`Registered @ ${res.result.ip}:${PUNCH_PORT}`);
  } catch (e) {
    warn('Register failed: ' + e.message);
  }
}

// ── Find peer and punch ───────────────────────────────────────
async function findAndPunch() {
  if (!PEER_ID) return;

  try {
    const res = await post(`${CORE_URL}/fn/rendezvousRead`, { deviceId: PEER_ID });
    const session = res?.result?.session;
    if (!session) { log(`Peer "${PEER_ID}" not yet registered`); return; }

    const peerIp   = session.ip.replace('::ffff:', '');
    const peerPort = session.port;

    log(`Punching toward peer ${PEER_ID} @ ${peerIp}:${peerPort}`);

    const pkt = Buffer.from(JSON.stringify({
      type: 'skybridge-punch',
      from: DEVICE_ID,
      nodeId: NODE_ID,
      ts: Date.now()
    }));

    sock.send(pkt, peerPort, peerIp, err => {
      if (err) warn(`Punch failed: ${err.message}`);
    });

  } catch (e) {
    warn('findAndPunch error: ' + e.message);
  }
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  log(`Starting SkyBridge Hole Punch`);
  log(`Device: ${DEVICE_ID} | Peer: ${PEER_ID || 'none'} | Port: ${PUNCH_PORT}`);

  await register();
  setInterval(register, REGISTER_INTERVAL_MS);
  setInterval(findAndPunch, PUNCH_INTERVAL_MS);

  sock.on('hole-open', (ip, port) => {
    log(`PATH ESTABLISHED to ${ip}:${port} -- handing off to SkyBridge peer layer`);
    // TODO: signal skybridge-peer.js to connect directly via this path
  });
}

main().catch(e => { console.error('[SkyBridge:Punch] Fatal:', e.message); process.exit(1); });
