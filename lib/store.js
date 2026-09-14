/**
 * DataStore — 模版 / 提问记录 / 设置 的统一存储层。
 *
 * 主存储：chrome.storage.local（浏览器扩展存储，不在插件目录内）。
 * 镜像存储：用户通过 File System Access API 指定的任意本地目录，
 *           每次数据变更自动写入 prompt-templates.json / ask-history.json。
 * 目录句柄保存在 IndexedDB 中，可跨会话复用。
 */
const DataStore = (() => {
  const FILE_TEMPLATES = 'prompt-templates.json';
  const FILE_HISTORY = 'ask-history.json';
  const HISTORY_LIMIT = 500;

  const DEFAULT_TEMPLATES = [
    { id: 'tpl-summary', title: '总结', content: '请用中文分点总结以上内容，突出关键结论。', updatedAt: 0 },
    { id: 'tpl-translate', title: '翻译', content: '请将以上内容翻译成中文，保持专业术语准确。', updatedAt: 0 },
    { id: 'tpl-explain', title: '通俗解释', content: '请用通俗易懂的方式解释以上内容，并举例说明。', updatedAt: 0 },
    { id: 'tpl-polish', title: '润色', content: '请润色以上文字，使其表达更清晰流畅，保持原意不变。', updatedAt: 0 },
  ];

  // ---------- chrome.storage.local ----------

  function storageGet(key) {
    return new Promise((resolve) => {
      chrome.storage.local.get(key, (res) => resolve(res[key]));
    });
  }

  function storageSet(obj) {
    return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
  }

  async function getTemplates() {
    let list = await storageGet('templates');
    if (!Array.isArray(list)) {
      // 首次运行，写入内置模版
      list = DEFAULT_TEMPLATES;
      await storageSet({ templates: list });
    }
    return list;
  }

  async function saveTemplates(list, sync = true) {
    await storageSet({ templates: list });
    if (sync) await syncToDisk();
  }

  /** 记录一次模版使用（次数 +1、更新最近使用时间），用于排序展示。 */
  async function markTemplateUsed(id) {
    const list = await getTemplates();
    const tpl = list.find((t) => t.id === id);
    if (!tpl) return;
    tpl.useCount = (tpl.useCount || 0) + 1;
    tpl.lastUsedAt = Date.now();
    await saveTemplates(list);
  }

  async function getHistory() {
    const list = await storageGet('history');
    return Array.isArray(list) ? list : [];
  }

  async function saveHistory(list, sync = true) {
    await storageSet({ history: list.slice(-HISTORY_LIMIT) });
    if (sync) await syncToDisk();
  }

  async function addHistory(entry) {
    const list = await getHistory();
    list.push({ id: crypto.randomUUID(), ts: Date.now(), ...entry });
    await saveHistory(list);
  }

  async function clearHistory() {
    await saveHistory([]);
  }

  async function getSettings() {
    const s = await storageGet('settings');
    return s && typeof s === 'object' ? s : {};
  }

  async function saveSettings(s) {
    await storageSet({ settings: s });
  }

  // ---------- IndexedDB（保存目录句柄） ----------

  function openIdb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('ai-ask-store', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSet(key, val) {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbGet(key) {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
      const req = db.transaction('kv').objectStore('kv').get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getDirHandle() {
    try {
      return (await idbGet('dirHandle')) || null;
    } catch {
      return null;
    }
  }

  // ---------- 本地目录（File System Access API） ----------

  /** 需要用户手势触发。返回目录名，失败/取消返回 null。 */
  async function pickDataDir() {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await idbSet('dirHandle', handle);
    const settings = await getSettings();
    settings.dataDirName = handle.name;
    await saveSettings(settings);
    return handle.name;
  }

  async function forgetDataDir() {
    try {
      await idbSet('dirHandle', null);
    } catch { /* ignore */ }
    const settings = await getSettings();
    delete settings.dataDirName;
    await saveSettings(settings);
  }

  async function hasPermission(handle, request = false) {
    if (!handle) return false;
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if (request) {
      return (await handle.requestPermission(opts)) === 'granted';
    }
    return false;
  }

  async function writeJsonFile(handle, name, data) {
    const fh = await handle.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(data, null, 2));
    await w.close();
  }

  async function readJsonFile(handle, name) {
    try {
      const fh = await handle.getFileHandle(name);
      const file = await fh.getFile();
      return JSON.parse(await file.text());
    } catch {
      return null;
    }
  }

  function mergeById(localList, diskList, timeKey) {
    const map = new Map();
    for (const item of localList || []) map.set(item.id, item);
    for (const item of diskList || []) {
      const cur = map.get(item.id);
      if (!cur || (item[timeKey] || 0) >= (cur[timeKey] || 0)) {
        map.set(item.id, item);
      }
    }
    return [...map.values()];
  }

  /** 把当前数据写入本地目录（已连接且有权限时）。返回是否成功。 */
  async function syncToDisk() {
    try {
      const handle = await getDirHandle();
      if (!handle || !(await hasPermission(handle))) return false;
      await writeJsonFile(handle, FILE_TEMPLATES, await getTemplates());
      await writeJsonFile(handle, FILE_HISTORY, await getHistory());
      return true;
    } catch {
      return false;
    }
  }

  /** 从本地目录读取并与本地存储合并（按 id + 时间戳取新），随后回写镜像。 */
  async function loadFromDisk() {
    try {
      const handle = await getDirHandle();
      if (!handle || !(await hasPermission(handle))) return false;
      const diskT = await readJsonFile(handle, FILE_TEMPLATES);
      const diskH = await readJsonFile(handle, FILE_HISTORY);
      if (Array.isArray(diskT)) {
        await saveTemplates(mergeById(await getTemplates(), diskT, 'updatedAt'), false);
      }
      if (Array.isArray(diskH)) {
        await saveHistory(mergeById(await getHistory(), diskH, 'ts'), false);
      }
      await syncToDisk();
      return true;
    } catch {
      return false;
    }
  }

  /** 目录连接状态：none / connected / need-permission */
  async function dirStatus() {
    const handle = await getDirHandle();
    if (!handle) return 'none';
    return (await hasPermission(handle)) ? 'connected' : 'need-permission';
  }

  /** 页面加载时调用：尝试从本地目录合并数据。 */
  async function init() {
    await loadFromDisk();
  }

  return {
    getTemplates,
    saveTemplates,
    markTemplateUsed,
    getHistory,
    saveHistory,
    addHistory,
    clearHistory,
    getSettings,
    saveSettings,
    pickDataDir,
    forgetDataDir,
    syncToDisk,
    loadFromDisk,
    dirStatus,
    init,
  };
})();
