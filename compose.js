let currentModelId = null;
let templates = [];

// ---------- 模型 ----------

function renderModels() {
  const list = document.getElementById('model-list');
  list.innerHTML = '';
  for (const m of Object.values(MODELS)) {
    const btn = document.createElement('button');
    btn.className = 'model-item' + (m.id === currentModelId ? ' active' : '');
    btn.textContent = m.name;
    btn.type = 'button';
    btn.onclick = () => {
      currentModelId = m.id;
      renderModels();
    };
    list.appendChild(btn);
  }
}

// ---------- 模版（平铺标签，最近/高频使用排前面） ----------

function sortedTemplates() {
  return [...templates].sort(
    (a, b) =>
      (b.lastUsedAt || 0) - (a.lastUsedAt || 0) ||
      (b.useCount || 0) - (a.useCount || 0)
  );
}

function renderTemplateChips() {
  const box = document.getElementById('template-chips');
  box.innerHTML = '';
  const list = sortedTemplates();

  if (!list.length) {
    const empty = document.createElement('span');
    empty.className = 'template-chips-empty';
    empty.textContent = '暂无模版，可在「管理模版」中创建';
    box.appendChild(empty);
    return;
  }

  for (const t of list) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'template-chip' + ((t.useCount || 0) > 0 ? ' hot' : '');
    chip.title = t.content;

    const name = document.createElement('span');
    name.textContent = t.title;
    chip.appendChild(name);

    if (t.useCount) {
      const count = document.createElement('span');
      count.className = 'use-count';
      count.textContent = t.useCount;
      chip.appendChild(count);
    }

    chip.onclick = () => applyTemplate(t.id);
    box.appendChild(chip);
  }
}

async function applyTemplate(id) {
  const tpl = templates.find((t) => t.id === id);
  if (!tpl) return;
  const box = document.getElementById('extra-prompt');
  const cur = box.value.trim();
  box.value = cur ? `${cur}\n\n${tpl.content}` : tpl.content;
  box.focus();

  // 记录使用情况（影响下次打开时的排序与角标，当前顺序不打乱）
  tpl.useCount = (tpl.useCount || 0) + 1;
  tpl.lastUsedAt = Date.now();
  DataStore.markTemplateUsed(id);
}

// ---------- 存为模版 ----------

function openSaveDialog() {
  const content = document.getElementById('extra-prompt').value.trim();
  if (!content) return;
  const dialog = document.getElementById('save-dialog');
  const input = document.getElementById('template-title-input');
  const err = document.getElementById('save-dialog-error');
  err.classList.add('hidden');
  input.value = content.slice(0, 12);
  dialog.classList.remove('hidden');
  input.focus();
  input.select();
}

function closeSaveDialog() {
  document.getElementById('save-dialog').classList.add('hidden');
}

async function confirmSaveTemplate() {
  const content = document.getElementById('extra-prompt').value.trim();
  const input = document.getElementById('template-title-input');
  const err = document.getElementById('save-dialog-error');
  const title = input.value.trim();

  if (!content) {
    closeSaveDialog();
    return;
  }
  if (!title) {
    err.textContent = '请输入模版名称';
    err.classList.remove('hidden');
    return;
  }
  if (templates.some((t) => t.title === title)) {
    err.textContent = '已存在同名模版，请修改名称';
    err.classList.remove('hidden');
    input.focus();
    input.select();
    return;
  }

  templates.push({
    id: crypto.randomUUID(),
    title,
    content,
    updatedAt: Date.now(),
    useCount: 0,
    lastUsedAt: 0,
  });
  await DataStore.saveTemplates(templates);
  renderTemplateChips();
  closeSaveDialog();
}

// ---------- 发送 ----------

let currentScreenshot = null;

function buildFinalText() {
  const selected = document.getElementById('selected-text').value.trim();
  const extra = document.getElementById('extra-prompt').value.trim();
  return { selected, extra, finalText: extra ? `${selected}\n\n${extra}` : selected };
}

