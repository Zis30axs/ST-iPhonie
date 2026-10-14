// 画画的作品, kept in this browser (IndexedDB 'st-iphonie-paint'): a list (name, size, when, a small picture) and,
// apart, each work's layers as PNG pictures — so the list opens quickly however big the works are.

const DB = 'st-iphonie-paint';
export function paintStore(win) {
  let opening = null;
  const open = () => opening ||= new Promise((resolve, reject) => {
    const req = win.indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { const db = req.result; db.createObjectStore('works', {keyPath: 'id'}); db.createObjectStore('layers', {keyPath: 'id'}); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { opening = null; reject(req.error || Error('打不开画画的存储')); };
  });
  const tx = async (names, mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(names, mode), out = {value: undefined};
      t.oncomplete = () => resolve(out.value);
      t.onerror = t.onabort = () => reject(t.error || Error('画画的存储出错了'));
      fn(t, out);
    });
  };
  return {
    /** The works, newest first: {id, name, width, height, updatedAt, thumb (Blob)}. */
    list: () => tx(['works'], 'readonly', (t, out) => { const r = t.objectStore('works').getAll(); r.onsuccess = () => { out.value = r.result.sort((a, b) => b.updatedAt - a.updatedAt); }; }),
    /** A work with its layers ({id, name, opacity, visible, blob}), or null. */
    get: id => tx(['works', 'layers'], 'readonly', (t, out) => {
      const w = t.objectStore('works').get(id), l = t.objectStore('layers').get(id);
      l.onsuccess = () => { out.value = w.result ? {...w.result, layers: l.result?.layers || []} : null; };
    }),
    /** Keeps a work: its entry and its layers. */
    put: work => tx(['works', 'layers'], 'readwrite', t => {
      const {layers, ...entry} = work;
      t.objectStore('works').put(entry);
      t.objectStore('layers').put({id: work.id, layers});
    }),
    rename: (id, name) => tx(['works'], 'readwrite', t => { const s = t.objectStore('works'), r = s.get(id); r.onsuccess = () => { if (r.result) s.put({...r.result, name}); }; }),
    remove: id => tx(['works', 'layers'], 'readwrite', t => { t.objectStore('works').delete(id); t.objectStore('layers').delete(id); }),
    close: async () => { if (opening) (await opening.catch(() => null))?.close(); opening = null; },
  };
}
