import './styles.css';
import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { classifyFaces, optimize, prepareMesh, type PreparedMesh } from './analysis/optimizer';
import { DEFAULT_SETTINGS, type Candidate, type Fixture, type Load, type OptimizerSettings } from './analysis/types';
import { normalize, scale, type Vec3 } from './analysis/vec';
import type { WorkerRequest, WorkerResponse } from './analysis/worker';
import { loadModelFile } from './loaders';
import { sampleBracket } from './sample';
import { Viewer } from './viewer';

type Mode = 'orbit' | 'load' | 'fixture';
type DirMode = 'push' | 'pull' | 'down' | 'custom';

interface LoadItem extends Load {
  dirMode: DirMode;
  custom: Vec3;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const state = {
  fileName: 'part',
  prepared: null as PreparedMesh | null,
  positions: null as Float32Array | null,
  loads: [] as LoadItem[],
  fixtures: [] as Fixture[],
  nextId: 1,
  mode: 'orbit' as Mode,
  selected: null as string | null,
  settings: structuredClone(DEFAULT_SETTINGS) as OptimizerSettings,
  results: [] as Candidate[],
  active: -1,
  stale: false,
};

const viewer = new Viewer($('stage'));

// ---------- helpers ----------

function toast(message: string, isError = false) {
  const el = $('toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout((toast as unknown as { t?: number }).t);
  (toast as unknown as { t?: number }).t = window.setTimeout(() => (el.hidden = true), 4500);
}

const fmt = (v: number, digits = 1) =>
  Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(digits).replace(/\.0+$/, '');

function areaText(mm2: number) {
  return mm2 >= 100 ? `${fmt(mm2 / 100)} cm²` : `${fmt(mm2)} mm²`;
}

function resolveDirection(l: LoadItem): Vec3 {
  switch (l.dirMode) {
    case 'push': return scale(l.normal, -1);
    case 'pull': return [...l.normal];
    case 'down': return [0, 0, -1];
    case 'custom': return normalize(l.custom);
  }
}

function describeUp(up: Vec3): string {
  const axes: [Vec3, string][] = [
    [[1, 0, 0], '+X'], [[-1, 0, 0], '−X'], [[0, 1, 0], '+Y'],
    [[0, -1, 0], '−Y'], [[0, 0, 1], '+Z'], [[0, 0, -1], '−Z'],
  ];
  for (const [a, name] of axes) {
    if (a[0] * up[0] + a[1] * up[1] + a[2] * up[2] > Math.cos((3 * Math.PI) / 180)) {
      return name === '+Z' ? 'Same as imported (+Z up)' : `Model's ${name} axis points up`;
    }
  }
  return `Up vector (${up.map((v) => v.toFixed(2)).join(', ')})`;
}

function setEnabled(enabled: boolean) {
  for (const id of ['loads-card', 'settings-card']) $(id).dataset.disabled = String(!enabled);
}

// ---------- model import ----------

function useGeometry(geometry: THREE.BufferGeometry, name: string) {
  state.fileName = name.replace(/\.[^.]+$/, '');
  state.positions = Float32Array.from(geometry.getAttribute('position').array as ArrayLike<number>);
  state.prepared = prepareMesh(state.positions);
  state.loads = [];
  state.fixtures = [];
  state.results = [];
  state.active = -1;
  state.selected = null;
  viewer.setGeometry(geometry);
  $('empty-state').hidden = true;
  $('results-card').hidden = true;

  const bb = geometry.boundingBox!;
  const s = new THREE.Vector3();
  bb.getSize(s);
  const info = $('model-info');
  info.hidden = false;
  info.innerHTML = `
    <div><b>${escapeHtml(name)}</b></div>
    <div>${fmt(s.x)} × ${fmt(s.y)} × ${fmt(s.z)} mm · ${state.prepared.triCount.toLocaleString()} triangles</div>
    <div>Volume ${fmt(state.prepared.volume / 1000, 2)} cm³</div>`;
  setEnabled(true);
  setMode('load');
  renderLists();
}

async function importFile(file: File) {
  try {
    const geometry = await loadModelFile(file);
    useGeometry(geometry, file.name);
    toast('Part loaded. Click on it to place a force.');
  } catch (err) {
    console.error(err);
    toast(err instanceof Error ? err.message : 'Could not read that file.', true);
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const fileInput = $<HTMLInputElement>('file-input');
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) importFile(f);
  fileInput.value = '';
});
const dropzone = $('dropzone');
for (const target of [dropzone, $('stage')]) {
  target.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('over'); });
  target.addEventListener('dragleave', () => dropzone.classList.remove('over'));
  target.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('over');
    const f = (e as DragEvent).dataTransfer?.files[0];
    if (f) importFile(f);
  });
}
$('sample-btn').addEventListener('click', () => useGeometry(sampleBracket(), 'L-bracket (sample)'));

