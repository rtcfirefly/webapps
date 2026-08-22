'use strict';
/* ------------------------------------------------------------------------
 * video-delay — phone camera -> PC screen, on a delay. Zero dependencies.
 *
 * Transport : WebRTC (public STUN, public TURN fallback)
 * Signalling: the PeerJS public cloud broker, spoken directly over a
 *             WebSocket (no peerjs library). Swappable; manual copy/paste
 *             pairing is always available as a fallback.
 * Delay     : MediaRecorder chunks the incoming stream, the chunks sit in a
 *             queue for N seconds, then get fed to a MediaSource that the
 *             <video> is playing. Buffer is bytes, not frames, so 30 s of
 *             720p costs ~10 MB rather than ~3 GB.
 * ---------------------------------------------------------------------- */

const $ = (s, r = document) => r.querySelector(s);
const params = new URLSearchParams(location.search);
const MSImpl = window.ManagedMediaSource || window.MediaSource;
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const now = () => performance.now();

const store = {
  get(k, d) { try { const v = localStorage.getItem('vd.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('vd.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

function toast(msg, ms = 3400) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

/* --------------------------------------------------------------- debug  */
/* An on-screen ring buffer, so a phone with no devtools can still produce
 * something worth reading. Addresses are reduced to their first octet: the
 * candidate type and protocol are what diagnose a connection, the rest is
 * just the user's network splashed into a pastebin. */

const T0 = now();
const LOG = [];
let dbgPre = null;

function fmtArg(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.name + ': ' + a.message;
  try { const s = JSON.stringify(a); return s && s.length > 400 ? s.slice(0, 400) + '\u2026' : s; }
  catch { return String(a); }
}

function dbg(...args) {
  const t = ((now() - T0) / 1000).toFixed(2).padStart(8);
  const line = t + '  ' + args.map(fmtArg).join(' ');
  LOG.push(line);
  if (LOG.length > 800) LOG.splice(0, LOG.length - 800);
  if (dbgPre) {
    dbgPre.textContent = LOG.slice(-250).join('\n');
    dbgPre.scrollTop = dbgPre.scrollHeight;
  }
  console.log('[vd]' + line);
}

function redactAddr(a) {
  if (!a) return '?';
  if (/\.local$/i.test(a)) return 'mdns.local';
  if (a.includes(':')) return 'ipv6';
  const p = a.split('.');
  return p.length === 4 ? p[0] + '.x.x.x' : 'addr';
}

function candInfo(c) {
  const typ = c.type || ((/ typ (\w+)/.exec(c.candidate || '') || [])[1]) || '?';
  return typ + ' ' + (c.protocol || '?') + ' ' + redactAddr(c.address) +
    (c.relatedAddress ? ' via ' + redactAddr(c.relatedAddress) : '') +
    (c.url ? ' [' + c.url + ']' : '');
}

function sdpSummary(d) {
  const sdp = (d && d.sdp) || '';
  const mids = (sdp.match(/^m=(\w+)/gm) || []).map(s => s.slice(2));
  const cands = (sdp.match(/^a=candidate:/gm) || []).length;
  return d.type + ' ' + sdp.length + 'B mlines=[' + mids.join(',') + '] inline-candidates=' + cands;
}

function logSdp(tag, d) {
  dbg(tag, sdpSummary(d));
  const box = $('#dbgSdp');
  if (box && box.checked) dbg(tag, 'full sdp:\n' + d.sdp);
}

function logPC(pc, tag) {
  pc.addEventListener('iceconnectionstatechange', () => dbg(tag, 'iceConnectionState =', pc.iceConnectionState));
  pc.addEventListener('icegatheringstatechange', () => dbg(tag, 'iceGatheringState =', pc.iceGatheringState));
  pc.addEventListener('signalingstatechange', () => dbg(tag, 'signalingState =', pc.signalingState));
  pc.addEventListener('connectionstatechange', () => {
    dbg(tag, 'connectionState =', pc.connectionState);
    if (pc.connectionState === 'connected') logSelectedPair(pc, tag);
  });
  pc.addEventListener('icecandidate', e => dbg(tag, 'local candidate:', e.candidate ? candInfo(e.candidate) : '(gathering complete)'));
  pc.addEventListener('icecandidateerror', e =>
    dbg(tag, 'ICE ERROR code=' + e.errorCode, e.errorText || '', 'url=' + (e.url || '?')));
}

async function logSelectedPair(pc, tag) {
  try {
    const rep = await pc.getStats();
    let pair = null;
    rep.forEach(r => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = rep.get(r.selectedCandidatePairId); });
    if (!pair) rep.forEach(r => { if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) pair = r; });
    if (!pair) { dbg(tag, 'no selected candidate pair yet'); return; }
    const l = rep.get(pair.localCandidateId), r = rep.get(pair.remoteCandidateId);
    const d = c => c ? c.candidateType + '/' + (c.protocol || '?') + (c.relayProtocol ? '(' + c.relayProtocol + ')' : '') : '?';
    dbg(tag, 'SELECTED PAIR:', d(l), '<->', d(r),
      'rtt=' + (pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) + 'ms' : '?'),
      l && l.candidateType === 'relay' ? '(via TURN)' : '');
  } catch (e) { dbg(tag, 'getStats failed', e); }
}

function logHeader() {
  const cap = [];
  for (const t of ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/mp4;codecs=avc1.42E01E']) {
    const r = window.MediaRecorder && MediaRecorder.isTypeSupported(t);
    const m = MSImpl && MSImpl.isTypeSupported(t);
    cap.push(t.replace('video/', '').replace(';codecs=', ':') + '=' + (r ? 'R' : '-') + (m ? 'M' : '-'));
  }
  return [
    'video-delay debug log',
    'when      : ' + new Date().toISOString(),
    'page      : ' + location.href,
    'ua        : ' + navigator.userAgent,
    'secure    : ' + window.isSecureContext + '   screen: ' + screen.width + 'x' + screen.height + '@' + devicePixelRatio,
    'broker    : ' + SIGNAL_URL,
    'ice       : ' + (store.get('ice', '') ? 'custom' : 'default (google + cloudflare STUN, no TURN)'),
    'MSImpl    : ' + (MSImpl ? MSImpl.name : 'none') + '   MediaRecorder: ' + (window.MediaRecorder ? 'yes' : 'no'),
    'codecs    : ' + cap.join('  ') + '   (R=MediaRecorder M=MediaSource)',
    'room      : ' + (V.room || C.room || '-'),
    'delay     : ' + (D.delayMs / 1000) + 's   bypass=' + D.bypass + '   mime=' + (D.mime || '-'),
    ''.padEnd(60, '-'),
  ].join('\n');
}

/* ----------------------------------------------------------------- ICE  */

const DEFAULT_ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    // stun1..stun4.l.google.com resolve to the same IPv4 and IPv6 addresses as
    // stun.l.google.com -- one box, so listing them buys no redundancy, only
    // duplicate gathering work. Cloudflare's is the only anonymous STUN with a
    // primary-source "free and unlimited" guarantee; port 53 survives networks
    // that drop 3478. Nextcloud's is a third operator, on 443, for the worst
    // firewalls.
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
    { urls: 'stun:stun.nextcloud.com:443' },
    // No TURN by default. The openrelay.metered.ca servers that used to be here
    // no longer resolve at all (every URL returned ICE error 701, "host lookup
    // received error", 2026-08-22) -- they only added ~50 failed lookups and a
    // gathering delay. There is no free TURN worth trusting; if you need a relay
    // because the two devices cannot see each other directly, put your own
    // credentials in Advanced -> ICE servers.
  ],
  iceCandidatePoolSize: 2,
};

function iceConfig() {
  const raw = (store.get('ice', '') || '').trim();
  if (raw) { try { return JSON.parse(raw); } catch { toast('ICE JSON is invalid — using defaults'); } }
  return DEFAULT_ICE;
}

/* Chrome offers VP8, VP9, AV1 and four H.264 profiles, each with its own
 * rtpmap/fmtp/rtcp-fb lines -- that codec list is most of a ~6 KB SDP. The
 * public broker cleanly closes the socket on an offer that size (observed: a
 * 6414 B send followed 200 ms later by close code 1000), and it is far too big
 * for a scannable QR. Pinning negotiation to VP8 + rtx cuts the SDP to roughly a
 * quarter. VP8 is also what the delay buffer re-encodes to, so this keeps one
 * codec end to end. */
function slimCodecs(pc) {
  try {
    const caps = { video: RTCRtpReceiver.getCapabilities('video'), audio: RTCRtpReceiver.getCapabilities('audio') };
    const want = { video: /\/(VP8|rtx)$/i, audio: /\/opus$/i };
    for (const t of pc.getTransceivers()) {
      const kind = (t.receiver && t.receiver.track && t.receiver.track.kind) ||
                   (t.sender && t.sender.track && t.sender.track.kind);
      const cap = caps[kind];
      if (!cap || !t.setCodecPreferences) continue;
      const keep = cap.codecs.filter(c => want[kind].test(c.mimeType));
      if (keep.length) t.setCodecPreferences(keep);
    }
  } catch (e) { dbg('codec', 'setCodecPreferences failed', e); }
}

/* --------------------------------------------------------- signalling  */

const SIGNAL_URL = params.get('signal') || store.get('signal', '') || 'wss://0.peerjs.com/peerjs';

/* Minimal client for the PeerJS broker protocol. The broker only relays:
 * we send {type, dst, payload}, the destination peer receives
 * {type, src, payload}. The payload is ours to define.               */
class Signal extends EventTarget {
  constructor(id) { super(); this.id = id; this.ws = null; this.hb = 0; }

