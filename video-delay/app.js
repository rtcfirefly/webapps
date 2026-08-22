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
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
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

const D = {
  video: null, stream: null,
  rec: null, ms: null, sb: null, mime: '',
  queue: [],      // {t, buf} — waiting out the delay
  pending: [],    // ArrayBuffers ready to append
  delayMs: 30000,
  live: true,     // false while the user is scrubbing back through the buffer
  frozen: false,
  timer: 0,
  lastAppend: 0,
  lastSeek: 0,
  lastTime: -1,
  lastMove: 0,
  firstRelease: 0,
  bypass: false,  // true if we gave up and fell back to undelayed playback
};

function pickMime(hasAudio) {
  const list = [];
  for (const v of ['vp8', 'vp9']) list.push(hasAudio ? `video/webm;codecs=${v},opus` : `video/webm;codecs=${v}`);
  list.push('video/webm');
  list.push(hasAudio ? 'video/mp4;codecs=avc1.42E01E,mp4a.40.2' : 'video/mp4;codecs=avc1.42E01E');
  list.push('video/mp4');
  if (!window.MediaRecorder || !MSImpl) return null;
  return list.find(t => MediaRecorder.isTypeSupported(t) && MSImpl.isTypeSupported(t)) || null;
}

function stopDelay() {
  clearInterval(D.timer); D.timer = 0;
  try { D.rec && D.rec.state !== 'inactive' && D.rec.stop(); } catch {}
  try { D.ms && D.ms.readyState === 'open' && D.ms.endOfStream(); } catch {}
  if (D.video) { D.video.removeAttribute('src'); D.video.srcObject = null; try { D.video.load(); } catch {} }
  D.rec = D.ms = D.sb = null; D.queue = []; D.pending = [];
  D.live = true; D.frozen = false; D.bypass = false; D.firstRelease = 0;
  D.lastAppend = 0; D.lastSeek = 0; D.lastTime = -1; D.lastMove = 0;
}

function bypassToLive(why) {
  if (D.bypass) return;
  dbg('delay', 'BYPASS to live video:', why);
  D.bypass = true;
  clearInterval(D.timer); D.timer = 0;
  try { D.rec && D.rec.state !== 'inactive' && D.rec.stop(); } catch {}
  D.video.removeAttribute('src');
  D.video.srcObject = D.stream;
  D.video.play().catch(() => {});
  toast('Delay buffer unavailable (' + why + ') — showing live video');
}

function startDelay(stream, video) {
  stopDelay();
  D.stream = stream; D.video = video;

  dbg('delay', 'remote stream: video=' + stream.getVideoTracks().length, 'audio=' + stream.getAudioTracks().length);
  const mime = pickMime(stream.getAudioTracks().length > 0);
  dbg('delay', 'chosen mime =', mime || '(none)');
  if (!mime) { bypassToLive('no MediaRecorder/MediaSource codec in common'); return; }
  D.mime = mime;

  let rec;
  try { rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 3_000_000 }); }
  catch (e) { bypassToLive('MediaRecorder: ' + e.name); return; }
  D.rec = rec;

  rec.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    // Keep queue order stable: reserve the slot now, fill it when the
    // Blob resolves. A chunk is only released once its bytes are in.
    const slot = { t: now(), buf: null };
    D.queue.push(slot);
    e.data.arrayBuffer().then(b => { slot.buf = b; }, () => { slot.buf = new ArrayBuffer(0); });
  };
  rec.onerror = (e) => bypassToLive('recorder error' + (e.error ? ': ' + e.error.name : ''));
  rec.start(200);

  const ms = new MSImpl();
  D.ms = ms;
  if (window.ManagedMediaSource && ms instanceof window.ManagedMediaSource) {
    video.disableRemotePlayback = true;
    video.srcObject = ms;
  } else {
    video.src = URL.createObjectURL(ms);
  }

  ms.addEventListener('sourceopen', () => {
    let sb;
    try { sb = ms.addSourceBuffer(rec.mimeType || mime); }
    catch (e) { bypassToLive('addSourceBuffer: ' + e.name); return; }
    dbg('delay', 'sourceopen, SourceBuffer for', rec.mimeType || mime);
    try { sb.mode = 'sequence'; } catch (e) { dbg('delay', 'sb.mode=sequence rejected', e); }
    sb.addEventListener('updateend', () => { step(); maintain(); });
    sb.addEventListener('error', () => bypassToLive('source buffer error'));
    D.sb = sb;
    step();
  }, { once: true });

  D.timer = setInterval(pump, 100);
}

