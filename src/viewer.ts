import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Fixture, Load } from './analysis/types';
import type { Vec3 } from './analysis/vec';

export interface PickResult {
  point: Vec3;
  normal: Vec3;
}

const BASE_COLOR = new THREE.Color(0xb8c4d6);
const OVERHANG_COLOR = new THREE.Color(0xe5484d);
const CONTACT_COLOR = new THREE.Color(0x30a46c);

/** Three.js scene: build plate (Z up), the part, and force / fixture markers. */
export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  private labels: CSS2DRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private plate = new THREE.Group();
  /** Holds the part; rotated to preview a print orientation. */
  private modelGroup = new THREE.Group();
  private markers = new THREE.Group();
  private mesh: THREE.Mesh | null = null;
  private raycaster = new THREE.Raycaster();
  private size = 100;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    container.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'label-layer';
    container.appendChild(this.labels.domElement);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 10000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(160, -200, 140);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(1, -1.5, 2);
    this.camera.add(sun); // light follows the camera so every side is readable
    this.scene.add(this.camera);
    this.scene.add(this.plate);
    this.scene.add(this.modelGroup);
    this.modelGroup.add(this.markers);
    this.buildPlate(220);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.labels.render(this.scene, this.camera);
    });
  }

  private resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / Math.max(h, 1);
    this.camera.updateProjectionMatrix();
  }

  private buildPlate(size: number) {
    this.plate.clear();
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshStandardMaterial({ color: 0x2a3140, roughness: 0.9, transparent: true, opacity: 0.55 }),
    );
    plane.position.z = -0.05;
    this.plate.add(plane);
    const divisions = Math.max(4, Math.round(size / 10));
    const grid = new THREE.GridHelper(size, divisions, 0x6b7a95, 0x3b4558);
    grid.rotation.x = Math.PI / 2;
    this.plate.add(grid);
    const axes = new THREE.AxesHelper(size * 0.12);
    axes.position.set(-size / 2, -size / 2, 0.1);
    this.plate.add(axes);
  }

  setGeometry(geometry: THREE.BufferGeometry) {
    if (this.mesh) {
      this.modelGroup.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    const count = geometry.getAttribute('position').count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) BASE_COLOR.toArray(colors, i * 3);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05, flatShading: true }),
    );
    this.modelGroup.add(this.mesh);

    this.size = geometry.boundingSphere!.radius * 2;
    this.buildPlate(Math.max(220, Math.ceil((this.size * 1.6) / 10) * 10));
    this.setUp([0, 0, 1]);
    this.frame();
  }

  /** Orient the part so model-frame direction `up` points to +Z and rest it on the plate. */
  setUp(up: Vec3) {
    if (!this.mesh) return;
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(...up).normalize(), new THREE.Vector3(0, 0, 1));
    this.modelGroup.quaternion.copy(q);
    this.modelGroup.position.set(0, 0, 0);
    this.modelGroup.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.mesh);
    this.modelGroup.position.z = -box.min.z;
    this.modelGroup.updateMatrixWorld(true);
  }

  /** Colour faces: 0 = normal, 1 = overhang (needs support), 2 = on the plate. `null` clears. */
  setFaceClasses(classes: Uint8Array | null) {
    if (!this.mesh) return;
    const attr = this.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    const tris = arr.length / 9;
    for (let t = 0; t < tris; t++) {
      const c = !classes || classes[t] === 0 ? BASE_COLOR : classes[t] === 1 ? OVERHANG_COLOR : CONTACT_COLOR;
      for (let v = 0; v < 3; v++) c.toArray(arr, t * 9 + v * 3);
    }
    attr.needsUpdate = true;
  }

  frame() {
    const target = new THREE.Vector3();
    if (this.mesh) new THREE.Box3().setFromObject(this.mesh).getCenter(target);
    const d = this.size * 1.5 + 30;
    this.controls.target.copy(target);
    this.camera.position.set(target.x + d * 0.6, target.y - d * 0.75, target.z + d * 0.55);
    this.camera.near = Math.max(0.1, this.size / 1000);
    this.camera.far = this.size * 100 + 2000;
    this.camera.updateProjectionMatrix();
  }

  /** Raycast a pointer event onto the part; returns the hit in the model frame. */
  pick(event: PointerEvent): PickResult | null {
    if (!this.mesh) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.mesh, false)[0];
    if (!hit || !hit.face) return null;
    const local = this.modelGroup.worldToLocal(hit.point.clone());
    const n = hit.face.normal.clone().normalize(); // mesh has identity transform inside the group
    return { point: [local.x, local.y, local.z], normal: [n.x, n.y, n.z] };
  }

  setMarkers(loads: Load[], fixtures: Fixture[], selected: string | null) {
    for (const child of [...this.markers.children]) {
      // ArrowHelper shares its geometry between instances, so only dispose our own meshes.
      if (child instanceof CSS2DObject) child.element.remove();
      else if (child instanceof THREE.Mesh) child.geometry.dispose();
    }
    this.markers.clear();
    const maxMag = Math.max(1, ...loads.map((l) => l.magnitude ?? 0));
    const anyMag = loads.some((l) => l.magnitude != null);
    const base = Math.max(this.size * 0.28, 8);

    loads.forEach((load, i) => {
      const key = `load-${load.id}`;
      const rel = anyMag ? 0.35 + 0.65 * ((load.magnitude ?? maxMag * 0.5) / maxMag) : 1;
      const len = base * rel;
      const dir = new THREE.Vector3(...load.direction).normalize();
      const p = new THREE.Vector3(...load.point);
      const n = new THREE.Vector3(...load.normal);
      // Pushing forces: arrow tip touches the surface. Pulling forces: tail on the surface.
      const pushing = dir.dot(n) < 0;
      const origin = pushing ? p.clone().addScaledVector(dir, -len) : p.clone();
      const color = selected === key ? 0xffd166 : 0xff7a1a;
      const arrow = new THREE.ArrowHelper(dir, origin, len, color, len * 0.28, len * 0.14);
      (arrow.line.material as THREE.LineBasicMaterial).linewidth = 2;
      this.markers.add(arrow);

      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(Math.max(this.size * 0.012, 0.6), 16, 12),
        new THREE.MeshBasicMaterial({ color }),
      );
      dot.position.copy(p);
      this.markers.add(dot);

      const label = document.createElement('div');
      label.className = `marker-label load${selected === key ? ' selected' : ''}`;
      label.textContent = `F${i + 1}${load.magnitude != null ? ` · ${load.magnitude} N` : ''}`;
      const obj = new CSS2DObject(label);
      obj.position.copy(pushing ? origin : p.clone().addScaledVector(dir, len));
      this.markers.add(obj);
    });

    fixtures.forEach((fx, i) => {
      const key = `fix-${fx.id}`;
      const r = Math.max(this.size * 0.025, 1.2);
      const cube = new THREE.Mesh(
        new THREE.OctahedronGeometry(r),
        new THREE.MeshStandardMaterial({ color: selected === key ? 0xffd166 : 0x3e8bff, emissive: 0x0b2a66 }),
      );
      cube.position.set(...fx.point);
      this.markers.add(cube);
      const label = document.createElement('div');
      label.className = `marker-label fixture${selected === key ? ' selected' : ''}`;
      label.textContent = `Fix ${i + 1}`;
      const obj = new CSS2DObject(label);
      obj.position.set(fx.point[0], fx.point[1], fx.point[2]);
      obj.center.set(0.5, -0.6);
      this.markers.add(obj);
    });
  }

  /** The part's triangles in the current (displayed) orientation, resting on Z = 0. */
  orientedGeometry(): THREE.BufferGeometry | null {
    if (!this.mesh) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', this.mesh.geometry.getAttribute('position').clone());
    this.modelGroup.updateMatrixWorld(true);
    g.applyMatrix4(this.mesh.matrixWorld);
    return g;
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }
}
