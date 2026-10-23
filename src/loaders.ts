import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';

/**
 * Load an STL or 3MF file into a single, non-indexed, position-only geometry
 * centred on the origin (X/Y centred, Z centred too — placement on the build
 * plate happens later, per orientation).
 */
export async function loadModelFile(file: File): Promise<THREE.BufferGeometry> {
  const ext = file.name.split('.').pop()?.toLowerCase();
  const buffer = await file.arrayBuffer();
  let geometry: THREE.BufferGeometry;

  if (ext === 'stl') {
    geometry = new STLLoader().parse(buffer);
  } else if (ext === '3mf') {
    const group = new ThreeMFLoader().parse(buffer);
    geometry = mergeGroup(group);
  } else {
    throw new Error(`Unsupported file type ".${ext}". Please use .stl or .3mf.`);
  }

  geometry = geometry.index ? geometry.toNonIndexed() : geometry;
  for (const name of Object.keys(geometry.attributes)) {
    if (name !== 'position') geometry.deleteAttribute(name);
  }
  if (geometry.getAttribute('position').count < 3) throw new Error('The file contains no triangles.');

  geometry.computeBoundingBox();
  const center = new THREE.Vector3();
  geometry.boundingBox!.getCenter(center);
  geometry.translate(-center.x, -center.y, -center.z);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Flatten every mesh of a 3MF scene (with its build transforms) into one geometry. */
function mergeGroup(group: THREE.Object3D): THREE.BufferGeometry {
  group.updateMatrixWorld(true);
  const chunks: Float32Array[] = [];
  let total = 0;
  group.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    let g = mesh.geometry.clone();
    g.applyMatrix4(mesh.matrixWorld);
    if (g.index) g = g.toNonIndexed();
    const arr = g.getAttribute('position').array as Float32Array;
    chunks.push(Float32Array.from(arr));
    total += arr.length;
  });
  if (total === 0) throw new Error('No meshes found in the 3MF file.');
  const merged = new Float32Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(merged, 3));
  return geometry;
}
