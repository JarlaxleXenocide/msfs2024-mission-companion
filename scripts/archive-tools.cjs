const assert = require('node:assert/strict');
const yauzl = require('yauzl');

function canonicalPath(raw) {
  const name = raw.replaceAll('\\', '/');
  assert(name && !name.startsWith('/') && !/^[a-z]:/i.test(name), `Unsafe absolute ZIP path: ${raw}`);
  const parts = name.replace(/\/$/, '').split('/');
  for (const part of parts) {
    assert(part && part !== '.' && part !== '..' && !/[\x00-\x1f\x7f:<>"|?*]/.test(part) && !/[. ]$/.test(part)
      && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part), `Unsafe ZIP path: ${raw}`);
  }
  return name;
}
async function withArchive(file, inspect) {
  const zip = await yauzl.openPromise(file, { autoClose: false, lazyEntries: true });
  try {
    const entries = new Map(); const normalized = new Set(); let total = 0;
    for await (const entry of zip.eachEntry()) {
      const name = canonicalPath(entry.fileName);
      const key = name.replace(/\/$/, '').toLowerCase();
      assert(!normalized.has(key), `Duplicate normalized ZIP entry: ${name}`);
      normalized.add(key);
      const type = (entry.externalFileAttributes >>> 16) & 0o170000;
      assert(type !== 0o120000, `ZIP symlink: ${name}`);
      assert([0, 0o040000, 0o100000].includes(type), `Unsafe ZIP file type: ${name}`);
      assert(type !== 0o040000 || name.endsWith('/'), `Unsafe ZIP directory: ${name}`);
      assert(!entry.isEncrypted(), `Encrypted ZIP entry: ${name}`);
      total += entry.uncompressedSize;
      assert(entry.uncompressedSize <= 512 * 1024 * 1024 && total <= 1024 * 1024 * 1024 && entries.size < 10000, 'ZIP size limit exceeded');
      entries.set(name, entry);
    }
    for (const name of entries.keys()) {
      const parts = name.replace(/\/$/, '').split('/');
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(0, i).join('/').toLowerCase();
        assert(![...entries.keys()].some(n => !n.endsWith('/') && n.toLowerCase() === parent), `Unsafe ZIP file/directory collision: ${name}`);
      }
    }
    const read = async name => {
      assert(entries.has(name), `Missing ZIP entry: ${name}`);
      const stream = await zip.openReadStreamPromise(entries.get(name));
      const chunks = []; for await (const chunk of stream) chunks.push(chunk);
      return Buffer.concat(chunks);
    };
    // No entry data is read or extracted until every archive path is validated.
    return await inspect(entries, read);
  } finally { zip.close(); }
}
module.exports = { canonicalPath, withArchive };
