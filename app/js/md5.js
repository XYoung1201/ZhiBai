// MD5（RFC 1321），可分块增量计算。上传前在浏览器里算出整本书的 MD5，先问服务器有没有，有就不再上传。
const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K = Int32Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0);

export class MD5 {
  #h = Int32Array.of(0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476);
  #buf = new Uint8Array(64);
  #n = 0;     // #buf 中待处理的字节数
  #len = 0;   // 已输入的总字节数
  #w = new Int32Array(16);

  update(data) {
    let i = 0;
    if (this.#n) {
      i = Math.min(64 - this.#n, data.length);
      this.#buf.set(data.subarray(0, i), this.#n);
      this.#n += i;
      if (this.#n < 64) { this.#len += data.length; return this; }
      this.#block(this.#buf, 0); this.#n = 0;
    }
    for (; i + 64 <= data.length; i += 64) this.#block(data, i);
    if (i < data.length) { this.#buf.set(data.subarray(i)); this.#n = data.length - i; }
    this.#len += data.length;
    return this;
  }

  digest() {
    const bits = this.#len * 8;
    const pad = new Uint8Array((this.#n < 56 ? 56 : 120) - this.#n + 8);
    pad[0] = 0x80;
    const p = pad.length - 8, lo = bits >>> 0, hi = Math.floor(bits / 2 ** 32) >>> 0;
    for (let k = 0; k < 4; k++) { pad[p + k] = (lo >>> (8 * k)) & 255; pad[p + 4 + k] = (hi >>> (8 * k)) & 255; }
    this.update(pad);
    let hex = '';
    for (const v of this.#h) for (let k = 0; k < 4; k++) hex += ((v >>> (8 * k)) & 255).toString(16).padStart(2, '0');
    return hex;
  }

  #block(d, o) {
    const w = this.#w, h = this.#h;
    for (let j = 0; j < 16; j++) { const q = o + j * 4; w[j] = d[q] | (d[q + 1] << 8) | (d[q + 2] << 16) | (d[q + 3] << 24); }
    let a = h[0], b = h[1], c = h[2], e = h[3];
    for (let j = 0; j < 64; j++) {
      let f, g;
      if (j < 16) { f = (b & c) | (~b & e); g = j; }
      else if (j < 32) { f = (e & b) | (~e & c); g = (5 * j + 1) & 15; }
      else if (j < 48) { f = b ^ c ^ e; g = (3 * j + 5) & 15; }
      else { f = c ^ (b | ~e); g = (7 * j) & 15; }
      const x = (a + f + K[j] + w[g]) | 0;
      a = e; e = c; c = b;
      b = (b + ((x << S[j]) | (x >>> (32 - S[j])))) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + e) | 0;
  }
}

// 分块读取整个文件（Blob / File）算 MD5，不会一次把大文件读进内存
export async function md5Blob(blob, onProgress) {
  const m = new MD5(), CH = 4 << 20;
  for (let off = 0; off < blob.size; off += CH) {
    m.update(new Uint8Array(await blob.slice(off, off + CH).arrayBuffer()));
    onProgress?.(Math.min(1, (off + CH) / blob.size));
  }
  return m.digest();
}
