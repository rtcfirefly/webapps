// runs-in: host (or anywhere with Deno) — optional.
//
// A ~20-line stand-in for the public signalling broker, speaking the same
// subset of the PeerJS protocol that app.js uses. Only needed if the public
// broker is down or you would rather not hand your SDP to a third party.
//
//   deno run --allow-net signal-server.js
//   then in the app: Advanced -> Signalling WebSocket URL -> ws://<host>:8787
//
// It relays {type, dst, payload} to the peer registered as `dst`, tagged with
// {src}. It never inspects or stores the payload.

const peers = new Map();
const PORT = Number(Deno.env.get('PORT') ?? 8787);

Deno.serve({ port: PORT }, (req) => {
  const id = new URL(req.url).searchParams.get('id');
  if (!id || req.headers.get('upgrade') !== 'websocket') {
    return new Response('video-delay signalling relay\n', { headers: { 'content-type': 'text/plain' } });
  }
  const { socket, response } = Deno.upgradeWebSocket(req);
  const send = (o) => { if (socket.readyState === 1) socket.send(JSON.stringify(o)); };

  socket.onopen = () => {
    if (peers.has(id)) { send({ type: 'ID-TAKEN' }); socket.close(); return; }
    peers.set(id, socket);
    send({ type: 'OPEN' });
  };
  socket.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'HEARTBEAT' || !m.dst) return;
    const dst = peers.get(m.dst);
    if (dst && dst.readyState === 1) dst.send(JSON.stringify({ type: m.type, src: id, payload: m.payload }));
    else send({ type: 'EXPIRE', src: m.dst });
  };
  socket.onclose = () => { if (peers.get(id) === socket) peers.delete(id); };
  return response;
});
console.log(`signalling relay on :${PORT}`);
