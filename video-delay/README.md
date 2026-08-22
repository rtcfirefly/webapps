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
| **Live PiP** | small *undelayed* thumbnail in the corner, for framing the shot |
| **⛶** | fullscreen |

Keys: `space` freeze · `f` fullscreen · `m` mirror · `p` PiP · `u` audio ·
`l` live · `←`/`→` jump 5 s (`shift` 30 s) · `+`/`-` delay ±5 s.

## How it works

**Transport** — a plain `RTCPeerConnection`. Public Google/Cloudflare STUN,
with public OpenRelay TURN as a fallback for when the two devices can't reach
each other directly. On the same Wi-Fi, STUN is enough and nothing leaves
the LAN.

**Signalling** — WebRTC needs a side channel to swap SDP, and GitHub Pages is
static, so there is nothing to run a socket on. The app talks the PeerJS public
broker's protocol directly over a WebSocket (no `peerjs` library — it's about
40 lines in `app.js`). The broker only relays `{type, dst, payload}` blobs; it
never sees media. Two escape hatches if it's down or you don't want to use it:

- **Manual pairing** — under *Pair manually* on both pages. Phone makes an
  offer code, you get it to the PC, PC hands back an answer code. Codes are
  gzip+base64 of the full SDP (~700 chars), so ICE is gathered up front and one
  blob is enough. Zero third parties.
- **`signal-server.js`** — a ~20-line Deno relay speaking the same protocol.
  `deno run --allow-net signal-server.js`, then point *Advanced → Signalling
  WebSocket URL* at it.

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

## Troubleshooting

- **"no broker" / manual pairing opens by itself** — the public PeerJS broker is
  down or blocked. Use manual pairing, or run `signal-server.js`.
- **"no viewer with that code"** — open the Viewer page first; it has to be
  registered before the phone offers. Codes are per-browser and persist.
- **Connects, then fails** — usually a NAT that needs TURN. The bundled public
  TURN credentials are best-effort; put your own in *Advanced → ICE servers*.
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
