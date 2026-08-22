# Video Delay

Your phone's camera on your PC screen, **N seconds late**. WebRTC for the
transport, a `MediaRecorder` → `MediaSource` buffer for the delay.

Live at **https://rtcfirefly.github.io/webapps/video-delay/**

No dependencies, no build step, no bundler — three static files.

## Use it

1. On the **PC**, open the page and pick **Viewer**. It shows a 6-character code.
2. On the **phone**, open the same page, tap **Camera**, type the code
   (or just open the `#c=CODE` link the viewer prints).
3. Video appears on the PC 30 seconds later. Drag the slider to change that,
   0–600 s, live.

The delay is real: you can leave the phone propped up, walk into frame, and
watch yourself half a minute ago.

### Viewer controls

| | |
|---|---|
| **Delay** | slider / number box / presets — changes take effect immediately |
| **Live** | jump back to the delayed live edge |
| **⏪ 10s** | replay within the buffer (last 40 s of played video is kept) |
| **Freeze** | freeze frame; unfreezing leaves you in replay |
| **Mirror** | flip horizontally — for practising in front of it |
| **Layout** | **split** (live left, delayed right), **delayed only**, or a corner live thumbnail |
| **⛶** | fullscreen |

In **fullscreen** the toolbar is gone, so a control bar inside the video
carries the delay: `−10 −5 −1 · 30s · +1 +5 +10`. It fades out with the cursor
after a few idle seconds and returns on any movement or key.

Keys: `space` freeze · `f` fullscreen · `m` mirror · `p` layout · `u` audio ·
`l` live · `←`/`→` jump 5 s (`shift` 30 s).
Delay: `-`/`=` ±1 s · `_`/`+` ±5 s · `alt` with any of them ±10 s (`↑`/`↓` also
work, with `shift` for 5 s). `+` is already Shift+`=` on most layouts, so the
shifted glyph picks the bigger step rather than a Shift modifier.

## How it works

**Transport** — a plain `RTCPeerConnection` with public Google/Cloudflare STUN.
On the same Wi-Fi that's enough and nothing but the SDP leaves the LAN. There is
**no TURN by default**: the OpenRelay servers that used to be here stopped
resolving entirely, and there is no free relay worth trusting. If the two
devices genuinely can't see each other directly, put your own credentials in
*Advanced → ICE servers*.

Negotiation is pinned to VP8 (+opus) with `setCodecPreferences`. A stock Chrome
offer lists VP8, VP9, AV1 and four H.264 profiles with rtpmap/fmtp/rtcp-fb lines
for each, which came to ~6 KB — large enough that the public broker closed the
socket on it, and far too large for a QR. VP8 is also what the delay buffer
re-encodes to, so this keeps one codec end to end.

**Signalling** — WebRTC needs a side channel to swap SDP, and GitHub Pages is
static, so there is nothing to run a socket on. The app talks the PeerJS public
broker's protocol directly over a WebSocket (no `peerjs` library — it's about
40 lines in `app.js`). The broker only relays `{type, dst, payload}` blobs; it
never sees media. SDP goes over it with trickle ICE, so each message stays
small and the socket is only needed while a call is being set up — once media
flows, the broker can vanish without affecting anything. Both sides reconnect
with backoff. Two escape hatches if it's down or you don't want to use it:

- **Manual pairing** — two steps, under *Pair manually* on both pages, and
  entirely free of third parties. See below.

- **`signal-server.js`** — a ~20-line Deno relay speaking the same protocol.
  `deno run --allow-net signal-server.js`, then point *Advanced → Signalling
  WebSocket URL* at it.

### Manual pairing, in two steps

1. **PC → phone, by QR.** The viewer makes a `recvonly` offer and renders it as
   a QR holding a deep link to this page with the offer in the `#fragment`.
   Point the phone's own camera app at it and the link opens the camera page,
   grabs the camera and produces an answer — one tap, no scanner to write, and
   the leg a QR *can* carry is also the one that bootstraps the phone into the
   right state.
2. **Phone → PC.** This direction has no such trick, so it offers both: the
   phone shows its answer as a QR to hold up to the PC's webcam, and the same
   answer as a copyable code. The scan button disables itself with a note where
   `BarcodeDetector` is missing — notably Chrome on Linux — and the paste box
   beside it always works.

Getting the payload small enough to scan is the whole game. `setCodecPreferences`
pinning to VP8 does most of it (a stock Chrome offer is ~6 KB, mostly codec
lines); the rest is `deflate-raw` + base64url, and dropping Chrome's port-9 TCP
placeholder candidates. That lands around 900–1000 characters — a version 22–23
QR, rendered at 560 px so each module is ~5 px. If a payload ever overflows QR
capacity the code hides itself and the copyable text takes over.

