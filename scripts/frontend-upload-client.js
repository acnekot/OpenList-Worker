(() => {
  const SMALL_FILE = 8 * 1024 * 1024;
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

  async function api(url, options = {}) {
    const response = await fetch('/api/fs/' + url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.code !== 200) {
      throw new Error(data.message || `上传失败 (HTTP ${response.status})`);
    }
    return data.data;
  }

  // XHR exposes upload progress and aborts the current request immediately.
  function sendFile(url, headers, body, signal, onProgress) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(cancelled());
      const xhr = new XMLHttpRequest();
      const abort = () => xhr.abort();
      const cleanup = () => signal.removeEventListener('abort', abort);
      xhr.open('PUT', '/api/fs/' + url);
      for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
      xhr.upload.onprogress = event => onProgress(Math.min(event.loaded, body.size));
      xhr.onload = () => {
        cleanup();
        let data;
        try { data = JSON.parse(xhr.responseText); } catch { data = {}; }
        if (xhr.status >= 200 && xhr.status < 300 && data.code === 200) resolve(data.data);
        else reject(new Error(data.message || `上传失败 (HTTP ${xhr.status})`));
      };
      xhr.onerror = () => { cleanup(); reject(new Error('网络连接中断')); };
      xhr.onabort = () => { cleanup(); reject(cancelled()); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) return abort();
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

    update(0, '正在连接 Google Drive');
    const session = await api('google_drive/upload/start', {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ path, size: file.size, mime_type: file.type || 'application/octet-stream' }),
      signal,
    });
    let offset = 0;
    while (offset < file.size) {
      if (signal.aborted) throw cancelled();
      const end = Math.min(offset + session.chunk_size, file.size);
      let completed = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const result = await sendFile('google_drive/upload/chunk', apiHeaders({
            'X-Google-Upload-Token': session.token,
            'X-Upload-Offset': String(offset),
            'Content-Type': 'application/octet-stream',
          }), file.slice(offset, end), signal, sent => update(offset + sent, '正在传输'));
          if (result.next_offset <= offset) throw new Error('上传进度未前进');
          offset = result.next_offset;
          update(offset, '已传至 Google Drive');
          completed = result.complete;
          break;
        } catch (error) {
          if (signal.aborted) throw cancelled();
          if (attempt === 3) throw error;
          update(offset, '正在恢复连接');
          const status = await api('google_drive/upload/status', {
            headers: apiHeaders({ 'X-Google-Upload-Token': session.token }),
            signal,
          });
          if (status.complete) { offset = file.size; completed = true; break; }
          if (status.next_offset > offset) {
            offset = status.next_offset;
            update(offset, '已恢复上传');
            break;
          }
        }
      }
      if (completed) { update(file.size, '已保存'); return; }
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
    if (mount) {
      quotaCache.delete(mount);
      syncQuota();
    }
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
    if (!button || !mount) { card?.remove(); return; }
    if (!card) {
      card = document.createElement('section');
      card.id = 'catsuki-drive-quota';
      card.setAttribute('aria-label', 'Google 云盘容量');
      button.after(card);
    }
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

  input.addEventListener('change', async () => {
    const files = Array.from(input.files || []);
    input.value = '';
    if (!files.length || busy) return;
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
        title.textContent = '上传已取消';
        stage.textContent = `已停止剩余文件；${finished} 个文件已完成`;
        rate.textContent = '正在发送的最后一段可能已经到达云盘，请刷新目录确认。';
      } else {
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
    }
  });

  function openPicker() { if (!busy) input.click(); }
  function syncUploadButton() {
    const icon = document.querySelector('.catsuki-upload-icon');
    const breadcrumb = document.querySelector('[aria-label="breadcrumb"]');
    let button = document.getElementById('catsuki-upload-button');
    if (!icon || !breadcrumb) { button?.remove(); document.getElementById('catsuki-drive-quota')?.remove(); return; }
    if (!button) {
      button = document.createElement('button');
      button.id = 'catsuki-upload-button';
      button.type = 'button';
      button.textContent = '↑ 上传文件';
      button.addEventListener('click', openPicker);
      breadcrumb.after(button);
    }
    syncQuota();
  }
  addEventListener('DOMContentLoaded', () => {
    new MutationObserver(syncUploadButton).observe(document.getElementById('root'), { childList: true, subtree: true });
    syncUploadButton();
  });
})();