// ---------- click modes ----------

const MODE_HINTS: Record<Mode, string> = {
  orbit: 'Drag to orbit, right-drag to pan, scroll to zoom.',
  load: 'Click the part where a force acts. By default it pushes into the surface — change it in the list below.',
  fixture: 'Click where the part is bolted, clamped or resting. Forces are resisted by the nearest fixture.',
};

function setMode(mode: Mode) {
  state.mode = mode;
  document.querySelectorAll<HTMLButtonElement>('.segmented button').forEach((b) =>
    b.classList.toggle('active', b.dataset.mode === mode));
  $('mode-hint').innerHTML = MODE_HINTS[mode];
  viewer.canvas.style.cursor = mode === 'orbit' ? 'grab' : 'crosshair';
}
document.querySelectorAll<HTMLButtonElement>('.segmented button').forEach((b) =>
  b.addEventListener('click', () => setMode(b.dataset.mode as Mode)));

let downAt: { x: number; y: number } | null = null;
viewer.canvas.addEventListener('pointerdown', (e) => (downAt = { x: e.clientX, y: e.clientY }));
viewer.canvas.addEventListener('pointerup', (e) => {
  if (!downAt || e.button !== 0) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  downAt = null;
  if (moved > 5 || state.mode === 'orbit' || !state.prepared) return;
  const hit = viewer.pick(e);
  if (!hit) return;
  const id = state.nextId++;
  if (state.mode === 'load') {
    const item: LoadItem = {
      id, point: hit.point, normal: hit.normal, direction: scale(hit.normal, -1),
      magnitude: null, dirMode: 'push', custom: scale(hit.normal, -1).map((v) => +v.toFixed(2)) as Vec3,
    };
    state.loads.push(item);
    state.selected = `load-${id}`;
  } else {
    state.fixtures.push({ id, point: hit.point });
    state.selected = `fix-${id}`;
  }
  markStale();
  renderLists();
});

// ---------- force / fixture lists ----------

function refreshMarkers() {
  viewer.setMarkers(state.loads, state.fixtures, state.selected);
}

function markStale() {
  if (state.results.length) {
    state.stale = true;
    renderResults();
  }
}

function renderLists() {
  const loadList = $('load-list');
  loadList.innerHTML = state.loads.length
    ? `<h3>Forces</h3>`
    : `<p class="empty-list">No forces yet. Without forces the optimizer only minimises support, height and adhesion problems.</p>`;
  state.loads.forEach((l, i) => {
    const el = document.createElement('div');
    el.className = `item${state.selected === `load-${l.id}` ? ' selected' : ''}`;
    el.innerHTML = `
      <div class="item-head">
        <span class="badge load">F${i + 1}</span>
        <span class="muted">at (${l.point.map((v) => fmt(v)).join(', ')})</span>
        <button class="icon" data-act="del" title="Remove force" aria-label="Remove force">×</button>
      </div>
      <div class="item-grid">
        <label>Force <span class="unit-input"><input type="number" min="0" step="any" data-act="mag" placeholder="optional" value="${l.magnitude ?? ''}" /> N</span></label>
        <label>Direction
          <select data-act="dir">
            <option value="push">Push into surface</option>
            <option value="pull">Pull away from surface</option>
            <option value="down">Downward (−Z, e.g. weight)</option>
            <option value="custom">Custom vector…</option>
          </select>
        </label>
      </div>
      <div class="vec-row" ${l.dirMode === 'custom' ? '' : 'hidden'}>
        ${['X', 'Y', 'Z'].map((a, k) => `<label>${a}<input type="number" step="0.1" data-act="vec" data-k="${k}" value="${l.custom[k]}" /></label>`).join('')}
      </div>`;
    (el.querySelector('[data-act=dir]') as HTMLSelectElement).value = l.dirMode;
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).dataset.act === 'del') {
        state.loads = state.loads.filter((x) => x !== l);
        markStale();
        renderLists();
        return;
      }
      if (state.selected !== `load-${l.id}`) {
        state.selected = `load-${l.id}`;
        loadList.querySelectorAll('.item').forEach((n) => n.classList.toggle('selected', n === el));
        $('fixture-list').querySelectorAll('.item').forEach((n) => n.classList.remove('selected'));
        refreshMarkers();
      }
    });
    el.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.act === 'mag') {
        const v = parseFloat(t.value);
        l.magnitude = Number.isFinite(v) && v > 0 ? v : null;
      } else if (t.dataset.act === 'dir') {
        l.dirMode = t.value as DirMode;
        (el.querySelector('.vec-row') as HTMLElement).hidden = l.dirMode !== 'custom';
      } else if (t.dataset.act === 'vec') {
        l.custom[Number(t.dataset.k)] = parseFloat(t.value) || 0;
      }
      l.direction = resolveDirection(l);
      markStale();
      refreshMarkers();
    });
    loadList.appendChild(el);
  });

  const fixList = $('fixture-list');
  fixList.innerHTML = state.fixtures.length ? `<h3>Fixtures</h3>` : '';
  state.fixtures.forEach((f, i) => {
    const el = document.createElement('div');
    el.className = `item compact${state.selected === `fix-${f.id}` ? ' selected' : ''}`;
    el.innerHTML = `
      <div class="item-head">
        <span class="badge fixture">Fix ${i + 1}</span>
        <span class="muted">at (${f.point.map((v) => fmt(v)).join(', ')})</span>
        <button class="icon" data-act="del" title="Remove fixture" aria-label="Remove fixture">×</button>
      </div>`;
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).dataset.act === 'del') {
        state.fixtures = state.fixtures.filter((x) => x !== f);
        markStale();
        renderLists();
        return;
      }
      state.selected = `fix-${f.id}`;
      renderLists();
    });
    fixList.appendChild(el);
  });
  if (state.loads.length && !state.fixtures.length) {
    fixList.innerHTML = `<p class="empty-list">Tip: add a <b>fixture</b> where the part is held. Otherwise forces are assumed to be resisted at the part's centre.</p>`;
  }
  refreshMarkers();
}

