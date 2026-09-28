import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');

fs.mkdirSync(path.join(CACHE_DIR, 'thumbs'), { recursive: true });
fs.mkdirSync(path.join(CACHE_DIR, 'subs'), { recursive: true });

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** data/ 以下の JSON ファイルを読み書きする（書き込みは遅延してまとめる） */
export class JsonStore {
  constructor(name, defaults, { delay = 1000, pretty = false } = {}) {
    this.file = path.join(DATA_DIR, name);
    this.delay = delay;
    this.pretty = pretty;
    this.timer = null;
    this.data = structuredClone(defaults);
    try {
      Object.assign(this.data, JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {}
  }

  save(now = false) {
    clearTimeout(this.timer);
    const write = () => {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, this.pretty ? 2 : 0));
      fs.renameSync(tmp, this.file);
    };
    if (now) write();
    else this.timer = setTimeout(write, this.delay);
  }
}

const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
export const naturalCompare = (a, b) => collator.compare(a, b);