  open() {
    return new Promise((resolve, reject) => {
      const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
      const url = `${SIGNAL_URL}?key=peerjs&id=${encodeURIComponent(this.id)}&token=${token}&version=1.5.4`;
      dbg('sig', 'opening as', this.id, 'to', SIGNAL_URL);
      let ws;
      try { ws = this.ws = new WebSocket(url); } catch (e) { dbg('sig', 'construct failed', e); reject(e); return; }
      let settled = false, live = false;
      const fail = (e) => { if (settled) return; settled = true; clearTimeout(timer); dbg('sig', 'open failed:', e.message); reject(e); try { ws.close(); } catch {} };

      const timer = setTimeout(() => fail(new Error('signalling timed out')), 12000);

      ws.onopen = () => { this.hb = setInterval(() => this.raw({ type: 'HEARTBEAT' }), 5000); };
      ws.onerror = () => fail(new Error('signalling connection failed'));
      ws.onclose = (ev) => {
        clearInterval(this.hb);
        dbg('sig', 'socket closed code=' + ev.code, 'reason=' + (ev.reason || '(none)'), 'clean=' + ev.wasClean, 'wasOpen=' + live);
        if (!settled) fail(new Error('signalling closed'));
        else if (live) { live = false; this.dispatchEvent(new Event('down')); }
      };
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'OPEN') { clearTimeout(timer); settled = true; live = true; dbg('sig', 'OPEN as', this.id); resolve(); return; }
        if (m.type === 'ID-TAKEN') { fail(new Error('ID-TAKEN')); return; }
        dbg('sig', 'recv', m.type, 'from', m.src || '(server)', ev.data.length + 'B');
        this.dispatchEvent(new CustomEvent('msg', { detail: m }));
      };
    });
  }

  raw(o) {
    const s = JSON.stringify(o);
    if (!this.ws || this.ws.readyState !== 1) {
      if (o.type !== 'HEARTBEAT') dbg('sig', 'DROPPED send', o.type, '- socket state', this.ws ? this.ws.readyState : 'null');
      return;
    }
    if (o.type !== 'HEARTBEAT') dbg('sig', 'send', o.type, 'to', o.dst, s.length + 'B');
    this.ws.send(s);
  }
  send(type, dst, payload) { this.raw({ type, dst, payload }); }
  close() { clearInterval(this.hb); try { this.ws && this.ws.close(); } catch {} this.ws = null; }
}

/* Codes avoid 0/O and 1/I so they can be read off a screen and typed. */
const ALPHA = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const newRoom = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => ALPHA[b % 32]).join('');
const rand4 = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), b => ALPHA[b % 32]).join('');
const viewerId = room => `vd-${room}-v`;
const cameraId = room => `vd-${room}-c${rand4()}`;

/* Real PeerJS clients wrap payloads with connectionId / type / browser. We had
 * been sending a bare {sdp}. A broker that validates the shape would explain
 * both the refusal to relay and the disconnect, and the extra fields cost
 * nothing, so send what the protocol's own client sends. */
let connId = 'mc_' + Math.random().toString(36).slice(2, 11);
const peerPayload = extra => Object.assign({ type: 'media', connectionId: connId, browser: 'Chrome', metadata: null }, extra);

/* ---------------------------------------------------------------- SDP  */

/* Gather ICE fully before sending, so a single blob is enough to connect.
 * Late candidates are still trickled when a broker is available. */
function waitIce(pc, ms = 4000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise(res => {
    const done = () => { clearTimeout(t); pc.removeEventListener('icegatheringstatechange', check); res(); };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    const t = setTimeout(done, ms);
    pc.addEventListener('icegatheringstatechange', check);
  });
}
const sdpJson = d => ({ type: d.type, sdp: d.sdp });

/* Manual pairing codes. deflate-raw rather than gzip (no 18-byte header and
 * trailer to pay for), base64url so the code drops straight into a URL
 * fragment and therefore into a QR. With slimCodecs() upstream this lands a
 * pairing payload in the high hundreds of chars -- a QR around version 20,
 * which a phone reads off a monitor without complaint. */
const B64 = {
  enc: u8 => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  dec: s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)),
};
async function squeeze(bytes, fmt) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream(fmt))).arrayBuffer());
}
async function expand(bytes, fmt) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream(fmt))).arrayBuffer());
}
async function pack(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  if (!window.CompressionStream) return 'J' + B64.enc(bytes);
  return 'D' + B64.enc(await squeeze(bytes, 'deflate-raw'));
}
async function unpack(str) {
  let s = (str || '').trim();
  const hash = s.lastIndexOf('#p=');            // tolerate a whole pasted URL
  if (hash >= 0) s = s.slice(hash + 3);
  s = s.replace(/\s+/g, '');
  if (!s) return null;
  const body = B64.dec(s.slice(1));
  const fmt = s[0] === 'D' ? 'deflate-raw' : s[0] === 'Z' ? 'gzip' : null;
  const json = fmt ? await expand(body, fmt) : body;
  return JSON.parse(new TextDecoder().decode(json));
}

/* Manual pairing means the two devices are in the same room by definition --
 * you are holding a phone up to a screen. Host and reflexive candidates are
 * enough, and every server dropped here is bytes off the QR. */
const MANUAL_ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], iceCandidatePoolSize: 0 };

/* Chrome emits TCP host candidates on port 9 ("tcptype active" placeholders).
 * They are no use for a LAN pairing and cost ~120 bytes of QR, so they are left
 * out of what gets transmitted. The local description keeps them. */
const forTransmit = sdp => sdp.split('\n').filter(l => !/^a=candidate:\S+ \d+ tcp /i.test(l)).join('\n');

/* ============================== DELAY LINE ============================== */

const KEEP_BEHIND = 40;   // seconds of already-played video kept for replay
const TARGET_LEAD = 0.35; // seconds the playhead sits behind the buffer edge

/* Two feeds run identical, independent pipelines: the phone (the main panes)
 * and the PC's own webcam (the self-view tiles). Everything below takes the
 * line it operates on, so nothing is shared but the delay setting. */
function makeLine(name, bitrate) {
  return {
    name, bitrate,
    video: null, stream: null,
    rec: null, ms: null, sb: null, mime: '', objUrl: '', onDecoded: null,
    queue: [],      // {t, buf} — waiting out the delay
    pending: [],    // ArrayBuffers ready to append
    delayMs: 30000,
    live: true,     // false while the user is scrubbing back through the buffer
    frozen: false,
    timer: 0, restart: 0, lastLog: 0,
    lastAppend: 0, everDecoded: false, watchdogDone: false, wantEdge: false,
    lastCapture: 0, lastSeek: 0, lastTime: -1, lastMove: 0,
    firstRelease: 0,
    bypass: false,  // true if we gave up and fell back to undelayed playback
  };
}

const D = makeLine('phone', 3_000_000);
const W = makeLine('webcam', 1_200_000);   // a small tile: no need for 3 Mb/s
const LINES = [D, W];

function pickMime(hasAudio) {
  const list = [];
  for (const v of ['vp8', 'vp9']) list.push(hasAudio ? `video/webm;codecs=${v},opus` : `video/webm;codecs=${v}`);
  list.push('video/webm');
  list.push(hasAudio ? 'video/mp4;codecs=avc1.42E01E,mp4a.40.2' : 'video/mp4;codecs=avc1.42E01E');
  list.push('video/mp4');
  if (!window.MediaRecorder || !MSImpl) return null;
  return list.find(t => MediaRecorder.isTypeSupported(t) && MSImpl.isTypeSupported(t)) || null;
}

function stopDelay(d) {
  clearInterval(d.timer); d.timer = 0;
  clearTimeout(d.restart);
  if (d === D) clearTimeout(attachRemote.t);
  if (d.video && d.onDecoded) {
    d.video.removeEventListener('loadeddata', d.onDecoded);
    d.video.removeEventListener('playing', d.onDecoded);
  }
  if (d.objUrl) { try { URL.revokeObjectURL(d.objUrl); } catch {} d.objUrl = ''; }
  // stop() flushes one last dataavailable ASYNCHRONOUSLY, after this function
  // has cleared d.queue and after startDelay has already built the replacement
  // recorder. That orphan is a bare WebM cluster with no init segment, so it
  // became the first append of the new pipeline and killed it with "media
  // segment received without an init segment" -- a recovery path that instantly
  // re-bypassed. Detach before stopping.
  if (d.rec) { d.rec.ondataavailable = null; d.rec.onerror = null; }
  try { d.rec && d.rec.state !== 'inactive' && d.rec.stop(); } catch {}
  try { d.ms && d.ms.readyState === 'open' && d.ms.endOfStream(); } catch {}
  if (d.video) { d.video.removeAttribute('src'); d.video.srcObject = null; try { d.video.load(); } catch {} }
  d.rec = d.ms = d.sb = null; d.queue = []; d.pending = [];
  d.live = true; d.frozen = false; d.bypass = false; d.firstRelease = 0;
  d.everDecoded = false; d.watchdogDone = false;
  d.lastAppend = 0; d.lastSeek = 0; d.lastTime = -1; d.lastMove = 0;
  d.wantEdge = false; d.lastCapture = 0;
}

function bypassToLive(d, why) {
  if (d.bypass) return;
  dbg(d.name, 'BYPASS to live video:', why);
  d.bypass = true;
  clearInterval(d.timer); d.timer = 0;
  setDelayTag();
  try { d.rec && d.rec.state !== 'inactive' && d.rec.stop(); } catch {}
  d.video.removeAttribute('src');
  d.video.srcObject = d.stream;
  d.video.play().catch(() => {});
  // updateOverlay/updateHud only run from pump(), which the clearInterval above
  // just killed -- and the watchdog is the last statement in pump(), so this
  // tick's overlay pass already ran with bypass still false. Without this the
  // user reads "filling the 30s buffer..." over live video, forever.
  if (d === D) { updateOverlay(); updateHud(); }
  toast(d.name + ': delay buffer unavailable (' + why + ') — showing live video');
}

