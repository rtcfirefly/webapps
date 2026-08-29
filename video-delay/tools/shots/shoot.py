#!/usr/bin/env python3
# runs-in: container
"""Screenshot and smoke-test video-delay.

Serves a copy of the repo over loopback and points headless Chromium at it, so
no network is needed and the default run is --network none. The repo is mounted
read only; the served copy differs only by two injected scripts -- one killing
animation so captures are not a race, one collecting JS errors so a page that
throws on boot cannot look fine in a screenshot.

Chromium is given a fake camera, which is what makes any of this possible: the
app is nothing but getUserMedia and WebRTC, and a real device is not available
here.

Run through tools/shots/run.sh.
"""

import http.server
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time

REPO, SITE, OUT, PORT = '/repo', '/tmp/site', '/out', 8138

# Animations make capture a race: a fading banner or a scaling modal can be
# caught mid-flight. Nothing here measures animation.
STILL = """<style>
*, *::before, *::after {
  animation-duration: 0s !important; animation-delay: 0s !important;
  transition-duration: 0s !important; transition-delay: 0s !important;
}
</style>"""

# A page that throws on boot still screenshots as a plausible-looking layout.
# Collect everything and park it in the DOM where --dump-dom can retrieve it.
ERRS = """<script>
window.__errs = [];
addEventListener('error', function (e) {
  window.__errs.push('error: ' + e.message + ' @' + String(e.filename || '').split('/').pop() + ':' + e.lineno);
});
addEventListener('unhandledrejection', function (e) {
  var r = e.reason; window.__errs.push('rejection: ' + ((r && r.message) || r));
});
(function (orig) {
  console.error = function () { window.__errs.push('console.error: ' + [].join.call(arguments, ' ')); orig.apply(console, arguments); };
})(console.error);
addEventListener('load', function () {
  setTimeout(function () {
    var d = document.createElement('div');
    d.id = '__errs'; d.style.display = 'none';
    d.textContent = JSON.stringify(window.__errs);
    document.body.appendChild(d);
  }, 2500);
});
</script>"""

CHROME = [
    'chromium', '--headless',
    # Chromium's own sandbox needs privileges this container deliberately drops.
    # The container is the boundary: no network, all capabilities dropped,
    # no-new-privileges, and the only thing rendered is the copy made below.
    '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--hide-scrollbars',
    # The whole app is a camera. Without these getUserMedia rejects and every
    # screenshot is of an error state.
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    # With --network none the only interface is lo, and WebRTC excludes loopback
    # candidates by default -- so ICE gathers nothing and every pairing fails
    # regardless of the app. This flag exists for exactly this case.
    '--allow-loopback-in-peer-connection',
    # mDNS host-candidate obfuscation cannot resolve without a network. Media
    # permission normally disables it; belt and braces, because a .local
    # candidate here is an unresolvable one.
    '--disable-features=WebRtcHideLocalIpsWithMdns',
]


def build_site():
    if os.path.exists(SITE):
        shutil.rmtree(SITE)
    shutil.copytree(REPO, SITE, ignore=shutil.ignore_patterns('.git', 'logs', 'tools'))
    for rel in ('index.html', 'test/pair.html'):
        p = os.path.join(SITE, rel)
        if not os.path.exists(p):
            continue
        html = open(p, encoding='utf-8').read()
        inject = STILL + '\n' + ERRS
        html = html.replace('</head>', inject + '\n</head>', 1) if '</head>' in html \
            else inject + html
        if rel == 'test/pair.html':
            # Injected rather than committed, so the page stays usable in a real
            # browser without a resource that deliberately hangs.
            html += '\n<img src="/__hold?ms=60000" alt="" style="display:none">\n'
        open(p, 'w', encoding='utf-8').write(html)


