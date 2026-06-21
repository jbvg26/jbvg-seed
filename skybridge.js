/**
 * SkyBridge.js
 * JBVG Sovereign Service Resolver
 * Version: 0.2.0
 *
 * Core is Seed Authority. GitHub is only Seed Carrier.
 * SkyBridge.call() is the only way frontend talks to JBVG services.
 *
 * Usage:
 *   const result = await SkyBridge.call("core.auth.exchange", { token: firebaseToken });
 *   const clients = await SkyBridge.call("core.fn.getClients", { uid });
 *   const url = SkyBridge.url("hub.ida.inquiryForm", { email: "x@y.com" });
 */

(function (global) {
  "use strict";

  // ── Constants ─────────────────────────────────────────────────────────────

  const SKYBRIDGE_VERSION = "0.2.0";
  const MANIFEST_CACHE_KEY = "skybridge_manifest_v2";
  const ROUTE_SUCCESS_KEY  = "skybridge_route_success_v2";
  const MANIFEST_TTL_MS    = 1000 * 60 * 30; // 30 minutes

  // Core public key for manifest signature verification.
  // Embedded here so verification never requires a network call.
  // Replace with real Ed25519 public key after Core generates the keypair.
  const CORE_PUBLIC_KEY_B64 = null; // TODO: populate after Core generates keypair

  // ── Internal State ────────────────────────────────────────────────────────

  let _manifest       = null;
  let _manifestLoaded = false;
  let _loadPromise    = null;
  let _authToken      = null;
  let _routeMemory    = {}; // service -> last successful route key

  // ── Boot ──────────────────────────────────────────────────────────────────

  async function _boot() {
    if (_manifestLoaded) return;
    if (_loadPromise) return _loadPromise;

    _loadPromise = (async () => {
      // 1. Try IndexedDB / localStorage cache first
      const cached = _readCache();
      if (cached) {
        _manifest = cached;
        _manifestLoaded = true;
        _log("Manifest loaded from cache");
        // Refresh in background
        _fetchManifest().catch(() => {});
        return;
      }

      // 2. Fetch fresh manifest from seed carrier
      await _fetchManifest();
    })();

    return _loadPromise;
  }

  async function _fetchManifest() {
    const carriers = [
      "/route-manifest.json",                                        // relative (same origin / GitHub Pages)
      "https://seed.jbventuresgroupinc.com/route-manifest.json",    // dedicated seed subdomain
    ];

    let raw = null;
    for (const url of carriers) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (res.ok) {
          raw = await res.json();
          _log("Manifest fetched from: " + url);
          break;
        }
      } catch (_) {}
    }

    if (!raw) {
      _warn("Could not fetch manifest from any carrier. Using last known cache or failing.");
      const stale = _readCache(true);
      if (stale) { _manifest = stale; _manifestLoaded = true; }
      return;
    }

    // Signature verification (when Core public key is populated)
    if (CORE_PUBLIC_KEY_B64 && raw.signature) {
      const valid = await _verifyManifest(raw);
      if (!valid) {
        _warn("Manifest signature invalid -- rejecting.");
        return;
      }
    } else {
      _warn("Manifest signature verification skipped (key not yet configured).");
    }

    _manifest = raw;
    _manifestLoaded = true;
    _writeCache(raw);
  }

  // ── Route Resolution ──────────────────────────────────────────────────────

  function _resolveService(identity) {
    if (!_manifest) throw new Error("SkyBridge: manifest not loaded");

    // identity = "core.auth.exchange" -> service = "core", endpoint key = "core.auth.exchange"
    const parts       = identity.split(".");
    const serviceName = parts[0];
    const service     = _manifest.services[serviceName];

    if (!service) throw new Error(`SkyBridge: unknown service "${serviceName}" in identity "${identity}"`);

    const endpoint = service.endpoints[identity];
    if (!endpoint) throw new Error(`SkyBridge: unknown endpoint identity "${identity}"`);

    return { service, serviceName, endpoint };
  }

  async function _resolveUrl(identity, params) {
    const { service, serviceName, endpoint } = _resolveService(identity);

    // Build priority list, putting last-known-good first
    const memory   = _routeMemory[serviceName];
    const priority = service.priority ? [...service.priority] : Object.keys(service.routes);
    if (memory && priority.includes(memory)) {
      priority.splice(priority.indexOf(memory), 1);
      priority.unshift(memory);
    }

    for (const routeKey of priority) {
      const base = service.routes[routeKey];
      if (!base) continue;

      const url = _buildUrl(base + endpoint.path, params, endpoint.method);

      // Probe reachability with a lightweight HEAD/GET on the base health endpoint
      const reachable = await _probe(base, serviceName);
      if (!reachable) {
        _log(`Route "${routeKey}" unreachable for service "${serviceName}"`);
        continue;
      }

      _routeMemory[serviceName] = routeKey;
      _saveRouteMemory();
      return { url, routeKey, endpoint };
    }

    // Ghost fallback for eligible endpoints
    if (endpoint.ghost_fallback) {
      _log(`All routes failed for "${identity}" -- routing through Ghost`);
      const ghostBase = _manifest.services.ghost?.routes?.public || "https://ghost.jbventuresgroupinc.com";
      return {
        url: ghostBase + "/_cache/queue",
        routeKey: "ghost",
        endpoint,
        ghostMode: true,
        originalIdentity: identity
      };
    }

    throw new Error(`SkyBridge: no reachable route for "${identity}"`);
  }

  // ── Probe Cache ───────────────────────────────────────────────────────────

  const _probeCache = {};
  const PROBE_TTL_MS = 15000; // 15s

  async function _probe(baseUrl, serviceName) {
    const now = Date.now();
    const cached = _probeCache[baseUrl];
    if (cached && (now - cached.ts) < PROBE_TTL_MS) return cached.ok;

    try {
      // Try the health endpoint -- timeout after 3s
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      let probeUrl = baseUrl;
      if (serviceName === "core") probeUrl = baseUrl + "/_health";

      const res = await fetch(probeUrl, {
        method: "GET",
        signal: controller.signal,
        cache: "no-store",
        mode: "cors"
      });
      clearTimeout(timer);
      const ok = res.ok || res.status === 401; // 401 means it's alive, just needs auth
      _probeCache[baseUrl] = { ok, ts: now };
      return ok;
    } catch (_) {
      _probeCache[baseUrl] = { ok: false, ts: now };
      return false;
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * SkyBridge.call(identity, payload, options)
   * The primary method for all JBVG service calls.
   *
   * @param {string} identity   - Service identity e.g. "core.auth.exchange"
   * @param {object} payload    - Request body (POST) or query params (GET)
   * @param {object} options    - { headers, raw } overrides
   * @returns {Promise<any>}    - Parsed JSON response
   */
  async function call(identity, payload = {}, options = {}) {
    await _boot();

    const { service, endpoint, routeKey, url, ghostMode, originalIdentity } =
      await _resolveUrl(identity, endpoint?.method === "GET" ? payload : null);

    const method  = endpoint.method || "POST";
    const headers = {
      "Content-Type": "application/json",
      "X-SkyBridge-Identity": identity,
      "X-SkyBridge-Version": SKYBRIDGE_VERSION,
      ...(options.headers || {})
    };

    if (_authToken) headers["Authorization"] = "Bearer " + _authToken;

    const fetchOpts = { method, headers };

    if (ghostMode) {
      // Wrap the original payload for Ghost queuing
      fetchOpts.body = JSON.stringify({
        identity: originalIdentity,
        payload,
        queued_at: Date.now()
      });
    } else if (method !== "GET" && method !== "HEAD") {
      fetchOpts.body = JSON.stringify(payload);
    }

    _log(`[${routeKey}] ${method} ${url}`);

    const res = await fetch(url, fetchOpts);

    if (options.raw) return res;

    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (_) {
      return text;
    }
  }

  /**
   * SkyBridge.url(identity, params)
   * Build a resolved URL for an identity without making a request.
   * Used for href links, redirects, iframe src, etc.
   *
   * @param {string} identity  - Service identity e.g. "hub.ida.inquiryForm"
   * @param {object} params    - Query string params to append
   * @returns {string}         - Fully resolved URL
   */
  function url(identity, params = {}) {
    if (!_manifestLoaded) {
      _warn("SkyBridge.url() called before manifest loaded -- returning public fallback");
      return _publicFallback(identity, params);
    }
    const { service, serviceName, endpoint } = _resolveService(identity);
    const routeKey = _routeMemory[serviceName] || service.priority?.[service.priority.length - 1] || "public";
    const base = service.routes[routeKey] || service.routes["public"];
    return _buildUrl(base + endpoint.path, params, "GET");
  }

  /**
   * SkyBridge.setToken(token)
   * Set the JBVG JWT for authenticated requests.
   */
  function setToken(token) {
    _authToken = token;
  }

  /**
   * SkyBridge.clearToken()
   */
  function clearToken() {
    _authToken = null;
  }

  /**
   * SkyBridge.status()
   * Returns current resolver state for diagnostics.
   */
  function status() {
    return {
      version: SKYBRIDGE_VERSION,
      manifestLoaded: _manifestLoaded,
      manifestVersion: _manifest?.version || null,
      routeMemory: { ..._routeMemory },
      probeCache: Object.fromEntries(
        Object.entries(_probeCache).map(([k, v]) => [k, { ok: v.ok, ageMs: Date.now() - v.ts }])
      ),
      authTokenSet: !!_authToken
    };
  }

  /**
   * SkyBridge.reload()
   * Force a manifest refresh.
   */
  async function reload() {
    _manifestLoaded = false;
    _loadPromise = null;
    _clearCache();
    await _boot();
  }

  // ── Utilities ─────────────────────────────────────────────────────────────

  function _buildUrl(base, params, method) {
    if (!params || method !== "GET") return base;
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
    ).toString();
    return qs ? `${base}?${qs}` : base;
  }

  function _publicFallback(identity, params) {
    // Hardcoded fallbacks for when manifest isn't loaded yet
    const fallbacks = {
      "core.root":                    "https://core.jbventuresinc.biz",
      "core.auth.exchange":           "https://core.jbventuresinc.biz/auth/exchange",
      "core.auth.login":              "https://core.jbventuresinc.biz/login",
      "core.fn.getClients":           "https://core.jbventuresinc.biz/fn/getClients",
      "core.fn.runTrajectoryAssessment": "https://core.jbventuresinc.biz/fn/runTrajectoryAssessment",
      "core.fn.sendCustomEmail":      "https://core.jbventuresinc.biz/fn/sendCustomEmail",
      "ghost.root":                   "https://ghost.jbventuresgroupinc.com",
      "hub.root":                     "https://hub.jbventuresgroupinc.com",
      "hub.ida.inquiryForm":          "https://hub.jbventuresgroupinc.com/IDA_Inquiry_Form.html",
      "hub.lumina.pay":               "https://hub.jbventuresgroupinc.com/LuminaPay.html",
      "hub.client.dossier":           "https://hub.jbventuresgroupinc.com/client-dossier.html",
      "hub.serve.engagementPacket":   "https://hub.jbventuresgroupinc.com/engagement-packet.html",
      "hub.serve.simulation":         "https://hub.jbventuresgroupinc.com/jbvg-simulation.html",
      "site.root":                    "https://jbventuresgroupinc.com",
    };
    const base = fallbacks[identity] || "#";
    return _buildUrl(base, params, "GET");
  }

  // ── Signature Verification ────────────────────────────────────────────────

  async function _verifyManifest(manifest) {
    if (!CORE_PUBLIC_KEY_B64) return true; // skip if no key configured
    try {
      const { signature, ...payload } = manifest;
      const keyBytes  = _b64ToBytes(CORE_PUBLIC_KEY_B64);
      const dataBytes = new TextEncoder().encode(JSON.stringify(payload));
      const sigBytes  = _b64ToBytes(signature);

      const cryptoKey = await crypto.subtle.importKey(
        "raw", keyBytes, { name: "Ed25519" }, false, ["verify"]
      );
      return await crypto.subtle.verify("Ed25519", cryptoKey, sigBytes, dataBytes);
    } catch (e) {
      _warn("Manifest signature verification error: " + e.message);
      return false;
    }
  }

  function _b64ToBytes(b64) {
    const binary = atob(b64);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // ── Cache ─────────────────────────────────────────────────────────────────

  function _writeCache(manifest) {
    try {
      localStorage.setItem(MANIFEST_CACHE_KEY, JSON.stringify({ manifest, ts: Date.now() }));
    } catch (_) {}
  }

  function _readCache(allowStale = false) {
    try {
      const raw = localStorage.getItem(MANIFEST_CACHE_KEY);
      if (!raw) return null;
      const { manifest, ts } = JSON.parse(raw);
      if (!allowStale && (Date.now() - ts) > MANIFEST_TTL_MS) return null;
      return manifest;
    } catch (_) { return null; }
  }

  function _clearCache() {
    try { localStorage.removeItem(MANIFEST_CACHE_KEY); } catch (_) {}
  }

  function _saveRouteMemory() {
    try {
      localStorage.setItem(ROUTE_SUCCESS_KEY, JSON.stringify(_routeMemory));
    } catch (_) {}
  }

  function _loadRouteMemory() {
    try {
      const raw = localStorage.getItem(ROUTE_SUCCESS_KEY);
      if (raw) _routeMemory = JSON.parse(raw);
    } catch (_) {}
  }

  // ── Logging ───────────────────────────────────────────────────────────────

  function _log(msg)  { if (global.SKYBRIDGE_DEBUG) console.log("[SkyBridge]", msg); }
  function _warn(msg) { console.warn("[SkyBridge]", msg); }

  // ── Init ──────────────────────────────────────────────────────────────────

  _loadRouteMemory();

  // Auto-boot on load
  _boot().catch(e => _warn("Boot error: " + e.message));

  // ── Export ────────────────────────────────────────────────────────────────

  const SkyBridge = { call, url, setToken, clearToken, status, reload, VERSION: SKYBRIDGE_VERSION };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = SkyBridge;
  } else {
    global.SkyBridge = SkyBridge;
  }

})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this);
