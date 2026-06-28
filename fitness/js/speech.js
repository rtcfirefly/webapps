/* speech.js — speech-to-text (Web Speech API) AND text-to-speech (SpeechSynthesis).
 * STT powers the composer mic and the call screen; TTS gives the coach a voice.
 * Both require a secure context (https or localhost) for the microphone.
 * TTS quality depends on the voices installed in the OS/browser, so the user can
 * pick one in Settings; otherwise we choose the best-sounding available voice. */
(function () {
  'use strict';
  window.App = window.App || {};

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var available = !!SR;

  var synth = window.speechSynthesis || null;
  var ttsAvailable = !!synth;
  var voiceListeners = [];

  function listVoices() { return synth ? (synth.getVoices() || []) : []; }

  // Rank installed voices: prefer modern "natural/neural/enhanced" voices,
  // then Google voices, then any US English, then any English.
  function bestVoice(list) {
    var en = list.filter(function (v) { return /^en/i.test(v.lang); });
    var pool = en.length ? en : list;
    function pick(re) { return pool.filter(function (v) { return re.test(v.name); })[0]; }
    return pick(/natural|neural|enhanced|premium/i) ||
           pick(/google/i) ||
           pick(/samantha|aria|jenny|libby|sonia/i) ||
           pool.filter(function (v) { return /en[-_]US/i.test(v.lang); })[0] ||
           pool[0] || list[0] || null;
  }

  function resolveVoice() {
    var list = listVoices();
    if (!list.length) return null;
    var prefName = App.Store ? App.Store.getVoice() : '';
    if (prefName) {
      var found = list.filter(function (v) { return v.name === prefName; })[0];
      if (found) return found;
    }
    return bestVoice(list);
  }

  function notifyVoices() { voiceListeners.forEach(function (cb) { try { cb(); } catch (e) {} }); }
  function onVoices(cb) { voiceListeners.push(cb); if (listVoices().length) cb(); }

  if (synth) {
    try { synth.getVoices(); } catch (e) {}            // kick off async load
    try { synth.onvoiceschanged = notifyVoices; } catch (e) {}
  }

  /* One-shot recognizer. Auto-ends on silence; we restart it for continuous call flow.
   * cb: { onStart, onInterim(text), onFinal(text), onError(code), onEnd(finalText) } */
  function create(cb) {
    cb = cb || {};
    if (!SR) return null;
    var rec = new SR();
    rec.lang = (App.Store ? App.Store.getLang() : 'en-US');
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;

    var finalText = '';
    rec.onstart = function () { finalText = ''; if (cb.onStart) cb.onStart(); };
    rec.onresult = function (e) {
      var interim = '';
      finalText = '';
      for (var i = 0; i < e.results.length; i++) {
        var r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      if (interim && cb.onInterim) cb.onInterim(interim);
      if (finalText && cb.onFinal) cb.onFinal(finalText.trim());
    };
    rec.onerror = function (e) { if (cb.onError) cb.onError((e && e.error) || 'speech_error'); };
    rec.onend = function () { if (cb.onEnd) cb.onEnd(finalText.trim()); };
    return rec;
  }

  /* Speak one chunk of text. Utterances queue inside the browser, so calling
   * speak() repeatedly plays them in order. cb: { onstart, onend } */
  function speak(text, cb) {
    cb = cb || {};
    text = (text || '').trim();
    if (!synth || !text) { if (cb.onend) cb.onend(); return null; }
    var u = new SpeechSynthesisUtterance(text);
    var v = resolveVoice();
    if (v) { u.voice = v; u.lang = v.lang; }
    u.rate = 1.0;
    u.pitch = 1.0;
    u.volume = 1.0;
    u.onstart = function () { if (cb.onstart) cb.onstart(); };
    u.onend = function () { if (cb.onend) cb.onend(); };
    u.onerror = function () { if (cb.onend) cb.onend(); };
    try { synth.speak(u); } catch (e) { if (cb.onend) cb.onend(); }
    return u;
  }

  function cancelSpeech() { if (synth) { try { synth.cancel(); } catch (e) {} } }

  App.Speech = {
    available: available,           // STT available
    ttsAvailable: ttsAvailable,     // TTS available
    secureContext: !!window.isSecureContext,
    create: create,
    speak: speak,
    cancelSpeech: cancelSpeech,
    listVoices: listVoices,         // for the Settings picker
    onVoices: onVoices              // fires when the async voice list is ready
  };
})();
