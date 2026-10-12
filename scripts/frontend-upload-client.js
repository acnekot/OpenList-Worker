(() => {
  const SMALL_FILE = 8 * 1024 * 1024;
  // Transfer tuning. A request that makes no progress is abandoned and retried,
  // so a dead connection can never leave the panel hanging.
  const STALL_MS = 45 * 1000; // no upload progress at all: the connection is dead
  const RESPONSE_MS = 90 * 1000; // body sent, waiting for the Worker to finish with Google
  const API_TIMEOUT_MS = 30 * 1000;
  const START_TIMEOUT_MS = 120 * 1000; // the Worker may scan a large quota folder first
  const RETRY_WAITS = [1000, 2000, 4000, 10000, 20000, 25000]; // the last wait repeats
  const PATIENCE_MS = 10 * 60 * 1000; // stop after this long without progress, keeping the session
  const CHUNK_UNIT = 256 * 1024; // Google needs non-final chunks in multiples of this
  const MIN_CHUNK = 1024 * 1024;
  const RESUME_KEY = 'catsuki-upload-sessions';
  const RESUME_TTL = 5 * 60 * 60 * 1000; // sessions renew while uploading and lapse after 6 h idle
  // Permission, quota and bad-request answers will not change on retry.
  const retryable = error => !error.status || error.status >= 500 || error.status === 408 || error.status === 429;
  const pause = (ms, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(cancelled());
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(cancelled()); };
    signal.addEventListener('abort', onAbort, { once: true });
  });

  // An interrupted large upload can be picked up again: the browser remembers
  // Google's session token for each file, and choosing the same file resumes it.
  function loadResumes() {
    try {
      const all = JSON.parse(localStorage.getItem(RESUME_KEY) || '{}');
      return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
    } catch { return {}; }
  }
  function saveResume(key, session) {
    try {
      const all = loadResumes();
      all[key] = { token: session.token, chunk_size: session.chunk_size, at: Date.now() };
      for (const [name, entry] of Object.entries(all)) {
        if (!entry || Date.now() - entry.at > RESUME_TTL) delete all[name];
      }
      localStorage.setItem(RESUME_KEY, JSON.stringify(all));
    } catch {}
  }
  function clearResume(key) {
    try {
      const all = loadResumes();
      if (key in all) {
        delete all[key];
        localStorage.setItem(RESUME_KEY, JSON.stringify(all));
      }
    } catch {}
  }
  function savedResume(key) {
    const entry = loadResumes()[key];
    return entry && typeof entry.token === 'string' && Date.now() - entry.at <= RESUME_TTL ? entry : null;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.hidden = true;
  document.addEventListener('DOMContentLoaded', () => document.body.append(input));
  let busy = false;
  const quotaCache = new Map();
  const quotaPending = new Set();

  const cancelled = () => new DOMException('上传已取消', 'AbortError');
  const formatBytes = value => {
    if (value < 1024) return `${Math.round(value)} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let size = value;
    let unit = -1;
    do { size /= 1024; unit++; } while (size >= 1024 && unit < units.length - 1);
    return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unit]}`;
  };
  const formatTime = seconds => {
    if (!Number.isFinite(seconds) || seconds < 0) return '计算中';
    if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
    if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分钟`;
    return `${Math.floor(seconds / 3600)} 小时 ${Math.ceil(seconds % 3600 / 60)} 分钟`;
  };

  function apiHeaders(extra = {}) {
    return { Authorization: localStorage.getItem('token') || '', ...extra };
  }

  async function api(url, options = {}, timeoutMs = API_TIMEOUT_MS) {
    const parent = options.signal;
    if (parent && parent.aborted) throw cancelled();
    const controller = new AbortController();
    const onParentAbort = () => controller.abort();
    if (parent) parent.addEventListener('abort', onParentAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const response = await fetch('/api/fs/' + url, { ...options, signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      if (timedOut) throw new Error('服务器响应超时');
      if (!response.ok || data.code !== 200) {
        const error = new Error(data.message || `上传失败 (HTTP ${response.status})`);
        error.status = response.status;
        throw error;
      }
      return data.data;
    } catch (error) {
      if (timedOut && !(parent && parent.aborted)) throw new Error('服务器响应超时');
      throw error;
    } finally {
      clearTimeout(timer);
      if (parent) parent.removeEventListener('abort', onParentAbort);
    }
  }

  // XHR exposes upload progress and aborts the current request immediately.
  // A watchdog also aborts it when the connection stops moving: browsers set no
  // timeout of their own, so a black-holed request would otherwise hang forever.
  function sendFile(url, headers, body, signal, onProgress) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(cancelled());
      const xhr = new XMLHttpRequest();
      let watchdog;
      let stalled = false;
      const arm = ms => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => { stalled = true; xhr.abort(); }, ms);
      };
      const abort = () => xhr.abort();
      const cleanup = () => {
        clearTimeout(watchdog);
        signal.removeEventListener('abort', abort);
      };
      xhr.open('PUT', '/api/fs/' + url);
      for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
      xhr.upload.onprogress = event => {
        arm(STALL_MS);
        onProgress(Math.min(event.loaded, body.size));
      };
      xhr.upload.onload = () => arm(RESPONSE_MS);
      xhr.onload = () => {
        cleanup();
        let data;
        try { data = JSON.parse(xhr.responseText); } catch { data = {}; }
        if (xhr.status >= 200 && xhr.status < 300 && data.code === 200) resolve(data.data);
        else {
          const error = new Error(data.message || `上传失败 (HTTP ${xhr.status})`);
          error.status = xhr.status;
          reject(error);
        }
      };
      xhr.onerror = () => { cleanup(); reject(new Error('网络连接中断')); };
      xhr.onabort = () => {
        cleanup();
        reject(stalled && !signal.aborted ? new Error('连接没有响应') : cancelled());
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) return abort();
      arm(STALL_MS);
      xhr.send(body);
    });
  }

  async function uploadFile(directory, file, signal, update) {
    const path = directory + '/' + file.name;
    if (signal.aborted) throw cancelled();
    if (file.size <= SMALL_FILE) {
      await sendFile('put', apiHeaders({
        'File-Path': encodeURIComponent(path),
        'Content-Type': 'application/octet-stream',
      }), file, signal, sent => update(sent, '正在传输'));
      update(file.size, '已保存');
      return;
    }

    // The same file at the same destination continues where it stopped.
    const key = `${path}|${file.size}|${file.lastModified || 0}`;
    let session = null;
    let offset = 0;
    const saved = savedResume(key);
    if (saved) {
      update(0, '正在检查上次中断的上传');
      try {
        const status = await api('google_drive/upload/status', {
          headers: apiHeaders({ 'X-Google-Upload-Token': saved.token }),
          signal,
        });
        if (status.complete) {
          clearResume(key);
          update(file.size, '已保存');
          return;
        }
        session = { token: status.token || saved.token, chunk_size: saved.chunk_size, key };
        offset = status.next_offset;
      } catch (error) {
        if (signal.aborted) throw cancelled();
        // A hiccup keeps the saved session for the next try; a lapsed one is dropped.
        if (retryable(error)) throw error;
        clearResume(key);
      }
    }
    if (!session) {
      update(0, '正在连接 Google Drive');
      session = await api('google_drive/upload/start', {
        method: 'POST',
        headers: apiHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ path, size: file.size, mime_type: file.type || 'application/octet-stream' }),
        signal,
      }, START_TIMEOUT_MS);
      session.key = key;
      saveResume(key, session);
    }
    try {
      await sendInChunks(session, file, signal, update, offset);
      clearResume(key);
    } catch (error) {
      // Only a long outage keeps the session; cancelling or a hard error ends it.
      if (!error.resumable) {
        clearResume(key);
        abandonSession(session);
      }
      throw error;
    }
  }

  // Best effort: hands the quota back and lets Google drop the session at once.
  function abandonSession(session) {
    fetch('/api/fs/google_drive/upload/cancel', {
      method: 'POST',
      headers: apiHeaders({ 'X-Google-Upload-Token': session.token }),
    }).catch(() => {});
  }

  async function sendInChunks(session, file, signal, update, offset = 0) {
    // Chunks shrink while the connection is poor and grow back once it recovers.
    let chunk = session.chunk_size;
    let clean = 0;
    let failures = 0;
    let failingSince = null; // monotonic time of the first failure since the last progress
    const remember = () => { if (session.key) saveResume(session.key, session); };
    while (offset < file.size) {
      if (signal.aborted) throw cancelled();
      const end = Math.min(offset + chunk, file.size);
      let reason;
      try {
        const result = await sendFile('google_drive/upload/chunk', apiHeaders({
          'X-Google-Upload-Token': session.token,
          'X-Upload-Offset': String(offset),
          'Content-Type': 'application/octet-stream',
        }), file.slice(offset, end), signal, sent => update(offset + sent, '正在传输'));
        if (result.next_offset <= offset) throw new Error('Google Drive 没有保存这一段');
        // Each accepted chunk renews the session token, so slow uploads can run for days.
        if (result.token) { session.token = result.token; remember(); }
        offset = result.next_offset;
        failures = 0;
        failingSince = null;
        if (result.complete) { update(file.size, '已保存'); return; }
        update(offset, '已传至 Google Drive');
        if (++clean >= 3 && chunk < session.chunk_size) {
          chunk = Math.min(session.chunk_size, chunk * 2);
          clean = 0;
        }
        continue;
      } catch (error) {
        if (signal.aborted) throw cancelled();
        if (!retryable(error)) throw error;
        reason = error.message;
      }

      clean = 0;
      failures++;
      if (failingSince === null) failingSince = performance.now();
      if (performance.now() - failingSince > PATIENCE_MS) {
        const error = new Error(`网络持续不可用，上传已暂停（${reason}）。重新选择同一个文件，可从 ${Math.floor(offset / file.size * 100)}% 处继续`);
        error.resumable = true;
        throw error;
      }
      chunk = Math.max(MIN_CHUNK, Math.floor(chunk / 2 / CHUNK_UNIT) * CHUNK_UNIT);
      const wait = RETRY_WAITS[Math.min(failures, RETRY_WAITS.length) - 1];
      update(offset, `正在恢复连接（第 ${failures} 次重试，${wait / 1000} 秒后）：${reason}`);
      await pause(wait, signal);
      // Ask Google what it really has: a lost reply may hide a chunk it stored.
      try {
        const status = await api('google_drive/upload/status', {
          headers: apiHeaders({ 'X-Google-Upload-Token': session.token }),
          signal,
        });
        if (status.token) { session.token = status.token; remember(); }
        if (status.complete) { update(file.size, '已保存'); return; }
        if (status.next_offset > offset) {
          offset = status.next_offset;
          failures = 0;
          failingSince = null;
          update(offset, '已恢复上传');
        }
      } catch (statusError) {
        if (signal.aborted) throw cancelled();
        if (!retryable(statusError)) throw statusError;
      }
    }
    const status = await api('google_drive/upload/status', {
      headers: apiHeaders({ 'X-Google-Upload-Token': session.token }),
      signal,
    });
    if (!status.complete) throw new Error('Google Drive 尚未完成文件上传');
    update(file.size, '已保存');
  }

  function refreshDirectory() {
    const refresh = document.querySelector('.left-toolbar-in [tips="refresh"]');
    refresh?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const mount = currentMount();
    if (mount) quotaCache.delete(mount);
    quotaCache.delete('@folder');
    syncQuota();
  }

  function currentMount() {
    try {
      const name = decodeURIComponent(location.pathname).split('/').filter(Boolean)[0];
      return name ? '/' + name : null;
    }
    catch { return null; }
  }

  function quotaText(bytes) {
    if (bytes === undefined || bytes === null || !/^\d+$/.test(String(bytes))) return null;
    const value = Number(bytes);
    return Number.isFinite(value) ? formatBytes(value) : null;
  }

  function syncQuota() {
    const button = document.getElementById('catsuki-upload-button');
    let card = document.getElementById('catsuki-drive-quota');
    const mount = currentMount();
    if (!button) { card?.remove(); return; }
    const folder = quotaCache.get('@folder');
    // Decide visibility before creating DOM: otherwise the observer repeatedly
    // creates and removes this card at the unrestricted user's root directory.
    if (!mount && folder && !folder.data && Date.now() - folder.time < 5 * 60 * 1000) {
      card?.remove();
      return;
    }
    if (!card) {
      card = document.createElement('section');
      card.id = 'catsuki-drive-quota';
      card.setAttribute('aria-label', 'Google 云盘容量');
      (document.getElementById('catsuki-folder-button') || button).after(card);
    }
    if (!folder || Date.now() - folder.time >= 5 * 60 * 1000) {
      if (card.textContent !== '容量 · 正在读取…') card.textContent = '容量 · 正在读取…';
      if (!quotaPending.has('@folder')) {
        quotaPending.add('@folder');
        api('folder_quota', { headers: apiHeaders() })
          .then(data => quotaCache.set('@folder', { data, time: Date.now() }))
          .catch(() => quotaCache.set('@folder', { error: true, time: Date.now() }))
          .finally(() => { quotaPending.delete('@folder'); syncQuota(); });
      }
      return;
    }
    if (folder.data) {
      const display = `专属文件夹 · 已用 ${quotaText(folder.data.used)} / ${quotaText(folder.data.limit)} · 剩余 ${quotaText(Math.max(0, folder.data.limit - folder.data.used))}`;
      if (card.textContent !== display) card.textContent = display;
      return;
    }
    if (!mount) { card.remove(); return; }
    const cached = quotaCache.get(mount);
    let display = `${mount.slice(1)} 容量 · 正在读取…`;
    if (cached?.error) display = `${mount.slice(1)} 容量暂不可用`;
    else if (cached?.data) {
      const { limit, usage, usageInDrive } = cached.data;
      const used = quotaText(usage);
      const total = quotaText(limit);
      const drive = quotaText(usageInDrive);
      if (used && total) {
        const remaining = BigInt(limit) > BigInt(usage) ? quotaText(String(BigInt(limit) - BigInt(usage))) : '0 B';
        display = `${mount.slice(1)} · 账号已用 ${used} / ${total} · 剩余 ${remaining}`;
      } else display = `${mount.slice(1)} · 账号已用 ${used || '未知'}`;
      if (drive) display += ` · 云盘文件已用 ${drive}`;
    }
    if (card.textContent !== display) card.textContent = display;
    if (cached && Date.now() - cached.time < 5 * 60 * 1000 || quotaPending.has(mount)) return;
    quotaPending.add(mount);
    api(`google_drive/quota?path=${encodeURIComponent(mount)}`, { headers: apiHeaders() })
      .then(data => quotaCache.set(mount, { data, time: Date.now() }))
      .catch(() => quotaCache.set(mount, { error: true, time: Date.now() }))
      .finally(() => { quotaPending.delete(mount); syncQuota(); });
  }

  input.addEventListener('change', () => {
    const files = Array.from(input.files || []);
    input.value = '';
    return startUpload(files);
  });

  async function startUpload(files) {
    if (!files.length || busy || !document.getElementById('catsuki-upload-button')) return;
    busy = true;
    const directory = decodeURIComponent(location.pathname).replace(/\/$/, '');
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const started = performance.now();
    const controller = new AbortController();
    const uploadButton = document.getElementById('catsuki-upload-button');
    if (uploadButton) uploadButton.disabled = true;

    document.getElementById('catsuki-upload-progress')?.remove();
    const panel = document.createElement('section');
    panel.id = 'catsuki-upload-progress';
    panel.setAttribute('role', 'status');
    panel.setAttribute('aria-live', 'polite');
    const title = document.createElement('strong');
    const fileName = document.createElement('div');
    fileName.className = 'catsuki-upload-name';
    const stage = document.createElement('div');
    const fileDetail = document.createElement('div');
    const totalDetail = document.createElement('div');
    const rate = document.createElement('div');
    const progress = document.createElement('progress');
    progress.max = 100;
    progress.value = 0;
    const actions = document.createElement('div');
    actions.className = 'catsuki-upload-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消上传';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '关闭';
    close.hidden = true;
    cancel.addEventListener('click', () => {
      cancel.disabled = true;
      title.textContent = '正在取消';
      controller.abort();
    });
    close.addEventListener('click', () => panel.remove());
    actions.append(cancel, close);
    panel.append(title, fileName, stage, fileDetail, totalDetail, rate, progress, actions);
    document.body.append(panel);

    let finished = 0;
    let finishedBytes = 0;
    let failed = false;
    const showProgress = (file, sent, state) => {
      if (controller.signal.aborted) return;
      const current = Math.min(file.size, sent);
      const overall = finishedBytes + current;
      const percent = totalBytes ? Math.min(99, Math.floor(overall / totalBytes * 100)) : 0;
      const elapsed = Math.max(0.1, (performance.now() - started) / 1000);
      const speed = overall / elapsed;
      title.textContent = `正在上传 · ${finished + 1}/${files.length}`;
      fileName.textContent = file.name;
      stage.textContent = state;
      fileDetail.textContent = `当前文件：${formatBytes(current)} / ${formatBytes(file.size)}`;
      totalDetail.textContent = `总进度：${formatBytes(overall)} / ${formatBytes(totalBytes)}（${percent}%）`;
      rate.textContent = `平均速度：${formatBytes(speed)}/秒 · 预计剩余：${speed > 0 ? formatTime((totalBytes - overall) / speed) : '计算中'}`;
      progress.value = percent;
    };

    try {
      for (const file of files) {
        if (controller.signal.aborted) throw cancelled();
        showProgress(file, 0, '等待开始');
        await uploadFile(directory, file, controller.signal, (sent, state) => showProgress(file, sent, state));
        finished++;
        finishedBytes += file.size;
      }
      title.textContent = '上传完成';
      stage.textContent = `${finished} 个文件已保存到当前目录`;
      totalDetail.textContent = `总计：${formatBytes(totalBytes)}（100%）`;
      rate.textContent = `耗时：${formatTime((performance.now() - started) / 1000)}`;
      progress.value = 100;
      refreshDirectory();
    } catch (error) {
      if (controller.signal.aborted) {
        failed = true;
        title.textContent = '上传已取消';
        stage.textContent = `已停止剩余文件；${finished} 个文件已完成`;
        rate.textContent = '正在发送的最后一段可能已经到达云盘，请刷新目录确认。';
      } else {
        failed = true;
        title.textContent = '上传失败';
        stage.textContent = error.message || String(error);
        rate.textContent = `${finished} 个文件已完成`;
      }
      refreshDirectory();
    } finally {
      busy = false;
      if (uploadButton) uploadButton.disabled = false;
      cancel.hidden = true;
      close.hidden = false;
      if (!failed) setTimeout(() => panel.remove(), 8000);
    }
  }

  addEventListener('beforeunload', event => {
    if (!busy) return;
    event.preventDefault();
    event.returnValue = '';
  });
  // Drop files anywhere on a writable folder page to upload them.
  const hasFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files');
  document.addEventListener('dragover', event => {
    if (hasFiles(event) && document.getElementById('catsuki-upload-button')) event.preventDefault();
  });
  document.addEventListener('drop', event => {
    if (!hasFiles(event) || !document.getElementById('catsuki-upload-button')) return;
    event.preventDefault();
    // Directories drop as empty entries; only plain files are supported.
    startUpload(Array.from(event.dataTransfer.files).filter(file => file.size > 0 || file.type));
  });

  function openPicker() { if (!busy) input.click(); }
  function openFolderDialog() {
    if (document.getElementById('catsuki-folder-dialog')) return;
    const dialog = document.createElement('form');
    dialog.id = 'catsuki-folder-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-label', '新建文件夹');
    const title = document.createElement('strong');
    title.textContent = '新建文件夹';
    const name = document.createElement('input');
    name.placeholder = '文件夹名称';
    name.required = true;
    const error = document.createElement('div');
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => dialog.remove());
    const confirm = document.createElement('button');
    confirm.type = 'submit';
    confirm.textContent = '创建';
    dialog.addEventListener('submit', async event => {
      event.preventDefault();
      const value = name.value.trim();
      if (!value || value === '.' || value === '..' || /[\\/\0]/.test(value)) {
        error.textContent = '请输入有效的文件夹名称';
        return;
      }
      confirm.disabled = true;
      try {
        const directory = decodeURIComponent(location.pathname).replace(/\/$/, '');
        await api('mkdir', {
          method: 'POST',
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ path: `${directory}/${value}` }),
        });
        dialog.remove();
        refreshDirectory();
      } catch (e) {
        error.textContent = e.message || String(e);
        confirm.disabled = false;
      }
    });
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') dialog.remove(); });
    dialog.append(title, name, error, cancel, confirm);
    document.body.append(dialog);
    name.focus();
  }
  function syncUploadButton() {
    const icon = document.querySelector('.catsuki-upload-icon');
    const breadcrumb = document.querySelector('[aria-label="breadcrumb"]');
    let button = document.getElementById('catsuki-upload-button');
    let folderButton = document.getElementById('catsuki-folder-button');
    if (!icon || !breadcrumb) {
      button?.remove(); folderButton?.remove(); document.getElementById('catsuki-drive-quota')?.remove(); return;
    }
    if (!button) {
      button = document.createElement('button');
      button.id = 'catsuki-upload-button';
      button.type = 'button';
      button.textContent = '↑ 上传文件';
      button.addEventListener('click', openPicker);
      breadcrumb.after(button);
    }
    if (!folderButton) {
      folderButton = document.createElement('button');
      folderButton.id = 'catsuki-folder-button';
      folderButton.type = 'button';
      folderButton.textContent = '＋ 新建文件夹';
      folderButton.addEventListener('click', openFolderDialog);
      button.after(folderButton);
    }
    syncQuota();
  }
  addEventListener('DOMContentLoaded', () => {
    // Large directories mutate the DOM constantly; coalesce into one pass per frame.
    let queued = false;
    const schedule = () => {
      if (typeof requestAnimationFrame !== 'function') return syncUploadButton();
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; syncUploadButton(); });
    };
    new MutationObserver(schedule).observe(document.getElementById('root'), { childList: true, subtree: true });
    syncUploadButton();
  });
})();