// ---------- settings ----------

const sliders: [string, keyof OptimizerSettings['weights']][] = [
  ['w-strength', 'strength'], ['w-support', 'support'], ['w-height', 'height'], ['w-adhesion', 'adhesion'],
];
for (const [id, key] of sliders) {
  const input = $<HTMLInputElement>(id);
  const out = input.nextElementSibling as HTMLOutputElement;
  input.value = String(state.settings.weights[key]);
  out.value = `${Math.round(state.settings.weights[key] * 100)}%`;
  input.addEventListener('input', () => {
    state.settings.weights[key] = parseFloat(input.value);
    out.value = `${Math.round(parseFloat(input.value) * 100)}%`;
    markStale();
  });
}
const overhangInput = $<HTMLInputElement>('overhang');
overhangInput.value = String(state.settings.overhangAngleDeg);
overhangInput.addEventListener('change', () => {
  state.settings.overhangAngleDeg = Math.min(80, Math.max(10, parseFloat(overhangInput.value) || 45));
  overhangInput.value = String(state.settings.overhangAngleDeg);
  markStale();
  applyActive();
});
const ratioInput = $<HTMLInputElement>('layer-ratio');
ratioInput.value = String(state.settings.layerStrengthRatio);
ratioInput.addEventListener('change', () => {
  state.settings.layerStrengthRatio = Math.min(1, Math.max(0.1, parseFloat(ratioInput.value) || 0.5));
  ratioInput.value = String(state.settings.layerStrengthRatio);
  markStale();
});

// ---------- optimisation ----------

let worker: Worker | null = null;