function pump() {
  const t = now();
  while (D.queue.length && D.queue[0].buf && (t - D.queue[0].t) >= D.delayMs) {
    const c = D.queue.shift();
    if (c.buf.byteLength) D.pending.push(c.buf);
    if (!D.firstRelease) D.firstRelease = t;
  }
  step();
  maintain();
  updateOverlay();
  updateHud();

  if (t - (pump.last || 0) > 5000) {
    pump.last = t;
    const v = D.video, sb = D.sb;
    const b = sb && sb.buffered.length
      ? sb.buffered.start(0).toFixed(1) + '-' + sb.buffered.end(sb.buffered.length - 1).toFixed(1) : 'none';
    dbg('delay', 'queue=' + D.queue.length, 'pending=' + D.pending.length, 'buffered=' + b,
      't=' + (v ? v.currentTime.toFixed(1) : '?'), 'rs=' + (v ? v.readyState : '?'),
      'paused=' + (v ? v.paused : '?'), 'set=' + (D.delayMs / 1000) + 's',
      'live=' + D.live, 'frozen=' + D.frozen,
      'sinceAppend=' + (D.lastAppend ? Math.round(t - D.lastAppend) + 'ms' : '-'),
      'overlay=' + ($('#overlay').hidden ? 'hidden' : 'SHOWN'));
  }

  // If chunks have been flowing for a while but nothing ever decoded, the
  // recorder/MSE codec pairing is lying to us. Show live video instead.
  if (D.firstRelease && !D.bypass && t - D.firstRelease > 6000 && D.video.readyState < 2) {
    bypassToLive('nothing decodable');
  }
}

function step() {
  const { sb, ms, video } = D;
  if (!sb || !ms || ms.readyState !== 'open' || sb.updating) return;

  // Drop what has already been played, well behind the replay window.
  if (sb.buffered.length) {
    const s0 = sb.buffered.start(0);
    const keep = Math.max(0, video.currentTime - KEEP_BEHIND);
    if (keep - s0 > 5) { try { sb.remove(s0, keep); return; } catch {} }
  }

  if (!D.pending.length) return;
  const buf = D.pending.shift();
  try {
    sb.appendBuffer(buf);
    D.lastAppend = now();
  } catch (e) {
    if (e && e.name === 'QuotaExceededError') {
      D.pending.unshift(buf);
      try {
        if (sb.buffered.length) sb.remove(sb.buffered.start(0), Math.max(0.1, video.currentTime - 5));
      } catch {}
    } else {
      dbg('delay', 'appendBuffer failed', e);
    }
  }
}

function maintain() {
  const { sb, video } = D;
  if (!sb || !sb.buffered.length) return;
  const start = sb.buffered.start(0);
  const end = sb.buffered.end(sb.buffered.length - 1);

  if (D.frozen) return;
  if (video.currentTime < start) video.currentTime = start + 0.05;

  const lead = end - video.currentTime;
  // Re-seek only once the burst of appends a delay change produces has fully
  // drained, and at most every 400 ms. Seeking on every updateend pins
  // readyState below HAVE_CURRENT_DATA and the picture never comes back.
  if (D.live && lead > 2.5 && !D.pending.length && !D.sb.updating && now() - D.lastSeek > 400) {
    D.lastSeek = now();
    dbg('delay', 'seek to live edge: lead was', lead.toFixed(2) + 's');
    video.currentTime = Math.max(start + 0.05, end - TARGET_LEAD);
  }
  // Scrubbed back and left there: don't let the buffer run away.
  if (!D.live && lead > KEEP_BEHIND + 60) { D.live = true; setLiveBtn(); }

  if (video.paused && end - video.currentTime > 0.15) video.play().catch(() => {});
}

