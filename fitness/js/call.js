/* call.js — "phone call to a coach" controller with barge-in.
 * The mic stays open for the whole call. While the coach is speaking, if the user
 * starts talking (and it isn't just the coach's own audio echoing back) we cancel
 * the speech and take their turn. Logging still happens via the log_workout tool. */
(function () {
  'use strict';
  window.App = window.App || {};

  var active = false, muted = false, processing = false;
  var pending = 0;          // outstanding TTS utterances for the current generation
  var gen = 0;              // bumped on every interruption / new turn to void stale callbacks
  var ttsBuf = '', coachText = '';
  var coachWords = {}, coachWordCount = 0;
  var rec = null, restartTimer = null, lastFinal = '';
  var lastSpeakEnd = 0;
  var timerInt = null, startTs = 0;
  var interrupted = false, queuedUtterance = null;
  var turnAbort = null;     // AbortController for the in-flight LLM turn

  function S() { return App.Store; }
  function U() { return App.UI; }
  function Sp() { return App.Speech; }

  // Strip markdown/emoji so the TTS doesn't read "asterisk" or choke on symbols.
  var EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}️‍•]/gu;
  function cleanForSpeech(s) {
    return String(s)
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      .replace(/^\s*>\s?/gm, '')
      .replace(EMOJI_RE, '')
      .replace(/[*_`#>]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  // ----- echo / noise filtering -------------------------------------------
  function words(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter(function (w) { return w.length >= 2; });
  }
  function setCoachWords(s) {
    coachWords = {};
    var ws = words(s);
    coachWordCount = ws.length;
    ws.forEach(function (w) { coachWords[w] = true; });
  }
  function isEcho(text) {
    if (!coachWordCount) return false;
    var tw = words(text);
    if (!tw.length) return false;
    var hits = 0;
    tw.forEach(function (w) { if (coachWords[w]) hits++; });
    return (hits / tw.length) >= 0.6;
  }
  function isMeaningful(text) {
    var t = (text || '').trim();
    return t.length >= 4 || words(t).length >= 2;
  }

  // ----- state / timer ----------------------------------------------------
  function refreshState() {
    U().setCallState(!active ? 'idle' : muted ? 'muted' : processing ? 'thinking'
      : pending > 0 ? 'speaking' : 'listening');
  }
  function fmt(t) { var m = Math.floor(t / 60), s = t % 60; return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s; }
  function startTimer() {
    startTs = Date.now(); U().setCallTimer('00:00');
    timerInt = setInterval(function () { U().setCallTimer(fmt(Math.floor((Date.now() - startTs) / 1000))); }, 1000);
  }
  function stopTimer() { if (timerInt) { clearInterval(timerInt); timerInt = null; } }

  // ----- speaking ---------------------------------------------------------
  function enqueueSpeech(text) {
    if (!active || interrupted) return; // call ended, or user cut in
    text = cleanForSpeech(text || '');
    if (!text) return;
    var g = gen;
    pending++;
    Sp().speak(text, {
      onstart: function () { if (g === gen) refreshState(); },
      onend: function () {
        if (g !== gen) return;
        pending = Math.max(0, pending - 1);
        if (pending === 0) lastSpeakEnd = Date.now();
        refreshState();
      }
    });
    refreshState();
  }
  function say(text) {
    setCoachWords(text);
    coachText = text;
    U().setCoachCaption(cleanForSpeech(text));
    enqueueSpeech(text);
  }
  function pushSentences(force) {
    if (interrupted) { ttsBuf = ''; return; }
    var re = /[.!?…]+["')\]]*\s/g, lastIndex = 0, m;
    while ((m = re.exec(ttsBuf))) {
      var end = m.index + m[0].length;
      var sentence = ttsBuf.slice(lastIndex, end).trim();
      if (sentence) enqueueSpeech(sentence);
      lastIndex = end;
    }
    ttsBuf = ttsBuf.slice(lastIndex);
    if (force && ttsBuf.trim()) { enqueueSpeech(ttsBuf.trim()); ttsBuf = ''; }
  }
  function onCoachDelta(delta) {
    coachText += delta;
    setCoachWords(coachText);
    U().setCoachCaption(cleanForSpeech(coachText));
    ttsBuf += delta;
    pushSentences(false);
  }

  // ----- barge-in ---------------------------------------------------------
  function bargeIn() {
    gen++;            // void any in-flight utterance + stream callbacks
    pending = 0;
    ttsBuf = '';
    interrupted = true;   // suppress the rest of the current reply's speech
    if (turnAbort) { try { turnAbort.abort(); } catch (e) {} }  // stop the LLM generation too
    Sp().cancelSpeech();
    refreshState();
  }

  // ----- always-on mic ----------------------------------------------------
  function startMic() {
    if (!active || muted) return;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    rec = Sp().create({
      onStart: function () { refreshState(); },
      onInterim: function (t) {
        U().setUserCaption(t);
        if (pending > 0 && isMeaningful(t) && !isEcho(t)) bargeIn(); // interrupt the coach
      },
      onFinal: function (t) { lastFinal = t; },
      onError: onRecError,
      onEnd: function (finalText) {
        var t = (finalText || lastFinal || '').trim();
        lastFinal = '';
        handleFinal(t);
        if (active && !muted) restartTimer = setTimeout(startMic, 300); // keep the mic open
      }
    });
    if (!rec) return;
    try { rec.start(); } catch (e) { /* already running */ }
  }

  function onRecError(code) {
    if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'audio-capture') {
      U().toast('Microphone unavailable (' + code + ').', 'error');
      end();
    }
    // 'no-speech' / 'aborted' -> onEnd restarts the mic
  }

  function handleFinal(t) {
    if (!active) return;
    if (!isMeaningful(t)) { U().setUserCaption(''); return; }
    // Drop the coach's own audio echoing back (during speech or just after).
    if ((pending > 0 || (Date.now() - lastSpeakEnd) < 1200) && isEcho(t)) { U().setUserCaption(''); return; }
    if (pending > 0 || processing) bargeIn();        // interrupt speech and/or the streaming reply
    if (processing) { queuedUtterance = t; U().setUserCaption(t); return; } // run it once this turn ends
    handleUserUtterance(t);
  }

  // ----- thinking ---------------------------------------------------------
  function handleUserUtterance(t) {
    U().setUserCaption(t);
    gen++;
    pending = 0; ttsBuf = ''; coachText = ''; coachWords = {}; coachWordCount = 0;
    interrupted = false; queuedUtterance = null;
    U().setCoachCaption('');
    processing = true;
    refreshState();

    var myGen = gen;
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    turnAbort = ctrl;

    App.Api.runTurn(t, {
      onRoundStart: function () {},
      onText: function (d) { if (myGen === gen) onCoachDelta(d); },   // ignore stale/superseded streams
      onRoundEnd: function () {},
      onLogged: function () { U().refreshHistory(); },
      onSession: function () { U().refreshSessions(); }
    }, { voice: true, signal: ctrl ? ctrl.signal : undefined }).then(function () {
      if (ctrl === turnAbort) turnAbort = null;
      if (myGen !== gen) return;          // a newer turn / barge-in took over
      processing = false;
      if (drainQueued()) return;
      pushSentences(true);
      refreshState();
    }, function (err) {
      if (ctrl === turnAbort) turnAbort = null;
      if (myGen !== gen || (err && err.code === 'aborted')) {
        processing = false;
        drainQueued();                    // run whatever the user said while interrupting
        return;
      }
      processing = false;
      if (drainQueued()) return;
      say('Sorry, something went wrong. ' + (err && err.message ? err.message : ''));
    });
  }

  // If the user interrupted mid-reply, run the utterance they queued next.
  function drainQueued() {
    if (!interrupted) return false;
    interrupted = false;
    var q = queuedUtterance; queuedUtterance = null;
    if (q && active) { handleUserUtterance(q); return true; }
    refreshState();
    return true;
  }

  // ----- controls ---------------------------------------------------------
  function start() {
    if (active) return;
    if (!Sp().available) {
      U().toast('Voice calls need speech recognition — try Chrome or an Android browser.', 'error');
      return;
    }
    if (!S().getApiKey()) {
      U().toast('Add your Anthropic API key first.', 'error');
      U().showScreen('settings');
      return;
    }
    active = true; muted = false; processing = false;
    pending = 0; gen++; ttsBuf = ''; coachText = ''; coachWords = {}; coachWordCount = 0; lastFinal = '';
    interrupted = false; queuedUtterance = null;
    U().openCall();
    U().setCallState('connecting');
    startTimer();
    startMic();
    say('Hey, coach here. What did you train today?');
  }

  function toggleMute() {
    if (!active) return;
    muted = !muted;
    U().setCallMuted(muted);
    if (muted) {
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      if (rec) { try { rec.stop(); } catch (e) {} }
    } else {
      startMic();
    }
    refreshState();
  }

  function end() {
    active = false; muted = false; processing = false;
    gen++;            // supersede any in-flight turn so its callbacks go inert
    if (turnAbort) { try { turnAbort.abort(); } catch (e) {} turnAbort = null; }
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (rec) { try { rec.stop(); } catch (e) {} rec = null; }
    Sp().cancelSpeech();
    pending = 0;
    stopTimer();
    U().setCallState('ended');
    U().closeCall();
    U().renderSession(S().getCurrentSession());
    U().refreshHistory();
  }

  App.Call = {
    start: start,
    end: end,
    toggleMute: toggleMute,
    isActive: function () { return active; }
  };
})();
