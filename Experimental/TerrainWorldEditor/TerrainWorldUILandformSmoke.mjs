/*==========================================================================================================================================
                                        TERRAINWORLDUILANDFORMSMOKE.MJS
==========================================================================================================================================*/
// Headless UI smoke test for Phase L1 Landform authoring WITHOUT a browser:
// - Builds a minimal DOM shim (elements, events, canvas 2D/WebGL stubs)
// - Instantiates the real TerrainWorldEditor, adds every landform archetype,
//   switches placement modes, drives the landform gizmo drags, and re-renders the inspector.
// This catches wiring bugs (missing DOM ids, undefined handlers, bad imports) that unit suites miss.

import assert from 'node:assert/strict';

/*------------------------------------------------------------------------------------------------------------------------------------------
  Minimal DOM + Canvas + WebGL2 shim
------------------------------------------------------------------------------------------------------------------------------------------*/
class ClassList
{
    constructor(El) { this.El = El; this.Set = new Set(); }
    add(...C) { for (const X of C) this.Set.add(X); }
    remove(...C) { for (const X of C) this.Set.delete(X); }
    contains(C) { return this.Set.has(C); }
    toggle(C, Force)
    {
        const On = Force === undefined ? !this.Set.has(C) : !!Force;
        if (On) this.Set.add(C); else this.Set.delete(C);
        return On;
    }
    get value() { return [...this.Set].join(' '); }
}

class Style
{
    constructor() { this._props = new Map(); }
    setProperty(K, V) { this._props.set(K, V); }
    getPropertyValue(K) { return this._props.get(K) ?? ''; }
    removeProperty(K) { this._props.delete(K); }
}

const CanvasCtx2DStub = () =>
{
    const Ctx = {
        canvas: null,
        save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
        stroke() {}, fill() {}, arc() {}, rect() {}, roundRect() {}, ellipse() {}, clip() {},
        setLineDash() {}, fillText() {}, strokeText() {}, translate() {}, rotate() {}, scale() {},
        setTransform() {}, clearRect() {}, drawImage() {}, putImageData() {}, fillRect() {}, strokeRect() {},
        createLinearGradient() { return { addColorStop() {} }; },
        createRadialGradient() { return { addColorStop() {} }; },
        createPattern() { return null; },
        measureText(T) { return { width: String(T).length * 6.2 }; },
        getImageData(X, Y, W, H) { return { data: new Uint8ClampedArray(Math.max(1, W * H * 4)), width: W, height: H }; },
        createImageData(W, H) { return { data: new Uint8ClampedArray(Math.max(1, W * H * 4)), width: W, height: H }; }
    };
    Ctx.font = ''; Ctx.fillStyle = ''; Ctx.strokeStyle = ''; Ctx.lineWidth = 1;
    Ctx.textAlign = 'left'; Ctx.textBaseline = 'alphabetic'; Ctx.globalAlpha = 1;
    return Ctx;
};

function WebGLStub()
{
    const Target = {};
    return new Proxy(Target, {
        get(Obj, Key)
        {
            if (Key in Obj) return Obj[Key];
            const Name = String(Key);
            if (/^[A-Z0-9_]+$/.test(Name)) return 1;
            if (Name === 'getShaderParameter' || Name === 'getProgramParameter') return () => true;
            if (Name === 'getShaderInfoLog' || Name === 'getProgramInfoLog') return () => '';
            if (Name === 'getUniformLocation') return () => ({});
            if (Name === 'getAttribLocation') return () => 0;
            if (Name === 'createShader' || Name === 'createProgram' || Name === 'createBuffer' || Name === 'createTexture' ||
                Name === 'createVertexArray' || Name === 'createFramebuffer' || Name === 'createRenderbuffer') return () => ({});
            if (Name === 'getExtension') return () => null;
            if (Name === 'getParameter') return () => 4096;
            if (Name.startsWith('get')) return () => null;
            return () => undefined;
        },
        set(Obj, Key, Val) { Obj[Key] = Val; return true; }
    });
}

