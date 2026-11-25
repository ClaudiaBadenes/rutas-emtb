/** Mini envoltorio de IndexedDB (almacenamiento persistente del móvil) */
const DB_NAME = "rutas-emtb";
const VERSION = 1;
export const STORES = ["tiles", "trails", "regions", "meta"] as const;
type Store = (typeof STORES)[number];

let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, VERSION);
    r.onupgradeneeded = () => {
      for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

const done = (t: IDBTransaction) => new Promise<void>((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function get<T>(store: Store, key: IDBValidKey): Promise<T | undefined> {
  const db = await open();
  return req(db.transaction(store).objectStore(store).get(key)) as Promise<T | undefined>;
}

export async function getAll<T>(store: Store): Promise<T[]> {
  const db = await open();
  return req(db.transaction(store).objectStore(store).getAll()) as Promise<T[]>;
}

export async function getAllKeys(store: Store): Promise<IDBValidKey[]> {
  const db = await open();
  return req(db.transaction(store).objectStore(store).getAllKeys());
}

export async function putMany(store: Store, entries: [IDBValidKey, unknown][]) {
  if (!entries.length) return;
  const db = await open();
  const t = db.transaction(store, "readwrite");
  const s = t.objectStore(store);
  for (const [k, v] of entries) s.put(v, k);
  await done(t);
}

export async function put(store: Store, key: IDBValidKey, value: unknown) {
  return putMany(store, [[key, value]]);
}

export async function clearAll() {
  const db = await open();
  const t = db.transaction([...STORES], "readwrite");
  for (const s of STORES) t.objectStore(s).clear();
  await done(t);
}
