/* app.js — bootstrap + session orchestration. Glues UI, Api and Store together. */
(function () {
  'use strict';
  window.App = window.App || {};
  var Store = App.Store, Api = App.Api, UI = App.UI;

  var busy = false;

  // ----- turn handling -----------------------------------------------------
  function handleSend(text) {
    if (busy) return;
    if (!Store.getApiKey()) {
      UI.toast('Add your Anthropic API key in Settings first.', 'error');
      UI.showScreen('settings');
      return;
    }
    busy = true;
    UI.addUserMessage(text);
    UI.setComposerEnabled(false);

    Api.runTurn(text, {
      onRoundStart: function () { UI.showTyping(); },
      onText: function (delta) { UI.appendAssistantDelta(delta); },
      onRoundEnd: function () { UI.finishAssistant(); },
      onLogged: function (entry) { UI.addLogChip(entry); UI.refreshHistory(); },
      onSession: function (name) { UI.addSessionChip(name); UI.refreshSessions(); }
    }).catch(function (err) {
      UI.finishAssistant();
      UI.toast(err && err.message ? err.message : 'Something went wrong.', 'error');
      if (err && err.code === 'no_key') UI.showScreen('settings');
    }).then(function () {
      UI.hideTyping();
      UI.setComposerEnabled(true);
      busy = false;
      UI.focusInput();
    });
  }

  // ----- finish / summarize session ---------------------------------------
  function sessionHasUserInput(session) {
    return !!(session && Array.isArray(session.messages) && session.messages.some(function (m) {
      return m.role === 'user' && typeof m.content === 'string';
    }));
  }

  function handleFinish() {
    if (busy) return;
    var session = Store.getCurrentSession();
    if (!sessionHasUserInput(session)) {
      UI.toast('Nothing to summarize yet — log a workout first.', 'info');
      return;
    }
    if (!Store.getApiKey()) {
      UI.toast('Add your API key to save a session summary.', 'error');
      UI.showScreen('settings');
      return;
    }
    busy = true;
    UI.setComposerEnabled(false);
    UI.toast('Saving conversation & updating summary…', 'info');

    Api.summarizeSession(session).then(function () {
      Store.archiveSession(session);
      var fresh = Store.startNewSession();
      UI.renderSession(fresh);
      UI.refreshHistory();
      UI.toast('Conversation saved. Summary updated.', 'success');
    }).catch(function (err) {
      UI.toast('Couldn’t update summary: ' + (err && err.message ? err.message : 'error'), 'error');
    }).then(function () {
      UI.setComposerEnabled(true);
      busy = false;
    });
  }

  // ----- import history ----------------------------------------------------
  function handleImport() {
    if (busy) return;
    var text = UI.getImportText();
    if (!text) { UI.toast('Paste some history first.', 'info'); return; }
    if (!Store.getApiKey()) { UI.toast('Add your Anthropic API key first.', 'error'); return; }
    busy = true;
    UI.setImportBusy(true);
    UI.setImportStatus('Importing… preparing.');
    Api.importHistory(text, function (done, total) {
      UI.setImportStatus('Importing… part ' + Math.min(done + 1, total) + ' of ' + total + '.');
    }).then(function (res) {
      var msg = 'Imported ' + res.count + ' new workout' + (res.count === 1 ? '' : 's');
      if (res.skipped) msg += ' (skipped ' + res.skipped + ' already-logged date' + (res.skipped === 1 ? '' : 's') + ')';
      msg += ' across ' + res.chunks + ' part' + (res.chunks === 1 ? '' : 's') + '.';
      if (res.failed) msg += ' ' + res.failed + ' part' + (res.failed === 1 ? '' : 's') + ' couldn’t be read.';
      if (res.count > 0) msg += res.summarized ? ' Summary updated.' : ' Summary generated offline.';
      else msg += ' Nothing new to import.';
      UI.setImportStatus(msg);
      UI.clearImportText();
      UI.refreshHistory();
    }).catch(function (err) {
      UI.setImportStatus('Import failed: ' + (err && err.message ? err.message : 'error'));
    }).then(function () {
      busy = false;
      UI.setImportBusy(false);
    });
  }

  // ----- build sessions from history --------------------------------------
  function handleSuggestSessions() {
    if (busy) return;
    if (!Store.getApiKey()) { UI.toast('Add your Anthropic API key first.', 'error'); UI.showScreen('settings'); return; }
    busy = true;
    UI.setSuggestBusy(true);
    Api.suggestSessions().then(function (res) {
      UI.refreshSessions();
      UI.toast('Created/updated ' + res.sessions + ' session' + (res.sessions === 1 ? '' : 's') + '.', 'success');
    }).catch(function (err) {
      UI.toast(err && err.message ? err.message : 'Could not build sessions.', 'error');
    }).then(function () {
      busy = false;
      UI.setSuggestBusy(false);
    });
  }

  // ----- clear all ---------------------------------------------------------
  function handleClearAll() {
    Store.clearAll();
    Store.ensureCurrentSession();
    UI.refreshSettings();
    UI.renderSession(Store.getCurrentSession());
    UI.refreshHistory();
    UI.toast('All local data cleared.', 'info');
    UI.showScreen('coach');
  }

  // ----- auto-finalize a stale (previous-day) session on load --------------
  function isStale(startedAt) {
    if (!startedAt) return false;
    return new Date(startedAt).toDateString() !== new Date().toDateString();
  }

  function maybeAutoFinalize() {
    var s = Store.getCurrentSession();
    if (!sessionHasUserInput(s) || !isStale(s.startedAt) || !Store.getApiKey()) {
      return Promise.resolve();
    }
    return Api.summarizeSession(s).then(function () {
      Store.archiveSession(s);
      Store.startNewSession();
    }).catch(function () { /* keep the session if summarizing fails */ });
  }

  // ----- boot --------------------------------------------------------------
  function boot() {
    Store.ensureCurrentSession();
    UI.init({
      onSend: handleSend, onFinish: handleFinish, onClearAll: handleClearAll,
      onImport: handleImport, onSuggestSessions: handleSuggestSessions
    });
    UI.showScreen('coach');

    maybeAutoFinalize().then(function () {
      UI.renderSession(Store.getCurrentSession());
      UI.refreshHistory();
      if (!Store.getApiKey()) {
        UI.toast('Add your Anthropic API key in Settings to get started.', 'info');
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  App.boot = boot;
})();