function startDelay(d, stream, video) {
  stopDelay(d);
  d.stream = stream; d.video = video;

  dbg(d.name, 'stream: video=' + stream.getVideoTracks().length, 'audio=' + stream.getAudioTracks().length);
  const mime = pickMime(stream.getAudioTracks().length > 0);
  dbg(d.name, 'chosen mime =', mime || '(none)');
  if (!mime) { bypassToLive(d, 'no MediaRecorder/MediaSource codec in common'); return; }
  d.mime = mime;

  let rec;
  try { rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: d.bitrate }); }
  catch (e) { bypassToLive(d, 'MediaRecorder: ' + e.name); return; }
  d.rec = rec;

  rec.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    // Keep queue order stable: reserve the slot now, fill it when the
    // Blob resolves. A chunk is only released once its bytes are in.
    const slot = { t: now(), buf: null };
    d.queue.push(slot);
    e.data.arrayBuffer().then(b => { slot.buf = b; }, () => { slot.buf = new ArrayBuffer(0); });
  };
  rec.onerror = (e) => bypassToLive(d, 'recorder error' + (e.error ? ': ' + e.error.name : ''));
  rec.start(200);

  const ms = new MSImpl();
  d.ms = ms;
  if (window.ManagedMediaSource && ms instanceof window.ManagedMediaSource) {
    video.disableRemotePlayback = true;
    video.srcObject = ms;
  } else {
    d.objUrl = URL.createObjectURL(ms);
    video.src = d.objUrl;
  }

  // Bound once and removed in stopDelay: re-added per start, these leaked a
  // pair on every reconnect and every bypass-recovery restart.
  d.onDecoded = (ev) => {
    if (!d.everDecoded) { d.everDecoded = true; d.watchdogDone = true; dbg(d.name, 'first decode (' + ev.type + ') - startup watchdog disarmed'); }
  };
  video.addEventListener('loadeddata', d.onDecoded);
  video.addEventListener('playing', d.onDecoded);

  ms.addEventListener('sourceopen', () => {
    let sb;
    try { sb = ms.addSourceBuffer(rec.mimeType || mime); }
    catch (e) { bypassToLive(d, 'addSourceBuffer: ' + e.name); return; }
    dbg(d.name, 'sourceopen, SourceBuffer for', rec.mimeType || mime);
    try { sb.mode = 'sequence'; } catch (e) { dbg(d.name, 'sb.mode=sequence rejected', e); }
    sb.addEventListener('updateend', () => { step(d); maintain(d); });
    sb.addEventListener('error', () => bypassToLive(d, 'source buffer error'));
    d.sb = sb;
    step(d);
  }, { once: true });

  d.timer = setInterval(() => pump(d), 100);
}

function pump(d) {
  const t = now();
  // A chunk whose arrayBuffer() never settles would otherwise stall the whole
  // line forever, silently. Give up on it after 5s past its due time.
  const head = d.queue[0];
  if (head && !head.buf && (t - head.t) > d.delayMs + 5000) {
    dbg(d.name, 'head chunk never resolved after 5s - discarding to unblock the line');
    head.buf = new ArrayBuffer(0);
  }
  while (d.queue.length && d.queue[0].buf && (t - d.queue[0].t) >= d.delayMs) {
    const c = d.queue.shift();
    if (c.buf.byteLength) { d.pending.push(c.buf); d.lastCapture = c.t; }
    else dbg(d.name, 'dropped an empty chunk - the stream now has a hole here');
    if (!d.firstRelease) d.firstRelease = t;
  }
  step(d);
  maintain(d);
  if (d === D) { updateOverlay(); updateHud(); }
  setDelayTag();

  if (t - d.lastLog > 5000) {
    d.lastLog = t;
    const v = d.video, sb = d.sb;
    const b = sb && sb.buffered.length
      ? sb.buffered.start(0).toFixed(1) + '-' + sb.buffered.end(sb.buffered.length - 1).toFixed(1) : 'none';
    dbg(d.name, 'queue=' + d.queue.length, 'pending=' + d.pending.length, 'buffered=' + b,
      't=' + (v ? v.currentTime.toFixed(1) : '?'), 'rs=' + (v ? v.readyState : '?'),
      'paused=' + (v ? v.paused : '?'), 'set=' + (d.delayMs / 1000) + 's',
      'live=' + d.live, 'frozen=' + d.frozen,
      'sinceAppend=' + (d.lastAppend ? Math.round(t - d.lastAppend) + 'ms' : '-'));
  }

  // Startup watchdog: if the recorder/MSE codec pairing turns out to be lying,
  // show live video rather than a black rectangle.
  //
  // This must only ever fire BEFORE anything has decoded. firstRelease is set
  // once and never reset, so without the everDecoded guard the test decayed
  // into a bare "readyState < 2" that stayed armed for the whole session --
  // and raising the delay deliberately starves the buffer, which is precisely
  // the condition that drops readyState. Starving on purpose is not a codec
  // failure.
  // One-shot by construction rather than by three conjoined conditions staying
  // correct forever: "did the codec pairing ever work" is answerable once.
  if (d.video && d.video.readyState >= 2) { d.everDecoded = true; d.watchdogDone = true; }
  const withholding = d.queue.length > 0 && (t - d.queue[0].t) < d.delayMs;
  if (!d.watchdogDone && d.firstRelease && !d.bypass && !withholding &&
      t - d.firstRelease > 6000 && d.video.readyState < 2) {
    d.watchdogDone = true;
    bypassToLive(d, 'nothing decodable in the first 6s');
  }
}

function step(d) {
  const { sb, ms, video } = d;
  if (!sb || !ms || ms.readyState !== 'open' || sb.updating) return;

  // Drop what has already been played, well behind the replay window.
  if (sb.buffered.length) {
    const s0 = sb.buffered.start(0);
    const keep = Math.max(0, video.currentTime - KEEP_BEHIND);
    if (keep - s0 > 5) { try { sb.remove(s0, keep); return; } catch {} }
  }

  if (!d.pending.length) return;
  const buf = d.pending.shift();
  try {
    sb.appendBuffer(buf);
    d.lastAppend = now();
  } catch (e) {
    if (e && e.name === 'QuotaExceededError') {
      d.pending.unshift(buf);
      try {
        // remove(start, end) with end <= start throws InvalidAccessError, which
        // left the quota unrelieved and the same buffer retried forever.
        if (sb.buffered.length) {
          const s0 = sb.buffered.start(0), to = video.currentTime - 5;
          if (to > s0) sb.remove(s0, to);
          else dbg(d.name, 'quota hit but nothing safe to evict', s0.toFixed(1), to.toFixed(1));
        }
      } catch (err) { dbg(d.name, 'quota eviction failed', err); }
    } else {
      dbg(d.name, 'appendBuffer failed', e);
    }
  }
}

function seekToEdge(d) {
  const { sb, video } = d;
  if (!sb || !video || !sb.buffered.length) return;
  const start = sb.buffered.start(0), end = sb.buffered.end(sb.buffered.length - 1);
  video.currentTime = Math.max(start + 0.05, end - TARGET_LEAD);
  d.lastSeek = now();
  video.play().catch(() => {});
}

function maintain(d) {
  const { sb, video } = d;
  if (!sb || !sb.buffered.length) return;
  const start = sb.buffered.start(0);
  const end = sb.buffered.end(sb.buffered.length - 1);

  if (d.frozen) return;
  if (video.currentTime < start) video.currentTime = start + 0.05;

  const lead = end - video.currentTime;
  // Re-seek only once the burst of appends a delay change produces has fully
  // drained, and at most every 400 ms. Seeking on every updateend pins
  // readyState below HAVE_CURRENT_DATA and the picture never comes back.
  // A shortened delay must always take effect, even by 1s: that releases only
  // ~1s of backlog, leaving a lead below the 2.5s snap threshold, so without
  // the explicit flag the change was silently absorbed.
  const drained = !d.pending.length && !sb.updating;
  if (d.wantEdge && drained) { d.wantEdge = false; seekToEdge(d); }
  else if (d.live && lead > 2.5 && drained && now() - d.lastSeek > 400) {
    dbg(d.name, 'seek to live edge: lead was', lead.toFixed(2) + 's');
    seekToEdge(d);
  }
  // Scrubbed back and left there: don't let the buffer run away.
  if (!d.live && lead > KEEP_BEHIND + 60) { d.live = true; if (d === D) setLiveBtn(); }

  if (video.paused && end - video.currentTime > 0.15) video.play().catch(() => {});
}

/* ------------------------------------------------- the PC's own webcam  */

const CAM = { stream: null, on: false };

/* One geometry shared by both tiles, as percentages of their pane, so they stay
 * symmetric and survive a resize of the window or a change of layout. */
const PIP = Object.assign({ x: 62, y: 66, w: 34 }, store.get('pip', {}));

function applyPip() {
  for (const el of [$('#pipLive'), $('#pipDelay')]) {
    el.style.width = PIP.w + '%';
    el.style.left = PIP.x + '%';
    el.style.top = PIP.y + '%';
  }
}

function pipDrag(el) {
  let mode = null, grabX = 0, grabY = 0, pane = null;

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    mode = e.target.classList.contains('grip') ? 'size' : 'move';
    pane = el.parentElement.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    grabX = e.clientX - r.left;
    grabY = e.clientY - r.top;
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    e.preventDefault();
  });

  el.addEventListener('pointermove', (e) => {
    if (!mode) return;
    if (mode === 'move') {
      // Clamp against the tile's own measured size so it cannot be dragged
      // off its pane, whatever the pane's aspect ratio happens to be.
      const wPct = el.offsetWidth / pane.width * 100;
      const hPct = el.offsetHeight / pane.height * 100;
      PIP.x = clamp((e.clientX - grabX - pane.left) / pane.width * 100, 0, Math.max(0, 100 - wPct));
      PIP.y = clamp((e.clientY - grabY - pane.top) / pane.height * 100, 0, Math.max(0, 100 - hPct));
    } else {
      const left = pane.left + PIP.x / 100 * pane.width;
      PIP.w = clamp((e.clientX - left) / pane.width * 100, 10, 70);
    }
    applyPip();
  });

  const end = (e) => {
    if (!mode) return;
    mode = null;
    el.classList.remove('dragging');
    try { el.releasePointerCapture(e.pointerId); } catch {}
    store.set('pip', { x: PIP.x, y: PIP.y, w: PIP.w });
    dbg('pip', 'x=' + PIP.x.toFixed(0) + '% y=' + PIP.y.toFixed(0) + '% w=' + PIP.w.toFixed(0) + '%');
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);

  el.addEventListener('dblclick', () => {
    Object.assign(PIP, { x: 62, y: 66, w: 34 });
    applyPip();
    store.set('pip', { x: PIP.x, y: PIP.y, w: PIP.w });
    toast('Self-view reset');
  });
}