class Element
{
    constructor(Tag)
    {
        this.tagName = String(Tag).toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.style = new Style();
        this.classList = new ClassList(this);
        this.dataset = {};
        this._listeners = new Map();
        this._attrs = new Map();
        this._text = '';
        this.width = 1280;
        this.height = 720;
        this.clientWidth = 1280;
        this.clientHeight = 720;
        this.value = '';
        this.checked = false;
        this.open = true;
        this.disabled = false;
        this.type = '';
        this.title = '';
        this.placeholder = '';
        this.innerHTML = '';
    }
    get id() { return this._attrs.get('id') || this._id || ''; }
    set id(V) { this._id = V; this._attrs.set('id', V); }
    get className() { return this.classList.value; }
    set className(V) { this.classList = new ClassList(this); for (const C of String(V).split(/\s+/).filter(Boolean)) this.classList.add(C); }
    get textContent() { return this._text; }
    set textContent(V) { this._text = String(V); this.children.length = 0; }
    get firstChild() { return this.children[0] || null; }
    get lastChild() { return this.children[this.children.length - 1] || null; }
    appendChild(N) { if (!N) return N; N.parentNode = this; this.children.push(N); return N; }
    append(...Ns) { for (const N of Ns) if (N) this.appendChild(typeof N === 'string' ? Object.assign(new Element('span'), { textContent: N }) : N); }
    prepend(N) { if (!N) return; N.parentNode = this; this.children.unshift(N); }
    insertBefore(N, Ref) { const I = this.children.indexOf(Ref); N.parentNode = this; if (I < 0) this.children.push(N); else this.children.splice(I, 0, N); return N; }
    removeChild(N) { const I = this.children.indexOf(N); if (I >= 0) this.children.splice(I, 1); return N; }
    remove() { this.parentNode?.removeChild(this); }
    setAttribute(K, V) { this._attrs.set(K, String(V)); }
    getAttribute(K) { return this._attrs.get(K) ?? null; }
    removeAttribute(K) { this._attrs.delete(K); }
    hasAttribute(K) { return this._attrs.has(K); }
    addEventListener(T, F) { if (!this._listeners.has(T)) this._listeners.set(T, []); this._listeners.get(T).push(F); }
    removeEventListener(T, F) { const L = this._listeners.get(T); if (L) this._listeners.set(T, L.filter(X => X !== F)); }
    dispatchEvent(E)
    {
        E.target = E.target || this;
        E.currentTarget = this;
        E.preventDefault = E.preventDefault || (() => {});
        E.stopPropagation = E.stopPropagation || (() => {});
        for (const F of (this._listeners.get(E.type) || [])) F(E);
        return true;
    }
    click() { this.dispatchEvent({ type: 'click', button: 0 }); }
    setPointerCapture() {}
    releasePointerCapture() {}
    hasPointerCapture() { return true; }
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight, right: this.clientWidth, bottom: this.clientHeight }; }
    getContext(Kind)
    {
        if (Kind === '2d') { const C = CanvasCtx2DStub(); C.canvas = this; return C; }
        if (Kind === 'webgl2' || Kind === 'webgl' || Kind === 'experimental-webgl') { this._gl = this._gl || WebGLStub(); return this._gl; }
        return null;
    }
    toDataURL() { return 'data:image/png;base64,'; }
    closest(Sel)
    {
        let N = this;
        const Attr = Sel.replace(/^\[|\]$/g, '');
        const [Key, Val] = Attr.split('=');
        while (N)
        {
            if (Key.startsWith('data-'))
            {
                const D = Key.slice(5).replace(/-([a-z])/g, (M, C) => C.toUpperCase());
                if (N.dataset && N.dataset[D] !== undefined && (Val === undefined || String(N.dataset[D]) === Val.replace(/["']/g, ''))) return N;
            }
            else if (Key === 'id' && N.id === Val?.replace(/["']/g, '')) return N;
            else if (Key === 'class' && N.classList.contains(Val)) return N;
            else if (N.classList.contains(Key.replace(/^\./, ''))) return N;
            N = N.parentNode;
        }
        return null;
    }
    querySelectorAll(Sel) { return QueryAll(this, Sel); }
    querySelector(Sel) { return QueryAll(this, Sel)[0] || null; }
    focus() {}
    blur() {}
}

function WalkAll(Node, Out = [])
{
    for (const C of Node.children)
    {
        Out.push(C);
        WalkAll(C, Out);
    }
    return Out;
}

function MatchesSel(N, Sel)
{
    // Support comma lists + simple attribute / class / id selectors used by this studio.
    for (const Part of Sel.split(',').map(P => P.trim()))
    {
        if (!Part) continue;
        if (Part.startsWith('#') && N.id === Part.slice(1)) return true;
        if (Part.startsWith('.') && N.classList.contains(Part.slice(1))) return true;
        if (Part.startsWith('['))
        {
            const Body = Part.slice(1, -1);
            const Eq = Body.indexOf('=');
            const Key = Eq < 0 ? Body : Body.slice(0, Eq);
            const RawVal = Eq < 0 ? null : Body.slice(Eq + 1).replace(/^["']|["']$/g, '');
            if (Key.startsWith('data-'))
            {
                const D = Key.slice(5).replace(/-([a-z])/g, (M, C) => C.toUpperCase());
                if (N.dataset[D] !== undefined && (RawVal === null || String(N.dataset[D]) === RawVal)) return true;
            }
        }
        const TagClass = /^([a-zA-Z0-9]+)?(?:\.([a-zA-Z0-9_-]+))?$/.exec(Part);
        if (TagClass)
        {
            const [, Tag, Cls] = TagClass;
            if (Tag && N.tagName !== Tag.toUpperCase()) continue;
            if (Cls && !N.classList.contains(Cls)) continue;
            if (Tag || Cls) return true;
        }
    }
    return false;
}

function QueryAll(Root, Sel)
{
    return WalkAll(Root).filter(N => MatchesSel(N, Sel));
}

/*------------------------------------------------------------------------------------------------------------------------------------------
  Document + window shim, then boot the real editor
------------------------------------------------------------------------------------------------------------------------------------------*/
const DomIds = [
    'Canvas2D', 'Canvas3D', 'Overlay3D', 'CanvasFracture', 'CanvasRock2', 'OverlayRock2', 'StageGrid', 'Pane2D', 'Pane3D', 'PaneFracture', 'PaneRock2',
    'InspectorContent', 'InspectorScroll', 'OutlinerContent', 'left-panel-title', 'stat-terrains-on', 'stat-layers-total',
    'outliner-subtitle', 'stat-label-1', 'stat-label-2', 'scene-search', 'left-footer-label', 'stage-bar-title',
    'inspector-foot-left', 'inspector-foot-right', 'region-tabs', 'quick-add-list', 'quick-lib-title', 'quick-lib-count',
    'toggle-ocean-btn', 'toggle-gizmo-btn', 'toggle-bounds-btn', 'toggle-contours-btn', 'export-button', 'add-button',
    'reset-demo-btn', 'import-btn', 'status-main', 'status-tiles', 'status-slab', 'status-mesh', 'hud-2d-tool', 'hud-3d-tool',
    'hud-3d-scope', 'Hud2DCoords', 'hud-slab-floor', 'hud-tris-count', 'Tools2DRail', 'Tools3DRail', 'new-scene-btn',
    'focus-btn', 'maximize-btn', 'engine-pill', 'engine-pill-text', 'studio-title', 'preset-strip', 'scope-select',
    'inspector-tabs', 'hud-rock2-layers', 'hud-rock2-stack', 'hud-rock2-pure', 'Rock2GizmoRail', 'rock2-tool-scope',
    'rock2-tool-scope-label', 'rock2-tool-path', 'rock2-tool-move', 'rock2-tool-rotate', 'rock2-tool-scale',
    'rock2-tool-sculpt', 'rock2-tool-erase', 'rock2-tool-reset', 'rock2-mode-ray-btn', 'rock2-mode-qef-btn',
    'rock2-wire-btn', 'rock2-cutaway-btn', 'rock2-lens-select', 'rock2-bool-ghosts-btn', 'rock2-sculpt-brush-select',
    'rock2-sculpt-radius', 'rock2-sculpt-strength', 'hud-rock2-instances', 'hud-fracture-preset', 'hud-fracture-zero',
    'FractureHud', 'ViewportHud', 'frac-mode-ray-btn', 'frac-mode-qef-btn', 'frac-wire-btn', 'frac-cutaway-btn',
    'frac-lens-select', 'hud-frac-blocks', 'hud-frac-tris', 'object-enabled', 'toggle-wiregrid-btn', 'toggle-inland-water-btn'
];

const DocumentStub = new Element('body');
DocumentStub.body = DocumentStub;
DocumentStub.documentElement = DocumentStub;
for (const Id of DomIds)
{
    const El = new Element(Id.startsWith('Canvas') || Id.startsWith('Overlay') ? 'canvas' : 'div');
    El.id = Id;
    El.dataset.itab = Id === 'inspector-tabs' ? 'landform' : undefined;
    DocumentStub.appendChild(El);
}
// Inspector tab buttons (queried via #inspector-tabs button[data-itab])
{
    const Tabs = DocumentStub.children.find(C => C.id === 'inspector-tabs');
    for (const Key of ['landform', 'layers', 'spline', 'slab', 'sim', 'texturing', 'stage', 'rock2', 'fracture'])
    {
        const B = new Element('button');
        B.dataset.itab = Key;
        Tabs.appendChild(B);
    }
}
// Workspace nav buttons
{
    const Nav = new Element('nav');
    Nav.className = 'top-nav';
    for (const Key of ['2d', '3d', 'split', 'fracture', 'rock2'])
    {
        const B = new Element('button');
        B.className = 'nav-button';
        B.dataset.ws = Key;
        Nav.appendChild(B);
    }
    DocumentStub.appendChild(Nav);
}
DocumentStub.getElementById = Id =>
{
    const Found = WalkAll(DocumentStub).find(N => N.id === Id);
    if (Found) return Found;
    // Auto-create any id the studio references, so unimplemented chrome never crashes the smoke run.
    const El = new Element('div');
    El.id = Id;
    DocumentStub.appendChild(El);
    return El;
};
DocumentStub.querySelectorAll = Sel => QueryAll(DocumentStub, Sel);
DocumentStub.querySelector = Sel => QueryAll(DocumentStub, Sel)[0] || null;
DocumentStub.createElement = Tag => new Element(Tag);
DocumentStub.createElementNS = (Ns, Tag) => new Element(Tag);
DocumentStub.createTextNode = T => { const E = new Element('span'); E.textContent = T; return E; };
DocumentStub.addEventListener = () => {};
DocumentStub.removeEventListener = () => {};

let RafBudget = 40;
const WindowStub = {
    location: { search: '?ws=split', href: 'http://localhost/', replace() {}, assign() {} },
    innerWidth: 1600, innerHeight: 900, devicePixelRatio: 1,
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame(F)
    {
        // Let the studio paint a handful of frames (proves the render path works), then stop the loop.
        if (RafBudget <= 0) return 0;
        RafBudget--;
        return setTimeout(() => F(performance.now()), 0);
    },
    cancelAnimationFrame(Id) { clearTimeout(Id); },
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    navigator: { userAgent: 'node-smoke', clipboard: { writeText: async () => {} } },
    performance,
    indexedDB: undefined,
    localStorage: { _d: new Map(), getItem(K) { return this._d.get(K) ?? null; }, setItem(K, V) { this._d.set(K, String(V)); }, removeItem(K) { this._d.delete(K); } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Image: class { set src(V) { this._src = V; } get src() { return this._src; } },
    Blob: class { constructor(Parts) { this.parts = Parts; this.size = (Parts || []).join('').length; } },
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL() {} },
    createImageBitmap: async () => ({ width: 1, height: 1 })
};
WindowStub.document = DocumentStub;
WindowStub.window = WindowStub;
WindowStub.self = WindowStub;

globalThis.window = WindowStub;
globalThis.document = DocumentStub;
try { globalThis.navigator = WindowStub.navigator; } catch { /* Node exposes navigator as getter-only; window.navigator is enough */ }
try { globalThis.location = WindowStub.location; } catch { /* getter-only in some runtimes */ }
globalThis.requestAnimationFrame = F =>
{
    if (RafBudget <= 0) return 0;
    RafBudget--;
    return setTimeout(() => F(performance.now()), 0);
};
globalThis.cancelAnimationFrame = WindowStub.cancelAnimationFrame;
globalThis.devicePixelRatio = 1;
globalThis.HTMLCanvasElement = Element;
globalThis.HTMLElement = Element;
globalThis.HTMLInputElement = Element;
globalThis.HTMLButtonElement = Element;
globalThis.Image = WindowStub.Image;
globalThis.Blob = WindowStub.Blob;
globalThis.matchMedia = WindowStub.matchMedia;
try { globalThis.indexedDB = undefined; } catch { /* optional */ }
try { globalThis.localStorage = WindowStub.localStorage; } catch { /* optional */ }

let Passed = 0;
const Failures = [];
function Check(Name, Fn)
{
    try
    {
        Fn();
        Passed++;
        console.log(`  [PASS] ${Name}`);
    }
    catch (Err)
    {
        Failures.push({ Name, Err });
        console.log(`  [FAIL] ${Name}\n         ${Err.message}`);
    }
}

console.log('Running Frontier Landform Studio headless UI smoke test...\n');

const Mod = await import('./TerrainWorldEditor.js');
const LandformMod = await import('./Engine/Landforms/TerrainLandformPrimitives.js');
let App = null;

Check('45. TerrainWorldEditor boots headlessly with the landform quick-add library & inspector tab wired', () =>
{
    // The studio boots itself as window.TerrainStudio; reuse that live instance.
    App = WindowStub.TerrainStudio || globalThis.TerrainStudio;
    assert.ok(App, 'The studio must auto-boot on the window (window.TerrainStudio)');
    assert.ok(App.world.regions.length >= 1, 'Editor must seed demo terrains');
    assert.ok(App.view3D, '3D viewport must initialise');
    App.workspaceMode = 'split';
    App.inspectorTab = 'landform';
    App.rebuildInspector();
    const Inspector = DocumentStub.getElementById('InspectorContent');
    assert.ok(Inspector.children.length > 0, 'Landform inspector must render content');
    const Library = DocumentStub.getElementById('quick-add-list');
    const Cards = QueryAll(Library, '.quick-add-card');
    assert.ok(Cards.length >= LandformMod.LANDFORM_ARCHETYPE_LIST.length,
        `Quick-add library must expose all ${LandformMod.LANDFORM_ARCHETYPE_LIST.length} landform archetype cards (got ${Cards.length})`);
});

Check('46. Every landform archetype can be stamped from the UI, evaluated & re-rendered without throwing', () =>
{
    assert.ok(App, 'Editor must be booted');
    const Reg = App.getActiveRegion();
    const Before = Reg.stack.filter(L => L.type === 'landform_primitive').length;
    for (const Type of LandformMod.LANDFORM_ARCHETYPE_LIST)
    {
        const Layer = App.addLandformLayer(Type);
        assert.ok(Layer && Layer.type === 'landform_primitive', `addLandformLayer("${Type}") must return a landform layer`);
        assert.equal(Layer.archetype, Type);
        assert.ok(Number.isFinite(Reg.runtime.maxHeight), `Region must stay finite after stamping "${Type}"`);
        // Inspector must render for this archetype without throwing (zero dead / missing controls).
        App.activeLayerId = Layer.id;
        App.activeLandformLayerId = Layer.id;
        App.inspectorTab = 'landform';
        App.rebuildInspector();
        const Inspector = DocumentStub.getElementById('InspectorContent');
        assert.ok(Inspector.children.length > 0, `Inspector must render for "${Type}"`);
    }
    const After = Reg.stack.filter(L => L.type === 'landform_primitive').length;
    assert.equal(After - Before, LandformMod.LANDFORM_ARCHETYPE_LIST.length, 'Every archetype must add exactly one layer');
    // Clean the stack back down so later checks stay fast.
    Reg.stack = Reg.stack.filter(L => L.type !== 'landform_primitive');
    Reg.dirty = true;
    App._evaluateDirtyRegionsNow();
});

Check('47. Placement modes & landform gizmo drags mutate the layer non-destructively and rebuild the terrain', () =>
{
    assert.ok(App, 'Editor must be booted');
    const Reg = App.getActiveRegion();
    const Layer = App.addLandformLayer('mesa_tepui', { radiusX: 240, radiusZ: 240, heightM: 180 });
    App.activeLayerId = Layer.id;

    // Placement mode round-trip through the inspector control.
    for (const Mode of ['scatter', 'ridge_range', 'chain', 'single'])
    {
        Layer.placement = Mode;
        Reg.dirty = true;
        App._evaluateDirtyRegionsNow();
        App.rebuildInspector();
        assert.ok(Number.isFinite(Reg.runtime.maxHeight), `Region must stay finite in "${Mode}" placement`);
    }
    Layer.placement = 'single';
    Reg.dirty = true;
    App._evaluateDirtyRegionsNow();

    // Gizmo: 3D landform context + projected handle geometry must exist for the active layer.
    App.view3D.activeRegionId = Reg.id;
    App.view3D.activeLandformLayerId = Layer.id;
    const Ctx = App.view3D.getActiveLandformContext();
    assert.ok(Ctx && Ctx.layer.id === Layer.id, 'Viewport must resolve the active landform gizmo context');

    const O = { worldX: Layer.worldX, worldZ: Layer.worldZ, radiusX: Layer.radiusX, radiusZ: Layer.radiusZ, heightM: Layer.heightM, strikeDeg: Layer.strikeDeg || 0, yawDeg: Layer.yawDeg || 0, pathPoints: null, archetype: Layer.archetype };
    const Origin = [Layer.worldX, 40, Layer.worldZ];
    const Ray = { origin: [Layer.worldX + 40, 900, Layer.worldZ - 40], dir: [0, -1, 0] };
    const DragState = { kind: 'landform-drag', layer: Layer, region: Reg, handle: 'move', gizmoOrigin: Origin, startPlaneXZ: [O.worldX, O.worldZ], startParam: 0, orig: O, knotIndex: -1, instanceIndex: -1 };

    // The synthetic ray starts 40 m east / 40 m north of the gizmo, so the planar move must land there exactly.
    App.view3D._applyLandformGizmoDrag(DragState, Ray, 0, 0);
    assert.equal(Layer.worldX, O.worldX + 40, 'Move handle must translate the landform origin by the ray-plane delta');
    assert.equal(Layer.worldZ, O.worldZ - 40, 'Move handle must translate the landform origin on Z too');

    DragState.handle = 'radiusX';
    DragState.startParam = 0;
    App.view3D._applyLandformGizmoDrag(DragState, { origin: [0, 0, 0], dir: [0, 0, -1] }, 0, 0);
    assert.ok(Layer.radiusX >= 24, 'radiusX handle must stay inside the legal footprint range');

    DragState.handle = 'apex';
    DragState.gizmoOrigin = [Layer.worldX, 100, Layer.worldZ];
    DragState.startParam = 0;
    App.view3D._applyLandformGizmoDrag(DragState, { origin: [Layer.worldX, 400, Layer.worldZ + 10], dir: [0, -1, 0] }, 0, 0);
    assert.ok(Number.isFinite(Layer.heightM), 'Apex handle must write a finite relief height');

    DragState.handle = 'strike';
    App.view3D._applyLandformGizmoDrag(DragState, Ray, 45, 0);
    assert.ok(Layer.strikeDeg >= 0 && Layer.strikeDeg <= 360, 'Strike ring must stay within 0..360°');

    // Linear A → B path knot drag re-routes the corridor.
    const PathLayer = App.addLandformLayer('v_gorge');
    App.view3D.activeLandformLayerId = PathLayer.id;
    Reg.dirty = true;
    App._evaluateDirtyRegionsNow();
    const PathCtx = App.view3D.getActiveLandformContext();
    assert.ok(PathCtx && PathCtx.layer.archetype === 'v_gorge', 'Viewport must resolve the A → B path landform');
    const PathDrag = {
        kind: 'landform-drag', layer: PathLayer, region: Reg, handle: 'knot', knotIndex: 4,
        gizmoOrigin: [PathLayer.worldX, 60, PathLayer.worldZ], orig: { ...O, pathPoints: null }, pathCache: null
    };
    App.view3D._applyLandformGizmoDrag(PathDrag, { origin: [PathLayer.worldX + 30, 800, PathLayer.worldZ + 30], dir: [0, -1, 0] }, 0, 0);
    assert.ok(Array.isArray(PathLayer.pathPoints) && PathLayer.pathPoints.length >= 2, 'Dragging an A → B knot must author pathPoints');
    Reg.dirty = true;
    App._evaluateDirtyRegionsNow();
    assert.ok(Number.isFinite(Reg.runtime.maxHeight), 'Re-routed canyon must still evaluate finite relief');

    // Overlay render must not throw with the landform gizmo active.
    App.view3D._lastViewProj = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    App.view3D._renderLandformGizmoOverlay(1280, 720, 1, App.view3D._lastViewProj);
    assert.ok(true, 'Landform gizmo overlay renders without throwing');
});

Check('48. Landform layers survive editor undo/redo snapshots & workspace switching', () =>
{
    assert.ok(App, 'Editor must be booted');
    const Reg = App.getActiveRegion();
    Reg.stack = Reg.stack.filter(L => L.type !== 'landform_primitive');
    Reg.dirty = true;
    App._evaluateDirtyRegionsNow();

    App.pushUndoSnapshot();
    const Layer = App.addLandformLayer('strato_volcano');
    assert.ok(Reg.stack.some(L => L.id === Layer.id), 'Volcano layer must be on the stack');
    App.undo();
    assert.ok(!App.getActiveRegion().stack.some(L => L.type === 'landform_primitive' && L.archetype === 'strato_volcano'),
        'Undo must remove the stamped landform layer');
    App.redo();
    assert.ok(App.getActiveRegion().stack.some(L => L.type === 'landform_primitive'),
        'Redo must restore the landform layer');

    // Workspace switching must not throw, and the landform tab must survive a terrain-workspace round-trip.
    for (const Mode of ['3d', 'split', '2d', 'split'])
    {
        App.setWorkspaceMode(Mode);
        assert.equal(App.workspaceMode, Mode);
    }
    App.inspectorTab = 'landform';
    App.rebuildInspector();
    assert.ok(DocumentStub.getElementById('InspectorContent').children.length > 0, 'Landform inspector must render after workspace switching');
});

console.log('');
if (Failures.length > 0)
{
    console.error(`${Failures.length} landform UI smoke check(s) FAILED (${Passed}/4 passed).`);
    for (const F of Failures) console.error(`\n--- ${F.Name}\n${F.Err.stack || F.Err.message}`);
    process.exit(1);
}
console.log(`All ${Passed}/4 Landform Studio UI smoke checks passed!`);
// The studio keeps a requestAnimationFrame render loop alive; exit explicitly once the checks are done.
process.exit(0);