async function send() {
  const model = MODELS[currentModelId];
  const { selected, extra, finalText } = buildFinalText();
  if (!model || (!finalText && !currentScreenshot)) return;

  const autoSend = document.getElementById('auto-send').checked;
  const jumpToTab = document.getElementById('jump-to-tab').checked;
  const sendBtn = document.getElementById('send-btn');
  sendBtn.disabled = true;

  // 记住本次选择，下次默认沿用
  const settings = await DataStore.getSettings();
  settings.lastModelId = model.id;
  settings.jumpToTab = jumpToTab;
  await DataStore.saveSettings(settings);

  // 记录提问历史（不存图片本体，避免本地同步文件膨胀）
  await DataStore.addHistory({
    modelId: model.id,
    modelName: model.name,
    selectedText: selected,
    extraPrompt: extra,
    finalText,
    autoSend,
    hasImage: !!currentScreenshot,
  });

  // 由后台服务线程在「正常窗口」中打开模型页面，
  // 避免标签页被开进本 popup 小窗并随窗口一起关闭
  await chrome.runtime.sendMessage({
    type: 'openModelTab',
    payload: {
      modelId: model.id,
      text: finalText,
      imageDataUrl: currentScreenshot,
      autoSend,
      foreground: jumpToTab,
    },
  });
  window.close();
}

// ---------- 数据目录提示 ----------

async function refreshDirHint() {
  const hint = document.getElementById('dir-hint');
  const status = await DataStore.dirStatus();
  if (status === 'connected') {
    const settings = await DataStore.getSettings();
    hint.textContent = `模版和提问记录已同步到本地目录：${settings.dataDirName || ''}`;
    hint.classList.remove('hidden');
  } else if (status === 'need-permission') {
    hint.textContent = '本地数据目录需要重新授权，请到「管理模版」页处理。';
    hint.classList.remove('hidden');
  }
}

// ---------- 入口 ----------

document.addEventListener('DOMContentLoaded', async () => {
  await DataStore.init();

  const [{ compose }, settings] = await Promise.all([
    chrome.storage.session.get('compose'),
    DataStore.getSettings(),
  ]);

  // 模型：优先上次使用，其次第一个
  currentModelId =
    settings.lastModelId && MODELS[settings.lastModelId]
      ? settings.lastModelId
      : Object.keys(MODELS)[0];
  renderModels();

  // 模版
  templates = await DataStore.getTemplates();
  renderTemplateChips();

  document.getElementById('selected-text').value =
    (compose && compose.selectedText) || '';

  // 截图附件（快捷键截图提问时传入）
  currentScreenshot = (compose && compose.screenshot) || null;
  const preview = document.getElementById('screenshot-preview');
  if (currentScreenshot) {
    document.getElementById('screenshot-img').src = currentScreenshot;
    preview.classList.remove('hidden');
  }
  document.getElementById('screenshot-remove').addEventListener('click', () => {
    currentScreenshot = null;
    preview.classList.add('hidden');
  });

  // 恢复「发送后跳转」偏好（默认跳转）
  document.getElementById('jump-to-tab').checked = settings.jumpToTab !== false;

  // 事件绑定
  document.getElementById('send-btn').addEventListener('click', send);

  document.getElementById('save-template-btn').addEventListener('click', openSaveDialog);
  document.getElementById('save-dialog-ok').addEventListener('click', confirmSaveTemplate);
  document.getElementById('save-dialog-cancel').addEventListener('click', closeSaveDialog);
  document.getElementById('template-title-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmSaveTemplate();
    if (e.key === 'Escape') closeSaveDialog();
  });

  document.getElementById('manage-template-btn').addEventListener('click', () => {
    chrome.windows.create({
      url: chrome.runtime.getURL('manage.html'),
      type: 'popup',
      width: 760,
      height: 720,
      focused: true,
    });
  });

  // Cmd/Ctrl + Enter 快捷发送
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      send();
    }
  });

  refreshDirHint();
  document.getElementById('extra-prompt').focus();
});
