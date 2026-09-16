let templates = [];
let apiConfig = null;

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

// ---------- AI 生成模版 ----------

const GEN_PROMPT =
  '你是一个提示词（prompt）模版生成助手。用户会描述一个模版的用途，' +
  '这个模版将被用于「网页划词/截图后向大模型提问」时追加到选中文本之后，' +
  '所以模版内容应该把划词内容当作「以上内容/所选内容」来指代。\n' +
  '请根据用户的需求写出一条可以直接使用的提示词模版，要求：\n' +
  '1. 只输出模版正文本身，不要任何解释、前言、引号或 Markdown 代码块；\n' +
  '2. 简洁明确，一两句话即可，可包含必要的格式要求；\n' +
  '3. 用中文书写（除非用户明确要求其他语言）。';

function apiConfigFromInputs() {
  return {
    baseUrl: document.getElementById('api-base').value.trim().replace(/\/+$/, ''),
    apiKey: document.getElementById('api-key').value.trim(),
    model: document.getElementById('api-model').value.trim(),
  };
}

function setApiStatus(text, cls) {
  const el = document.getElementById('api-status');
  el.textContent = text;
  el.classList.remove('ok', 'warn');
  if (cls) el.classList.add(cls);
}

/** 运行时向用户申请 API 域名的访问权限（MV3 跨域请求需要）。 */
async function ensureOriginPermission(baseUrl) {
  let origin;
  try {
    origin = new URL(baseUrl).origin + '/*';
  } catch {
    return 'invalid';
  }
  const opts = { origins: [origin] };
  if (await chrome.permissions.contains(opts)) return true;
  return chrome.permissions.request(opts);
}

async function callApi(api, messages) {
  const res = await fetch(`${api.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${api.apiKey}`,
    },
    body: JSON.stringify({ model: api.model, messages, temperature: 0.7, stream: false }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('接口返回内容为空');
  // 去掉可能被模型包上的 Markdown 代码块
  return text.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/i, '').trim();
}

async function saveApiConfig() {
  const api = apiConfigFromInputs();
  if (!api.baseUrl || !api.apiKey || !api.model) {
    setApiStatus('请填写完整的 API 地址、Key 和模型名称', 'warn');
    return;
  }
  const granted = await ensureOriginPermission(api.baseUrl);
  if (granted === 'invalid') {
    setApiStatus('API 地址格式不正确', 'warn');
    return;
  }
  if (!granted) {
    setApiStatus('未授权访问该 API 域名，无法保存', 'warn');
    return;
  }
  const settings = await DataStore.getSettings();
  settings.apiConfig = api;
  await DataStore.saveSettings(settings);
  apiConfig = api; // 同步内存缓存，生成时无需重开页面
  setApiStatus('API 配置已保存', 'ok');
}

async function testApi() {
  const api = apiConfigFromInputs();
  if (!api.baseUrl || !api.apiKey || !api.model) {
    setApiStatus('请先填写完整配置', 'warn');
    return;
  }
  setApiStatus('测试中…');
  try {
    await callApi(api, [{ role: 'user', content: '回复"ok"' }]);
    setApiStatus('连接成功', 'ok');
  } catch (e) {
    setApiStatus(`连接失败：${e.message}`, 'warn');
  }
}

function getSavedApi() {
  return apiConfig; // 缓存于页面加载时
}

async function generateTemplate() {
  const req = document.getElementById('gen-requirement').value.trim();
  const err = document.getElementById('gen-error');
  err.classList.add('hidden');
  if (!req) {
    err.textContent = '请先填写模版需求描述';
    err.classList.remove('hidden');
    return;
  }
  const api = getSavedApi();
  if (!api) {
    setApiStatus('请先保存 API 配置', 'warn');
    return;
  }

  const btn = document.getElementById('gen-btn');
  btn.disabled = true;
  btn.textContent = '生成中…';
  try {
    const content = await callApi(api, [
      { role: 'system', content: GEN_PROMPT },
      { role: 'user', content: req },
    ]);
    // 生成结果进入人工编辑区
    document.getElementById('gen-content').value = content;
    if (!document.getElementById('gen-title').value) {
      document.getElementById('gen-title').value = req.slice(0, 12);
    }
    document.getElementById('gen-result').classList.remove('hidden');
    document.getElementById('gen-title').focus();
  } catch (e) {
    err.textContent = `生成失败：${e.message}`;
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'AI 生成';
  }
}

async function saveGeneratedTemplate() {
  const title = document.getElementById('gen-title').value.trim();
  const content = document.getElementById('gen-content').value.trim();
  const err = document.getElementById('gen-error');
  err.classList.add('hidden');

  if (!title || !content) {
    err.textContent = '模版名称和内容不能为空';
    err.classList.remove('hidden');
    return;
  }
  if (templates.some((t) => t.title === title)) {
    err.textContent = '已存在同名模版，请修改名称';
    err.classList.remove('hidden');
    return;
  }

  templates.unshift({
    id: crypto.randomUUID(),
    title,
    content,
    updatedAt: Date.now(),
  });
  await DataStore.saveTemplates(templates);
  renderTemplates();
  document.getElementById('gen-result').classList.add('hidden');
  document.getElementById('gen-title').value = '';
  document.getElementById('gen-content').value = '';
  document.getElementById('gen-requirement').value = '';
  toast('模版已保存');
}

// ---------- 入口 ----------

document.addEventListener('DOMContentLoaded', async () => {
  await DataStore.init();

  templates = await DataStore.getTemplates();
  renderTemplates();
  await renderHistory();
  await refreshDirStatus();

  // AI 生成模版：载入已保存的 API 配置
  const settings = await DataStore.getSettings();
  apiConfig = settings.apiConfig || null;
  if (apiConfig) {
    document.getElementById('api-base').value = apiConfig.baseUrl || '';
    document.getElementById('api-key').value = apiConfig.apiKey || '';
    document.getElementById('api-model').value = apiConfig.model || '';
    setApiStatus(`已配置：${apiConfig.model || '未命名模型'}`, 'ok');
  }
  document.getElementById('api-save-btn').addEventListener('click', saveApiConfig);
  document.getElementById('api-test-btn').addEventListener('click', testApi);
  document.getElementById('gen-btn').addEventListener('click', generateTemplate);
  document.getElementById('gen-save-btn').addEventListener('click', saveGeneratedTemplate);
  document.getElementById('gen-discard-btn').addEventListener('click', () => {
    document.getElementById('gen-result').classList.add('hidden');
  });

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
