/**
 * Presentation-only lease for the existing phone dialog. The iframe stays in its
 * original DOM position, so its app state and connection are never recreated.
 * Consumers receive no settings, storage, model, or backend API through this host.
 * release() is idempotent and does not call onClose. The callback runs once for
 * phone UI closure, replacement, a lost slot, or plugin disable instead.
 */
export function createPanelHost({win = globalThis.window, isActive, ensurePanel, getPanel, getFrame, visibility = () => {}}) {
  let current = null, disposed = false, mounting = false, retiring = 0, watchedPanel = null, watchedFrame = null, pendingCloses = 0;
  const restore = (element, name, value) => value === null ? element.removeAttribute(name) : element.setAttribute(name, value);
  const close = panel => { if (panel.open) { pendingCloses++; panel.close(); } };
  const onPanelClose = () => {
    // HTMLDialogElement.close queues its event. An older event must not close a
    // newly opened lease or phone, including a synchronous release/remount.
    if (pendingCloses) { pendingCloses--; return; }
    if (watchedPanel?.open) return;
    current?.finish(true);
  };
  const onFrameLoad = () => {
    if (disposed || !isActive() || getPanel() !== watchedPanel || getFrame() !== watchedFrame) return;
    // The initial visibility call can happen before the phone installs its
    // hooks. In particular, a quick release during loading must stay hidden
    // after createPhoneApp initializes with its ordinary native default.
    try { visibility(!!watchedPanel?.open, true); } catch { /* an app hook must not break its host */ }
  };
  const watch = (panel, frame) => {
    if (watchedPanel === panel && watchedFrame === frame) return;
    watchedPanel?.removeEventListener('close', onPanelClose);
    watchedFrame?.removeEventListener('load', onFrameLoad);
    watchedPanel = panel;
    watchedFrame = frame;
    pendingCloses = 0;
    panel.addEventListener('close', onPanelClose);
    frame.addEventListener('load', onFrameLoad);
  };
  function mount(anchor, {onClose} = {}) {
    if (disposed || !isActive()) throw Error('ST-iPhonie 未启用，无法嵌入手机');
    if (mounting) throw Error('ST-iPhonie 正在交接手机宿主，请稍后重试');
    // Vue can create the slot in a helper iframe and adopt it into the parent
    // shadow root. Its prototype remains in that iframe realm, so instanceof
    // parent.HTMLElement would incorrectly reject a valid parent-page element.
    let connectedRoot = null;
    try { connectedRoot = win.Node.prototype.getRootNode.call(anchor, {composed: true}); } catch { /* not a DOM node */ }
    if (anchor?.nodeType !== 1 || anchor.namespaceURI !== 'http://www.w3.org/1999/xhtml' ||
      anchor.ownerDocument !== win.document || !anchor.isConnected || connectedRoot !== win.document) {
      throw Error('手机槽位必须是酒馆当前页面中已连接的 HTMLElement');
    }
    if (onClose !== undefined && typeof onClose !== 'function') throw Error('手机宿主 onClose 必须是函数');
    const rectOf = () => {
      const rect = anchor.getBoundingClientRect();
      if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
        throw Error('手机槽位尚不可见或尺寸为零，请在前端完成布局后再嵌入');
      }
      return rect;
    };
    rectOf();
    mounting = true;
    let lease = null;
    try {
      // Retire the previous lease before notifying its owner. Recursive mount in
      // that callback is rejected instead of leaving two competing hosts alive.
      current?.finish(true);
      ensurePanel();
      const panel = getPanel(), frame = getFrame();
      if (!panel?.isConnected || !frame || frame.parentElement !== panel) throw Error('ST-iPhonie 手机窗口未准备好');
      watch(panel, frame);
      const saved = {panelStyle: panel.getAttribute('style'), panelClass: panel.getAttribute('class'), frameStyle: frame.getAttribute('style')};
      let ended = false, raf = 0, resize = null, changes = null;
      const remove = [];
      const listen = (target, name, handler, options) => {
        target?.addEventListener(name, handler, options);
        remove.push(() => target?.removeEventListener(name, handler, options));
      };
      const apply = rect => {
        const styles = {position: 'fixed', inset: 'auto', margin: '0', padding: '0', border: '0', 'border-radius': '0', 'box-sizing': 'border-box',
          'min-width': '0', 'min-height': '0', 'max-width': 'none', 'max-height': 'none', transform: 'none', translate: 'none', rotate: 'none', scale: 'none',
          filter: 'none', 'box-shadow': 'none', 'z-index': '2147483200', 'pointer-events': 'auto',
          left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px'};
        for (const [name, value] of Object.entries(styles)) panel.style.setProperty(name, value, 'important');
        for (const [name, value] of Object.entries({width: '100%', height: '100%', transform: 'none', 'max-width': 'none', 'max-height': 'none'})) {
          frame.style.setProperty(name, value, 'important');
        }
      };
      const finish = notify => {
        if (ended) return;
        ended = true;
        if (current === lease) current = null;
        win.cancelAnimationFrame(raf);
        resize?.disconnect(); changes?.disconnect();
        for (const off of remove) off();
        close(panel);
        restore(panel, 'style', saved.panelStyle);
        restore(panel, 'class', saved.panelClass);
        restore(frame, 'style', saved.frameStyle);
        // Leaving an internal app may ask to leave its full-screen drawing mode.
        // Keep the host guard active during that call so it cannot relayout the
        // just-restored ordinary phone styles.
        retiring++;
        try { visibility(false); } catch { /* a failing app cannot prevent release or its close notification */ } finally { retiring--; }
        if (notify) { try { onClose?.(); } catch { /* the owner cannot prevent cleanup */ } }
      };
      const sync = () => {
        if (ended) return;
        if (!isActive() || !anchor.isConnected || !panel.isConnected || !panel.open) { finish(true); return; }
        try { apply(rectOf()); } catch { finish(true); }
      };
      const schedule = () => {
        if (ended || raf) return;
        raf = win.requestAnimationFrame(() => { raf = 0; sync(); });
      };
      lease = {panel, finish, sync, release: () => finish(false), focus: () => { if (!ended && panel.open) frame.focus({preventScroll: true}); }};
      current = lease;
      // Modal dialogs make their siblings inert, including the immersive Shell.
      // Reopen this same dialog non-modally without reparenting its iframe.
      if (panel.open) close(panel);
      panel.classList.remove('floating', 'expanded');
      panel.classList.add('st-iphonie-hosted');
      apply(rectOf());
      panel.show();
      visibility(true);
      listen(win, 'resize', schedule);
      listen(win, 'scroll', schedule, true);
      for (const name of ['resize', 'scroll']) listen(win.visualViewport, name, schedule);
      if (win.ResizeObserver) { resize = new win.ResizeObserver(schedule); resize.observe(anchor); }
      if (win.MutationObserver) {
        changes = new win.MutationObserver(schedule);
        changes.observe(win.document.documentElement, {childList: true, subtree: true});
        changes.observe(panel, {attributes: true, attributeFilter: ['open']});
        // Document observers do not cross shadow roots. Also watch every root
        // containing this slot so a Vue unmount there releases the phone.
        for (let node = anchor; node;) {
          const root = node.getRootNode();
          if (!root?.host) break;
          changes.observe(root, {childList: true, subtree: true});
          node = root.host;
        }
      }
      return Object.freeze({release: lease.release, sync: lease.sync, focus: lease.focus});
    } catch (error) {
      lease?.finish(false);
      throw error;
    } finally { mounting = false; }
  }
  return Object.freeze({
    api: Object.freeze({mount}),
    get hosted() { return !!current || retiring > 0; },
    // The ordinary close handler must not relayout styles restored by a lease.
    get hostingClose() { return !!current || pendingCloses > 0; },
    sync() { current?.sync(); },
    dispose() {
      if (disposed) return;
      disposed = true;
      current?.finish(true);
      watchedPanel?.removeEventListener('close', onPanelClose);
      watchedFrame?.removeEventListener('load', onFrameLoad);
      watchedPanel = null;
      watchedFrame = null;
    }
  });
}
