// 截图框选遮罩层：由 background 在用户按下快捷键后通过
// chrome.scripting.executeScript 注入当前页面。
// 流程：接收整屏截图 dataURL → 拖拽框选区域 → canvas 裁剪 → 回传 background。
// Esc 取消；未拖出有效区域时可重新框选。

(function () {
  if (window.__aiAskCaptureLoaded) return;
  window.__aiAskCaptureLoaded = true;

  const MIN_SIZE = 8; // 选区最小边长，避免误触
  let overlay = null;
  let docListeners = null; // 挂在 document 上的监听，随 cleanup 一起移除

  function cleanup() {
    if (overlay) {
      overlay.remove();
      overlay = null;
    }
    if (docListeners) {
      document.removeEventListener('mousemove', docListeners.move, true);
      document.removeEventListener('mouseup', docListeners.up, true);
      document.removeEventListener('keydown', docListeners.key, true);
      docListeners = null;
    }
  }

  function cancel() {
    cleanup();
    chrome.runtime.sendMessage({ type: 'captureCanceled' }).catch(() => {});
  }

  function start(dataUrl) {
    cleanup();
    overlay = document.createElement('div');
    overlay.id = '__ai-ask-capture-overlay';
    Object.assign(overlay.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483647',
      background: 'rgba(0,0,0,0.35)',
      cursor: 'crosshair',
      userSelect: 'none',
    });
    document.documentElement.appendChild(overlay);

    let startX = 0;
    let startY = 0;
    let box = null; // 选区高亮 div
    let dragging = false;
    let finished = false;

    const hint = document.createElement('div');
    hint.textContent = '拖拽框选要提问的区域，Esc 取消';
    Object.assign(hint.style, {
      position: 'absolute',
      top: '16px',
      left: '50%',
      transform: 'translateX(-50%)',
      padding: '6px 14px',
      borderRadius: '6px',
      background: 'rgba(0,0,0,0.65)',
      color: '#fff',
      fontSize: '14px',
      fontFamily: 'system-ui, sans-serif',
      pointerEvents: 'none',
    });
    overlay.appendChild(hint);

    function getRect() {
      if (!box) return null;
      const r = box.getBoundingClientRect();
      return {
        x: Math.min(r.left, r.right),
        y: Math.min(r.top, r.bottom),
        w: Math.abs(r.width),
        h: Math.abs(r.height),
      };
    }

    function onMouseDown(e) {
      if (finished) return;
      if (e.button !== 0) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      if (box) box.remove();
      box = document.createElement('div');
      Object.assign(box.style, {
        position: 'absolute',
        border: '2px solid #4a9eff',
        background: 'rgba(74,158,255,0.15)',
        left: startX + 'px',
        top: startY + 'px',
        width: '0px',
        height: '0px',
      });
      overlay.appendChild(box);
      e.preventDefault();
    }

    function onMouseMove(e) {
      if (!dragging || !box) return;
      Object.assign(box.style, {
        left: Math.min(startX, e.clientX) + 'px',
        top: Math.min(startY, e.clientY) + 'px',
        width: Math.abs(e.clientX - startX) + 'px',
        height: Math.abs(e.clientY - startY) + 'px',
      });
    }

    function onMouseUp() {
      if (!dragging) return;
      dragging = false;
      const r = getRect();
      if (!r || r.w < MIN_SIZE || r.h < MIN_SIZE) {
        // 无效选区，允许重新拖拽
        if (box) box.remove();
        box = null;
        return;
      }
      finished = true;
      showConfirmBar(r);
    }

    function showConfirmBar(r) {
      const bar = document.createElement('div');
      Object.assign(bar.style, {
        position: 'absolute',
        left: Math.min(r.x + r.w - 176, window.innerWidth - 190) + 'px',
        top: Math.min(r.y + r.h + 8, window.innerHeight - 48) + 'px',
        display: 'flex',
        gap: '8px',
        padding: '6px',
        borderRadius: '6px',
        background: 'rgba(255,255,255,0.95)',
        boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
      });
      overlay.appendChild(bar);

      function btn(text, primary, fn) {
        const b = document.createElement('button');
        b.textContent = text;
        Object.assign(b.style, {
          padding: '4px 14px',
          border: 'none',
          borderRadius: '4px',
          cursor: 'pointer',
          fontSize: '13px',
          background: primary ? '#4a9eff' : '#eee',
          color: primary ? '#fff' : '#333',
        });
        b.onclick = (ev) => {
          ev.stopPropagation();
          fn();
        };
        return b;
      }

      bar.appendChild(btn('✓ 确认', true, () => cropAndSend(r)));
      bar.appendChild(btn('↻ 重选', false, () => {
        finished = false;
        bar.remove();
        if (box) box.remove();
        box = null;
      }));
      bar.appendChild(btn('✕ 取消', false, cancel));
      // 阻止遮罩层在点击按钮区时重新开始框选
      bar.addEventListener('mousedown', (e) => e.stopPropagation());
    }

    function cropAndSend(r) {
      const img = new Image();
      img.onload = () => {
        // captureVisibleTab 返回的图按 devicePixelRatio 缩放，需要换算
        const scale = img.naturalWidth / window.innerWidth;
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(r.w * scale);
        canvas.height = Math.round(r.h * scale);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(
          img,
          r.x * scale,
          r.y * scale,
          r.w * scale,
          r.h * scale,
          0,
          0,
          canvas.width,
          canvas.height
        );
        const cropped = canvas.toDataURL('image/png');
        cleanup();
        chrome.runtime
          .sendMessage({ type: 'captureCropDone', dataUrl: cropped })
          .catch(() => {});
      };
      img.onerror = cancel;
      img.src = dataUrl;
    }

    overlay.addEventListener('mousedown', onMouseDown);
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        cancel();
      }
    };
    docListeners = { move: onMouseMove, up: onMouseUp, key: onKey };
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('keydown', onKey, true);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'start-capture' && msg.dataUrl) {
      start(msg.dataUrl);
    }
  });
})();
