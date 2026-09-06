const { ZipFile } = require('yazl');
const { createWriteStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
async function writeZip(file, entries) {
  const zip = new ZipFile();
  const writing = pipeline(zip.outputStream, createWriteStream(file));
  for (const { name, data = 'fixture', mode } of entries) {
    zip.addBuffer(Buffer.isBuffer(data) ? data : Buffer.from(data), 'placeholder', { mode });
    // The maintained writer rejects attacks itself. Override only fixture metadata to
    // encode malicious names (including Windows backslashes) in both ZIP headers.
    zip.entries.at(-1).utf8FileName = Buffer.from(name);
  }
  zip.end();
  await writing;
}
function pe(machine = 0x8664) {
  const bytes = Buffer.alloc(512);
  bytes.write('MZ'); bytes.writeUInt32LE(64, 60); bytes.write('PE\0\0', 64);
  bytes.writeUInt16LE(machine, 68); bytes.writeUInt16LE(1, 70);
  bytes.writeUInt16LE(240, 84); bytes.writeUInt16LE(2, 86);
  bytes.writeUInt16LE(machine === 0x8664 ? 0x20b : 0x10b, 88);
  return bytes;
}
module.exports = { writeZip, pe };