class Handler(http.server.SimpleHTTPRequestHandler):
    """Adds /__hold?ms=N, which answers after N real milliseconds.

    --virtual-time-budget fast-forwards timers, so a page that waits on real
    work -- getUserMedia resolving, ICE gathering, DTLS completing -- sees its
    own timeouts expire before any of it has happened. That is what failed the
    pairing test the first time. A slow resource holds the load event open
    instead, and headless Chromium dumps the DOM after load, so the page gets
    real seconds without virtual time in the picture."""

    def do_GET(self):
        if self.path.startswith('/__hold'):
            ms = 30000
            m = re.search(r'ms=(\d+)', self.path)
            if m:
                ms = min(int(m.group(1)), 180000)
            time.sleep(ms / 1000.0)
            body = b'\x89PNG\r\n\x1a\n'          # enough to be a response
            self.send_response(200)
            self.send_header('Content-Type', 'image/png')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        return super().do_GET()

    def log_message(self, *a):
        pass                                       # the request log drowns the report


def serve():
    handler = lambda *a, **kw: Handler(*a, directory=SITE, **kw)
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), handler)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def url(path):
    return 'http://127.0.0.1:%d/%s' % (PORT, path)


def capture(name, path, width, height, budget=6000, scale=2):
    out = os.path.join(OUT, name + '.png')
    args = ['--force-device-scale-factor=%d' % scale, '--window-size=%d,%d' % (width, height)]
    if budget:
        args.append('--virtual-time-budget=%d' % budget)
    r = subprocess.run(CHROME + args + ['--screenshot=' + out, url(path)],
                       capture_output=True, text=True, timeout=300)
    if not os.path.exists(out):
        print('  FAILED %s\n%s' % (name, r.stderr[-800:]), file=sys.stderr)
        return False
    print('  %-22s %dx%d @%dx  %s bytes' % (name + '.png', width, height, scale,
                                            format(os.path.getsize(out), ',')))
    return True


def dom(path, width=1400, height=900, budget=8000):
    args = ['--window-size=%d,%d' % (width, height)]
    # budget=None means real time: the caller is holding the load event open
    # because it is waiting on something virtual time would skip past.
    if budget:
        args.append('--virtual-time-budget=%d' % budget)
    r = subprocess.run(CHROME + args + ['--dump-dom', url(path)],
                       capture_output=True, text=True, timeout=300)
    return r.stdout


def errors_in(html):
    m = re.search(r'<div id="__errs"[^>]*>(.*?)</div>', html, re.S)
    if not m:
        return None                      # collector never ran: page died early
    try:
        return json.loads(m.group(1) or '[]')
    except Exception:
        return []


SHOTS = [
    # name,              path,                      w,    h,    budget
    ('viewer-1400',      'index.html#v',            1400, 900,  6000),
    ('viewer-900',       'index.html#v',            900,  800,  6000),
    ('camera-390',       'index.html#cam',          390,  844,  6000),
    ('home-1400',        'index.html#home',         1400, 900,  4000),
]


def main():
    os.makedirs(OUT, exist_ok=True)
    build_site()
    serve()
    failures = []

    print('screenshots:')
    for name, path, w, h, budget in SHOTS:
        if not capture(name, path, w, h, budget):
            failures.append('screenshot ' + name)

    print('\nJS errors on boot:')
    for name, path, _, _, _ in SHOTS:
        errs = errors_in(dom(path))
        if errs is None:
            print('  %-14s COLLECTOR NEVER RAN — the page died before load' % name)
            failures.append(name + ': page died before load')
        elif errs:
            print('  %-14s %d' % (name, len(errs)))
            for e in errs:
                print('      ' + e)
            failures.append(name + ': %d JS errors' % len(errs))
        else:
            print('  %-14s clean' % name)

    print('\nend-to-end pairing (two iframes, QR route, loopback):')
    html = dom('test/pair.html', 1400, 1000, budget=None)
    result = (re.search(r'<body[^>]*data-result="(\w+)"', html) or [None, 'none'])[1]
    log = re.search(r'<div id="log"[^>]*>(.*?)</div>', html, re.S)
    for line in (log.group(1) if log else '(no log)').split('\n'):
        print('  ' + line.strip())
    print('  => %s' % result.upper())
    if result != 'pass':
        failures.append('pairing: ' + result)
    capture('pair', 'test/pair.html', 1400, 1000, budget=0, scale=1)

    print('\n' + ('FAILURES:\n  ' + '\n  '.join(failures) if failures else 'all checks passed'))
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