async function toggleWebcam(want) {
  const on = want === undefined ? !CAM.on : want;
  if (!on) {
    stopDelay(W);
    if (CAM.stream) CAM.stream.getTracks().forEach(t => t.stop());
    CAM.stream = null; CAM.on = false;
    $('#selfLive').srcObject = null;
    $('#pipLive').hidden = true; $('#pipDelay').hidden = true;
    $('#btnSelf').classList.remove('on');
    store.set('webcam', false);
    dbg('webcam', 'off');
    return;
  }
  try {
    // No audio: this is a silent self-view sitting next to speakers, and a
    // second microphone in the room is a feedback loop waiting to happen.
    CAM.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } },
      audio: false,
    });
  } catch (e) {
    dbg('webcam', 'getUserMedia failed', e);
    toast('No webcam available: ' + e.name);
    return;
  }
  CAM.on = true;
  $('#pipLive').hidden = false; $('#pipDelay').hidden = false;
  $('#btnSelf').classList.add('on');
  $('#selfLive').srcObject = CAM.stream;
  $('#selfLive').play().catch(() => {});
  startDelay(W, CAM.stream, $('#selfDelay'));
  store.set('webcam', true);
  dbg('webcam', 'on, tracks:', CAM.stream.getVideoTracks().map(t => JSON.stringify(t.getSettings())).join(' '));
}

/* ============================== VIEWER UI ============================== */

const V = { sig: null, pc: null, room: '', peer: null, manual: false, reoffer: 0, pendingCands: [], stats: null, statsTimer: 0 };

function show(id) {
  for (const s of document.querySelectorAll('.view')) s.hidden = (s.id !== id);
}

function setSig(text, cls) {
  dbg('viewer', 'status:', text);
  const el = $('#sigState');
  el.textContent = text;
  el.className = 'pill' + (cls ? ' ' + cls : '');
}

const QUEUE_BUDGET = 220 * 1048576;   // bytes of undelivered chunks we will hold

function setDelay(sec, persist = true) {
  sec = clamp(Math.round(sec) || 0, 0, 600);
  // The queues are the delay. At 3 Mb/s plus the webcam's 1.2 Mb/s, ten minutes
  // is ~315 MB of ArrayBuffers and a killed tab, so cap the delay by a byte
  // budget rather than discovering the limit the hard way.
  const bytesPerSec = (LINES.filter(d => d.stream).reduce((n, d) => n + d.bitrate, 0) || 3_000_000) / 8;
  const maxSec = Math.floor(QUEUE_BUDGET / bytesPerSec);
  if (sec > maxSec) {
    dbg('delay', 'clamped', sec + 's ->', maxSec + 's by the ' + Math.round(QUEUE_BUDGET / 1048576) + ' MB queue budget');
    if (!setDelay.warned) { setDelay.warned = true; toast('Delay capped at ' + maxSec + 's — beyond that the buffer would exceed ' + Math.round(QUEUE_BUDGET / 1048576) + ' MB'); }
    sec = maxSec;
  }
  const changed = D.delayMs !== sec * 1000;
  if (changed) dbg('delay', 'set to', sec + 's');
  // One delay for both feeds: the point of the self-view is to sit beside the
  // phone's delayed picture at the same offset.
  for (const d of LINES) {
    if (changed && sec * 1000 < d.delayMs && d.live) d.wantEdge = true;
    d.delayMs = sec * 1000;
    // Bypass used to be terminal: once it fired, only a reload brought the
    // delay back. Touching the delay is an unambiguous request for a delayed
    // picture, so take it as a cue to rebuild the pipeline.
    if (changed && d.bypass && d.stream && d.video) {
      dbg(d.name, 'delay changed while bypassed - restarting the pipeline');
      const s = d.stream, v = d.video, line = d;
      clearTimeout(d.restart);
      d.restart = setTimeout(() => startDelay(line, s, v), 250);
    }
  }
  $('#delay').value = sec;
  $('#delayNum').value = sec;
  setDelayTag();
  if (persist) store.set('delay', sec);
}

function setLiveBtn() { $('#btnLive').classList.toggle('on', !D.live); }

/* split  — live left, delayed right. Two portrait feeds on a squarish screen.
 * delayed — delayed only, full stage.
 * pip     — delayed full stage with the live feed as a corner thumbnail. */
const LAYOUTS = {
  split:   { label: '\u25A5\u00A0Split',   on: true  },
  delayed: { label: '\u25A4\u00A0Delayed', on: false },
  pip:     { label: '\u25A3\u00A0PiP',     on: true  },
};
function setLayout(l) {
  if (!LAYOUTS[l]) l = 'split';
  $('#stage').dataset.layout = l;
  $('#btnLayout').innerHTML = LAYOUTS[l].label;
  $('#btnLayout').classList.toggle('on', LAYOUTS[l].on);
  store.set('layout', l);
  dbg('viewer', 'layout =', l);
  if (l !== 'delayed') $('#pip').play().catch(() => {});
}

function setDelayTag() {
  const s = Math.round(D.delayMs / 1000);
  $('#delayTag').textContent = D.bypass ? 'live (no delay)' : (s ? s + 's delay' : 'no delay');
  $('#selfTag').textContent = W.bypass ? 'you \u00b7 live' : 'you \u00b7 ' + s + 's';
  $('#fsVal').textContent = s + 's';
}

/* Fullscreen hides the toolbar, so the in-stage bar carries the delay there.
 * It fades out with the cursor after a few idle seconds and comes back on any
 * pointer movement or key. */
function fsIdleWatch() {
  const stage = $('#stage');
  const wake = () => {
    stage.classList.remove('idle');
    clearTimeout(fsIdleWatch.t);
    fsIdleWatch.t = setTimeout(() => {
      if (document.fullscreenElement === stage) stage.classList.add('idle');
    }, 2800);
  };
  stage.addEventListener('pointermove', wake);
  stage.addEventListener('pointerdown', wake);
  addEventListener('keydown', wake);
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement === stage) wake();
    else { clearTimeout(fsIdleWatch.t); stage.classList.remove('idle'); }
  });
}

function updateOverlay() {
  const ov = $('#overlay'), video = D.video;
  if (!V.pc || !D.stream) {
    ov.hidden = false;
    $('#ovNum').textContent = '··';
    $('#ovMsg').textContent = V.pc ? 'connecting…' : 'waiting for phone…';
    return;
  }
  if (D.bypass) { ov.hidden = true; return; }

  // Never cover a picture that exists. Either there is data ahead of the
  // playhead, or frames moved a moment ago -- either way, get out of the way.
  // (readyState is not usable here: a seek drops it, and delay changes seek.)
  if (video && video.currentTime !== D.lastTime) { D.lastTime = video.currentTime; D.lastMove = now(); }
  const ahead = (D.sb && D.sb.buffered.length && video)
    ? D.sb.buffered.end(D.sb.buffered.length - 1) - video.currentTime : 0;
  if (D.frozen || ahead > 0.2 || (D.lastMove && now() - D.lastMove < 700)) { ov.hidden = true; return; }

  const head = D.queue.find(c => c.buf) || D.queue[0];
  const left = head ? Math.max(0, (D.delayMs - (now() - head.t)) / 1000) : D.delayMs / 1000;
  ov.hidden = false;
  $('#ovNum').textContent = left >= 1 ? Math.ceil(left) : '\u00b7\u00b7';
  $('#ovMsg').textContent = left >= 1 ? 'filling the ' + Math.round(D.delayMs / 1000) + 's buffer\u2026' : 'starting\u2026';
}

function updateHud() {
  const hud = $('#hud'), video = D.video;
  const bits = [];
  if (V.pc) bits.push(V.pc.connectionState);
  const s = V.stats;
  if (s) {
    if (s.w) bits.push(s.w + '×' + s.h);
    if (s.fps != null) bits.push(s.fps + ' fps');
    if (s.kbps != null) bits.push(s.kbps + ' kb/s');
  }
  if (!D.bypass && D.sb && D.sb.buffered.length && video) {
    const end = D.sb.buffered.end(D.sb.buffered.length - 1);
    const start = D.sb.buffered.start(0);
    // Measured, not the setting: during a delay raise nothing is being
    // released, so this correctly grows with the frozen picture instead of
    // claiming the new delay is already in force.
    const atEdge = D.lastCapture ? (now() - D.lastCapture) / 1000 : D.delayMs / 1000;
    bits.push('delay ' + (atEdge + Math.max(0, end - video.currentTime)).toFixed(1) + 's');
    bits.push('buf ' + (end - start).toFixed(0) + 's');
    if (D.queue.length) {
      const mb = D.queue.reduce((n, c) => n + (c.buf ? c.buf.byteLength : 0), 0) / 1048576;
      if (mb >= 1) bits.push('queued ' + mb.toFixed(0) + ' MB');
    }
    if (!D.live) bits.push('replay −' + (end - video.currentTime).toFixed(1) + 's');
  }
  if (D.bypass) bits.push('LIVE (no delay)');
  hud.innerHTML = bits.map(b => '<span>' + b + '</span>').join('');
}

function attachRemote(stream) {
  $('#pip').srcObject = stream;
  $('#pip').play().catch(() => {});
  // One `track` event fires per remote track, so an audio+video call called
  // this twice for the same stream: the second run tore the pipeline down and
  // rebuilt it milliseconds in, and the first run's pickMime() had already
  // decided on a codec from an audio-less stream. Coalesce.
  clearTimeout(attachRemote.t);
  attachRemote.t = setTimeout(() => {
    dbg('delay', 'starting pipeline, tracks:', stream.getTracks().map(t => t.kind).join('+') || 'none');
    startDelay(D, stream, $('#v'));
    clearInterval(V.statsTimer);
    V.statsTimer = setInterval(pollStats, 1000);
  }, 300);
}