The QR encoder in `qr.js` is vendored from
[burn-after-reading](https://github.com/rtcfirefly/burn-after-reading) — an
original implementation of ISO/IEC 18004 (byte mode, Reed–Solomon over GF(256),
all eight masks with penalty selection). There is deliberately no QR *decoder*:
reading codes uses the browser's `BarcodeDetector` where it exists, and falls
back to paste where it doesn't.

**The delay** — the naive approach (ring-buffer of frames on a canvas) costs
~3 GB for 30 s of 720p. Instead the incoming stream goes through
`MediaRecorder` at 200 ms chunks; the chunks sit in a queue until they're N
seconds old, then get appended to a `MediaSource` the `<video>` is playing.
That's compressed video, so 30 s costs roughly 10 MB. Playback is nudged to
sit ~0.35 s behind the buffer edge, old data is pruned 40 s behind the
playhead, and shortening the delay releases a burst of chunks and seeks
forward.

Codec is whichever of VP8/VP9-in-WebM or H.264-in-MP4 both `MediaRecorder` and
`MediaSource` claim to support. If nothing decodes within 6 s of the first
release, the viewer gives up and shows undelayed live video rather than a
black rectangle.

## Deploying

It's plain static files in `video-delay/` of the `webapps` repo, served by
GitHub Pages from the default branch. Nothing to build:

```sh
git add video-delay && git commit -m "..." && git push
```

Every path is relative, so it works from any subdirectory.

**HTTPS is required** — `getUserMedia` won't run on `http://`. GitHub Pages is
HTTPS, so that's handled; if you serve it locally, `localhost` also counts.

## Browser support

| | Viewer (delay buffer) | Camera |
|---|---|---|
| Chrome / Edge desktop | yes | — |
| Firefox desktop | yes | — |
| Chrome / Firefox Android | yes | yes |
| Safari / iOS | untested — `ManagedMediaSource` path is handled, but Safari's `MediaRecorder` MP4 output may not be appendable; it will fall back to live | yes |

Put the **viewer** on Chrome or Firefox. The camera side is ordinary WebRTC and
works anywhere.

## Debug log

Both pages have a **🐞 Debug log** panel at the bottom (also reachable from the
🐞 button in the viewer toolbar / camera controls). **Copy log** puts the whole
thing on the clipboard, **Download** saves it as a text file — either is fine to
paste somewhere for diagnosis.

It records the broker socket lifecycle (including the WebSocket close code and
reason, which is the thing that says *why* a connection dropped), every
signalling message with its type and size, all four `RTCPeerConnection` state
machines, every ICE candidate, `icecandidateerror` events with the STUN/TURN URL
that failed, the selected candidate pair once connected (so you can see whether
it went direct or via TURN), the chosen recorder/MSE codec, and a delay-pipeline
summary every 5 s.

**IP addresses are reduced to their first octet** (`192.x.x.x`, `mdns.local`,
`ipv6`) — candidate type and protocol are what diagnose a connection, the rest is
just your network. Full SDP is *off* by default for the same reason; the
checkbox in the panel turns it on if it's genuinely needed.

## Troubleshooting

- **"no broker" / manual pairing opens by itself** — the public PeerJS broker is
  down or blocked. It keeps retrying in the background; meanwhile use manual
  pairing, or run `signal-server.js`.
- **"broker dropped" on the phone** — phones close WebSockets on backgrounding,
  screen-off and network handover. It reconnects automatically, and a call that
  is already up is unaffected.
- **"no viewer with that code"** — open the Viewer page first; it has to be
  registered before the phone offers. Codes are per-browser and persist.
- **Connects, then fails** — usually a NAT that needs a relay. There is no TURN
  configured by default; put your own in *Advanced → ICE servers*.
- **Scan button greyed out on the PC** — no `BarcodeDetector` in that browser
  (Chrome on Linux doesn't ship it). Paste the answer code instead.
- **"LIVE (no delay)" in the HUD** — no working recorder/MSE codec pair on this
  browser. Try Chrome or Firefox for the viewer.
- **Phone screen sleeps** — the camera page takes a `wakeLock`; some browsers
  ignore it. Bump the screen timeout.

## Status

Written in one pass and **not yet run against real devices** — the machine it
was written on had neither a browser nor network access. The logic is
straightforward but expect to shake out a bug or two on first use; the HUD
(bottom-left of the viewer) reports connection state, resolution, fps, bitrate
and the measured delay, which is where to look first.