function runOptimizer() {
  if (!state.positions) return;
  worker?.terminate();
  const btn = $<HTMLButtonElement>('optimize-btn');
  const progress = $('progress');
  const bar = progress.firstElementChild as HTMLElement;
  btn.disabled = true;
  btn.textContent = 'Analysing…';
  progress.hidden = false;
  bar.style.width = '0%';

  const handle = (msg: WorkerResponse) => {
    if (msg.type === 'progress') {
      bar.style.width = `${Math.round(msg.fraction * 100)}%`;
      return;
    }
    btn.disabled = false;
    btn.textContent = 'Find best orientation';
    progress.hidden = true;
    worker?.terminate();
    worker = null;
    if (msg.type === 'error') {
      toast(`Analysis failed: ${msg.message}`, true);
      return;
    }
    state.results = msg.result.candidates;
    state.stale = false;
    state.active = 0;
    renderResults();
    applyActive();
    const ms = msg.result.elapsedMs;
    toast(`Checked ${msg.result.evaluated.toLocaleString()} orientations in ${ms < 1000 ? `${Math.round(ms)} ms` : `${fmt(ms / 1000, 1)} s`}.`);
    $('results-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const request: WorkerRequest = {
    positions: state.positions,
    loads: state.loads.map(({ id, point, normal, direction, magnitude }) => ({ id, point, normal, direction, magnitude })),
    fixtures: state.fixtures,
    settings: state.settings,
  };
  // Fallback when the page may not start workers (e.g. a sandboxed host): run on the main thread.
  const runInline = () =>
    setTimeout(() => {
      try {
        handle({ type: 'done', result: optimize(request.positions, request.loads, request.fixtures, request.settings) });
      } catch (err) {
        handle({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    }, 30);

  try {
    worker = new Worker(new URL('./analysis/worker.ts', import.meta.url), { type: 'module' });
  } catch {
    runInline();
    return;
  }
  worker.onmessage = (e: MessageEvent<WorkerResponse>) => handle(e.data);
  worker.onerror = (e) => {
    e.preventDefault();
    worker?.terminate();
    worker = null;
    runInline();
  };
  worker.postMessage(request);
}
$('optimize-btn').addEventListener('click', runOptimizer);

function reasons(c: Candidate, maxContact: number): string[] {
  const out: string[] = [];
  const m = c.metrics;
  if (state.loads.length) {
    const eff = m.strengthEfficiency;
    out.push(eff > 0.9
      ? 'Forces run along the layers — layer lines are not pulled apart.'
      : eff > 0.7
        ? 'Forces are partly across layers — acceptable strength.'
        : 'Forces pull across layer lines — weakest direction for FDM.');
  }
  if (m.overhangArea < 1) out.push('No support needed.');
  if (m.contactArea > 0 && m.contactArea >= maxContact * 0.95) out.push('Largest flat face on the bed.');
  else if (m.contactArea === 0) out.push('Only an edge or point touches the bed — use a brim.');
  return out;
}

function renderResults() {
  const card = $('results-card');
  const list = $('results');
  card.hidden = state.results.length === 0;
  if (!state.results.length) return;
  const maxContact = Math.max(...state.results.map((r) => r.metrics.contactArea));
  list.innerHTML = state.stale
    ? `<p class="stale">Inputs changed since this analysis — click <b>Find best orientation</b> again to update.</p>`
    : '';
  state.results.forEach((c, i) => {
    const m = c.metrics;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `result${state.active === i ? ' active' : ''}`;
    const effPct = Math.round(m.strengthEfficiency * 100);
    el.innerHTML = `
      <div class="result-head">
        <span class="rank">${i === 0 ? '★ Best' : `#${i + 1}`}</span>
        <span class="rot">Rotate <b>X ${fmt(c.rotation.x)}°</b>, then <b>Y ${fmt(c.rotation.y)}°</b></span>
      </div>
      <div class="muted small">${describeUp(c.up)}</div>
      ${state.loads.length ? `
      <div class="meter" title="How much of the load is carried along the strong in-layer direction">
        <span>Strength</span><div class="track"><div class="${effPct >= 90 ? 'good' : effPct >= 70 ? 'ok' : 'bad'}" style="width:${effPct}%"></div></div><b>${effPct}%</b>
      </div>` : ''}
      <div class="stats">
        <div><span>Support</span><b>${m.overhangArea < 1 ? 'none' : areaText(m.overhangArea)}</b></div>
        <div><span>Height</span><b>${fmt(m.height)} mm</b></div>
        <div><span>Bed contact</span><b>${areaText(m.contactArea)}</b></div>
      </div>
      <ul class="reasons">${reasons(c, maxContact).map((r) => `<li>${r}</li>`).join('')}</ul>`;
    el.addEventListener('click', () => {
      state.active = i;
      renderResults();
      applyActive();
    });
    list.appendChild(el);
  });
  $('original-btn').classList.toggle('active', state.active === -1);
}

function applyActive() {
  if (!state.prepared) return;
  const up: Vec3 = state.active >= 0 && state.results[state.active] ? state.results[state.active].up : [0, 0, 1];
  viewer.setUp(up);
  const show = $<HTMLInputElement>('show-overhang').checked && state.results.length > 0;
  viewer.setFaceClasses(show ? classifyFaces(state.prepared, up, state.settings.overhangAngleDeg) : null);
}

$('original-btn').addEventListener('click', () => {
  state.active = -1;
  renderResults();
  applyActive();
});
$('show-overhang').addEventListener('change', applyActive);

$('export-btn').addEventListener('click', () => {
  const g = viewer.orientedGeometry();
  if (!g) return;
  const data = new STLExporter().parse(new THREE.Mesh(g), { binary: true }) as DataView;
  const blob = new Blob([data.buffer as ArrayBuffer], { type: 'model/stl' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.fileName}_oriented.stl`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  g.dispose();
});

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest('input, select, textarea')) return;
  if (e.key === 'Escape') setMode('orbit');
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected) {
    const [kind, id] = state.selected.split('-');
    if (kind === 'load') state.loads = state.loads.filter((l) => l.id !== Number(id));
    else state.fixtures = state.fixtures.filter((f) => f.id !== Number(id));
    state.selected = null;
    markStale();
    renderLists();
  }
});

setEnabled(false);
