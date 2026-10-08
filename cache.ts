export class DiagramCache {
	private dbPromise: Promise<IDBDatabase> | null = null;
	private readonly dbName = "ObsidianTikz";
	private readonly storeName = "svgImages";

	private getDb(): Promise<IDBDatabase> {
		if (this.dbPromise) return this.dbPromise;

		this.dbPromise = new Promise((resolve, reject) => {
			if (typeof indexedDB === "undefined") {
				return reject(new Error("IndexedDB is not available in current environment"));
			}
			const req = indexedDB.open(this.dbName, 1);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains(this.storeName)) {
					db.createObjectStore(this.storeName);
				}
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error || new Error("Failed to open IndexedDB"));
		});

		return this.dbPromise;
	}

	async get(key: string): Promise<string | null> {
		try {
			const db = await this.getDb();
			const result = await new Promise<string | null>((resolve, reject) => {
				const tx = db.transaction(this.storeName, "readonly");
				const store = tx.objectStore(this.storeName);
				const req = store.get(key);
				req.onsuccess = () => resolve((req.result as string) || null);
				req.onerror = () => reject(req.error);
			});

			if (result) return result;

			return await this.getLegacy(key);
		} catch {
			return null;
		}
	}

	private async getLegacy(key: string): Promise<string | null> {
		return new Promise<string | null>((resolve) => {
			try {
				if (typeof indexedDB === "undefined") return resolve(null);
				const req = indexedDB.open("localforage");
				req.onsuccess = () => {
					const db = req.result;
					if (!db.objectStoreNames.contains("keyvaluepairs")) {
						db.close();
						return resolve(null);
					}
					const tx = db.transaction("keyvaluepairs", "readonly");
					const store = tx.objectStore("keyvaluepairs");
					const getReq = store.get(key);
					getReq.onsuccess = () => {
						const val = (getReq.result as string) || null;
						db.close();
						if (val) {
							this.set(key, val).catch(() => {});
						}
						resolve(val);
					};
					getReq.onerror = () => {
						db.close();
						resolve(null);
					};
				};
				req.onerror = () => resolve(null);
			} catch {
				resolve(null);
			}
		});
	}

	async set(key: string, value: string): Promise<void> {
		try {
			const db = await this.getDb();
			await new Promise<void>((resolve, reject) => {
				const tx = db.transaction(this.storeName, "readwrite");
				const store = tx.objectStore(this.storeName);
				const req = store.put(value, key);
				req.onsuccess = () => resolve();
				req.onerror = () => reject(req.error);
			});
		} catch {
			// Silently ignore caching errors
		}
	}

	async clear(): Promise<void> {
		try {
			const db = await this.getDb();
			await new Promise<void>((resolve, reject) => {
				const tx = db.transaction(this.storeName, "readwrite");
				const store = tx.objectStore(this.storeName);
				const req = store.clear();
				req.onsuccess = () => resolve();
				req.onerror = () => reject(req.error);
			});
		} catch (err) {
			console.error("Failed to clear diagram cache", err);
			throw err;
		}
	}
}
