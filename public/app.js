/* Shared, dependency-free frontend for the capture, library and login pages. */
(() => {
  const STATUS_LABELS = {
    QUEUED: 'Queued',
    PROCESSING: 'Processing',
    READY: 'Ready',
    RETRYABLE_ERROR: 'Retrying',
    CONTENT_UNAVAILABLE: 'Unavailable',
    AUTHORIZATION_REQUIRED: 'Needs import',
    FAILED: 'Failed',
  };
  const TERMINAL = new Set(['READY', 'CONTENT_UNAVAILABLE', 'AUTHORIZATION_REQUIRED', 'FAILED']);

  function $(id) {
    return document.getElementById(id);
  }

  function show(el, visible) {
    if (!el) return;
    el.classList.toggle('hidden', !visible);
  }

  function text(el, value) {
    if (el) el.textContent = value == null ? '' : String(value);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function api(path, options) {
    const opts = Object.assign({ headers: {} }, options || {});
    if (opts.body && typeof opts.body !== 'string') {
      opts.body = JSON.stringify(opts.body);
      opts.headers['Content-Type'] = 'application/json';
    }
    opts.credentials = 'same-origin';
    const response = await fetch(path, opts);
    if (response.status === 401 && !path.startsWith('/api/auth/')) {
      window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
      throw new Error('Not signed in');
    }
    let data = null;
    try {
      data = await response.json();
    } catch (_) {
      data = null;
    }
    if (!response.ok) {
      const message = data?.error?.message || `Request failed (${response.status})`;
      const error = new Error(message);
      error.code = data?.error?.code;
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function formatDate(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function formatSize(bytes) {
    if (!bytes) return '';
    if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  function wireLogout() {
    const link = $('logout-link');
    if (!link) return;
    link.addEventListener('click', async (event) => {
      event.preventDefault();
      try {
        await api('/api/auth/logout', { method: 'POST' });
      } finally {
        window.location.href = '/login';
      }
    });
  }

  function registerServiceWorker() {
    if ('serviceWorker' in navigator && window.location.protocol === 'https:') {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }

  /* ---------- Login ---------- */
  function initLogin() {
    const form = $('login-form');
    const error = $('login-error');
    const button = $('login-button');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      show(error, false);
      button.disabled = true;
      try {
        await api('/api/auth/login', { method: 'POST', body: { password: $('password').value } });
        const params = new URLSearchParams(window.location.search);
        const next = params.get('next');
        window.location.href = next?.startsWith('/') && !next.startsWith('//') ? next : '/';
      } catch (err) {
        text(error, err.message);
        show(error, true);
        button.disabled = false;
      }
    });
  }

  /* ---------- Capture ---------- */
  function extractUrlFromShare(params) {
    const direct = params.get('url');
    if (direct && /^https?:\/\//i.test(direct)) return direct;
    const candidates = [params.get('text'), params.get('title')];
    for (const candidate of candidates) {
      if (!candidate) continue;
      const match = candidate.match(/https?:\/\/[^\s<>"']+/i);
      if (match) return match[0];
    }
    return '';
  }

  function initCapture() {
    wireLogout();
    registerServiceWorker();
    const form = $('capture-form');
    const urlInput = $('url');
    const button = $('capture-button');
    const result = $('result');
    let pollTimer = null;
    let currentId = null;

    const params = new URLSearchParams(window.location.search);
    const shared = extractUrlFromShare(params);
    const importId = params.get('import');
    if (shared) {
      urlInput.value = shared;
      history.replaceState(null, '', '/');
      setTimeout(() => form.requestSubmit(), 50);
    } else if (importId && /^[0-9a-f-]{36}$/i.test(importId)) {
      history.replaceState(null, '', '/');
      api(`/api/articles/${importId}`)
        .then((data) => {
          urlInput.value = data.article.url;
          track(data.article);
          show($('import-panel'), true);
        })
        .catch((err) => {
          text($('result-error'), err.message);
          show($('result-error'), true);
          show(result, true);
        });
    }

    function render(article) {
      show(result, true);
      text($('result-title'), article.title || 'Processing…');
      const status = $('result-status');
      status.className = `status ${article.status}`;
      text(status, STATUS_LABELS[article.status] || article.status);
      const meta = [
        article.author,
        article.publicationName,
        article.publishedAt ? formatDate(article.publishedAt) : null,
      ]
        .filter(Boolean)
        .join(' · ');
      text($('result-meta'), meta);
      const message = $('result-message');
      const errorBox = $('result-error');
      show(errorBox, false);
      if (article.status === 'READY') {
        text(
          message,
          'Your EPUB is ready' +
            (article.epubSize ? ` (${formatSize(article.epubSize)})` : '') +
            '.',
        );
      } else if (article.status === 'QUEUED' || article.status === 'PROCESSING') {
        message.innerHTML = '<span class="spinner"></span> Fetching and converting the article…';
      } else {
        text(message, '');
        text(errorBox, article.errorMessage || 'Processing failed.');
        show(errorBox, true);
      }
      const download = $('download-link');
      download.href = article.downloadUrl || '#';
      show(download, !!article.downloadUrl);
      show($('retry-button'), article.canRetry);
      const original = $('original-link');
      original.href = article.url;
      show(original, true);
      show(
        $('import-panel'),
        article.status === 'AUTHORIZATION_REQUIRED' ||
          article.status === 'CONTENT_UNAVAILABLE' ||
          article.status === 'FAILED',
      );
      if (TERMINAL.has(article.status) && pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    }

    async function poll() {
      if (!currentId) return;
      try {
        const data = await api(`/api/articles/${currentId}`);
        render(data.article);
        if (!TERMINAL.has(data.article.status)) pollTimer = setTimeout(poll, 2500);
      } catch (err) {
        text($('result-error'), err.message);
        show($('result-error'), true);
      }
    }

    function track(article) {
      currentId = article.id;
      if (pollTimer) clearTimeout(pollTimer);
      render(article);
      if (!TERMINAL.has(article.status)) pollTimer = setTimeout(poll, 1500);
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      button.disabled = true;
      show($('result-error'), false);
      try {
        const data = await api('/api/articles', {
          method: 'POST',
          body: { url: urlInput.value.trim() },
        });
        track(data.article);
        if (data.duplicate) {
          text($('result-message'), 'This article was already in your library.');
        }
      } catch (err) {
        show(result, true);
        text($('result-title'), 'Could not save');
        $('result-status').className = 'status FAILED';
        text($('result-status'), 'Rejected');
        text($('result-meta'), '');
        text($('result-message'), '');
        text($('result-error'), err.message);
        show($('result-error'), true);
        show($('download-link'), false);
        show($('retry-button'), false);
        show($('original-link'), false);
        show($('import-panel'), false);
      } finally {
        button.disabled = false;
      }
    });

    $('retry-button').addEventListener('click', async () => {
      if (!currentId) return;
      try {
        const data = await api(`/api/articles/${currentId}/retry`, { method: 'POST' });
        track(data.article);
      } catch (err) {
        text($('result-error'), err.message);
        show($('result-error'), true);
      }
    });

    $('import-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!currentId) return;
      const content = $('import-content').value;
      const looksLikeHtml = /<\/?(p|div|h[1-6]|article|html|body)[\s>]/i.test(content);
      const payload = looksLikeHtml ? { html: content } : { text: content };
      const title = $('import-title').value.trim();
      const author = $('import-author').value.trim();
      if (title) payload.title = title;
      if (author) payload.author = author;
      $('import-button').disabled = true;
      try {
        const data = await api(`/api/articles/${currentId}/import`, {
          method: 'POST',
          body: payload,
        });
        track(data.article);
      } catch (err) {
        text($('result-error'), err.message);
        show($('result-error'), true);
      } finally {
        $('import-button').disabled = false;
      }
    });
  }

  /* ---------- Library ---------- */
  function initLibrary() {
    wireLogout();
    const list = $('library-list');
    const alert = $('library-alert');
    const state = { page: 1, pageSize: 20, q: '', status: '', totalPages: 1 };
    let refreshTimer = null;

    function articleCard(article) {
      const meta = [
        article.author,
        article.publicationName,
        article.publishedAt ? `Published ${formatDate(article.publishedAt)}` : null,
        `Saved ${formatDate(article.capturedAt)}`,
        article.epubSize ? formatSize(article.epubSize) : null,
        article.wordCount ? `${article.wordCount.toLocaleString()} words` : null,
      ].filter(Boolean);
      const actions = [];
      if (article.downloadUrl)
        actions.push(
          '<a class="button" href="' +
            escapeHtml(article.downloadUrl) +
            '" download>Download EPUB</a>',
        );
      if (article.canRetry)
        actions.push(
          '<button class="secondary" data-action="retry" data-id="' +
            article.id +
            '">Retry</button>',
        );
      if (article.status === 'AUTHORIZATION_REQUIRED' || article.status === 'CONTENT_UNAVAILABLE') {
        actions.push(`<a class="button secondary" href="/?import=${article.id}">Manual import</a>`);
      }
      actions.push(
        '<a class="button secondary" href="' +
          escapeHtml(article.url) +
          '" target="_blank" rel="noopener noreferrer">Original</a>',
      );
      actions.push(
        `<button class="danger" data-action="delete" data-id="${article.id}">Delete</button>`,
      );
      return (
        '<article class="card article" data-id="' +
        article.id +
        '">' +
        '<div class="row" style="justify-content:space-between;align-items:flex-start">' +
        '<h3>' +
        escapeHtml(article.title || article.canonicalUrl) +
        '</h3>' +
        '<span class="status ' +
        article.status +
        '">' +
        escapeHtml(STATUS_LABELS[article.status] || article.status) +
        '</span></div>' +
        '<div class="meta">' +
        escapeHtml(meta.join(' · ')) +
        '</div>' +
        (article.errorMessage && article.status !== 'READY'
          ? `<div class="error">${escapeHtml(article.errorMessage)}</div>`
          : '') +
        '<div class="actions">' +
        actions.join('') +
        '</div>' +
        '</article>'
      );
    }

    async function load() {
      show(alert, false);
      const params = new URLSearchParams({
        page: String(state.page),
        pageSize: String(state.pageSize),
      });
      if (state.q) params.set('q', state.q);
      if (state.status) params.set('status', state.status);
      try {
        const data = await api(`/api/articles?${params.toString()}`);
        state.totalPages = data.totalPages;
        if (data.items.length === 0) {
          list.innerHTML =
            '<p class="muted card">No articles yet. <a href="/">Save your first one.</a></p>';
        } else {
          list.innerHTML = data.items.map(articleCard).join('');
        }
        text(
          $('page-info'),
          'Page ' +
            data.page +
            ' of ' +
            data.totalPages +
            ' · ' +
            data.total +
            ' article' +
            (data.total === 1 ? '' : 's'),
        );
        $('prev-page').disabled = data.page <= 1;
        $('next-page').disabled = data.page >= data.totalPages;
        const active = data.items.some((a) => a.status === 'QUEUED' || a.status === 'PROCESSING');
        if (refreshTimer) clearTimeout(refreshTimer);
        if (active) refreshTimer = setTimeout(load, 4000);
      } catch (err) {
        text(alert, err.message);
        show(alert, true);
      }
    }

    $('filter-form').addEventListener('submit', (event) => {
      event.preventDefault();
      state.q = $('q').value.trim();
      state.status = $('status').value;
      state.page = 1;
      load();
    });
    $('prev-page').addEventListener('click', () => {
      if (state.page > 1) {
        state.page -= 1;
        load();
      }
    });
    $('next-page').addEventListener('click', () => {
      if (state.page < state.totalPages) {
        state.page += 1;
        load();
      }
    });
    list.addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const id = button.getAttribute('data-id');
      const action = button.getAttribute('data-action');
      button.disabled = true;
      try {
        if (action === 'delete') {
          if (!window.confirm('Delete this article and its EPUB? This cannot be undone.')) return;
          await api(`/api/articles/${id}`, { method: 'DELETE' });
        } else if (action === 'retry') {
          await api(`/api/articles/${id}/retry`, { method: 'POST' });
        }
        await load();
      } catch (err) {
        text(alert, err.message);
        show(alert, true);
      } finally {
        button.disabled = false;
      }
    });
    load();
  }

  window.SK = { initLogin, initCapture, initLibrary };
})();
