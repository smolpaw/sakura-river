// BufferGeometry <-> plain transferable data
import * as THREE from 'three';

export function packGeo(g, transfer) {
  const attrs = {};
  for (const k in g.attributes) {
    const a = g.attributes[k];
    attrs[k] = { array: a.array, itemSize: a.itemSize, normalized: a.normalized };
    transfer.add(a.array.buffer);
  }
  const index = g.index ? g.index.array : null;
  if (index) transfer.add(index.buffer);
  const bs = g.boundingSphere ? [g.boundingSphere.center.x, g.boundingSphere.center.y, g.boundingSphere.center.z, g.boundingSphere.radius] : null;
  return { geo: true, attrs, index, bs, groups: g.groups };
}

export function unpackGeo(d) {
  const g = new THREE.BufferGeometry();
  for (const k in d.attrs) { const a = d.attrs[k]; g.setAttribute(k, new THREE.BufferAttribute(a.array, a.itemSize, a.normalized)); }
  if (d.index) g.setIndex(new THREE.BufferAttribute(d.index, 1));
  if (d.bs) g.boundingSphere = new THREE.Sphere(new THREE.Vector3(d.bs[0], d.bs[1], d.bs[2]), d.bs[3]);
  for (const gr of d.groups) g.addGroup(gr.start, gr.count, gr.materialIndex);
  return g;
}

// walk a job result: geometries become packed descriptors, typed arrays are transferred
export function packDeep(v, transfer) {
  if (v && v.isBufferGeometry) return packGeo(v, transfer);
  if (ArrayBuffer.isView(v)) { transfer.add(v.buffer); return v; }
  if (Array.isArray(v)) return v.map((x) => packDeep(x, transfer));
  if (v && typeof v === 'object' && v.constructor === Object) { const o = {}; for (const k in v) o[k] = packDeep(v[k], transfer); return o; }
  return v;
}

export function unpackDeep(v) {
  if (v && v.geo === true && v.attrs) return unpackGeo(v);
  if (Array.isArray(v)) return v.map(unpackDeep);
  if (v && typeof v === 'object' && v.constructor === Object) { const o = {}; for (const k in v) o[k] = unpackDeep(v[k]); return o; }
  return v;
}
