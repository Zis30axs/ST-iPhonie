// Private character-card entry. The original extension entry is bundled by the
// caller with portable-only resource/lifecycle adapters; its ordinary install
// and data schema remain unchanged.
import { enable, disposePortable } from '../index.js';
import { portableData } from 'virtual:unread-city-phone-data';

const key = '__unreadCityEmbeddedPhoneRuntime';
let disposed = false;
let cleanup = null;
const style = document.createElement('style');
style.dataset.unreadCityEmbeddedPhone = 'style';
style.textContent = portableData.hostCss;
document.head.append(style);

const finish = () => cleanup ||= (async () => {
  try { await disposePortable(); }
  finally {
    style.remove();
    if (globalThis[key] === runtime) delete globalThis[key];
  }
})();

const runtime = {
  kind: 'st-iphonie-embedded',
  version: portableData.version,
  // Public, immutable build assets only. No settings, messages or keys here.
  readAsset(name) {
    if (!Object.hasOwn(portableData.tokenizers, name)) throw Error('未知的内嵌手机资源');
    return portableData.tokenizers[name];
  },
  ready: null,
  async dispose() {
    disposed = true;
    try { await runtime.ready; } catch { /* failed initialization still cleans */ }
    await finish();
  },
};
globalThis[key] = runtime;
runtime.ready = (async () => {
  try {
    await enable();
    if (disposed) throw new DOMException('手机初始化已取消', 'AbortError');
    const host = globalThis.STiPhoniePanelHost;
    if (!host?.mount) throw Error('当前酒馆未提供手机所需的接口；请查看手机启动提示');
    return host;
  } catch (error) {
    await finish();
    throw error;
  }
})();
// A consumer attaches to ready after this static script has finished executing.
// Mark rejection handled immediately, while preserving ready's rejection.
runtime.ready.catch(() => {});
