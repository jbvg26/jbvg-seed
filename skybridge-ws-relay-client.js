/**
 * skybridge-ws-relay-client.js
 * SkyBridge WebSocket Relay Client
 *
 * Connects to Core's WebSocket relay at:
 *   wss://core.jbventuresinc.biz/_skybridge/ws-relay
 *
 * Both devices connect outbound via HTTPS/WSS.
 * Cloudflare forwards the WebSocket upgrade.
 * Core relays messages between them.
 *
 * Usage:
 *   node skybridge-ws-relay-client.js --device s24-ultra --peer tab-s9
 *   node skybridge-ws-relay-client.js --device tab-s9 --peer s24-ultra
 */

"use strict";

const WebSocket = require("ws");

const args = {};
process.argv.slice(2).forEach((a, i, arr) => {
  if (a.startsWith("--")) args[a.slice(2)] = arr[i + 1];
});

const DEVICE_ID    = args.device || "jbvg-device";
const PEER_ID      = args.peer   || null;
const RELAY_URL    = args.relay  || "wss://relay.jbventuresgroupinc.com/_skybridge/ws-relay";
const KEEPALIVE_MS = parseInt(args.keepalive || "10000");
const RECONNECT_MS = parseInt(args.reconnect || "5000");

const log  = (msg) => console.log(`[SkyBridge:WSRelay:${DEVICE_ID}] ${msg}`);
const warn = (msg) => console.warn(`[SkyBridge:WSRelay:${DEVICE_ID}] WARN: ${msg}`);

let _ws          = null;
let _peerReady   = false;
let _connected   = false;
let _pingInterval = null;

function connect() {
  log(`Connecting to relay: ${RELAY_URL}`);

  _ws = new WebSocket(RELAY_URL);

  _ws.on("open", () => {
    _connected = true;
    log(`Connected to relay`);

    // Register
    _ws.send(JSON.stringify({
      type:     "ws-register",
      deviceId: DEVICE_ID,
      peerId:   PEER_ID
    }));

    // Keepalive
    _pingInterval = setInterval(() => {
      if (_ws.readyState === WebSocket.OPEN) {
        _ws.send(JSON.stringify({ type: "ws-ping", deviceId: DEVICE_ID }));
      }
    }, KEEPALIVE_MS);
  });

  _ws.on("message", (raw) => {
    let pkt;
    try { pkt = JSON.parse(raw.toString()); } catch { return; }

    switch (pkt.type) {

      case "ws-ack":
        log(`Registered. Waiting for peer "${PEER_ID}"...`);
        break;

      case "ws-peer-ready":
        _peerReady = true;
        log(`PATH ESTABLISHED -- peer "${pkt.peerId}" connected via relay`);

        // Send hello
        sendToPeer({
          type:    "hello",
          from:    DEVICE_ID,
          ts:      Date.now(),
          message: `${DEVICE_ID} is sovereign and online via SkyBridge relay`
        });
        break;

      case "ws-data": {
        const payload = pkt.payload;
        if (!payload) return;

        if (payload.type === "ping") {
          sendToPeer({ type: "pong", from: DEVICE_ID, ts: Date.now() });
          return;
        }
        if (payload.type === "pong") return;

        log(`Message from ${pkt.deviceId}: ${JSON.stringify(payload)}`);
        break;
      }

      case "ws-pong":
        // Keepalive acknowledged
        break;

      case "ws-error":
        warn(`Relay error: ${pkt.reason} (peer: ${pkt.peerId})`);
        break;
    }
  });

  _ws.on("close", () => {
    _connected = false;
    _peerReady = false;
    if (_pingInterval) clearInterval(_pingInterval);
    log(`Disconnected. Reconnecting in ${RECONNECT_MS}ms...`);
    setTimeout(connect, RECONNECT_MS);
  });

  _ws.on("error", (e) => {
    warn(`WebSocket error: ${e.message}`);
  });
}

function sendToPeer(payload) {
  if (!_peerReady || !_ws || _ws.readyState !== WebSocket.OPEN) {
    warn("Cannot send -- peer not ready");
    return;
  }
  _ws.send(JSON.stringify({
    type:     "ws-data",
    deviceId: DEVICE_ID,
    peerId:   PEER_ID,
    payload
  }));
}

// Ping peer periodically once connected
setInterval(() => {
  if (_peerReady) {
    sendToPeer({ type: "ping", from: DEVICE_ID, ts: Date.now() });
  }
}, KEEPALIVE_MS);

log(`Starting SkyBridge WebSocket Relay Client`);
log(`Device: ${DEVICE_ID} | Peer: ${PEER_ID || "none"} | Relay: ${RELAY_URL}`);
connect();
