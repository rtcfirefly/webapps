# Video Delay

Your phone's camera on your PC screen, **N seconds late**. WebRTC for the
transport, a `MediaRecorder` → `MediaSource` buffer for the delay.

Live at **https://rtcfirefly.github.io/webapps/video-delay/**

No dependencies, no build step, no bundler — three static files.

## Use it

Open the same URL on both devices. There is nothing to choose:

1. The **desktop** lands on a full-page **QR code** and waits.
2. The **phone** lands on a **QR scanner**. Point it at the screen.
3. Connected. The PC replaces the QR with the video; the delay controls appear
   with it. Drag the slider for 0–600 s, live.

Roles are guessed from the device, and the guess is one tap to undo — each page
has a *this is my camera / this is my screen* link. `#v` and `#cam` force a role.

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
| **Self** | this computer's webcam inset into each pane — live inside live, delayed inside delayed |

The HUD (bottom-left) also shows the **phone's battery**, sent over the same
authenticated data channel that carries the pairing token — useful when the
phone spends a whole session on a tripod. It turns red below 15 % and warns
once. Needs `navigator.getBattery`, which Chrome has and Firefox and Safari
deliberately removed; where it is missing the chip simply does not appear.
| **⛶** | fullscreen |

In **fullscreen** the toolbar is gone, so a control bar inside the video
carries the delay: `−10 −5 −1 · 30s · +1 +5 +10`. It fades out with the cursor
after a few idle seconds and returns on any movement or key.

Keys: `space` freeze · `f` fullscreen · `m` mirror · `p` layout · `c` self-view ·
`u` audio · `l` live · `←`/`→` jump 5 s (`shift` 30 s).

Freeze, Live and the jump keys act on **both** feeds at once, so the phone and
the self-view stay aligned.

**Drag the self-view** to move it, drag its bottom-right grip to resize, and
double-click to reset. Both tiles share one position and size — expressed as a
percentage of their pane, so they stay symmetric and survive a window resize or
a change of layout — and it is remembered across sessions.
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

- **The pairing QR** — carries a standalone offer as well as the room code, so
  it finishes the connection with no broker at all if the broker is down. See
  below.

- **`signal-server.js`** — a ~20-line Deno relay speaking the same protocol.
  `deno run --allow-net signal-server.js`, then point *Advanced → Signalling
  WebSocket URL* at it.

### Pairing: one QR, two routes

The viewer shows a QR as soon as it loads. It encodes a link to this page whose
fragment carries **both** the room code and a complete, standalone offer, so a
single scan works whichever way the connection ends up being made:

1. **Scan it with the phone's own camera app.** The link opens the camera page,
   which starts the camera and tries the **broker** first — that route needs no
   return leg at all, so it just connects and you are done.
2. **If the broker does not finish it**, the phone falls back automatically to
   the offer embedded in the same code: it answers locally and shows its answer
   as a QR. Bring that back with *Scan the phone's QR* on the PC (or paste the
   code). No third party involved.

The fallback fires when the broker socket will not open, when no `ANSWER` comes
back within 6 s, or when nothing has connected within 10 s. The phone stops
trying the broker before falling back, because a late broker offer would replace
the viewer's connection and strand the answer it is about to produce.

Both routes are live at once on the PC and race; whichever completes first wins,
and a late arrival cannot tear down a pairing that already finished.

Getting the payload small enough to scan is the whole game. `setCodecPreferences`
pinning to VP8 does most of it (a stock Chrome offer is ~6 KB, mostly codec
lines); the rest is `deflate-raw` + base64url, and dropping Chrome's port-9 TCP
placeholder candidates. That lands around 900 characters — a version 22 QR,
rendered at 560 px so each module is ~5 px. Adding the room code to it cost 15
characters and did not change the version. If a payload ever overflows QR
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

## Cache busting

Pairing links carry a `?v=` token, and the loader in `index.html` propagates it
to `app.js`, `qr.js` and `style.css`. That last part is the point: GitHub Pages
sets its own `Cache-Control` (~10 minutes) and gives you no way to override it,
so a token on the document alone would fetch a fresh `index.html` that still
pulled the *old* scripts out of the phone's cache.

*Advanced → Cache-bust TTL* controls how often the token changes:

- **0 (default)** — a fresh token per link, so every scan is a cold load. This is
  what you want while iterating on the code.
- **N minutes** — the token is quantised to N, so repeat scans inside the window
  reuse the cache. Raise it once things settle.

