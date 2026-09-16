// 在各大模型网页版中等待输入框出现，填入问题文本，可选自动发送。
// 数据通道：优先通过消息向后台取（可靠，不受存储权限影响），
// 失败后回退直接读 storage.session。
// 站点输入框为 SPA 动态渲染，采用「多选择器 + 轮询」提高兼容性。

const SITE_CONFIG = {
  'chatgpt.com': {
    inputSelectors: ['#prompt-textarea', 'div[contenteditable="true"]'],
    sendSelectors: [
      'button[data-testid="send-button"]',
      'button#composer-submit-button',
      'button[aria-label*="Send"]',
      'button[aria-label*="发送"]',
    ],
  },
  'chat.deepseek.com': {
    inputSelectors: ['#chat-input', 'textarea'],
    sendSelectors: ['div[role="button"][aria-disabled="false"]'],
  },
  'gemini.google.com': {
    inputSelectors: ['.ql-editor', 'rich-textarea div[contenteditable="true"]', 'div[contenteditable="true"]'],
    sendSelectors: [
      'button.send-button',
      'button[aria-label*="Send"]',
      'button[aria-label*="发送"]',
    ],
  },
  'www.doubao.com': {
    inputSelectors: ['textarea[data-testid="chat_input_input"]', 'textarea', 'div[contenteditable="true"]'],
    sendSelectors: [
      'button[data-testid="chat_input_send_button"]',
      'button[aria-label*="发送"]',
    ],
  },
};

const POLL_INTERVAL = 500;
const POLL_TIMEOUT = 60000; // 登录跳转等场景下最长等 60s

function log(...args) {
  console.info('[AI划词]', ...args);
}

function findFirst(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function fillTextarea(el, text) {
  el.focus();
  el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function fillContentEditable(el, text) {
  el.focus();
  // execCommand 的 insertText 能被 ProseMirror / Quill 等编辑器识别
  const ok = document.execCommand('insertText', false, text);
  if (!ok || !el.innerText.trim()) {
    el.innerText = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }
}

function fillInput(el, text) {
  // 按元素实际类型选择填充方式，不依赖站点配置
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    fillTextarea(el, text);
  } else {
    fillContentEditable(el, text);
  }
}

function pressEnter(el) {
  const opts = {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
    bubbles: true,
    cancelable: true,
  };
  el.dispatchEvent(new KeyboardEvent('keydown', opts));
  el.dispatchEvent(new KeyboardEvent('keypress', opts));
  el.dispatchEvent(new KeyboardEvent('keyup', opts));
}

// ---------- 图片粘贴上传 ----------

function dataUrlToFile(dataUrl, name) {
  const [head, b64] = dataUrl.split(',');
  const mime = (head.match(/data:([^;]+)/) || [, 'image/png'])[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new File([arr], name, { type: mime });
}

/** 向输入框模拟粘贴图片（各模型网页版把 paste 事件当作上传附件处理）。 */
function pasteImage(el, dataUrl) {
  try {
    el.focus();
    const file = dataUrlToFile(dataUrl, 'screenshot.png');
    const dt = new DataTransfer();
    dt.items.add(file);
    const ev = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    });
    el.dispatchEvent(ev);
    log('已派发图片粘贴事件：', file.size, '字节');
    return true;
  } catch (e) {
    log('图片粘贴失败：', e);
    return false;
  }
}

function trySend(config, inputEl) {
  const btn = findFirst(config.sendSelectors);
  if (btn && !btn.disabled) {
    btn.click();
    log('已点击发送按钮');
    return;
  }
  // 回退：对输入框派发回车键（大多数聊天框 Enter 即发送）
  pressEnter(inputEl);
  log('未找到发送按钮，已派发 Enter 键');
}

/** 向后台取待填充内容（消息通道）；失败则回退直接读 storage.session 队列。 */
function hasContent(p) {
  return p && (p.text || p.imageDataUrl);
}

async function fetchPayload(host) {
  try {
    const payload = await chrome.runtime.sendMessage({ type: 'consumePendingFill', host });
    if (hasContent(payload)) return payload;
    return null;
  } catch (e) {
    // 后台不可达时回退
  }
  try {
    const { pendingQueue = [] } = await chrome.storage.session.get('pendingQueue');
    const now = Date.now();
    const idx = pendingQueue.findIndex(
      (p) => p.host === host && hasContent(p) && now - p.ts < 120000
    );
    if (idx === -1) return null;
    const [payload] = pendingQueue.splice(idx, 1);
    await chrome.storage.session.set({ pendingQueue });
    return payload;
  } catch (e) {
    // 存储不可读则放弃本轮
  }
  return null;
}

function main() {
  const cfg = SITE_CONFIG[location.hostname];
  if (!cfg) return;

  const start = Date.now();
  let payload = null;
  let asked = false;

  const timer = setInterval(async () => {
    if (Date.now() - start > POLL_TIMEOUT) {
      clearInterval(timer);
      if (!payload) log('超时：未收到待填充内容');
      return;
    }

    if (!payload) {
      payload = await fetchPayload(location.hostname);
      if (payload) {
        log('收到待填充内容，文字长度：', (payload.text || '').length, '含图：', !!payload.imageDataUrl);
      }
      return; // 下一轮再找输入框，避免同帧时序问题
    }

    const inputEl = findFirst(cfg.inputSelectors);
    if (!inputEl) return;

    clearInterval(timer);

    // 先粘贴图片（上传需要时间），再填文字
    const hasImage = !!payload.imageDataUrl;
    if (hasImage) pasteImage(inputEl, payload.imageDataUrl);
    if (payload.text) {
      fillInput(inputEl, payload.text);
      log('已填入输入框');
    }

    if (payload.autoSend && !asked) {
      asked = true;
      // 图片上传中直接发送会丢附件，多等一会儿
      setTimeout(() => trySend(cfg, inputEl), hasImage ? 3000 : 800);
    }
  }, POLL_INTERVAL);
}

main();
