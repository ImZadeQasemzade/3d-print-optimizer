import * as THREE from 'three';

/** A simple L-bracket (60 × 30 × 45 mm, 6 mm walls) so the app can be tried without a file. */
export function sampleBracket(): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(60, 0);
  shape.lineTo(60, 6);
  shape.lineTo(6, 6);
  shape.lineTo(6, 45);
  shape.lineTo(0, 45);
  shape.closePath();
  let g: THREE.BufferGeometry = new THREE.ExtrudeGeometry(shape, { depth: 30, bevelEnabled: false });
  g.rotateX(Math.PI / 2); // profile in XZ, extruded along -Y
  if (g.index) g = g.toNonIndexed();
  for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name);
  g.computeBoundingBox();
  const c = new THREE.Vector3();
  g.boundingBox!.getCenter(c);
  g.translate(-c.x, -c.y, -c.z);
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}
