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

/* ----------------------------------------------------------------- ICE  */

const DEFAULT_ICE = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
    // Public TURN. Only needed when the two devices cannot reach each other
    // directly (phone on mobile data, or a NAT that blocks hairpinning).
    { urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turns:openrelay.metered.ca:443?transport=tcp'],
      username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: ['turn:staticauth.openrelay.metered.ca:80', 'turn:staticauth.openrelay.metered.ca:443'],
      username: 'openrelayproject', credential: 'openrelayproject' },
  ],
  iceCandidatePoolSize: 2,
};

function iceConfig() {
  const raw = (store.get('ice', '') || '').trim();
  if (raw) { try { return JSON.parse(raw); } catch { toast('ICE JSON is invalid — using defaults'); } }
  return DEFAULT_ICE;
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
      let ws;
      try { ws = this.ws = new WebSocket(url); } catch (e) { reject(e); return; }
      let settled = false, live = false;
      const fail = (e) => { if (settled) return; settled = true; clearTimeout(timer); reject(e); try { ws.close(); } catch {} };

      const timer = setTimeout(() => fail(new Error('signalling timed out')), 12000);

      ws.onopen = () => { this.hb = setInterval(() => this.raw({ type: 'HEARTBEAT' }), 5000); };
      ws.onerror = () => fail(new Error('signalling connection failed'));
      ws.onclose = () => {
        clearInterval(this.hb);
        if (!settled) fail(new Error('signalling closed'));
        else if (live) { live = false; this.dispatchEvent(new Event('down')); }
      };
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.type === 'OPEN') { clearTimeout(timer); settled = true; live = true; resolve(); return; }
        if (m.type === 'ID-TAKEN') { fail(new Error('ID-TAKEN')); return; }
        this.dispatchEvent(new CustomEvent('msg', { detail: m }));
      };
    });
  }

  raw(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
  send(type, dst, payload) { this.raw({ type, dst, payload }); }
  close() { clearInterval(this.hb); try { this.ws && this.ws.close(); } catch {} this.ws = null; }
}

/* Codes avoid 0/O and 1/I so they can be read off a screen and typed. */
const ALPHA = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const newRoom = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => ALPHA[b % 32]).join('');
const rand4 = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), b => ALPHA[b % 32]).join('');
const viewerId = room => `vd-${room}-v`;
const cameraId = room => `vd-${room}-c${rand4()}`;

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

/* Manual pairing codes: gzip + base64 keeps a full SDP around 700 chars. */
const B64 = {
  enc: u8 => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); },
  dec: s => Uint8Array.from(atob(s), c => c.charCodeAt(0)),
};
async function pack(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  if (!window.CompressionStream) return 'J' + B64.enc(bytes);
  const cs = new CompressionStream('gzip');
  const buf = await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer();
  return 'Z' + B64.enc(new Uint8Array(buf));
}
async function unpack(str) {
  const s = (str || '').trim().replace(/\s+/g, '');
  if (!s) return null;
  const body = B64.dec(s.slice(1));
  if (s[0] === 'J') return JSON.parse(new TextDecoder().decode(body));
  const ds = new DecompressionStream('gzip');
  const buf = await new Response(new Blob([body]).stream().pipeThrough(ds)).arrayBuffer();
  return JSON.parse(new TextDecoder().decode(buf));
}

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

  const mime = pickMime(stream.getAudioTracks().length > 0);
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
    try { sb.mode = 'sequence'; } catch {}
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
      console.warn('[vd] appendBuffer', e);
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
  const el = $('#sigState');
  el.textContent = text;
  el.className = 'pill' + (cls ? ' ' + cls : '');
}

