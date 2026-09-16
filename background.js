importScripts('models.js');

const MENU_ID = 'ask-ai';
const FILL_TTL = 120000; // pendingFill 超过 2 分钟视为过期

// content script 默认无权访问 storage.session，需要放开（消息通道为主，此为兜底）
chrome.storage.session.setAccessLevel({
  accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
});

function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: '用 AI 提问：%s',
      contexts: ['selection'],
    });
  });
}

chrome.runtime.onInstalled.addListener(setupMenus);
if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(setupMenus);
}

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId !== MENU_ID) return;

  const selectedText = (info.selectionText || '').trim();
  if (!selectedText) return;

  // 把选中文本交给 compose 窗口（模型在弹窗中选择）
  chrome.storage.session.set(
    { compose: { selectedText, ts: Date.now() } },
    () => {
      chrome.windows.create({
        url: chrome.runtime.getURL('compose.html'),
        type: 'popup',
        width: 580,
        height: 720,
        focused: true,
      });
    }
  );
});

// ---------- 快捷键截图提问 ----------

async function openComposeWindow() {
  return chrome.windows.create({
    url: chrome.runtime.getURL('compose.html'),
    type: 'popup',
    width: 580,
    height: 720,
    focused: true,
  });
}

function openComposeWith(screenshotDataUrl) {
  chrome.storage.session.set(
    { compose: { selectedText: '', screenshot: screenshotDataUrl, ts: Date.now() } },
    () => openComposeWindow()
  );
}

async function handleScreenshotCommand() {
  // 快捷键触发时取最后聚焦窗口的激活标签页（activeTab 已随快捷键授予）。
  // 不用 getLastFocused + windowTypes 过滤：焦点在 popup/devtools 上时会取不到普通窗口。
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs && tabs[0];
  if (!tab || !/^https?:/i.test(tab.url || '')) {
    console.warn('[AI划词] 截图提问仅支持普通网页');
    return;
  }

  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch (e) {
    console.error('[AI划词] 截图失败', e);
    return;
  }

  // 注入框选遮罩（已注入过则幂等），再通知其开始框选
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/capture.js'],
    });
    await chrome.tabs.sendMessage(tab.id, { type: 'start-capture', dataUrl });
  } catch (e) {
    console.error('[AI划词] 框选层注入失败', e);
  }
}

// 快捷键：截图提问
chrome.commands.onCommand.addListener((command) => {
  if (command === 'screenshot-ask') handleScreenshotCommand();
});

// ---------- 消息处理 ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  // 框选完成：写入截图并弹起 compose 窗口
  if (msg.type === 'captureCropDone' && msg.dataUrl) {
    openComposeWith(msg.dataUrl);
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'captureCanceled') {
    console.info('[AI划词] 截图框选已取消');
    sendResponse({ ok: true });
    return;
  }

  // compose 窗口：请求打开模型页面
  if (msg.type === 'openModelTab') {
    handleOpenModelTab(msg.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error('[AI划词] openModelTab 失败', err);
        sendResponse({ ok: false, error: String(err) });
      });
    return true; // 异步响应
  }

  // content script：取走属于本域名的待填充内容
  if (msg.type === 'consumePendingFill') {
    handleConsume(msg.host)
      .then((payload) => sendResponse(payload || null))
      .catch(() => sendResponse(null));
    return true;
  }
});

async function handleOpenModelTab(payload) {
  const model = payload && MODELS[payload.modelId];
  if (!model || (!payload.text && !payload.imageDataUrl)) return;

  // 待填充内容入队（支持后台模式连续提问多个问题/模型），再开页面
  const { pendingQueue = [] } = await chrome.storage.session.get('pendingQueue');
  pendingQueue.push({
    host: model.host,
    modelId: model.id,
    text: payload.text || '',
    imageDataUrl: payload.imageDataUrl || null,
    autoSend: !!payload.autoSend,
    ts: Date.now(),
  });
  await chrome.storage.session.set({ pendingQueue: pendingQueue.slice(-20) });

  // 强制在「正常窗口」中打开，避免标签页被开进 popup 小窗后随窗口关闭
  // foreground=false 时后台静默打开（不激活标签、不聚焦窗口），便于批量提问后统一查看
  const foreground = payload.foreground !== false;
  const normalWins = await chrome.windows.getAll({ windowTypes: ['normal'] });
  const target = normalWins.find((w) => w.focused) || normalWins[0];

  if (target) {
    await chrome.tabs.create({ windowId: target.id, url: model.url, active: foreground });
    if (foreground) {
      await chrome.windows.update(target.id, { focused: true });
    }
  } else {
    await chrome.windows.create({ url: model.url, type: 'normal', focused: foreground });
  }
  console.info('[AI划词] 已打开模型页面：', model.name, foreground ? '（前台）' : '（后台）');
}

async function handleConsume(host) {
  const { pendingQueue = [] } = await chrome.storage.session.get('pendingQueue');
  const now = Date.now();

  // 取该域名最早一条未过期内容（先进先出，与开页顺序一致）
  const idx = pendingQueue.findIndex(
    (p) => p.host === host && (p.text || p.imageDataUrl) && now - p.ts < FILL_TTL
  );
  if (idx === -1) return null;

  const [payload] = pendingQueue.splice(idx, 1);
  await chrome.storage.session.set({ pendingQueue });
  console.info('[AI划词] 待填充内容已被页面取走：', host, '剩余队列', pendingQueue.length);
  return payload;
}