let lastBytes = 0, lastStatsAt = 0;
async function pollStats() {
  if (!V.pc) return;
  let rep;
  try { rep = await V.pc.getStats(); } catch { return; }
  rep.forEach(r => {
    if (r.type === 'inbound-rtp' && r.kind === 'video') {
      const t = r.timestamp;
      const kbps = lastStatsAt ? Math.round((r.bytesReceived - lastBytes) * 8 / (t - lastStatsAt)) : null;
      lastBytes = r.bytesReceived; lastStatsAt = t;
      V.stats = { w: r.frameWidth, h: r.frameHeight, fps: r.framesPerSecond != null ? Math.round(r.framesPerSecond) : null, kbps };
    }
  });
}

function newViewerPC(remoteId, cfg) {
  if (V.pc) { try { V.pc.close(); } catch {} }
  const pc = V.pc = new RTCPeerConnection(cfg || iceConfig());
  dbg('viewer', 'new RTCPeerConnection, peer =', remoteId || '(manual)');
  logPC(pc, 'viewer');
  V.peer = remoteId; V.pendingCands = [];
  pc.addEventListener('icecandidate', e => {
    if (e.candidate && V.sig && remoteId && !pc.__gathered) V.sig.send('CANDIDATE', remoteId, peerPayload({ candidate: e.candidate.toJSON() }));
  });
  pc.addEventListener('track', e => { if (e.streams[0]) attachRemote(e.streams[0]); });
  pc.addEventListener('connectionstatechange', () => {
    updateHud();
    if (pc.connectionState === 'connected') {
      setSig('phone connected', 'ok');
      setVfy('pending', 'Compare with the phone, or scan its code.');
      refreshSas(pc, $('#vfyCode'), $('#vfyQr'));
    }
    if (['failed', 'closed'].includes(pc.connectionState)) { VFY.full = ''; setVfy('none', ''); }
    if (pc.connectionState === 'failed') { setSig('connection failed', 'bad'); toast('Connection failed — try again, or enable TURN'); }
    if (V.manual && ['failed', 'disconnected', 'closed'].includes(pc.connectionState) &&
        !$('#mvStart').disabled && store.get('paired', '') === 'manual') {
      dbg('viewer', 'manual pairing dropped - putting a fresh QR up');
      $('#vManual').open = true;
      clearTimeout(V.reoffer);
      V.reoffer = setTimeout(() => manualOffer(), 1200);
    }
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'closed') setSig('phone disconnected', 'bad');
  });
  return pc;
}

async function handleOffer(m) {
  // Manual pairing leaves this connection in have-local-offer, waiting for a
  // scanned answer. A broker OFFER arriving in that window would replace it and
  // leave the scan failing with "wrong state: stable".
  if (V.manual && V.pc && ['have-local-offer', 'stable'].includes(V.pc.signalingState) &&
      ['new', 'connecting', 'connected'].includes(V.pc.connectionState)) {
    dbg('viewer', 'ignoring broker OFFER from', m.src, '- a manual pairing is in progress');
    return;
  }
  setSig('phone found \u2014 negotiating\u2026');
  const early = V.pendingCands;          // candidates that beat the offer here
  const pc = newViewerPC(m.src);
  logSdp('viewer <- remote', m.payload.sdp);
  await pc.setRemoteDescription(m.payload.sdp);
  slimCodecs(pc);   // transceivers only exist once the offer is applied
  // Answer immediately and trickle candidates as separate messages. A
  // fully-gathered SDP is both slow and a large single broker message.
  await pc.setLocalDescription(await pc.createAnswer());
  await waitIce(pc, 2500);
  pc.__gathered = true;
  logSdp('viewer -> local', pc.localDescription);
  if (V.sig) V.sig.send('ANSWER', m.src, peerPayload({ sdp: sdpJson(pc.localDescription) }));
  for (const c of early) { try { await pc.addIceCandidate(c); } catch {} }
}

async function startViewer() {
  show('viewer');
  setDelay(store.get('delay', 30), false);
  renderJoin(store.get('room', '') || newRoom(), 'startup');
  updateOverlay();

  // A WebRTC session cannot outlive its page: reloading destroys the
  // RTCPeerConnection, and nothing in the browser can carry a live DTLS/ICE
  // session across that. What a reload CAN do is come back ready to re-pair,
  // so if the last pairing was manual, put the QR on screen immediately --
  // recovery is then one scan rather than a hunt through the panels.
  if (store.get('webcam', false)) toggleWebcam(true);
  if (store.get('paired', '') === 'manual') {
    $('#vManual').open = true;
    dbg('viewer', 'last pairing was manual - regenerating the QR for a quick re-pair');
    manualOffer();
  }
  await connectViewerSignal();
}

function renderJoin(room, why) {
  if (V.room && V.room !== room) dbg('viewer', 'ROOM CODE CHANGED', V.room, '->', room, '(' + (why || 'unknown') + ')');
  V.room = room; store.set('room', room);
  $('#roomCode').textContent = room;
  const url = location.origin + location.pathname + '#c=' + room;
  $('#joinUrl').textContent = url.replace(/^https?:\/\//, '');
  $('#joinUrl').dataset.url = url;
}

let vTaken = 0, vBackoff = 1000, vTimer = 0;

async function connectViewerSignal() {
  clearTimeout(vTimer);
  if (V.sig) { V.sig.close(); V.sig = null; }
  if ($('#viewer').hidden) return;
  setSig('connecting to broker\u2026');

  const sig = new Signal(viewerId(V.room));
  try {
    await sig.open();
  } catch (e) {
    if (e.message === 'ID-TAKEN') {
      // Nearly always our own previous session that the broker has not
      // reaped yet. Retry the same code before changing what the PC shows --
      // minting a new code silently invalidates whatever the phone was told.
      if (++vTaken <= 4) { setSig('code busy \u2014 retrying\u2026'); vTimer = setTimeout(connectViewerSignal, 2000); return; }
      vTaken = 0; renderJoin(newRoom(), 'gave up after 4 ID-TAKEN'); vTimer = setTimeout(connectViewerSignal, 300); return;
    }
    setSig('no broker: ' + e.message, 'bad');
    $('#vManual').open = true;
    toast('Signalling broker unreachable \u2014 use manual pairing below');
    vBackoff = Math.min(vBackoff * 2, 30000);
    vTimer = setTimeout(connectViewerSignal, vBackoff);
    return;
  }

  V.sig = sig; vTaken = 0; vBackoff = 1000;
  const connected = () => V.pc && V.pc.connectionState === 'connected';
  setSig(connected() ? 'phone connected' : 'waiting for phone', 'ok');

  sig.addEventListener('msg', ev => {
    const m = ev.detail;
    if (m.type === 'OFFER') handleOffer(m).catch(e => { console.warn(e); toast('Negotiation failed: ' + e.message); });
    else if (m.type === 'CANDIDATE') {
      const c = m.payload.candidate || m.payload;
      if (V.pc && V.pc.remoteDescription) V.pc.addIceCandidate(c).catch(() => {});
      else V.pendingCands.push(c);
    }
    else if (m.type === 'EXPIRE') {
      // The broker could not deliver to m.src. On a multi-region broker whose
      // peer registry is per-process this is what a cross-node pair looks like:
      // both ends OPEN, nothing relayed. Compare the "broker node" lines in the
      // two devices' logs.
      dbg('viewer', 'EXPIRE for', m.src, '- broker could not deliver');
      setSig('broker could not reach the phone', 'bad');
    }
  });
  sig.addEventListener('down', () => {
    if (V.sig !== sig) return;
    V.sig = null;
    // Media is peer-to-peer: losing the broker does not hurt a live call.
    setSig(connected() ? 'phone connected' : 'broker dropped \u2014 reconnecting', connected() ? 'ok' : 'bad');
    vTimer = setTimeout(connectViewerSignal, 1500);
  });
}

/* ============================== CAMERA UI ============================== */

const C = { sig: null, pc: null, stream: null, room: '', wake: null, retry: 0, answerTimer: 0, pendingCands: [], backoff: 1000 };

async function getCam(facing, height) {
  return navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: facing },
      width: { ideal: Math.round(height * 16 / 9) },
      height: { ideal: height },
      frameRate: { ideal: 30 },
    },
    audio: $('#mic').checked ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
  });
}

async function keepAwake() {
  try { C.wake = await navigator.wakeLock.request('screen'); } catch {}
}

function setCamState(t, cls) {
  dbg('camera', 'status:', t);
  const el = $('#camState'); el.textContent = t; el.className = 'pill' + (cls ? ' ' + cls : '');
}

function applyBitrate() {
  if (!C.pc) return;
  const s = C.pc.getSenders().find(x => x.track && x.track.kind === 'video');
  if (!s) return;
  const p = s.getParameters();
  p.encodings = p.encodings && p.encodings.length ? p.encodings : [{}];
  p.encodings[0].maxBitrate = Number($('#rate').value);
  p.encodings[0].maxFramerate = 30;
  p.degradationPreference = 'maintain-framerate';
  s.setParameters(p).catch(() => {});
}

function newCameraPC(dst, cfg) {
  if (C.pc) { try { C.pc.close(); } catch {} }
  const pc = C.pc = new RTCPeerConnection(cfg || iceConfig());
  dbg('camera', 'new RTCPeerConnection, dst =', dst || '(manual)');
  logPC(pc, 'camera');
  C.pendingCands = [];
  for (const t of C.stream.getTracks()) pc.addTrack(t, C.stream);
  pc.addEventListener('icecandidate', e => {
    if (e.candidate && C.sig && dst && !pc.__gathered) C.sig.send('CANDIDATE', dst, peerPayload({ candidate: e.candidate.toJSON() }));
  });
  pc.addEventListener('connectionstatechange', () => {
    const s = pc.connectionState;
    setCamState(s, s === 'connected' ? 'ok' : (s === 'failed' ? 'bad' : ''));
    if (s === 'connected') refreshSas(pc, $('#cVfyCode'), $('#cVfyQr'));
    if (s === 'failed') negotiate().catch(() => {});
  });
  applyBitrate();
  return pc;
}