function setDelay(sec, persist = true) {
  sec = clamp(Math.round(sec) || 0, 0, 600);
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

function newViewerPC(remoteId) {
  if (V.pc) { try { V.pc.close(); } catch {} }
  const pc = V.pc = new RTCPeerConnection(iceConfig());
  V.peer = remoteId; V.pendingCands = [];
  pc.addEventListener('icecandidate', e => {
    if (e.candidate && V.sig && remoteId) V.sig.send('CANDIDATE', remoteId, e.candidate.toJSON());
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
  await pc.setRemoteDescription(m.payload.sdp);
  // Answer immediately and trickle candidates as separate messages. A
  // fully-gathered SDP is both slow and a large single broker message.
  await pc.setLocalDescription(await pc.createAnswer());
  if (V.sig) V.sig.send('ANSWER', m.src, { sdp: sdpJson(pc.localDescription) });
  for (const c of early) { try { await pc.addIceCandidate(c); } catch {} }
}

async function startViewer() {
  show('viewer');
  setDelay(store.get('delay', 30), false);
  renderJoin(store.get('room', '') || newRoom());
  updateOverlay();
  await connectViewerSignal();
}

function renderJoin(room) {
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
      vTaken = 0; renderJoin(newRoom()); vTimer = setTimeout(connectViewerSignal, 300); return;
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
      if (V.pc && V.pc.remoteDescription) V.pc.addIceCandidate(m.payload).catch(() => {});
      else V.pendingCands.push(m.payload);
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

const C = { sig: null, pc: null, stream: null, room: '', wake: null, retry: 0, pendingCands: [], backoff: 1000 };

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

function setCamState(t, cls) { const el = $('#camState'); el.textContent = t; el.className = 'pill' + (cls ? ' ' + cls : ''); }

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

function newCameraPC(dst) {
  if (C.pc) { try { C.pc.close(); } catch {} }
  const pc = C.pc = new RTCPeerConnection(iceConfig());
  C.pendingCands = [];
  for (const t of C.stream.getTracks()) pc.addTrack(t, C.stream);
  pc.addEventListener('icecandidate', e => {
    if (e.candidate && C.sig && dst) C.sig.send('CANDIDATE', dst, e.candidate.toJSON());
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
  // Trickle. The previous version waited for full ICE gathering and shipped
  // host + srflx + relay candidates for four TURN URLs in a single broker
  // message, which is slow and large enough to get the socket closed.
  await pc.setLocalDescription(await pc.createOffer());
  C.sig.send('OFFER', dst, { sdp: sdpJson(pc.localDescription) });
  setCamState('offer sent\u2026');
}

async function onCamMsg(ev) {
  const m = ev.detail;
  if (m.type === 'ANSWER') {
    if (!C.pc) return;
    try {
      await C.pc.setRemoteDescription(m.payload.sdp);
      setCamState('answered \u2014 connecting\u2026');
      for (const c of C.pendingCands) { try { await C.pc.addIceCandidate(c); } catch {} }
      C.pendingCands = [];
    } catch (e) { console.warn('[vd] answer', e); }
  } else if (m.type === 'CANDIDATE') {
    if (C.pc && C.pc.remoteDescription) C.pc.addIceCandidate(m.payload).catch(() => {});
    else C.pendingCands.push(m.payload);
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

/* ============================== WIRING ============================== */

function wire() {
  /* --- home --- */
  $('#goViewer').onclick = () => { location.hash = '#v'; startViewer(); };
  $('#goCamera').onclick = () => { show('camera'); $('#codeIn').focus(); };
  for (const b of document.querySelectorAll('[data-back]')) {
    b.onclick = () => { stopDelay(); stopCamera(); if (V.sig) V.sig.close(); if (V.pc) try { V.pc.close(); } catch {}
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
  $('#newRoom').onclick = () => { renderJoin(newRoom()); connectViewerSignal(); };

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

  /* --- manual pairing, viewer side --- */
  $('#mvGo').onclick = async () => {
    try {
      const o = await unpack($('#mvIn').value);
      if (!o || o.k !== 'offer') { toast('That is not an offer code'); return; }
      const pc = newViewerPC(null);
      await pc.setRemoteDescription(o.sdp);
      await pc.setLocalDescription(await pc.createAnswer());
      $('#mvOut').value = '…gathering…';
      await waitIce(pc, 5000);
      $('#mvOut').value = await pack({ k: 'answer', sdp: sdpJson(pc.localDescription) });
      toast('Answer ready — send it to the phone');
    } catch (e) { toast('Could not read that code: ' + e.message); }
  };
  $('#mvCopy').onclick = () => { navigator.clipboard.writeText($('#mvOut').value).then(() => toast('Copied'), () => {}); };

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
  $('#mcMake').onclick = async () => {
    try {
      if (!C.stream) {
        C.stream = await getCam(store.get('facing', 'environment'), Number($('#res').value));
        $('#pv').srcObject = C.stream; $('#camJoin').hidden = true; $('#camLive').hidden = false; keepAwake();
      }
      const pc = newCameraPC(null);
      await pc.setLocalDescription(await pc.createOffer());
      $('#mcOut').value = '…gathering…';
      await waitIce(pc, 5000);
      $('#mcOut').value = await pack({ k: 'offer', sdp: sdpJson(pc.localDescription) });
      setCamState('offer made — waiting for answer');
    } catch (e) { toast('Could not make an offer: ' + e.message); }
  };
  $('#mcCopy').onclick = () => { navigator.clipboard.writeText($('#mcOut').value).then(() => toast('Copied'), () => {}); };
  $('#mcGo').onclick = async () => {
    try {
      const a = await unpack($('#mcIn').value);
      if (!a || a.k !== 'answer') { toast('That is not an answer code'); return; }
      await C.pc.setRemoteDescription(a.sdp);
      setCamState('connecting…');
    } catch (e) { toast('Could not read that code: ' + e.message); }
  };

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
  const m = /^#c=([A-Za-z0-9]+)/.exec(h);
  if (m) { show('camera'); $('#codeIn').value = m[1].toUpperCase(); return; }
  if (h === '#v') { startViewer(); return; }
  show('home');
}

wire();
route();