/* ============================== VIEWER UI ============================== */

const V = { sig: null, pc: null, room: '', peer: null, pendingCands: [], stats: null, statsTimer: 0 };

function show(id) {
  for (const s of document.querySelectorAll('.view')) s.hidden = (s.id !== id);
}

function setSig(text, cls) {
  dbg('viewer', 'status:', text);
  const el = $('#sigState');
  el.textContent = text;
  el.className = 'pill' + (cls ? ' ' + cls : '');
}

function setDelay(sec, persist = true) {
  sec = clamp(Math.round(sec) || 0, 0, 600);
  if (D.delayMs !== sec * 1000) dbg('delay', 'set to', sec + 's');
  D.delayMs = sec * 1000;
  $('#delay').value = clamp(sec, 0, 180);
  $('#delayNum').value = sec;
  if (persist) store.set('delay', sec);
}

function setLiveBtn() { $('#btnLive').classList.toggle('on', !D.live); }

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
    const actual = D.delayMs / 1000 + Math.max(0, end - video.currentTime);
    bits.push('delay ' + actual.toFixed(1) + 's');
    bits.push('buf ' + (end - start).toFixed(0) + 's');
    if (!D.live) bits.push('replay −' + (end - video.currentTime).toFixed(1) + 's');
  }
  if (D.bypass) bits.push('LIVE (no delay)');
  hud.innerHTML = bits.map(b => '<span>' + b + '</span>').join('');
}

function attachRemote(stream) {
  $('#pip').srcObject = stream;
  if (!$('#pip').hidden) $('#pip').play().catch(() => {});
  startDelay(stream, $('#v'));
  clearInterval(V.statsTimer);
  V.statsTimer = setInterval(pollStats, 1000);
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
    if (pc.connectionState === 'connected') setSig('phone connected', 'ok');
    if (pc.connectionState === 'failed') { setSig('connection failed', 'bad'); toast('Connection failed — try again, or enable TURN'); }
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'closed') setSig('phone disconnected', 'bad');
  });
  return pc;
}

async function handleOffer(m) {
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
  logSdp('manual answer', { type: 'answer', sdp: a.s });
  await V.pc.setRemoteDescription({ type: 'answer', sdp: a.s });
  toast('Answer accepted \u2014 connecting');
  return true;
}

/* Phone side: turn an offer code into an answer, and show it back as a QR. */
async function manualAnswer(code) {
  show('camera');
  $('#cManual').open = true;
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
const SCAN = { on: false, stream: null, timer: 0 };

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
  $('#mvCam').srcObject = null;
  $('#mvCam').hidden = true;
  $('#mvScan').textContent = '\uD83D\uDCF7 Scan the phone\u2019s QR';
}

