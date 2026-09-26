// Bench-only: SHA-256 of every generated buffer in the scene (geometry attributes, indices, instance data,
// texture pixels), as an order-independent sorted list. Used to prove worker generation is bit-identical.
async function sha(view) {
  const bytes = view instanceof ArrayBuffer ? view : view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

function texturePixels(tex) {
  const img = tex.image;
  if (!img) return null;
  if (img.data && tex.userData.rowsFlipped) { // stored bottom-up (canvas flipY layout): hash top-down like a canvas
    const row = img.width * 4, out = new Uint8Array(img.data.length);
    for (let y = 0; y < img.height; y++) out.set(img.data.subarray(y * row, y * row + row), (img.height - 1 - y) * row);
    return out;
  }
  if (img.data) return img.data; // DataTexture: logical top-down rows
  const w = img.width, h = img.height;
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, w, h).data;
}

export async function hashScene(scene, extra = {}) {
  const out = [];
  const seenTex = new Set();
  const jobs = [];
  const add = (label, arr) => jobs.push(sha(arr).then((h) => out.push(`${label}:${arr.length}:${h}`)));
  scene.traverse((o) => {
    const g = o.geometry;
    if (g) {
      for (const k in g.attributes) { const a = g.attributes[k]; add(`attr.${k}.${a.itemSize}`, a.array); }
      if (g.index) add('index', g.index.array);
      if (g.isInstancedBufferGeometry) out.push(`instanceCount:${g.instanceCount}`);
    }
    if (o.isInstancedMesh) {
      add('instanceMatrix', o.instanceMatrix.array);
      if (o.instanceColor) add('instanceColor', o.instanceColor.array);
      out.push(`count:${o.count}`);
    }
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) for (const key of ['map', 'bumpMap', 'alphaMap', 'normalMap']) {
      const t = m[key];
      if (!t || seenTex.has(t)) continue;
      seenTex.add(t);
      const px = texturePixels(t);
      if (px) add(`tex.${key}.${t.image.width}x${t.image.height}`, px);
    }
    if (o.material && o.material.uniforms) for (const k in o.material.uniforms) {
      const t = o.material.uniforms[k].value;
      if (t && t.isTexture && !t.isRenderTargetTexture && !seenTex.has(t)) { seenTex.add(t); const px = texturePixels(t); if (px) add(`tex.u.${k}`, px); }
    }
  });
  for (const k in extra) if (extra[k]) add('extra.' + k, extra[k]);
  await Promise.all(jobs);
  out.sort();
  const all = await sha(new TextEncoder().encode(out.join('\n')));
  return { all, items: out };
}