async function negotiate() {
  if (!C.sig || !C.stream) return;
  const dst = viewerId(C.room);
  const pc = newCameraPC(dst);
  slimCodecs(pc);
  await pc.setLocalDescription(await pc.createOffer());
  // With no TURN in the list, gathering finishes in ~150 ms, so folding the
  // candidates into the offer costs nothing and takes the broker traffic from
  // eighteen messages to one. Trickle stays wired up for anything that arrives
  // after the offer has gone.
  await waitIce(pc, 2500);
  pc.__gathered = true;
  logSdp('camera -> local', pc.localDescription);
  C.sig.send('OFFER', dst, peerPayload({ sdp: sdpJson(pc.localDescription) }));
  setCamState('offer sent\u2026');

  clearTimeout(C.answerTimer);
  C.answerTimer = setTimeout(() => {
    if (C.pc && C.pc.remoteDescription) return;
    dbg('camera', 'no ANSWER within 6s of the offer');
    setCamState('the PC never answered \u2014 is the Viewer open on code ' + C.room + '?', 'bad');
  }, 6000);
}

async function onCamMsg(ev) {
  const m = ev.detail;
  if (m.type === 'ANSWER') {
    if (!C.pc) return;
    try {
      clearTimeout(C.answerTimer);
      logSdp('camera <- remote', m.payload.sdp);
      await C.pc.setRemoteDescription(m.payload.sdp);
      setCamState('answered \u2014 connecting\u2026');
      for (const c of C.pendingCands) { try { await C.pc.addIceCandidate(c); } catch {} }
      C.pendingCands = [];
    } catch (e) { console.warn('[vd] answer', e); }
  } else if (m.type === 'CANDIDATE') {
    const c = m.payload.candidate || m.payload;
    if (C.pc && C.pc.remoteDescription) C.pc.addIceCandidate(c).catch(() => {});
    else C.pendingCands.push(c);
  } else if (m.type === 'EXPIRE') {
    setCamState('no viewer with that code', 'bad');
    clearTimeout(C.retry);
    C.retry = setTimeout(() => negotiate().catch(() => {}), 3000);
  }
}

// The broker socket is only needed to set a call up. It gets dropped a lot on
// phones (backgrounding, screen-off, network handover), so reconnect rather
// than reporting failure -- and never renegotiate a call that is already up.
async function connectCameraSignal(renegotiate = true) {
  clearTimeout(C.retry);
  if (!C.stream) return;
  if (C.sig) { C.sig.close(); C.sig = null; }

  const live = () => C.pc && C.pc.connectionState === 'connected';
  if (!live()) setCamState('connecting to broker\u2026');

  const sig = new Signal(cameraId(C.room));
  try {
    await sig.open();
  } catch (e) {
    if (!live()) {
      setCamState('no broker \u2014 retrying', 'bad');
      if (!$('#cManual').open) {
        $('#cManual').open = true;
        toast('Signalling broker unreachable \u2014 retrying, or pair manually below');
      }
    }
    C.backoff = Math.min(C.backoff * 2, 30000);
    C.retry = setTimeout(() => connectCameraSignal(!live()), C.backoff);
    return;
  }

  C.sig = sig; C.backoff = 1000;
  sig.addEventListener('msg', onCamMsg);
  sig.addEventListener('down', () => {
    if (C.sig !== sig) return;
    C.sig = null;
    if (live()) { setCamState('connected', 'ok'); C.retry = setTimeout(() => connectCameraSignal(false), 5000); return; }
    setCamState('broker dropped \u2014 reconnecting', 'bad');
    C.retry = setTimeout(() => connectCameraSignal(true), 1500);
  });

  if (renegotiate && !live()) await negotiate();
  else if (live()) setCamState('connected', 'ok');
}

function onCamVisible() {
  if (document.hidden || !C.stream) return;
  keepAwake();
  if (!C.sig) connectCameraSignal(!(C.pc && C.pc.connectionState === 'connected'));
}

async function startCamera(room) {
  C.room = (room || '').toUpperCase();
  try {
    C.stream = await getCam(store.get('facing', 'environment'), Number($('#res').value));
  } catch (e) {
    toast('Camera unavailable: ' + e.name + (location.protocol === 'https:' ? '' : ' — needs HTTPS'));
    return;
  }
  const vt = C.stream.getVideoTracks()[0];
  dbg('camera', 'got media:', vt ? JSON.stringify(vt.getSettings()) : 'no video track',
    'audio=' + C.stream.getAudioTracks().length);
  $('#pv').srcObject = C.stream;
  $('#camJoin').hidden = true;
  $('#camLive').hidden = false;
  keepAwake();
  document.removeEventListener('visibilitychange', onCamVisible);
  document.addEventListener('visibilitychange', onCamVisible);

  C.backoff = 1000;
  await connectCameraSignal(true);
}

function stopCamera() {
  clearTimeout(C.retry);
  document.removeEventListener('visibilitychange', onCamVisible);
  C.backoff = 1000; C.pendingCands = [];
  if (C.sig) C.sig.close();
  if (C.pc) { try { C.pc.close(); } catch {} }
  if (C.stream) C.stream.getTracks().forEach(t => t.stop());
  if (C.wake) { try { C.wake.release(); } catch {} C.wake = null; }
  C.sig = C.pc = C.stream = null;
  $('#pv').srcObject = null;
  $('#camLive').hidden = true;
  $('#camJoin').hidden = false;
}

/* A self-contained probe of the broker, so its behaviour can be established
 * independently of everything else in the app. It opens two sockets and asks
 * three questions: does it relay at all, does messaging a peer that does not
 * exist get the sender disconnected, and does a large message. Written because
 * a size hypothesis looked convincing from the app's own logs and turned out to
 * be wrong. */
async function brokerSelfTest() {
  const btn = $('#advTest');
  btn.disabled = true; btn.textContent = 'testing…';
  $('#dbg').open = true;
  dbg('selftest', '===== broker self-test:', SIGNAL_URL, '=====');

  const sdp = { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' };

  /* Each probe gets its own pair of sockets: the first probe killing its
   * sender must not make later probes report nonsense, which is exactly what
   * the first version of this did. */
  async function probe(label, type, payload) {
    const A = new Signal('vdtest-' + rand4() + '-a'), B = new Signal('vdtest-' + rand4() + '-b');
    let verdict;
    try {
      await A.open(); await B.open();
      const got = new Promise(res => {
        const h = ev => { B.removeEventListener('msg', h); res(ev.detail); };
        B.addEventListener('msg', h);
        setTimeout(() => { B.removeEventListener('msg', h); res(null); }, 3500);
      });
      const died = new Promise(res => {
        A.addEventListener('down', () => res(true), { once: true });
        setTimeout(() => res(false), 3500);
      });
      A.send(type, B.id, payload);
      const [msg, senderDied] = await Promise.all([got, died]);
      verdict = (msg ? 'RELAYED' : 'not relayed') + (senderDied ? ' + SENDER DISCONNECTED' : ' + sender alive');
    } catch (e) {
      verdict = 'could not open sockets: ' + e.message;
    }
    A.close(); B.close();
    dbg('selftest', label.padEnd(34), verdict);
    return verdict;
  }

  await probe('OFFER, PeerJS payload shape', 'OFFER', peerPayload({ sdp }));
  await probe('OFFER, bare {sdp}', 'OFFER', { sdp });
  await probe('CANDIDATE, PeerJS shape', 'CANDIDATE', peerPayload({ candidate: { candidate: '', sdpMid: '0' } }));
  await probe('HEARTBEAT (control message)', 'HEARTBEAT', null);

  dbg('selftest', '===== done. "not relayed + SENDER DISCONNECTED" on every row means the broker is refusing to relay at all =====');
  toast('Self-test finished — read the debug log');
  btn.disabled = false; btn.textContent = 'Test the broker';
}

/* ========================= MANUAL PAIRING (2 step) =========================
 * Step 1 is a QR on the PC holding a deep link to this page with the offer in
 * the fragment: the phone's own camera app opens it, so there is no scanner to
 * write for the leg that matters. Step 2 comes back the other way, which has no
 * such trick -- the phone shows its answer as a QR for the PC's webcam, and
 * falls back to a copyable code where the PC cannot scan.
 * The PC offers (recvonly) so that the leg a QR can carry is the one that also
 * bootstraps the phone into the right page and state in a single tap.        */

function joinBase() { return location.origin + location.pathname; }

async function manualOffer() {
  const btn = $('#mvStart');
  btn.disabled = true; btn.textContent = 'gathering…';
  try {
    V.manual = true;
    store.set('paired', 'manual');
    const pc = newViewerPC(null, MANUAL_ICE);
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    slimCodecs(pc);
    await pc.setLocalDescription(await pc.createOffer());
    await waitIce(pc, 5000);                    // one blob, no trickle channel
    logSdp('manual offer', pc.localDescription);

    const code = await pack({ k: 'o', s: forTransmit(pc.localDescription.sdp) });
    const url = joinBase() + '#p=' + code;
    $('#mvOffer').value = code;
    dbg('manual', 'offer code', code.length + ' chars, url', url.length + ' chars');

    const fitted = window.VDQR && VDQR.render(url, $('#mvQr'), 560);
    $('#mvQrNote').hidden = false;
    $('#mvQrNote').textContent = fitted
      ? 'Open this with your phone\u2019s camera. It will start the camera page and produce an answer.'
      : 'Too long for a QR on this connection \u2014 copy the offer code across instead.';
    dbg('manual', 'QR', fitted ? 'rendered' : 'DID NOT FIT');
    btn.textContent = 'Regenerate QR';
  } catch (e) {
    dbg('manual', 'offer failed', e);
    toast('Could not make an offer: ' + e.message);
    btn.textContent = 'Show pairing QR';
  }
  btn.disabled = false;
}

async function manualFinish(text) {
  const a = await unpack(text);
  if (!a || a.k !== 'a') { toast('That does not look like an answer code'); return false; }
  if (!V.pc) { toast('Show the pairing QR first'); return false; }

  // An answer can only be applied to a connection still holding its offer.
  // Anything else -- the answer applied twice, or a broker OFFER having
  // replaced this connection underneath us -- lands here as
  // "Called in wrong state: stable", which says nothing useful to a user.
  const st = V.pc.signalingState;
  dbg('manual', 'applying answer, signalingState =', st, 'connectionState =', V.pc.connectionState);
  if (st !== 'have-local-offer') {
    if (V.pc.remoteDescription && ['connected', 'connecting'].includes(V.pc.connectionState)) {
      toast('Already paired \u2014 nothing more to do');
      return true;
    }
    toast('That pairing is no longer current (state: ' + st + ') \u2014 press "Show pairing QR" again');
    dbg('manual', 'refused: needed have-local-offer, had', st);
    return false;
  }

  logSdp('manual answer', { type: 'answer', sdp: a.s });
  await V.pc.setRemoteDescription({ type: 'answer', sdp: a.s });
  toast('Answer accepted \u2014 connecting');
  return true;
}

/* Phone side: turn an offer code into an answer, and show it back as a QR. */
async function manualAnswer(code) {
  show('camera');
  $('#cManual').open = true;
  $('#mcAnswerRow').hidden = true;          // re-pairing: clear the previous answer
  $('#mcOfferRow').hidden = false;
  clearTimeout(C.answerTimer);
  try {
    if (!C.stream) {
      C.stream = await getCam(store.get('facing', 'environment'), Number($('#res').value));
      const vt = C.stream.getVideoTracks()[0];
      dbg('manual', 'got media', vt ? JSON.stringify(vt.getSettings()) : 'none');
      $('#pv').srcObject = C.stream;
      $('#camJoin').hidden = true;
      $('#camLive').hidden = false;
      keepAwake();
    }
    const o = await unpack(code);
    if (!o || o.k !== 'o') { toast('That does not look like an offer code'); return; }

    setCamState('building answer\u2026');
    const pc = newCameraPC(null, MANUAL_ICE);
    await pc.setRemoteDescription({ type: 'offer', sdp: o.s });
    slimCodecs(pc);
    await pc.setLocalDescription(await pc.createAnswer());
    await waitIce(pc, 5000);
    logSdp('manual answer', pc.localDescription);

    const ans = await pack({ k: 'a', s: forTransmit(pc.localDescription.sdp) });
    $('#mcOut').value = ans;
    $('#mcAnswerRow').hidden = false;
    $('#mcOfferRow').hidden = true;
    const fitted = window.VDQR && VDQR.render(ans, $('#mcQr'), 520);
    dbg('manual', 'answer code', ans.length + ' chars, QR', fitted ? 'rendered' : 'DID NOT FIT');
    setCamState('answer ready \u2014 show it to the PC');
    $('#mcAnswerRow').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (e) {
    dbg('manual', 'answer failed', e);
    toast('Pairing failed: ' + e.message);
  }
}

/* PC side: read the phone's answer QR off a webcam. BarcodeDetector is absent
 * on some desktops (notably Chrome on Linux), so this is strictly an optional
 * accelerator -- the paste box beside it always works. */
const SCAN = { on: false, stream: null, timer: 0, video: null, btn: null, label: '' };

async function scannerAvailable() {
  if (!('BarcodeDetector' in window)) return false;
  try { return (await BarcodeDetector.getSupportedFormats()).includes('qr_code'); }
  catch { return false; }
}

function stopScan() {
  SCAN.on = false;
  clearTimeout(SCAN.timer);
  if (SCAN.stream) SCAN.stream.getTracks().forEach(t => t.stop());
  SCAN.stream = null;
  if (SCAN.video) { SCAN.video.srcObject = null; SCAN.video.hidden = true; }
  if (SCAN.btn) SCAN.btn.innerHTML = SCAN.label;
  SCAN.video = SCAN.btn = null;
}

/* One webcam scanner, two jobs: reading the phone's answer during manual
 * pairing, and reading its safety code afterwards. */
async function startScan({ video, btn, onResult }) {
  if (SCAN.on) { const same = SCAN.btn === btn; stopScan(); if (same) return; }
  if (!await scannerAvailable()) { toast('No QR scanner in this browser — compare the codes by eye instead'); return; }
  let det;
  try { det = new BarcodeDetector({ formats: ['qr_code'] }); }
  catch (e) { toast('Scanner unavailable: ' + e.name); return; }
  try {
    SCAN.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } });
  } catch (e) { dbg('scan', 'getUserMedia failed', e); toast('No webcam available: ' + e.name); return; }

  SCAN.video = video; SCAN.btn = btn; SCAN.label = btn.innerHTML;
  video.srcObject = SCAN.stream; video.hidden = false;
  await video.play().catch(() => {});
  SCAN.on = true;
  btn.textContent = 'Stop scanning';
  dbg('scan', 'started for', btn.id);

  const tick = async () => {
    if (!SCAN.on) return;
    try {
      const found = await det.detect(video);
      if (found.length) {
        const text = found[0].rawValue;
        dbg('scan', 'detected', text.length + ' chars');
        stopScan();
        onResult(text);
        return;
      }
    } catch (e) { dbg('scan', 'detect error', e); }
    SCAN.timer = setTimeout(tick, 150);   // a timer, not rAF: rAF stalls when the tab is not focused
  };
  tick();
}