There is no service worker and no application cache to configure; the URL is the
only lever, which is why the TTL lives here rather than in a header.

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

## Pairing security (optional)

### The QR is the authentication channel

The pairing QR carries the viewer's offer, and that offer carries the viewer's
**DTLS certificate fingerprint** — delivered to the phone over a camera rather
than over the broker. The viewer generates **one certificate per session** and
reuses it for every connection it makes, so that fingerprint stays valid however
the connection is finally established.

So the phone pins it. When the answer comes back, if its fingerprint is not the
one that was scanned, **the phone refuses before `setRemoteDescription` and
sends nothing**. A broker that substituted a peer, or someone who guessed the
room code and answered first, is rejected automatically — no comparing, no user
decision.

That is one direction. It gives the **viewer** no reason to trust the phone —
whoever saw the QR could have used it. So the QR also carries a **one-time token
that never touches the broker**, and the phone echoes it back over a data
channel on the established connection. Because that channel is inside DTLS, the
echo can only come from the peer actually connected, and only a peer that saw
the screen knows the value. Both ends therefore verify automatically:

| | proves | how |
|---|---|---|
| phone → PC | this is the PC whose QR I scanned | certificate fingerprint pinned from the QR |
| PC → phone | this peer saw my screen | one-time token echoed inside DTLS |

A relay cannot launder the token by forwarding someone else's: the phone's
fingerprint pin refuses the relayed leg before any of it happens.

Typing a room code by hand skips the QR, so there is no token and the PC stays
unverified — correctly, because nothing has been proven. Use the manual code
below in that case. The fingerprint half needs
`RTCPeerConnection.generateCertificate`; where that is unavailable the app still
works and falls back to the manual check.

Once connected, **Pairing security** on both pages shows a safety code — three
groups of four letters for reading, plus a QR carrying the **entire SHA-256**.
Nothing has to be typed from the QR, so there is no reason to truncate it: it
is 52 base32 characters, which is still only a version-3 code.

Both ends derive it by hashing the two **DTLS certificate fingerprints actually
in use** for the connection, sorted so neither needs to know which end it is.
Those fingerprints are what the media stream is authenticated against, so
anyone who came between you on the signalling channel must present a different
certificate — and the codes diverge.

That matters here because the peer id is derived from the room code: someone
who guesses your six characters could register the viewer id first and answer
in your place. Verification is what turns that from undetectable into obvious.

Two ways to check, both optional:

- **Scan** — hold the phone up to the PC's webcam and press *Scan the phone's
  code*. All 256 bits are compared, so this is a real check, not a glance.
- **By eye** — compare the twelve letters (60 bits). Shortened only because a
  human is reading it; the alphabet omits `0/O` and `1/I` so misreads show.

`verified` means both ends see the same certificate pair. **`MISMATCH` means
someone is in the middle — stop.** The scan button disables itself where
`BarcodeDetector` is missing; comparing by eye works everywhere.

## Troubleshooting

- **"no broker" / manual pairing opens by itself** — the public PeerJS broker is
  down or blocked. It keeps retrying in the background; meanwhile use manual
  pairing, or run `signal-server.js`.
- **"broker dropped" on the phone** — phones close WebSockets on backgrounding,
  screen-off and network handover. It reconnects automatically, and a call that
  is already up is unaffected.
- **"no viewer with that code"** — open the Viewer page first; it has to be
  registered before the phone offers. Codes are per-browser and persist.
- **Connects, then fails, and only when the two devices are on different
  networks** — you need TURN, and no setting on this page can substitute for it.
  STUN only tells a peer its public address; it cannot make an unreachable peer
  reachable. Two devices behind a VPN (Cloudflare WARP, Tailscale exit nodes) or
  behind carrier-grade NAT have no direct path at all, so ICE exhausts every
  candidate pair and fails. Same Wi-Fi works because the host candidates reach
  each other on the LAN without leaving it.

  **Cloudflare WARP on either device is enough to cause this**, even when the
  other end is on a perfectly ordinary connection: WARP puts the device behind
  Cloudflare's carrier NAT, so its reflexive candidate is unreachable from
  outside. Same Wi-Fi still works because WARP does not tunnel LAN traffic.

  The debug log names this explicitly on failure: it prints the candidate types
  gathered, and if there is no `relay` on either side it says so. Fix it by
  putting a TURN server in *Advanced → TURN*, then tick **force relay-only** to
  confirm the relay itself works rather than guessing whether a success came
  from it or from a lucky direct path.
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
