// Decodes the surface kinds' photographed sets and packs them as the layers of two texture arrays (photos.js), off
// the main thread. Message: { urls: [[diff, nor], ...] } -> { width, height, diff, nor (Uint8Array RGBA, layer after
// layer, rows bottom up as three uploads a picture), aspect: [height / width of each set] } or { error }.
self.onmessage = async ({ data: { urls } }) => {
  try {
    const decode = async (url) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url}: ${r.status}`);
      return createImageBitmap(await r.blob(), { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    };
    const out = { aspect: [] };
    for (const [m, map] of ['diff', 'nor'].entries()) {
      let cx, data;
      for (const [l, pair] of urls.entries()) {
        const bmp = await decode(pair[m]);
        if (!data) {
          // (every set at the first one's resolution: a taller one is squeezed, and its tiles stretched back by aspect)
          out.width = bmp.width; out.height = bmp.height;
          cx = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d', { willReadFrequently: true });
          data = new Uint8Array(bmp.width * bmp.height * 4 * urls.length);
        }
        if (!m) out.aspect.push(bmp.height / bmp.width);
        cx.drawImage(bmp, 0, 0, out.width, out.height);
        bmp.close();
        data.set(cx.getImageData(0, 0, out.width, out.height).data, l * out.width * out.height * 4);
      }
      out[map] = data;
    }
    self.postMessage(out, [out.diff.buffer, out.nor.buffer]);
  } catch (e) {
    self.postMessage({ error: String((e && e.message) || e) });
  }
};
