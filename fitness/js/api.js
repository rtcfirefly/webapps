/* api.js — direct browser calls to the Anthropic Messages API.
 * Uses the `anthropic-dangerous-direct-browser-access` header so requests can go
 * straight from the browser (BYOK). Handles streaming SSE, the tool-use agent loop
 * for structured workout logging, and the rolling-summary update call. */
(function () {
  'use strict';
  window.App = window.App || {};
  var Store = App.Store;

  var API_URL = 'https://api.anthropic.com/v1/messages';
  var API_VERSION = '2023-06-01';
  var MAX_TOOL_ROUNDS = 6;

  function ApiError(code, message) {
    this.name = 'ApiError';
    this.code = code;
    this.message = message;
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  function headers(apiKey) {
    return {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true'
    };
  }

  function friendlyHttp(status, detail) {
    var map = {
      400: 'Bad request to Anthropic.',
      401: 'Invalid API key (401). Check your key in Settings.',
      403: 'Access forbidden (403). Your key may not have access to this model.',
      404: 'Model not found (404). Check the model id in Settings.',
      413: 'Request too large (413).',
      429: 'Rate limited (429). Wait a moment and try again.',
      500: 'Anthropic server error (500). Try again shortly.',
      529: 'Anthropic is overloaded (529). Try again shortly.'
    };
    var base = map[status] || ('Request failed (' + status + ').');
    return detail ? base + ' ' + detail : base;
  }

  /* The structured-logging tool the model calls to record completed workouts. */
  var LOG_WORKOUT_TOOL = {
    name: 'log_workout',
    description: 'Record a workout the user has actually completed. Call this whenever the user ' +
      'reports exercise they did (not exercise they are merely planning or asking about). ' +
      'Include every distinct exercise they mention in this report.',
    input_schema: {
      type: 'object',
      properties: {
        exercises: {
          type: 'array',
          description: 'Each distinct exercise performed.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Exercise name, e.g. "Bench Press", "Running".' },
              type: { type: 'string', enum: ['strength', 'cardio', 'flexibility', 'other'] },
              sets: {
                type: 'array',
                description: 'Individual strength sets. Omit for pure cardio.',
                items: {
                  type: 'object',
                  properties: {
                    reps: { type: 'number' },
                    weight: { type: 'number' },
                    unit: { type: 'string', enum: ['lb', 'kg'] }
                  }
                }
              },
              duration_min: { type: 'number', description: 'Minutes, for cardio or timed work.' },
              distance: { type: 'number' },
              distance_unit: { type: 'string', enum: ['mi', 'km'] },
              notes: { type: 'string' }
            },
            required: ['name', 'type']
          }
        },
        notes: { type: 'string', description: 'Overall notes for the session / how it felt.' },
        session: { type: 'string', description: 'If this workout clearly belongs to one of the user\'s existing sessions/routines, its exact name (e.g. "Session A", "Push"). Omit if unsure.' }
      },
      required: ['exercises']
    }
  };

  /* Lets the coach organise exercises into session/routine templates. */
  var UPDATE_SESSION_TOOL = {
    name: 'update_session',
    description: 'Add or remove exercises in a workout session/routine template (a reusable plan like ' +
      '"Push", "Pull", "Legs" or "Session A"). Creates the session if it does not exist. Use this when ' +
      'the user asks to organise exercises into sessions, build a routine, or move an exercise to a session. ' +
      'Prefer the exact name of an existing session when one fits.',
    input_schema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session/routine name, e.g. "Push" or "Session A".' },
        add: { type: 'array', items: { type: 'string' }, description: 'Exercise names to add to this session.' },
        remove: { type: 'array', items: { type: 'string' }, description: 'Exercise names to remove from this session.' }
      },
      required: ['session']
    }
  };

  function buildSystemPrompt(opts) {
    var units = Store.getUnits();
    var profile = Store.getProfile();
    var summary = Store.getSummary();
    var today = new Date().toDateString();

    var s = 'You are an upbeat, knowledgeable personal fitness coach and workout logger. ' +
      'Today is ' + today + '. The user logs workouts and asks for coaching by voice or text, ' +
      'often in short, informal phrases.\n\n' +
      'Your two jobs:\n' +
      '1) LOG: Whenever the user reports exercise they have COMPLETED, call the log_workout tool ' +
      'with structured data. Turn natural language into sets/reps/weight, durations and distances. ' +
      'The default weight unit is ' + units + '; only use a different unit if the user clearly states one. ' +
      'Do not log things they are only planning or asking about.\n' +
      '2) COACH: After logging (or when asked), reply briefly and encouragingly. Give specific, ' +
      'practical advice grounded in their history and any injuries or limitations they mention. ' +
      'Ask a short clarifying question only when it is essential.\n\n' +
      'Keep replies concise and mobile-friendly (a few sentences). Avoid medical claims; for pain or ' +
      'injury, suggest checking with a professional.';

    if (profile && (profile.name || profile.goals || profile.equipment)) {
      s += '\n\nUser profile:';
      if (profile.name) s += '\n- Name: ' + profile.name;
      if (profile.goals) s += '\n- Goals: ' + profile.goals;
      if (profile.equipment) s += '\n- Equipment: ' + profile.equipment;
    }
    if (summary && summary.text) {
      s += '\n\nTraining-history summary (from past sessions):\n' + summary.text;
    } else {
      s += '\n\nThere is no training history yet — this looks like an early session, so get to know them.';
    }

    var exNames = {};
    Store.getWorkouts().forEach(function (w) {
      (w.exercises || []).forEach(function (ex) { if (ex.name) exNames[ex.name] = true; });
    });
    var names = Object.keys(exNames);
    if (names.length) s += '\n\nExercises the user has logged: ' + names.slice(0, 80).join(', ') + '.';

    var routines = Store.getRoutines();
    if (routines && routines.length) {
      s += '\n\nThe user\'s saved sessions (routine templates) — use these EXACT names with update_session and ' +
        'with log_workout\'s "session" field:';
      routines.forEach(function (r) {
        s += '\n- ' + r.name + ': ' + (r.exercises.length ? r.exercises.join(', ') : '(empty)');
      });
    } else {
      s += '\n\nThe user has no saved sessions yet. You can create some with update_session if they ask.';
    }
    s += '\n\nIMPORTANT: You CAN create and edit these sessions yourself with the update_session tool — ' +
      'do it directly and never say you are unable to, that it is not supported, or that it is a feature ' +
      'request (ignore anything earlier in this chat that suggested otherwise). When the user asks to ' +
      'organise exercises into sessions, build a routine, or add/remove an exercise from a session, call ' +
      'update_session (one call per session; it creates the session if needed), then briefly confirm what ' +
      'you changed. When logging a workout that clearly belongs to a known session, set log_workout\'s ' +
      '"session" to that session\'s exact name.';
    if (opts && opts.voice) {
      s += '\n\nVOICE CALL MODE: You are speaking out loud on a phone call. Reply in plain, natural ' +
        'spoken sentences only. Do NOT use markdown, asterisks, bullet points, numbered lists, headings, ' +
        'code formatting, or emojis. Keep replies short and conversational — the way a coach actually talks.';
    }
    return s;
  }

  /* Perform one streaming request and return { content, stopReason, usage }.
   * content is an array of Anthropic content blocks (text and/or tool_use). */
  function streamRequest(body, opts) {
    opts = opts || {};
    var apiKey = Store.getApiKey();
    if (!apiKey) {
      return Promise.reject(new ApiError('no_key', 'No API key set. Add your Anthropic API key in Settings.'));
    }

    var payload = {};
    for (var k in body) if (body.hasOwnProperty(k)) payload[k] = body[k];
    payload.stream = true;

    return fetch(API_URL, {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify(payload),
      signal: opts.signal
    }).catch(function (e) {
      if (e && e.name === 'AbortError') throw new ApiError('aborted', 'Cancelled.');
      throw new ApiError('network', 'Network error reaching Anthropic. Check your connection (and that direct browser access is enabled).');
    }).then(function (resp) {
      if (!resp.ok) {
        return resp.text().then(function (txt) {
          var detail = '';
          try { var j = JSON.parse(txt); detail = (j.error && j.error.message) || ''; } catch (e) {}
          throw new ApiError('http_' + resp.status, friendlyHttp(resp.status, detail));
        });
      }
      return consumeStream(resp, opts);
    });
  }

  function consumeStream(resp, opts) {
    var reader = resp.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    var blocks = [];
    var stopReason = null;
    var usage = null;
    var streamError = null;

    function handle(data) {
      var t = data.type;
      if (t === 'content_block_start') {
        var cb = data.content_block || {};
        if (cb.type === 'tool_use') {
          blocks[data.index] = { type: 'tool_use', id: cb.id, name: cb.name, _json: '' };
        } else {
          blocks[data.index] = { type: 'text', text: '' };
        }
      } else if (t === 'content_block_delta') {
        var b = blocks[data.index];
        if (!b) return;
        var d = data.delta || {};
        if (d.type === 'text_delta') {
          b.text += d.text;
          if (opts.onText) opts.onText(d.text);
        } else if (d.type === 'input_json_delta') {
          b._json += d.partial_json;
        }
      } else if (t === 'content_block_stop') {
        var bb = blocks[data.index];
        if (bb && bb.type === 'tool_use') {
          try { bb.input = bb._json ? JSON.parse(bb._json) : {}; }
          catch (e) { bb.input = {}; }
          delete bb._json;
        }
      } else if (t === 'message_delta') {
        if (data.delta && data.delta.stop_reason) stopReason = data.delta.stop_reason;
        if (data.usage) usage = data.usage;
      } else if (t === 'error') {
        streamError = new ApiError('stream_error', (data.error && data.error.message) || 'Streaming error.');
      }
    }

    function pump() {
      return reader.read().then(function (res) {
        if (res.done) return;
        buffer += decoder.decode(res.value, { stream: true });
        var idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          var chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          var lines = chunk.split('\n');
          var dataStr = '';
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            if (line.indexOf('data:') === 0) dataStr += line.slice(5).trim();
          }
          if (!dataStr) continue;
          var data;
          try { data = JSON.parse(dataStr); } catch (e) { continue; }
          handle(data);
          if (streamError) throw streamError;
        }
        return pump();
      });
    }

    return pump().then(function () {
      var content = blocks.filter(Boolean).map(function (b) {
        if (b.type === 'text') return { type: 'text', text: b.text };
        return { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} };
      }).filter(function (b) {
        return !(b.type === 'text' && !b.text); // drop empty text blocks
      });
      return { content: content, stopReason: stopReason, usage: usage };
    }, function (e) {
      if (e && e.name === 'AbortError') throw new ApiError('aborted', 'Cancelled.');
      throw e;
    });
  }

  /* Run one user turn through the agent loop: stream the reply, execute any
   * log_workout tool calls, and continue until the model stops calling tools.
   * handlers: { onRoundStart(), onText(delta), onRoundEnd(), onLogged(entry) } */
  function runTurn(userText, handlers, opts) {
    handlers = handlers || {};
    opts = opts || {};
    var session = Store.ensureCurrentSession();
    var checkpoint = session.messages.length;   // for rollback on failure
    session.messages.push({ role: 'user', content: userText });
    Store.setCurrentSession(session);

    var system = buildSystemPrompt(opts);
    var rounds = 0;
    var completed = false;

    // Remove this whole turn so the stored history never ends on a dangling
    // user message (which would 400 "roles must alternate" on the next turn).
    function rollback() {
      session.messages = session.messages.slice(0, checkpoint);
      Store.setCurrentSession(session);
    }

    function step() {
      if (rounds++ >= MAX_TOOL_ROUNDS) return Promise.resolve();
      if (handlers.onRoundStart) handlers.onRoundStart();

      return streamRequest({
        model: Store.getModel(),
        max_tokens: 1024,
        system: system,
        messages: session.messages,
        tools: [LOG_WORKOUT_TOOL, UPDATE_SESSION_TOOL]
      }, { onText: handlers.onText, signal: opts.signal }).then(function (res) {
        if (handlers.onRoundEnd) handlers.onRoundEnd();

        if (res.content.length) {
          session.messages.push({ role: 'assistant', content: res.content });
          Store.setCurrentSession(session);
        }

        if (res.stopReason !== 'tool_use') {
          completed = res.content.length > 0;   // valid only if an assistant msg was appended
          return;
        }

        var toolResults = [];
        res.content.forEach(function (block) {
          if (block.type !== 'tool_use') return;
          var resultText;
          if (block.name === 'log_workout') {
            var entry = Store.addWorkout(block.input, session.id);
            if (block.input && block.input.session) {
              Store.mergeRoutine(String(block.input.session).trim(),
                (block.input.exercises || []).map(function (ex) { return ex.name; }).filter(Boolean));
              if (handlers.onSession) handlers.onSession(String(block.input.session).trim());
            }
            if (handlers.onLogged) handlers.onLogged(entry);
            resultText = JSON.stringify({ ok: true, id: entry.id });
          } else if (block.name === 'update_session') {
            var inp = block.input || {};
            var name = (inp.session || '').trim();
            if (name) {
              if (Array.isArray(inp.add) && inp.add.length) Store.mergeRoutine(name, inp.add);
              if (Array.isArray(inp.remove) && inp.remove.length) Store.sessionRemoveExercises(name, inp.remove);
            }
            if (handlers.onSession) handlers.onSession(name);
            resultText = JSON.stringify({ ok: !!name, session: name });
          } else {
            resultText = JSON.stringify({ ok: false, error: 'unknown tool' });
          }
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: resultText });
        });

        session.messages.push({ role: 'user', content: toolResults });
        Store.setCurrentSession(session);
        return step();
      });
    }

    return step().then(function () {
      if (!completed) rollback();   // incomplete (e.g. max tool rounds) — don't leave a dangling turn
    }, function (err) {
      rollback();
      throw err;
    });
  }

  /* Build a fresh rolling summary from the previous summary + this session's
   * logged workouts + chat transcript. Returns the new summary text. */
  function summarizeSession(session) {
    var prev = Store.getSummary();
    var workouts = Store.getWorkoutsBySession(session.id);

    var transcript = (session.messages || []).map(function (m) {
      if (m.role === 'user') {
        return typeof m.content === 'string' ? 'User: ' + m.content : null;
      }
      if (m.role === 'assistant') {
        var text = (Array.isArray(m.content) ? m.content : [])
          .filter(function (b) { return b.type === 'text'; })
          .map(function (b) { return b.text; }).join(' ').trim();
        return text ? 'Coach: ' + text : null;
      }
      return null;
    }).filter(Boolean).join('\n');

    var sys = 'You maintain a concise, evolving training-history summary for a fitness app. ' +
      'Given the previous summary, the workouts logged this session, and the chat transcript, ' +
      'write an UPDATED summary. Capture recurring exercises and typical loads, recent ' +
      'progression or PRs, cardio patterns, injuries or limitations, stated goals and preferences, ' +
      'and rough training frequency. Be specific but brief (about 180 words max). Write it as notes ' +
      'for a coach to read before the next session. Output ONLY the summary text, with no preamble.';

    var userMsg = 'PREVIOUS SUMMARY:\n' + (prev && prev.text ? prev.text : '(none yet)') +
      '\n\nWORKOUTS LOGGED THIS SESSION (JSON):\n' + (JSON.stringify(workouts) || '[]') +
      '\n\nCHAT TRANSCRIPT:\n' + (transcript || '(no chat)');

    return streamRequest({
      model: Store.getModel(),
      max_tokens: 512,
      system: sys,
      messages: [{ role: 'user', content: userMsg }]
    }).then(function (res) {
      var text = res.content.filter(function (b) { return b.type === 'text'; })
        .map(function (b) { return b.text; }).join('').trim();
      if (text) Store.setSummary({ text: text, updatedAt: new Date().toISOString() });
      return text;
    });
  }

  function parseJsonLoose(text) {
    if (!text) return null;
    var t = text.trim().replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
    try { return JSON.parse(t); } catch (e) {}
    var first = t.indexOf('{'), last = t.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try { return JSON.parse(t.slice(first, last + 1)); } catch (e2) {}
    }
    return null;
  }

  /* Split pasted history into bounded chunks so each LLM call's JSON output can't
   * be truncated. CSV is grouped by date (~3 sessions/chunk, header re-attached);
   * freeform text is split on blank lines into ~1.8k-char chunks. */
  function chunkHistory(text) {
    var lines = text.split(/\r?\n/).map(function (l) { return l.replace(/\s+$/, ''); });
    var headerIdx = -1, header = '';
    for (var i = 0; i < lines.length; i++) {
      if (/^\s*date\s*,/i.test(lines[i]) && /exercise/i.test(lines[i])) { headerIdx = i; header = lines[i].trim(); break; }
    }
    if (headerIdx !== -1) {
      var rows = lines.slice(headerIdx + 1).filter(function (l) { return l.trim() !== ''; });
      var chunks = [], cur = [], seen = {}, dateCount = 0;
      rows.forEach(function (r) {
        var date = (r.split(',')[0] || '').trim();
        if (!(date in seen)) {
          if (dateCount >= 3) { chunks.push(header + '\n' + cur.join('\n')); cur = []; seen = {}; dateCount = 0; }
          seen[date] = true; dateCount++;
        }
        cur.push(r);
      });
      if (cur.length) chunks.push(header + '\n' + cur.join('\n'));
      return chunks.length ? chunks : [text];
    }
    var blocks = text.split(/\n\s*\n/);
    var out = [], buf = '';
    blocks.forEach(function (b) {
      if (buf && (buf + '\n\n' + b).length > 1800) { out.push(buf); buf = b; }
      else buf = buf ? buf + '\n\n' + b : b;
    });
    if (buf) out.push(buf);
    return out.length ? out : [text];
  }

  function toTimestamp(d) {
    if (!d) return new Date().toISOString();
    var s = String(d);
    var date = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T12:00:00') : new Date(s);
    return isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  }

  function dayKey(ts) {
    var x = new Date(ts);
    return x.getFullYear() + '-' + (x.getMonth() + 1) + '-' + x.getDate();
  }

  /* Convert one chunk of history into structured workouts via the LLM. */
  function extractWorkouts(chunkText) {
    var units = Store.getUnits();
    var today = new Date().toDateString();
    var sys = 'You convert part of a user\'s training-history log into structured JSON for a fitness app. ' +
      'Today is ' + today + '. Dates may lack a year — assume the most recent occurrence on or before today. ' +
      'Return ONLY a single JSON object (no markdown, no prose): { "workouts": [ ... ] }.\n' +
      'Each workout is one session on one date: { "date": "YYYY-MM-DD", "session": string or null ' +
      '(a routine/day label like "A", "B", "Push", "Legs" if the data indicates one), "exercises": [ ' +
      '{ "name", "type": one of strength|cardio|flexibility|other, "sets": [ { "reps": number, ' +
      '"weight": number, "unit": "lb"|"kg" } ], "duration_min": number, "distance": number, ' +
      '"distance_unit": "mi"|"km", "notes": string } ], "notes": string }.\n' +
      'Interpret shorthand: "2x5kg" = two implements of 5 kg each (keep "2x5kg" in the exercise notes); ' +
      '"30m" for a carry = 30 metres (use distance with distance_unit "km" = 0.03, and keep "30m" in notes); ' +
      '"each side"/"each hand" = unilateral (note it); a rep range like "8-10" → use a representative number ' +
      'and keep the range in notes; "Bodyweight" = omit weight. Skipped items (0 sets) may be omitted or noted. ' +
      'Group every exercise on the same date into one workout. Default unit ' + units + '. ' +
      'Only use data actually present — never invent numbers.';

    return streamRequest({
      model: Store.getModel(),
      max_tokens: 4096,
      system: sys,
      messages: [{ role: 'user', content: chunkText }]
    }).then(function (res) {
      var out = res.content.filter(function (b) { return b.type === 'text'; })
        .map(function (b) { return b.text; }).join('');
      var data = parseJsonLoose(out);
      if (!data) throw new ApiError('parse', 'Could not parse a chunk of the history.');
      return Array.isArray(data.workouts) ? data.workouts : [];
    });
  }

  function summarizeText(text) {
    var today = new Date().toDateString();
    var prev = Store.getSummary();
    var sys = 'You maintain concise coach notes summarizing a user\'s training history. Today is ' + today + '. ' +
      'If a PREVIOUS SUMMARY is given, MERGE the new data into it (keep still-relevant facts, update what ' +
      'changed) rather than discarding it. Write ONLY the updated summary (no preamble, ~150-180 words): the ' +
      'split/structure, training frequency, main lifts with typical loads and any progression, carries and ' +
      'unilateral work, and especially any injuries, pains, or limitations to watch (with rough dates). ' +
      'Write it as notes a coach reads before the next session.';
    var user = (prev && prev.text ? 'PREVIOUS SUMMARY:\n' + prev.text + '\n\n' : '') + 'NEW TRAINING DATA:\n' + text;
    return streamRequest({
      model: Store.getModel(),
      max_tokens: 700,
      system: sys,
      messages: [{ role: 'user', content: user }]
    }).then(function (res) {
      return res.content.filter(function (b) { return b.type === 'text'; })
        .map(function (b) { return b.text; }).join('').trim();
    });
  }

  /* Fallback summary built locally from stored workouts (used if the LLM
   * summary call fails after workouts were already imported). */
  function localSummary(ws) {
    if (!ws.length) return 'Imported training history.';
    var dts = ws.map(function (w) { return new Date(w.timestamp); }).sort(function (a, b) { return a - b; });
    var first = dts[0], last = dts[dts.length - 1];
    var freq = {}, injuries = [];
    ws.forEach(function (w) {
      (w.exercises || []).forEach(function (ex) {
        if (ex.name) freq[ex.name] = (freq[ex.name] || 0) + 1;
        var n = ex.notes || '';
        if (/pain|strain|cramp|tweak|injur|sharp/i.test(n)) injuries.push((ex.name || 'exercise') + ' — ' + n);
      });
    });
    var top = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; }).slice(0, 8);
    var s = 'Imported ' + ws.length + ' sessions (' + first.toLocaleDateString() + '–' + last.toLocaleDateString() + '). ';
    s += 'Frequent movements: ' + top.join(', ') + '. ';
    if (injuries.length) s += 'Watch-outs: ' + injuries.slice(0, 5).join('; ') + '.';
    return s;
  }

  /* Chunked importer: convert history to structured workouts batch-by-batch,
   * then summarize the whole thing. onProgress(done, total) is optional.
   * Returns { count, chunks, failed, summarized }. */
  function importHistory(text, onProgress) {
    var chunks = chunkHistory(text);
    var total = chunks.length;
    var sid = 'import-' + Store.uid();
    var added = 0, skipped = 0, failed = 0, idx = 0;

    // Idempotency: any calendar day that already has a workout is skipped.
    var existing = {};
    Store.getWorkouts().forEach(function (w) { existing[dayKey(w.timestamp)] = true; });
    var routineAcc = {};   // routine label -> { name -> true }

    function next() {
      if (idx >= total) return Promise.resolve();
      var here = idx++;
      if (onProgress) onProgress(here, total);
      return extractWorkouts(chunks[here]).then(function (workouts) {
        workouts.forEach(function (w) {
          if (!w || !Array.isArray(w.exercises) || !w.exercises.length) return;
          var ts = toTimestamp(w.date);
          var key = dayKey(ts);
          if (existing[key]) { skipped++; return; }
          existing[key] = true;
          Store.addWorkout({ exercises: w.exercises, notes: w.notes || '' }, sid, ts);
          added++;
          if (w.session) {
            var label = String(w.session).trim();
            var rname = label.length <= 2 ? ('Session ' + label.toUpperCase()) : label;
            var acc = routineAcc[rname] || (routineAcc[rname] = {});
            w.exercises.forEach(function (ex) { if (ex.name) acc[ex.name] = true; });
          }
        });
      }, function (err) {
        // Auth/network errors are fatal; a parse error on one chunk is skipped.
        if (err && (err.code === 'no_key' || err.code === 'network' ||
                    err.code === 'http_401' || err.code === 'http_403')) throw err;
        failed++;
      }).then(next);
    }

    return next().then(function () {
      if (onProgress) onProgress(total, total);
      Object.keys(routineAcc).forEach(function (rname) {
        Store.mergeRoutine(rname, Object.keys(routineAcc[rname]));
      });
      if (added === 0) {
        return { count: 0, skipped: skipped, chunks: total, failed: failed, summarized: false };
      }
      return summarizeText(text).then(function (sum) {
        if (sum) Store.setSummary({ text: sum, updatedAt: new Date().toISOString() });
        return { count: added, skipped: skipped, chunks: total, failed: failed, summarized: !!sum };
      }, function () {
        Store.setSummary({ text: localSummary(Store.getWorkoutsBySession(sid)), updatedAt: new Date().toISOString() });
        return { count: added, skipped: skipped, chunks: total, failed: failed, summarized: false };
      });
    });
  }

  /* Deterministically build session/routine templates from the user's history.
   * Uses a forced JSON response (not the chat model's discretion), so it always acts. */
  function suggestSessions() {
    var summary = Store.getSummary();
    var exMap = {};
    Store.getWorkouts().forEach(function (w) {
      (w.exercises || []).forEach(function (ex) { if (ex.name) exMap[ex.name] = true; });
    });
    var names = Object.keys(exMap);
    var routines = Store.getRoutines();
    if (!names.length && !(summary && summary.text)) {
      return Promise.reject(new ApiError('nodata', 'No history yet to build sessions from. Import or log some workouts first.'));
    }

    var sys = 'You organise a user\'s exercises into workout sessions (reusable routine templates). ' +
      'Use their existing split if one is evident (e.g. A/B/C or Push/Pull/Legs). ' +
      'Return ONLY a JSON object (no markdown, no prose): ' +
      '{ "sessions": [ { "name": string, "exercises": [string, ...] } ] }. ' +
      'Use the EXACT exercise names given. Put each exercise in the session(s) it belongs to; ' +
      'an exercise may appear in more than one session.';
    var user = '';
    if (summary && summary.text) user += 'HISTORY SUMMARY:\n' + summary.text + '\n\n';
    user += 'EXERCISES:\n' + (names.join(', ') || '(none)');
    if (routines.length) user += '\n\nEXISTING SESSION NAMES (reuse these exact names where they fit): ' +
      routines.map(function (r) { return r.name; }).join(', ');

    return streamRequest({
      model: Store.getModel(),
      max_tokens: 1500,
      system: sys,
      messages: [{ role: 'user', content: user }]
    }).then(function (res) {
      var out = res.content.filter(function (b) { return b.type === 'text'; })
        .map(function (b) { return b.text; }).join('');
      var data = parseJsonLoose(out);
      if (!data || !Array.isArray(data.sessions)) throw new ApiError('parse', 'Could not build sessions from the response.');
      var created = 0;
      data.sessions.forEach(function (s) {
        if (!s || !s.name || !Array.isArray(s.exercises) || !s.exercises.length) return;
        Store.mergeRoutine(String(s.name).trim(), s.exercises.filter(Boolean));
        created++;
      });
      return { sessions: created };
    });
  }

  App.Api = {
    ApiError: ApiError,
    LOG_WORKOUT_TOOL: LOG_WORKOUT_TOOL,
    suggestSessions: suggestSessions,
    buildSystemPrompt: buildSystemPrompt,
    runTurn: runTurn,
    summarizeSession: summarizeSession,
    importHistory: importHistory
  };
})();
