/**
 * jbvg-bridge.js
 * JBVG Sovereign Peer Bridge
 *
 * Establishes a direct persistent WebSocket connection
 * between two JBVG-owned devices using Core as rendezvous only.
 * After handshake, Core is not in the data path.
 *
 * Usage:
 *   node jbvg-bridge.js --device s24-ultra --port 9000 --peer tab-s9
 *   node jbvg-bridge.js --device tab-s9 --port 9001 --peer s24-ultra
 *
 * What it does:
 *   1. Registers this device with Core rendezvous
 *   2. Waits for peer to appear in rendezvous
 *   3. Establishes direct WebSocket connection to peer
 *   4. Sends keepalives to maintain session through CGNAT
 *   5. Logs all messages received from peer
 */

"use strict";

const WebSocket = require("ws");
const http      = require("http");
const https     = require("https");

// ── Config from args ──────────────────────────────────────────
const args = {};
process.argv.slice(2).forEach((a, i, arr) => {
  if (a.startsWith("--")) args[a.slice(2)] = arr[i + 1];
});

const DEVICE_ID   = args.device  || "jbvg-device";
const LISTEN_PORT = parseInt(args.port || "9000");
const PEER_ID     = args.peer    || null;
const CORE_URL    = args.core    || "https://core.jbventuresinc.biz";
const KEEPALIVE_MS = parseInt(args.keepalive || "10000"); // 10s keepalive
const POLL_MS      = parseInt(args.poll      || "3000");  // 3s peer poll

// ── Logging ───────────────────────────────────────────────────
const log  = (msg) => console.log(`[Bridge:${DEVICE_ID}] ${msg}`);
const warn = (msg) => console.warn(`[Bridge:${DEVICE_ID}] WARN: ${msg}`);

// ── HTTP helper ───────────────────────────────────────────────
function post(url, body) {
  return new Promise((resolve, reject) => {
    const data    = JSON.stringify(body);
    const parsed  = new URL(url);
    const lib     = parsed.protocol === "https:" ? https : http;
    const options = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path:     parsed.pathname,
      method:   "POST",
      headers:  {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(data)
      }
    };
    const req = lib.request(options, (res) => {
      let raw = "";
      res.on("data", (d) => raw += d);
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); }
        catch (_) { resolve(raw); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ── Rendezvous ────────────────────────────────────────────────
async function register() {
  try {
    const res = await post(`${CORE_URL}/fn/rendezvousWrite`, {
      deviceId: DEVICE_ID,
      port:     LISTEN_PORT,
      ttl:      60000, // 60s TTL, keepalive will re-register
      meta:     { nodeVersion: process.version, platform: process.platform }
    });
    if (res?.result?.ok) {
      log(`Registered @ ${res.result.ip}:${LISTEN_PORT}`);
      return res.result;
    }
  } catch (e) {
    warn("Rendezvous register failed: " + e.message);
  }
  return null;
}

async function findPeer(peerId) {
  try {
    const res = await post(`${CORE_URL}/fn/rendezvousRead`, { deviceId: peerId });
    if (res?.result?.found) return res.result.session;
  } catch (e) {
    warn("Rendezvous read failed: " + e.message);
  }
  return null;
}

// ── WebSocket Server (listens for incoming peer connections) ──
function startServer(onConnection) {
  const server = new WebSocket.Server({ port: LISTEN_PORT });
  log(`Listening on ws://0.0.0.0:${LISTEN_PORT}`);

  server.on("connection", (ws, req) => {
    const peerAddr = req.socket.remoteAddress;
    log(`Peer connected from ${peerAddr}`);
    onConnection(ws, peerAddr);
  });

  server.on("error", (e) => warn("Server error: " + e.message));
  return server;
}

// ── WebSocket Client (connects to peer) ───────────────────────
function connectToPeer(peerIp, peerPort) {
  return new Promise((resolve, reject) => {
    const url = `ws://${peerIp}:${peerPort}`;
    log(`Connecting to peer @ ${url}`);

    const ws = new WebSocket(url, { handshakeTimeout: 5000 });

    ws.on("open", () => {
      log(`Direct connection established to peer @ ${url}`);
      resolve(ws);
    });

    ws.on("error", (e) => {
      warn(`Connection to ${url} failed: ${e.message}`);
      reject(e);
    });
  });
}

// ── Connection Handler ────────────────────────────────────────
function handleConnection(ws, label) {
  log(`[${label}] Connection active`);

  // Send greeting
  ws.send(JSON.stringify({
    type:     "hello",
    from:     DEVICE_ID,
    ts:       Date.now(),
    message:  `${DEVICE_ID} is sovereign and online`
  }));

  // Keepalive ping every KEEPALIVE_MS
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping", from: DEVICE_ID, ts: Date.now() }));
    } else {
      clearInterval(pingInterval);
    }
  }, KEEPALIVE_MS);

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", from: DEVICE_ID, ts: Date.now() }));
        return;
      }
      if (msg.type === "pong") return;
      log(`[${label}] Message: ${JSON.stringify(msg)}`);
    } catch (_) {
      log(`[${label}] Raw: ${data}`);
    }
  });

  ws.on("close", () => {
    log(`[${label}] Connection closed`);
    clearInterval(pingInterval);
  });

  ws.on("error", (e) => warn(`[${label}] Error: ${e.message}`));
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  log(`Starting JBVG Bridge`);
  log(`Device: ${DEVICE_ID} | Port: ${LISTEN_PORT} | Peer: ${PEER_ID || "none"} | Core: ${CORE_URL}`);

  // Register with rendezvous
  await register();

  // Re-register on keepalive schedule to maintain session
  setInterval(register, KEEPALIVE_MS);

  // Start WebSocket server to accept incoming peer connections
  startServer((ws, addr) => handleConnection(ws, `inbound:${addr}`));

  // If peer specified, poll until found then connect
  if (PEER_ID) {
    log(`Polling for peer "${PEER_ID}"...`);

    const poll = setInterval(async () => {
      const peer = await findPeer(PEER_ID);
      if (!peer) {
        log(`Peer "${PEER_ID}" not yet registered -- retrying...`);
        return;
      }

      clearInterval(poll);
      log(`Peer found: ${peer.deviceId} @ ${peer.ip}:${peer.port}`);

      // Extract clean IP (strip IPv6 prefix if present)
      const cleanIp = peer.ip.replace("::ffff:", "");

      try {
        const ws = await connectToPeer(cleanIp, peer.port);
        handleConnection(ws, `outbound:${peer.deviceId}`);
      } catch (e) {
        warn(`Direct connection failed: ${e.message}`);
        warn(`Peer is behind CGNAT on this interface -- try alternate route`);
      }
    }, POLL_MS);
  }
}

main().catch((e) => {
  console.error("[Bridge] Fatal:", e.message);
  process.exit(1);
});
