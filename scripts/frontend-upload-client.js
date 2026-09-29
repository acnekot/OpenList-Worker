(() => {
  const SMALL_FILE = 8 * 1024 * 1024;
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.hidden = true;
  document.addEventListener('DOMContentLoaded', () => document.body.append(input));

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

  function currentPath(directory, file) {
    return directory + '/' + file.name;
  }

  async function uploadFile(directory, file, update) {
    const path = currentPath(directory, file);
    if (file.size <= SMALL_FILE) {
      await api('put', {
        method: 'PUT',
        headers: apiHeaders({ 'File-Path': encodeURIComponent(path), 'Content-Type': 'application/octet-stream' }),
        body: file,
      });
      update(1);
      return;
    }

    const session = await api('google_drive/upload/start', {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ path, size: file.size, mime_type: file.type || 'application/octet-stream' }),
    });
    let offset = 0;
    while (offset < file.size) {
      const end = Math.min(offset + session.chunk_size, file.size);
      let completed = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const result = await api('google_drive/upload/chunk', {
            method: 'PUT',
            headers: apiHeaders({
              'X-Google-Upload-Token': session.token,
              'X-Upload-Offset': String(offset),
              'Content-Type': 'application/octet-stream',
            }),
            body: file.slice(offset, end),
          });
          if (result.next_offset <= offset) throw new Error('上传进度未前进');
          offset = result.next_offset;
          update(offset / file.size);
          completed = result.complete;
          break;
        } catch (error) {
          if (attempt === 3) throw error;
          const status = await api('google_drive/upload/status', {
            headers: apiHeaders({ 'X-Google-Upload-Token': session.token }),
          });
          if (status.complete) { offset = file.size; completed = true; break; }
          if (status.next_offset > offset) {
            offset = status.next_offset;
            update(offset / file.size);
            break;
          }
        }
      }
      if (completed) return;
    }
    const status = await api('google_drive/upload/status', {
      headers: apiHeaders({ 'X-Google-Upload-Token': session.token }),
    });
    if (!status.complete) throw new Error('Google Drive 尚未完成文件上传');
  }

  input.addEventListener('change', async () => {
    const files = Array.from(input.files || []);
    input.value = '';
    if (!files.length) return;
    const directory = decodeURIComponent(location.pathname).replace(/\/$/, '');

    const panel = document.createElement('section');
    panel.id = 'catsuki-upload-progress';
    panel.setAttribute('role', 'status');
    const title = document.createElement('strong');
    title.textContent = '正在上传';
    const detail = document.createElement('div');
    const progress = document.createElement('progress');
    progress.max = 100;
    progress.value = 0;
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '关闭';
    close.hidden = true;
    close.addEventListener('click', () => panel.remove());
    panel.append(title, detail, progress, close);
    document.body.append(panel);

    let finished = 0;
    try {
      for (const file of files) {
        detail.textContent = file.name;
        await uploadFile(directory, file, fraction => {
          progress.value = Math.round((finished + fraction) / files.length * 100);
        });
        finished++;
      }
      title.textContent = '上传完成';
      detail.textContent = `${files.length} 个文件已上传到当前目录`;
      progress.value = 100;
      close.hidden = false;
      const refresh = document.querySelector('.left-toolbar-in [tips="refresh"]');
      refresh?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    } catch (error) {
      title.textContent = '上传失败';
      detail.textContent = error.message || String(error);
      close.hidden = false;
    }
  });

  function openPicker() { input.click(); }
  function syncUploadButton() {
    const icon = document.querySelector('.catsuki-upload-icon');
    const breadcrumb = document.querySelector('[aria-label="breadcrumb"]');
    let button = document.getElementById('catsuki-upload-button');
    if (!icon || !breadcrumb) { button?.remove(); return; }
    if (!button) {
      button = document.createElement('button');
      button.id = 'catsuki-upload-button';
      button.type = 'button';
      button.textContent = '↑ 上传文件';
      button.addEventListener('click', openPicker);
      breadcrumb.after(button);
    }
  }
  addEventListener('DOMContentLoaded', () => {
    new MutationObserver(syncUploadButton).observe(document.getElementById('root'), { childList: true, subtree: true });
    syncUploadButton();
  });
})();