/* ====================== PAIRING SECURITY (safety code) ======================
 * Both ends hash the pair of DTLS certificate fingerprints actually in use for
 * this connection. Those fingerprints are what the media is authenticated
 * against, so anyone who sat in the middle of the signalling channel -- the
 * exact attack the deterministic room id invites, since a guessed code lets
 * someone register the viewer id first and answer in your place -- necessarily
 * presents a different certificate, and the codes diverge.
 *
 * The QR is machine-read, so it carries the WHOLE SHA-256 -- there is no reason
 * to truncate a value nobody has to type. Only the printed groups are shortened,
 * and only because they exist to be compared by eye when no camera is free. */

const VFY = { full: '', short: '', state: 'unknown' };

function b32(bytes, n) {
  let bits = 0, val = 0, out = '';
  for (const b of bytes) {
    val = ((val << 8) | b) >>> 0; bits += 8;
    while (bits >= 5) { out += ALPHA[(val >>> (bits - 5)) & 31]; bits -= 5; }
    if (n && out.length >= n) break;
  }
  if (bits > 0 && (!n || out.length < n)) out += ALPHA[(val << (5 - bits)) & 31];  // flush the tail
  return n ? out.slice(0, n) : out;
}

function dtlsPrint(desc) {
  const m = /^a=fingerprint:(\S+)[ \t]+(\S+)/mi.exec((desc && desc.sdp) || '');
  return m ? m[1].toLowerCase() + ' ' + m[2].toUpperCase() : null;
}

async function computeSas(pc) {
  if (!pc || !pc.localDescription || !pc.remoteDescription) return null;
  const a = dtlsPrint(pc.localDescription), b = dtlsPrint(pc.remoteDescription);
  if (!a || !b) return null;
  // Sorted, so both ends derive the same value without agreeing who is who.
  const material = 'video-delay/sas/v1|' + [a, b].sort().join('|');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material)));
  const full = b32(digest);            // all 256 bits, 52 base32 chars
  return { full, short: full.slice(0, 12).replace(/(.{4})(.{4})(.{4})/, '$1 $2 $3') };
}

function setVfy(state, note) {
  VFY.state = state;
  const pill = $('#vfyPill');
  if (pill) {
    pill.textContent = { ok: 'verified', bad: 'MISMATCH', pending: 'not verified', none: 'not connected' }[state] || state;
    pill.className = 'pill' + (state === 'ok' ? ' ok' : state === 'bad' ? ' bad' : '');
  }
  if (note !== undefined) { const n = $('#vfyNote'); if (n) n.textContent = note; }
  dbg('verify', state, note || '');
}

async function refreshSas(pc, codeEl, qrEl) {
  const sas = await computeSas(pc);
  if (!sas) { if (codeEl) codeEl.textContent = '— — —'; if (qrEl) qrEl.hidden = true; return null; }
  VFY.full = sas.full; VFY.short = sas.short;
  if (codeEl) codeEl.textContent = sas.short;
  if (qrEl) VDQR.render(sas.full, qrEl, 300);
  dbg('verify', 'safety code', sas.short);
  return sas;
}

function verifyScanned(text) {
  const got = (text || '').trim().toUpperCase();
  if (!VFY.full) { toast('No safety code yet — connect first'); return; }
  if (got === VFY.full) {
    setVfy('ok', 'The phone reported the same fingerprints. Nobody is in the middle.');
    toast('Pairing verified \u2713');
  } else {
    setVfy('bad', 'Scanned ' + got.slice(0, 12) + '…, expected ' + VFY.full.slice(0, 12) + '…');
    toast('MISMATCH — do not trust this connection');
  }
}

/* ============================== WIRING ============================== */

