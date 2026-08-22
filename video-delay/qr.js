/* qr.js - self-contained QR Code generator + renderer (window.VDQR). No outside code.
 *
 * Vendored from rtcfirefly/burn-after-reading (js/qr.js), same author. Changes here:
 * dropped the App.Codec dependency (inline TextEncoder), render() takes a target pixel
 * size because pairing payloads make far denser codes than a short link, and it returns
 * whether the code fitted so the caller can fall back to the text form.
 *
 * Original implementation of the QR Code spec (ISO/IEC 18004): byte-mode encoding, Reed–Solomon
 * error correction over GF(256), block interleaving, function patterns, all 8 data masks with
 * penalty-based selection, and format/version info. Renders to a <canvas>. Used only to encode
 * the same link the user can already copy — it handles no secret material of its own.
 *
 * render() is defensive: if the data won't fit a QR, it hides the container and the app falls
 * back to the copyable text. No dependencies. */
(function () {
  'use strict';
  window.App = window.App || {};

  function getBit(x, i) { return ((x >>> i) & 1) !== 0; }

  // ---- GF(256) Reed–Solomon (primitive polynomial 0x11D) ----
  function rsMultiply(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
  }
  function rsDivisor(degree) {
    var result = [];
    for (var i = 0; i < degree; i++) result.push(0);
    result[degree - 1] = 1;
    var root = 1;
    for (var i = 0; i < degree; i++) {
      for (var j = 0; j < result.length; j++) {
        result[j] = rsMultiply(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = rsMultiply(root, 0x02);
    }
    return result;
  }
  function rsRemainder(data, divisor) {
    var result = [];
    for (var i = 0; i < divisor.length; i++) result.push(0);
    for (var d = 0; d < data.length; d++) {
      var factor = data[d] ^ result.shift();
      result.push(0);
      for (var i = 0; i < divisor.length; i++) result[i] ^= rsMultiply(divisor[i], factor);
    }
    return result;
  }

  // ---- standard capacity/EC tables, indexed [ecl][version]; ecl 0=L 1=M 2=Q 3=H ----
  var ECC_CODEWORDS_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30]
  ];
  var NUM_EC_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81]
  ];
  var ECL_FORMATBITS = [1, 0, 3, 2];   // L, M, Q, H

  function numRawDataModules(ver) {
    var result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      var numAlign = Math.floor(ver / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }
  function numDataCodewords(ver, ecl) {
    return Math.floor(numRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[ecl][ver] * NUM_EC_BLOCKS[ecl][ver];
  }

  // ---- QrCode ----
  function QrCode(version, ecl, dataCodewords) {
    this.version = version;
    this.ecl = ecl;
    this.size = version * 4 + 17;
    var n = this.size;
    this.modules = [];
    this.isFunction = [];
    for (var y = 0; y < n; y++) {
      var mrow = [], frow = [];
      for (var x = 0; x < n; x++) { mrow.push(false); frow.push(false); }
      this.modules.push(mrow); this.isFunction.push(frow);
    }
    this.drawFunctionPatterns();
    this.drawCodewords(this.addEccAndInterleave(dataCodewords));
    // choose the lowest-penalty mask
    var mask = 0, minPenalty = Infinity;
    for (var i = 0; i < 8; i++) {
      this.applyMask(i); this.drawFormatBits(i);
      var p = this.getPenaltyScore();
      if (p < minPenalty) { mask = i; minPenalty = p; }
      this.applyMask(i);   // undo (XOR is its own inverse)
    }
    this.applyMask(mask);
    this.drawFormatBits(mask);
  }
  QrCode.prototype.getModule = function (x, y) {
    return 0 <= x && x < this.size && 0 <= y && y < this.size && this.modules[y][x];
  };
  QrCode.prototype.setFunctionModule = function (x, y, isDark) {
    this.modules[y][x] = isDark; this.isFunction[y][x] = true;
  };
  QrCode.prototype.drawFunctionPatterns = function () {
    var n = this.size;
    for (var i = 0; i < n; i++) {
      this.setFunctionModule(6, i, i % 2 === 0);
      this.setFunctionModule(i, 6, i % 2 === 0);
    }
    this.drawFinderPattern(3, 3);
    this.drawFinderPattern(n - 4, 3);
    this.drawFinderPattern(3, n - 4);
    var pos = this.getAlignmentPatternPositions(), k = pos.length;
    for (var i = 0; i < k; i++) {
      for (var j = 0; j < k; j++) {
        if (!((i === 0 && j === 0) || (i === 0 && j === k - 1) || (i === k - 1 && j === 0)))
          this.drawAlignmentPattern(pos[i], pos[j]);
      }
    }
    this.drawFormatBits(0);
    this.drawVersion();
  };
  QrCode.prototype.drawFinderPattern = function (x, y) {
    for (var dy = -4; dy <= 4; dy++) {
      for (var dx = -4; dx <= 4; dx++) {
        var dist = Math.max(Math.abs(dx), Math.abs(dy)), xx = x + dx, yy = y + dy;
        if (0 <= xx && xx < this.size && 0 <= yy && yy < this.size)
          this.setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  };
  QrCode.prototype.drawAlignmentPattern = function (x, y) {
    for (var dy = -2; dy <= 2; dy++)
      for (var dx = -2; dx <= 2; dx++)
        this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  };
  QrCode.prototype.getAlignmentPatternPositions = function () {
    if (this.version === 1) return [];
    var numAlign = Math.floor(this.version / 7) + 2;
    var step = (this.version === 32) ? 26 : Math.ceil((this.version * 4 + 4) / (numAlign * 2 - 2)) * 2;
    var result = [6];
    for (var p = this.size - 7; result.length < numAlign; p -= step) result.splice(1, 0, p);
    return result;
  };
  QrCode.prototype.drawFormatBits = function (mask) {
    var n = this.size, data = (ECL_FORMATBITS[this.ecl] << 3) | mask, rem = data;
    for (var i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412;
    for (var i = 0; i <= 5; i++) this.setFunctionModule(8, i, getBit(bits, i));
    this.setFunctionModule(8, 7, getBit(bits, 6));
    this.setFunctionModule(8, 8, getBit(bits, 7));
    this.setFunctionModule(7, 8, getBit(bits, 8));
    for (var i = 9; i < 15; i++) this.setFunctionModule(14 - i, 8, getBit(bits, i));
    for (var i = 0; i < 8; i++) this.setFunctionModule(n - 1 - i, 8, getBit(bits, i));
    for (var i = 8; i < 15; i++) this.setFunctionModule(8, n - 15 + i, getBit(bits, i));
    this.setFunctionModule(8, n - 8, true);
  };
  QrCode.prototype.drawVersion = function () {
    if (this.version < 7) return;
    var rem = this.version;
    for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    var bits = (this.version << 12) | rem;
    for (var i = 0; i < 18; i++) {
      var bit = getBit(bits, i), a = this.size - 11 + i % 3, b = Math.floor(i / 3);
      this.setFunctionModule(a, b, bit); this.setFunctionModule(b, a, bit);
    }
  };
  QrCode.prototype.addEccAndInterleave = function (data) {
    var ver = this.version, ecl = this.ecl;
    var numBlocks = NUM_EC_BLOCKS[ecl][ver], blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl][ver];
    var rawCodewords = Math.floor(numRawDataModules(ver) / 8);
    var numShort = numBlocks - rawCodewords % numBlocks;
    var shortLen = Math.floor(rawCodewords / numBlocks);
    var blocks = [], rsDiv = rsDivisor(blockEccLen);
    for (var i = 0, k = 0; i < numBlocks; i++) {
      var datLen = shortLen - blockEccLen + (i < numShort ? 0 : 1);
      var dat = [].slice.call(data, k, k + datLen); k += datLen;
      var ecc = rsRemainder(dat, rsDiv);
      var block = dat.slice();
      if (i < numShort) block.push(0);
      blocks.push(block.concat(ecc));
    }
    var result = [];
    for (var i = 0; i < blocks[0].length; i++) {
      for (var j = 0; j < blocks.length; j++) {
        if (i !== shortLen - blockEccLen || j >= numShort) result.push(blocks[j][i]);
      }
    }
    return result;
  };
  QrCode.prototype.drawCodewords = function (data) {
    var n = this.size, i = 0;
    for (var right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < n; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? n - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7)); i++;
          }
        }
      }
    }
  };
  QrCode.prototype.applyMask = function (mask) {
    var n = this.size;
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        var invert;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = (x * y) % 2 + (x * y) % 3 === 0; break;
          case 6: invert = ((x * y) % 2 + (x * y) % 3) % 2 === 0; break;
          default: invert = ((x + y) % 2 + (x * y) % 3) % 2 === 0; break;
        }
        if (!this.isFunction[y][x] && invert) this.modules[y][x] = !this.modules[y][x];
      }
    }
  };
  QrCode.prototype.getPenaltyScore = function () {
    var n = this.size, m = this.modules, result = 0, x, y;
    for (y = 0; y < n; y++) {
      var runColor = false, runLen = 0, hist = [0, 0, 0, 0, 0, 0, 0];
      for (x = 0; x < n; x++) {
        if (m[y][x] === runColor) { runLen++; if (runLen === 5) result += 3; else if (runLen > 5) result++; }
        else { this.finderAdd(runLen, hist); if (!runColor) result += this.finderCount(hist) * 40; runColor = m[y][x]; runLen = 1; }
      }
      result += this.finderTerm(runColor, runLen, hist) * 40;
    }
    for (x = 0; x < n; x++) {
      var runColor = false, runLen = 0, hist = [0, 0, 0, 0, 0, 0, 0];
      for (y = 0; y < n; y++) {
        if (m[y][x] === runColor) { runLen++; if (runLen === 5) result += 3; else if (runLen > 5) result++; }
        else { this.finderAdd(runLen, hist); if (!runColor) result += this.finderCount(hist) * 40; runColor = m[y][x]; runLen = 1; }
      }
      result += this.finderTerm(runColor, runLen, hist) * 40;
    }
    for (y = 0; y < n - 1; y++)
      for (x = 0; x < n - 1; x++) {
        var c = m[y][x];
        if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) result += 3;
      }
    var dark = 0;
    for (y = 0; y < n; y++) for (x = 0; x < n; x++) if (m[y][x]) dark++;
    var total = n * n;
    result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return result;
  };
  QrCode.prototype.finderAdd = function (runLen, hist) {
    if (hist[0] === 0) runLen += this.size;
    hist.pop(); hist.unshift(runLen);
  };
  QrCode.prototype.finderCount = function (h) {
    var n = h[1];
    var core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
    return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0);
  };
  QrCode.prototype.finderTerm = function (color, runLen, hist) {
    if (color) { this.finderAdd(runLen, hist); runLen = 0; }
    runLen += this.size;
    this.finderAdd(runLen, hist);
    return this.finderCount(hist);
  };

  // ---- encoding (byte mode) ----
  function appendBits(bb, val, len) { for (var i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1); }

  function encodeText(text, ecl) {
    if (ecl == null) ecl = 0;              // default: Low (max capacity, less dense → easier scan)
    var data = text instanceof Uint8Array ? text : new TextEncoder().encode(String(text));
    var ver;
    for (ver = 1; ; ver++) {
      var cap = numDataCodewords(ver, ecl) * 8;
      var ccbits = ver <= 9 ? 8 : 16;
      if (4 + ccbits + data.length * 8 <= cap) break;
      if (ver >= 40) throw new Error('data too long for a QR code');
    }
    var bb = [], ccbits = ver <= 9 ? 8 : 16, cap = numDataCodewords(ver, ecl) * 8;
    appendBits(bb, 0x4, 4);                // byte mode indicator
    appendBits(bb, data.length, ccbits);
    for (var i = 0; i < data.length; i++) appendBits(bb, data[i], 8);
    appendBits(bb, 0, Math.min(4, cap - bb.length));         // terminator
    appendBits(bb, 0, (8 - bb.length % 8) % 8);              // byte-align
    for (var pad = 0xEC; bb.length < cap; pad ^= 0xEC ^ 0x11) appendBits(bb, pad, 8);
    var codewords = [];
    for (var i = 0; i < bb.length; i += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | bb[i + j];
      codewords.push(b);
    }
    return new QrCode(ver, ecl, codewords);
  }

  // ---- render ----
  function draw(qr, el, target) {
    var size = qr.size, border = 4;
    var scale = Math.max(2, Math.floor((target || 520) / (size + border * 2)));
    var dim = (size + border * 2) * scale;
    var c = document.createElement('canvas');
    c.width = dim; c.height = dim;
    c.style.width = '100%'; c.style.maxWidth = dim + 'px'; c.style.imageRendering = 'pixelated';
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, dim, dim);
    ctx.fillStyle = '#000000';
    for (var y = 0; y < size; y++)
      for (var x = 0; x < size; x++)
        if (qr.getModule(x, y)) ctx.fillRect((x + border) * scale, (y + border) * scale, scale, scale);
    el.replaceChildren(c);
  }
  function render(text, el, target) {
    try { draw(encodeText(text, 0), el, target); el.hidden = false; return true; }
    catch (e) { el.hidden = true; return false; }   // too long → the copyable code still works
  }

  window.VDQR = { render: render, encodeText: encodeText };
})();
