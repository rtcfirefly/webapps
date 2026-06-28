/* store.js — localStorage persistence layer.
 * All app state lives under the `fit.` prefix. No backend; everything is local. */
(function () {
  'use strict';
  window.App = window.App || {};

  var PREFIX = 'fit.';
  var K = {
    apiKey: PREFIX + 'apiKey',
    model: PREFIX + 'model',
    units: PREFIX + 'units',
    lang: PREFIX + 'lang',
    voice: PREFIX + 'voice',
    profile: PREFIX + 'profile',
    summary: PREFIX + 'summary',
    workouts: PREFIX + 'workouts',
    sessions: PREFIX + 'sessions',
    currentSession: PREFIX + 'currentSession',
    videos: PREFIX + 'videos',
    routines: PREFIX + 'routines'
  };

  function lc(s) { return String(s || '').toLowerCase(); }

  var DEFAULTS = {
    model: 'claude-sonnet-4-6',
    units: 'lb',
    lang: 'en-US'
  };

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      console.warn('store: failed to read', key, e);
      return fallback;
    }
  }
  function isQuota(e) {
    return e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      e.code === 22 || e.code === 1014);
  }
  // When storage is full, reclaim space by dropping message bodies from archived
  // chat sessions (their content is already captured in the rolling summary) and
  // capping how many we keep. Returns true if it freed anything.
  function pruneForSpace() {
    try {
      var raw = localStorage.getItem(K.sessions);
      if (!raw) return false;
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr) || !arr.length) return false;
      var changed = false;
      arr.forEach(function (s) { if (s && s.messages && s.messages.length) { s.messages = []; changed = true; } });
      if (arr.length > 50) { arr = arr.slice(arr.length - 50); changed = true; }
      if (!changed) return false;
      localStorage.setItem(K.sessions, JSON.stringify(arr));
      return true;
    } catch (e) { return false; }
  }

  function setRaw(key, str) {
    try {
      localStorage.setItem(key, str);
      return true;
    } catch (e) {
      if (isQuota(e) && pruneForSpace()) {
        try { localStorage.setItem(key, str); return true; } catch (e2) {}
      }
      console.error('store: failed to write', key, e);
      return false;
    }
  }
  function writeJSON(key, value) { return setRaw(key, JSON.stringify(value)); }

  function readStr(key, fallback) {
    var v = localStorage.getItem(key);
    return v == null ? (fallback == null ? '' : fallback) : v;
  }

  function newSession() {
    return { id: uid(), startedAt: new Date().toISOString(), messages: [] };
  }

  var Store = {
    keys: K,

    // --- API key ---
    getApiKey: function () { return readStr(K.apiKey, ''); },
    setApiKey: function (v) { setRaw(K.apiKey, v || ''); },
    clearApiKey: function () { localStorage.removeItem(K.apiKey); },

    // --- model / units / lang ---
    getModel: function () { return readStr(K.model, DEFAULTS.model) || DEFAULTS.model; },
    setModel: function (v) { setRaw(K.model, v || DEFAULTS.model); },
    getUnits: function () { return readStr(K.units, DEFAULTS.units) || DEFAULTS.units; },
    setUnits: function (v) { setRaw(K.units, v === 'kg' ? 'kg' : 'lb'); },
    getLang: function () { return readStr(K.lang, DEFAULTS.lang) || DEFAULTS.lang; },
    setLang: function (v) { setRaw(K.lang, v || DEFAULTS.lang); },
    getVoice: function () { return readStr(K.voice, ''); },
    setVoice: function (v) { setRaw(K.voice, v || ''); },

    // --- profile ---
    getProfile: function () { return readJSON(K.profile, {}) || {}; },
    setProfile: function (p) { writeJSON(K.profile, p || {}); },

    // --- rolling summary ---
    getSummary: function () { return readJSON(K.summary, null); },
    setSummary: function (s) { writeJSON(K.summary, s); },

    // --- workouts ---
    getWorkouts: function () { return readJSON(K.workouts, []) || []; },
    getWorkoutsBySession: function (sessionId) {
      return this.getWorkouts().filter(function (w) { return w.sessionId === sessionId; });
    },
    addWorkout: function (input, sessionId, timestamp) {
      input = input || {};
      var entry = {
        id: uid(),
        timestamp: timestamp || new Date().toISOString(),
        sessionId: sessionId || null,
        routine: (input.session || input.routine || '') || null,  // which session/template this was
        exercises: Array.isArray(input.exercises) ? input.exercises : [],
        notes: input.notes || ''
      };
      var all = this.getWorkouts();
      all.push(entry);
      writeJSON(K.workouts, all);
      return entry;
    },
    deleteWorkout: function (id) {
      var all = this.getWorkouts().filter(function (w) { return w.id !== id; });
      writeJSON(K.workouts, all);
    },
    clearWorkouts: function () { writeJSON(K.workouts, []); },

    // --- workout sessions / routines (templates of exercise names) ---
    getRoutines: function () { return readJSON(K.routines, []) || []; },
    setRoutines: function (arr) { writeJSON(K.routines, arr || []); },
    addRoutine: function (name) {
      var arr = this.getRoutines();
      var r = { id: uid(), name: (name || '').trim() || ('Session ' + (arr.length + 1)), exercises: [] };
      arr.push(r); this.setRoutines(arr); return r;
    },
    renameRoutine: function (id, name) {
      var arr = this.getRoutines();
      arr.forEach(function (r) { if (r.id === id) r.name = (name || '').trim() || r.name; });
      this.setRoutines(arr);
    },
    deleteRoutine: function (id) {
      this.setRoutines(this.getRoutines().filter(function (r) { return r.id !== id; }));
    },
    routineAddExercise: function (id, name) {
      name = (name || '').trim(); if (!name) return;
      var arr = this.getRoutines();
      arr.forEach(function (r) {
        if (r.id === id && r.exercises.map(lc).indexOf(lc(name)) === -1) r.exercises.push(name);
      });
      this.setRoutines(arr);
    },
    routineRemoveExercise: function (id, name) {
      var arr = this.getRoutines();
      arr.forEach(function (r) {
        if (r.id === id) r.exercises = r.exercises.filter(function (e) { return lc(e) !== lc(name); });
      });
      this.setRoutines(arr);
    },
    mergeRoutine: function (name, exNames) {
      var arr = this.getRoutines();
      var r = arr.filter(function (x) { return lc(x.name) === lc(name); })[0];
      if (!r) { r = { id: uid(), name: name, exercises: [] }; arr.push(r); }
      (exNames || []).forEach(function (n) {
        if (n && r.exercises.map(lc).indexOf(lc(n)) === -1) r.exercises.push(n);
      });
      this.setRoutines(arr);
    },
    sessionRemoveExercises: function (name, exNames) {
      var arr = this.getRoutines();
      arr.forEach(function (r) {
        if (lc(r.name) !== lc(name)) return;
        (exNames || []).forEach(function (n) {
          r.exercises = r.exercises.filter(function (e) { return lc(e) !== lc(n); });
        });
      });
      this.setRoutines(arr);
    },

    // --- exercise videos (normalizedName -> YouTube id) ---
    getVideos: function () { return readJSON(K.videos, {}) || {}; },
    setVideoFor: function (normName, id) {
      var m = this.getVideos();
      if (id) m[normName] = id; else delete m[normName];
      writeJSON(K.videos, m);
    },

    // --- sessions ---
    getSessions: function () { return readJSON(K.sessions, []) || []; },
    archiveSession: function (session) {
      if (!session) return;
      session.endedAt = new Date().toISOString();
      var all = this.getSessions();
      all.push(session);
      writeJSON(K.sessions, all);
    },

    // --- current session ---
    getCurrentSession: function () { return readJSON(K.currentSession, null); },
    setCurrentSession: function (s) { writeJSON(K.currentSession, s); },
    ensureCurrentSession: function () {
      var s = this.getCurrentSession();
      if (!s || !s.id || !Array.isArray(s.messages)) {
        s = newSession();
        this.setCurrentSession(s);
      }
      return s;
    },
    startNewSession: function () {
      var s = newSession();
      this.setCurrentSession(s);
      return s;
    },

    // --- maintenance ---
    newSession: newSession,
    uid: uid,
    clearAll: function () {
      var toRemove = [];
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (key && key.indexOf(PREFIX) === 0) toRemove.push(key);
      }
      toRemove.forEach(function (k) { localStorage.removeItem(k); });
    },

    // --- backup / restore (everything except the API key) ---
    exportData: function () {
      var out = { _app: 'fitness-coach', _version: 1, exportedAt: new Date().toISOString(), data: {} };
      for (var name in K) {
        if (!K.hasOwnProperty(name) || name === 'apiKey') continue;
        var raw = localStorage.getItem(K[name]);
        if (raw != null) out.data[K[name]] = raw;
      }
      return out;
    },
    importData: function (obj) {
      if (!obj || typeof obj !== 'object' || obj._app !== 'fitness-coach' || !obj.data || typeof obj.data !== 'object') {
        throw new Error('Not a valid Fitness Coach backup file.');
      }
      // Which keys hold JSON (and of what shape) vs. plain strings.
      var jsonShape = {};
      jsonShape[K.workouts] = 'array'; jsonShape[K.sessions] = 'array'; jsonShape[K.routines] = 'array';
      jsonShape[K.currentSession] = 'object'; jsonShape[K.profile] = 'object';
      jsonShape[K.summary] = 'object'; jsonShape[K.videos] = 'object';
      var stringKeys = {};
      stringKeys[K.model] = 1; stringKeys[K.units] = 1; stringKeys[K.lang] = 1; stringKeys[K.voice] = 1;

      // Validate EVERYTHING first; only commit if the whole file is sound.
      var pending = [];
      Object.keys(obj.data).forEach(function (fullKey) {
        if (fullKey.indexOf(PREFIX) !== 0 || fullKey === K.apiKey) return;
        var v = obj.data[fullKey];
        if (typeof v !== 'string') return;
        if (jsonShape[fullKey]) {
          var parsed;
          try { parsed = JSON.parse(v); } catch (e) { throw new Error('Backup is corrupt (' + fullKey + ').'); }
          var ok = jsonShape[fullKey] === 'array' ? Array.isArray(parsed) : (parsed && typeof parsed === 'object');
          if (!ok) throw new Error('Backup has invalid data (' + fullKey + ').');
          pending.push([fullKey, v]);
        } else if (stringKeys[fullKey]) {
          pending.push([fullKey, v]);
        }
        // unknown fit.* keys are ignored (forward-compatible, but not blindly written)
      });
      pending.forEach(function (kv) { setRaw(kv[0], kv[1]); });
    }
  };

  App.Store = Store;
})();