function wire() {
  /* --- debug log --- */
  dbgPre = $('#dbgPre');
  const logText = () => logHeader() + '\n' + LOG.join('\n');
  $('#dbgCopy').onclick = async () => {
    try { await navigator.clipboard.writeText(logText()); toast('Log copied (' + LOG.length + ' lines)'); }
    catch { toast('Copy blocked — use Download, or select the text'); }
  };
  $('#dbgSave').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([logText()], { type: 'text/plain' }));
    a.download = 'video-delay-log.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  };
  $('#dbgClear').onclick = () => { LOG.length = 0; dbgPre.textContent = ''; dbg('log cleared'); };
  const showLog = () => { $('#dbg').open = true; $('#dbg').scrollIntoView({ behavior: 'smooth', block: 'center' }); };
  $('#btnLog').onclick = showLog;
  $('#camLog').onclick = showLog;

  addEventListener('error', e => dbg('!! window error:', e.message, (e.filename || '').split('/').pop() + ':' + e.lineno));
  addEventListener('unhandledrejection', e => dbg('!! unhandled rejection:', fmtArg(e.reason)));
  dbg('boot', navigator.userAgent);
  dbg('boot', 'secure=' + window.isSecureContext, 'broker=' + SIGNAL_URL, 'MSImpl=' + (MSImpl ? MSImpl.name : 'none'));
  // The public broker runs a multi-region build whose peer registry is a bare
  // per-process Map with no cross-node routing, so two peers can both be OPEN
  // on different nodes and never see each other. If the two devices report
  // different nodes, that is the whole story and no client change fixes it.
  try {
    const root = SIGNAL_URL.replace(/^ws/, 'http').replace(/\/[^/]*$/, '/');
    fetch(root).then(r => r.json())
      .then(j => dbg('boot', 'broker node =', j.location || '(not reported)', JSON.stringify(j).slice(0, 120)))
      .catch(e => dbg('boot', 'broker node probe failed (CORS or offline):', e.message));
  } catch {}

  /* --- home --- */
  $('#goViewer').onclick = () => { location.hash = '#v'; startViewer(); };
  $('#goCamera').onclick = () => { show('camera'); $('#codeIn').focus(); };
  for (const b of document.querySelectorAll('[data-back]')) {
    b.onclick = () => { for (const d of LINES) stopDelay(d); toggleWebcam(false); stopCamera(); stopScan(); if (V.sig) V.sig.close(); if (V.pc) try { V.pc.close(); } catch {}
      V.pc = null; V.sig = null; clearInterval(V.statsTimer); location.hash = ''; show('home'); };
  }

  /* --- delay controls --- */
  const presets = $('#presets');
  for (const s of [5, 10, 15, 30, 60, 90]) {
    const b = document.createElement('button');
    b.textContent = s + 's';
    b.onclick = () => setDelay(s);
    presets.append(b);
  }
  $('#delay').oninput = e => setDelay(Number(e.target.value));
  $('#delayNum').onchange = e => setDelay(Number(e.target.value));

  // maintain()'s snap only fires past a 2.5s lead, so pressing Live while
  // 1-2s behind used to toggle the button and move nothing.
  $('#btnLive').onclick = () => {
    $('#btnFreeze').classList.remove('on');
    for (const d of LINES) { d.live = true; d.frozen = false; seekToEdge(d); maintain(d); }
    setLiveBtn();
  };
  $('#btnBack').onclick = () => jump(-10);
  $('#btnFreeze').onclick = () => {
    const frozen = !D.frozen;
    $('#btnFreeze').classList.toggle('on', frozen);
    for (const d of LINES) {
      d.frozen = frozen;
      if (!d.video) continue;
      if (frozen) d.video.pause();
      else { d.live = false; d.video.play().catch(() => {}); }
    }
    setLiveBtn();
  };
  $('#btnMirror').onclick = () => {
    const on = $('#stage').classList.toggle('mirror');
    $('#btnMirror').classList.toggle('on', on);
    store.set('mirror', on);
  };
  $('#btnLayout').onclick = () => {
    const order = ['split', 'delayed', 'pip'];
    setLayout(order[(order.indexOf(store.get('layout', 'split')) + 1) % order.length]);
  };
  setLayout(store.get('layout', 'split'));
  $('#btnMute').onclick = () => {
    const v = $('#v');
    v.muted = !v.muted;
    $('#btnMute').textContent = v.muted ? '🔇' : '🔊';
    $('#btnMute').classList.toggle('on', !v.muted);
    if (!v.muted) v.play().catch(() => {});
  };
  for (const b of document.querySelectorAll('#fsbar button')) {
    b.onclick = () => {
      setDelay(D.delayMs / 1000 + Number(b.dataset.d));
      b.blur();                 // keep Space on Freeze rather than this button
    };
  }
  fsIdleWatch();

  $('#btnFs').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else $('#stage').requestFullscreen().catch(() => {});
  };

  $('#btnSelf').onclick = () => toggleWebcam();
  applyPip();
  pipDrag($('#pipLive'));
  pipDrag($('#pipDelay'));
  if (store.get('mirror', false)) $('#btnMirror').click();

  /* --- pairing --- */
  $('#copyLink').onclick = async () => {
    try { await navigator.clipboard.writeText($('#joinUrl').dataset.url); toast('Link copied'); }
    catch { toast('Copy failed — select the link manually'); }
  };
  $('#newRoom').onclick = () => { V.manual = false; renderJoin(newRoom(), 'New code button'); connectViewerSignal(); };

  /* --- advanced --- */
  $('#iceCfg').value = store.get('ice', '');
  $('#sigUrl').value = store.get('signal', '') || SIGNAL_URL;
  $('#advSave').onclick = () => {
    const ice = $('#iceCfg').value.trim();
    if (ice) { try { JSON.parse(ice); } catch { toast('ICE JSON is invalid'); return; } }
    store.set('ice', ice);
    store.set('signal', $('#sigUrl').value.trim());
    location.reload();
  };
  $('#advReset').onclick = () => { store.set('ice', ''); store.set('signal', ''); location.reload(); };
  $('#advTest').onclick = () => brokerSelfTest();

  /* --- manual pairing, viewer side --- */
  $('#mvStart').onclick = manualOffer;
  $('#mvOfferCopy').onclick = () => navigator.clipboard.writeText($('#mvOffer').value).then(() => toast('Offer code copied'), () => toast('Copy failed'));
  $('#mvScan').onclick = () => startScan({
    video: $('#mvCam'), btn: $('#mvScan'),
    onResult: text => { $('#mvIn').value = text; manualFinish(text).catch(e => toast('Could not use that code: ' + e.message)); },
  }).catch(e => toast('Scanner failed: ' + e.message));

  $('#vfyScan').onclick = () => startScan({
    video: $('#vfyCam'), btn: $('#vfyScan'), onResult: verifyScanned,
  }).catch(e => toast('Scanner failed: ' + e.message));
  $('#vfyRefresh').onclick = () => refreshSas(V.pc, $('#vfyCode'), $('#vfyQr'));
  $('#mvGo').onclick = () => manualFinish($('#mvIn').value).catch(e => toast('Could not read that code: ' + e.message));
  scannerAvailable().then(ok => {
    $('#mvScan').disabled = !ok;
    $('#vfyScan').disabled = !ok;
    $('#mvScanNote').textContent = ok ? '' : 'no QR scanner in this browser — paste instead';
    if (!ok) $('#vfyNote').textContent = 'No QR scanner in this browser — compare the letters by eye instead.';
  });

  /* --- camera --- */
  $('#codeIn').oninput = e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); };
  $('#codeIn').onkeydown = e => { if (e.key === 'Enter') $('#camConnect').click(); };
  $('#camConnect').onclick = () => {
    const code = $('#codeIn').value.trim().toUpperCase();
    if (code.length < 4) { toast('Enter the code shown on the PC'); return; }
    startCamera(code);
  };
  $('#camStop').onclick = stopCamera;
  $('#flip').onclick = async () => {
    const facing = store.get('facing', 'environment') === 'environment' ? 'user' : 'environment';
    store.set('facing', facing);
    try {
      const s = await getCam(facing, Number($('#res').value));
      const nv = s.getVideoTracks()[0];
      const sender = C.pc && C.pc.getSenders().find(x => x.track && x.track.kind === 'video');
      if (sender) await sender.replaceTrack(nv);
      C.stream.getVideoTracks().forEach(t => t.stop());
      C.stream.getVideoTracks().forEach(t => C.stream.removeTrack(t));
      C.stream.addTrack(nv);
      $('#pv').srcObject = C.stream;
    } catch (e) { toast('Flip failed: ' + e.name); }
  };
  $('#res').onchange = async () => {
    const h = Number($('#res').value);
    const t = C.stream && C.stream.getVideoTracks()[0];
    if (t) { try { await t.applyConstraints({ width: { ideal: Math.round(h * 16 / 9) }, height: { ideal: h } }); } catch {} }
  };
  $('#rate').onchange = applyBitrate;

  /* --- manual pairing, camera side --- */
  $('#mcGo').onclick = () => manualAnswer($('#mcIn').value.trim());
  $('#mcCopy').onclick = () => navigator.clipboard.writeText($('#mcOut').value).then(() => toast('Answer code copied'), () => toast('Copy failed'));

  /* --- keyboard --- */
  addEventListener('keydown', e => {
    if ($('#viewer').hidden) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); $('#btnFreeze').click(); }
    else if (k === 'f') $('#btnFs').click();
    else if (k === 'm') $('#btnMirror').click();
    else if (k === 'p') $('#btnLayout').click();
    else if (k === 'c') $('#btnSelf').click();
    else if (k === 'u') $('#btnMute').click();
    else if (k === 'l') $('#btnLive').click();
    else if (e.key === 'ArrowLeft') { e.preventDefault(); jump(e.shiftKey ? -30 : -5); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); jump(e.shiftKey ? 30 : 5); }
    // Delay nudges. '+' is already Shift+'=' on most layouts, so the shifted
    // glyph itself selects the 5 s step rather than a Shift modifier:
    //   -  =   ±1     _  +   ±5     Alt with any of them  ±10
    // Arrow up/down do the same with Shift/Alt, for anyone who prefers them.
    else if (['-', '=', '_', '+', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      e.preventDefault();
      const arrow = e.key === 'ArrowUp' || e.key === 'ArrowDown';
      const down = e.key === '-' || e.key === '_' || e.key === 'ArrowDown';
      const step = e.altKey ? 10 : (e.key === '_' || e.key === '+' || (arrow && e.shiftKey)) ? 5 : 1;
      setDelay(D.delayMs / 1000 + (down ? -step : step));
    }
  });
}

function jump(sec) {
  $('#btnFreeze').classList.remove('on');
  for (const d of LINES) {
    const { sb, video } = d;
    if (!sb || !sb.buffered.length || d.bypass) continue;
    const start = sb.buffered.start(0), end = sb.buffered.end(sb.buffered.length - 1);
    // clamp() inverts when the buffered range is shorter than the guard band,
    // so widen rather than let the low bound lose to the high one.
    const lo = start + 0.05, hi = Math.max(lo, end - 0.05);
    const t = clamp(video.currentTime + sec, lo, hi);
    video.currentTime = t;
    d.live = (end - t) < 1;
    d.frozen = false;
    video.play().catch(() => {});
  }
  setLiveBtn();
}

function route() {
  const h = location.hash;
  const p = /^#p=(.+)$/.exec(h);
  if (p) { manualAnswer(p[1]); return; }        // arrived by scanning the PC's QR
  const m = /^#c=([A-Za-z0-9]+)/.exec(h);
  if (m) { show('camera'); $('#codeIn').value = m[1].toUpperCase(); return; }
  if (h === '#v') { startViewer(); return; }
  show('home');
}

addEventListener('hashchange', () => { dbg('route', 'hashchange ->', location.hash.slice(0, 24) + '…'); route(); });

wire();
route();
