let templates = [];

// ---------- 通用 ----------

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.add('hidden'), 2000);
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------- 模版管理 ----------

function renderTemplates() {
  const list = document.getElementById('template-list');
  const empty = document.getElementById('template-empty');
  list.innerHTML = '';
  empty.classList.toggle('hidden', templates.length > 0);

  for (const tpl of templates) {
    const item = document.createElement('div');
    item.className = 'template-item';

    // 标题行
    const row = document.createElement('div');
    row.className = 'row';
    const titleInput = document.createElement('input');
    titleInput.className = 'template-title-input';
    titleInput.value = tpl.title;
    titleInput.placeholder = '模版名称';
    row.appendChild(titleInput);
    item.appendChild(row);

    // 内容
    const contentInput = document.createElement('textarea');
    contentInput.className = 'template-content-input';
    contentInput.rows = 3;
    contentInput.value = tpl.content;
    contentInput.placeholder = '模版内容';
    item.appendChild(contentInput);

    // 错误提示
    const err = document.createElement('p');
    err.className = 'error-text hidden';
    item.appendChild(err);

    // 操作按钮
    const actions = document.createElement('div');
    actions.className = 'actions';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'small-primary';
    saveBtn.textContent = '保存';
    saveBtn.onclick = async () => {
      const title = titleInput.value.trim();
      const content = contentInput.value.trim();
      if (!title) {
        err.textContent = '请输入模版名称';
        err.classList.remove('hidden');
        return;
      }
      if (!content) {
        err.textContent = '请输入模版内容';
        err.classList.remove('hidden');
        return;
      }
      if (templates.some((t) => t.id !== tpl.id && t.title === title)) {
        err.textContent = '已存在同名模版，请修改名称';
        err.classList.remove('hidden');
        titleInput.focus();
        return;
      }
      err.classList.add('hidden');
      tpl.title = title;
      tpl.content = content;
      tpl.updatedAt = Date.now();
      await DataStore.saveTemplates(templates);
      toast('已保存');
    };

    const delBtn = document.createElement('button');
    delBtn.className = 'link-btn danger';
    delBtn.textContent = '删除';
    delBtn.onclick = async () => {
      templates = templates.filter((t) => t.id !== tpl.id);
      await DataStore.saveTemplates(templates);
      renderTemplates();
      toast('已删除');
    };

    actions.appendChild(saveBtn);
    actions.appendChild(delBtn);
    item.appendChild(actions);
    list.appendChild(item);
  }
}

// ---------- 提问记录 ----------

async function renderHistory() {
  const list = document.getElementById('history-list');
  const empty = document.getElementById('history-empty');
  const history = (await DataStore.getHistory()).slice().reverse();
  list.innerHTML = '';
  empty.classList.toggle('hidden', history.length > 0);

  for (const h of history.slice(0, 100)) {
    const item = document.createElement('div');
    item.className = 'history-item';

    const meta = document.createElement('div');
    meta.className = 'history-meta';
    const tag = document.createElement('span');
    tag.className = 'model-tag';
    tag.textContent = h.modelName || h.modelId || '未知模型';
    meta.appendChild(tag);
    meta.appendChild(document.createTextNode(fmtTime(h.ts)));
    item.appendChild(meta);

    const text = document.createElement('div');
    text.className = 'history-text';
    text.textContent = h.finalText || '';
    item.appendChild(text);

    list.appendChild(item);
  }
}

// ---------- 数据目录 ----------

async function refreshDirStatus() {
  const statusEl = document.getElementById('dir-status');
  const syncBtn = document.getElementById('sync-now-btn');
  const forgetBtn = document.getElementById('forget-dir-btn');
  const status = await DataStore.dirStatus();
  const settings = await DataStore.getSettings();

  statusEl.classList.remove('ok', 'warn');
  if (status === 'connected') {
    statusEl.textContent = `已关联：${settings.dataDirName || '本地目录'}`;
    statusEl.classList.add('ok');
    syncBtn.classList.remove('hidden');
    forgetBtn.classList.remove('hidden');
  } else if (status === 'need-permission') {
    statusEl.textContent = `目录「${settings.dataDirName || ''}」需要重新授权，请重新选择`;
    statusEl.classList.add('warn');
    syncBtn.classList.add('hidden');
    forgetBtn.classList.remove('hidden');
  } else {
    statusEl.textContent = '未设置（数据仅保存在浏览器扩展存储中）';
    syncBtn.classList.add('hidden');
    forgetBtn.classList.add('hidden');
  }
}

async function pickDir() {
  try {
    const name = await DataStore.pickDataDir();
    await DataStore.loadFromDisk();
    templates = await DataStore.getTemplates();
    renderTemplates();
    await renderHistory();
    await refreshDirStatus();
    toast(`已关联目录：${name}`);
  } catch {
    // 用户取消选择，不提示
  }
}

// ---------- 导入 / 导出 ----------

async function exportJson() {
  const data = {
    templates: await DataStore.getTemplates(),
    history: await DataStore.getHistory(),
    exportedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ai-ask-backup-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importJson(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result);
      if (Array.isArray(data.templates)) {
        const map = new Map();
        for (const t of await DataStore.getTemplates()) map.set(t.id, t);
        for (const t of data.templates) {
          if (t && t.id && t.title && t.content) map.set(t.id, t);
        }
        templates = [...map.values()];
        await DataStore.saveTemplates(templates);
        renderTemplates();
      }
      if (Array.isArray(data.history)) {
        const map = new Map();
        for (const h of await DataStore.getHistory()) map.set(h.id, h);
        for (const h of data.history) {
          if (h && h.id) map.set(h.id, h);
        }
        await DataStore.saveHistory([...map.values()]);
        await renderHistory();
      }
      toast('导入完成');
    } catch {
      toast('导入失败：文件格式不正确');
    }
  };
  reader.readAsText(file);
}

// ---------- 入口 ----------

document.addEventListener('DOMContentLoaded', async () => {
  await DataStore.init();

  templates = await DataStore.getTemplates();
  renderTemplates();
  await renderHistory();
  await refreshDirStatus();

  document.getElementById('add-template-btn').addEventListener('click', async () => {
    templates.unshift({
      id: crypto.randomUUID(),
      title: '',
      content: '',
      updatedAt: Date.now(),
    });
    renderTemplates();
    const first = document.querySelector('.template-title-input');
    if (first) first.focus();
  });

  document.getElementById('pick-dir-btn').addEventListener('click', pickDir);

  document.getElementById('sync-now-btn').addEventListener('click', async () => {
    const ok = await DataStore.syncToDisk();
    toast(ok ? '已同步到本地目录' : '同步失败，请重新选择目录');
  });

  document.getElementById('forget-dir-btn').addEventListener('click', async () => {
    await DataStore.forgetDataDir();
    await refreshDirStatus();
    toast('已取消关联（已生成的文件不会被删除）');
  });

  document.getElementById('clear-history-btn').addEventListener('click', async () => {
    await DataStore.clearHistory();
    await renderHistory();
    toast('已清空');
  });

  document.getElementById('export-btn').addEventListener('click', exportJson);

  const importFile = document.getElementById('import-file');
  document.getElementById('import-btn').addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', () => {
    if (importFile.files[0]) importJson(importFile.files[0]);
    importFile.value = '';
  });
});