async function startScan() {
  if (SCAN.on) { stopScan(); return; }
  if (!await scannerAvailable()) { toast('No QR scanner in this browser — paste the code instead'); return; }
  let det;
  try { det = new BarcodeDetector({ formats: ['qr_code'] }); }
  catch (e) { toast('Scanner unavailable: ' + e.name); return; }
  try {
    SCAN.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } });
  } catch (e) { dbg('scan', 'getUserMedia failed', e); toast('No webcam available: ' + e.name); return; }

  const v = $('#mvCam');
  v.srcObject = SCAN.stream; v.hidden = false;
  await v.play().catch(() => {});
  SCAN.on = true;
  $('#mvScan').textContent = 'Stop scanning';
  dbg('scan', 'started');

  const tick = async () => {
    if (!SCAN.on) return;
    try {
      const found = await det.detect(v);
      if (found.length) {
        const text = found[0].rawValue;
        dbg('scan', 'detected', text.length + ' chars');
        stopScan();
        $('#mvIn').value = text;
        manualFinish(text).catch(e => toast('Could not use that code: ' + e.message));
        return;
      }
    } catch (e) { dbg('scan', 'detect error', e); }
    SCAN.timer = setTimeout(tick, 150);   // a timer, not rAF: rAF stalls when the tab is not focused
  };
  tick();
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

  /* --- home --- */
  $('#goViewer').onclick = () => { location.hash = '#v'; startViewer(); };
  $('#goCamera').onclick = () => { show('camera'); $('#codeIn').focus(); };
  for (const b of document.querySelectorAll('[data-back]')) {
    b.onclick = () => { stopDelay(); stopCamera(); stopScan(); if (V.sig) V.sig.close(); if (V.pc) try { V.pc.close(); } catch {}
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

  $('#btnLive').onclick = () => { D.live = true; D.frozen = false; $('#btnFreeze').classList.remove('on'); setLiveBtn(); maintain(); };
  $('#btnBack').onclick = () => jump(-10);
  $('#btnFreeze').onclick = () => {
    D.frozen = !D.frozen;
    $('#btnFreeze').classList.toggle('on', D.frozen);
    if (D.frozen) D.video && D.video.pause(); else { D.live = false; setLiveBtn(); D.video && D.video.play().catch(() => {}); }
  };
  $('#btnMirror').onclick = () => {
    const on = $('#stage').classList.toggle('mirror');
    $('#btnMirror').classList.toggle('on', on);
    store.set('mirror', on);
  };
  $('#btnPip').onclick = () => {
    const p = $('#pip');
    p.hidden = !p.hidden;
    $('#btnPip').classList.toggle('on', !p.hidden);
    if (!p.hidden) p.play().catch(() => {});
  };
  $('#btnMute').onclick = () => {
    const v = $('#v');
    v.muted = !v.muted;
    $('#btnMute').textContent = v.muted ? '🔇' : '🔊';
    $('#btnMute').classList.toggle('on', !v.muted);
    if (!v.muted) v.play().catch(() => {});
  };
  $('#btnFs').onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else $('#stage').requestFullscreen().catch(() => {});
  };

  if (store.get('mirror', false)) $('#btnMirror').click();

  /* --- pairing --- */
  $('#copyLink').onclick = async () => {
    try { await navigator.clipboard.writeText($('#joinUrl').dataset.url); toast('Link copied'); }
    catch { toast('Copy failed — select the link manually'); }
  };
  $('#newRoom').onclick = () => { renderJoin(newRoom(), 'New code button'); connectViewerSignal(); };

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
  $('#mvScan').onclick = () => startScan().catch(e => toast('Scanner failed: ' + e.message));
  $('#mvGo').onclick = () => manualFinish($('#mvIn').value).catch(e => toast('Could not read that code: ' + e.message));
  scannerAvailable().then(ok => {
    $('#mvScan').disabled = !ok;
    $('#mvScanNote').textContent = ok ? '' : 'no QR scanner in this browser — paste instead';
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
    else if (k === 'p') $('#btnPip').click();
    else if (k === 'u') $('#btnMute').click();
    else if (k === 'l') $('#btnLive').click();
    else if (e.key === 'ArrowLeft') { e.preventDefault(); jump(e.shiftKey ? -30 : -5); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); jump(e.shiftKey ? 30 : 5); }
    else if (k === '+' || k === '=') setDelay(D.delayMs / 1000 + 5);
    else if (k === '-') setDelay(D.delayMs / 1000 - 5);
  });
}

function jump(sec) {
  const { sb, video } = D;
  if (!sb || !sb.buffered.length || D.bypass) return;
  const start = sb.buffered.start(0), end = sb.buffered.end(sb.buffered.length - 1);
  const t = clamp(video.currentTime + sec, start + 0.05, end - 0.05);
  video.currentTime = t;
  D.live = (end - t) < 1;
  D.frozen = false; $('#btnFreeze').classList.remove('on');
  setLiveBtn();
  video.play().catch(() => {});
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

wire();
route();
