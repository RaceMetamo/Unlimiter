/* ============================================================
   unlimiter-ports.js — typed data between tools (schemaVersion 1)

   The drive moves scalars between tools. This moves everything else.

   Four types, each defined once here:

     image   a canvas / ImageBitmap / video — what the rack has always passed
     points  the unlimiter-points frame, extended: clouds, strokes, branches
     field   a 2D vector field (velocity, orientation, displacement)
     mask    a w×h byte mask

   A tool says what it can give and take by publishing a contract:

     UnlimiterPorts.publish({
       tool: "flow-weave",
       outputs: { out:      { type:"image",  get: () => canvas } },
       inputs:  { emitters: { type:"points", set: frame => … } }
     });

   and a host reads it back off the tool's own window:

     const io = toolWindow.UnlimiterPorts && toolWindow.UnlimiterPorts.contract;

   That replaces guessing a tool's internal variable names. Tools opt in one at
   a time; a host keeps its old behaviour for any tool that hasn't.

   Rules that make sharing work:
   - Producers normalise on publish. A consumer never has to know how the
     producer measured things.
   - Values carry a `version` that bumps on change, so a consumer can skip
     work (and a GPU upload) when nothing moved.
   - Values are passed by reference. Inside the rack, tools share one JS heap,
     so nothing is copied. Consumers must not mutate what they receive.
   - Checks are structural (ArrayBuffer.isView, never instanceof): values
     cross realms, and a Float32Array from another iframe fails instanceof.

   Browser global + CommonJS, and uses globalThis so it runs headless in node.
   ============================================================ */
const UnlimiterPorts = (() => {
"use strict";

const SCHEMA_VERSION = 1;

/* Colours match the rack's cable colours. */
const TYPES = {
  image:  { label: "Image",  color: "#e8e6e1" },
  points: { label: "Points", color: "#7fd1c0" },
  field:  { label: "Field",  color: "#ffb02e" },
  mask:   { label: "Mask",   color: "#9d7bff" }
};

/* ---------------------------------------------------------------
   Spaces for points
     "uv"    u right, v DOWN, both 0..1 across a frame of `aspect` (w/h);
             z is depth in -1..1, positive toward the viewer.
     "3d"    centred on the origin, roughly unit radius, y up.
     "world" whatever units the producer thinks in. Never published on a
             port — normalise to "3d" first.
   --------------------------------------------------------------- */
const SPACES = ["uv", "3d", "world"];

const isView = v => ArrayBuffer.isView(v) && !(v instanceof DataView);
const isF32  = v => isView(v) && v.BYTES_PER_ELEMENT === 4 && typeof v.fill === "function" &&
                    Object.prototype.toString.call(v) === "[object Float32Array]";
const isU8   = v => isView(v) && Object.prototype.toString.call(v) === "[object Uint8Array]";

/* ---------------- constructors ---------------- */

function makePoints(capacity, space){
  capacity = Math.max(1, capacity | 0);
  return {
    type: "points", space: space || "3d", aspect: 1,
    count: 0, capacity, version: 0,
    // present, white, size 1 by default: a producer that fills positions and
    // forgets the rest should get visible points, not silently invisible ones
    positions: new Float32Array(capacity * 3),
    colors:    new Float32Array(capacity * 3).fill(1),
    sizes:     new Float32Array(capacity).fill(1),
    presence:  new Float32Array(capacity).fill(1)
  };
}
/** Reuse `frame` if it is big enough, otherwise grow (to the next power of two,
 *  so a count that wobbles doesn't reallocate every frame). */
function ensurePoints(frame, count, space){
  if(frame && frame.capacity >= count){ frame.count = count; if(space) frame.space = space; return frame; }
  let cap = 1; while(cap < count) cap <<= 1;
  const f = makePoints(cap, space || (frame && frame.space));
  f.count = count;
  if(frame){ f.version = frame.version; f.aspect = frame.aspect; }
  return f;
}
function makeField(w, h){
  w = Math.max(1, w | 0); h = Math.max(1, h | 0);
  return { type: "field", w, h, space: "uv", version: 0, data: new Float32Array(w * h * 2) };
}
function makeMask(w, h){
  w = Math.max(1, w | 0); h = Math.max(1, h | 0);
  return { type: "mask", w, h, version: 0, data: new Uint8Array(w * h) };
}
function bump(v){ if(v) v.version = ((v.version | 0) + 1) >>> 0; return v; }

/* ---------------- validation (cheap, structural, cross-realm safe) ---------------- */

function isImage(v){
  if(!v || typeof v !== "object") return false;
  // TexImageSource duck-typing: canvases, bitmaps, video, images all have a size
  return ("width" in v && "height" in v) || ("videoWidth" in v);
}
function isPoints(v){
  if(!v || typeof v !== "object") return false;
  const n = v.count | 0;
  if(n < 0 || !isF32(v.positions) || v.positions.length < n * 3) return false;
  if(v.colors   && (!isF32(v.colors)   || v.colors.length   < n * 3)) return false;
  if(v.sizes    && (!isF32(v.sizes)    || v.sizes.length    < n))     return false;
  if(v.presence && (!isF32(v.presence) || v.presence.length < n))     return false;
  if(v.tangents && (!isF32(v.tangents) || v.tangents.length < n * 3)) return false;
  if(v.offsets  && (!isView(v.offsets) || v.offsets.length < 1))      return false;
  if(v.space && SPACES.indexOf(v.space) < 0) return false;
  return true;
}
function isField(v){
  return !!v && typeof v === "object" && (v.w | 0) > 0 && (v.h | 0) > 0 &&
         isF32(v.data) && v.data.length >= v.w * v.h * 2;
}
function isMask(v){
  return !!v && typeof v === "object" && (v.w | 0) > 0 && (v.h | 0) > 0 &&
         isU8(v.data) && v.data.length >= v.w * v.h;
}
function isType(type, v){
  switch(type){
    case "image":  return isImage(v);
    case "points": return isPoints(v);
    case "field":  return isField(v);
    case "mask":   return isMask(v);
    default:       return false;
  }
}

/* ---------------- points operations ---------------- */

/** world -> "3d": subtract `center`, multiply by `scale`. Colours, sizes and
 *  presence are shared by reference when the source already has them. */
function normalize3d(src, center, scale, out){
  const n = src.count | 0;
  out = ensurePoints(out, n, "3d");
  const cx = center ? center[0] : 0, cy = center ? center[1] : 0, cz = center ? center[2] : 0;
  const s = isFinite(scale) && scale > 0 ? scale : 1;
  const P = src.positions, Q = out.positions;
  for(let i = 0; i < n; i++){
    const i3 = i * 3;
    Q[i3] = (P[i3] - cx) * s; Q[i3 + 1] = (P[i3 + 1] - cy) * s; Q[i3 + 2] = (P[i3 + 2] - cz) * s;
  }
  copyAttrs(src, out, n);
  out.space = "3d"; out.aspect = 1;
  return bump(out);
}

/** "3d" -> "uv" through a simple orbit view.
 *  view = { yaw, pitch, roll (degrees), zoom (1 = unit radius fills half the
 *           frame height), persp (0 orthographic .. 1 strong), aspect (w/h) }
 *  z carries depth, +1 nearest the viewer, so a consumer can favour the
 *  front of a surface over its back. */
function project(src, view, out){
  const n = src.count | 0;
  out = ensurePoints(out, n, "uv");
  const D = Math.PI / 180;
  const cy = Math.cos((view.yaw || 0) * D),   sy = Math.sin((view.yaw || 0) * D);
  const cp = Math.cos((view.pitch || 0) * D), sp = Math.sin((view.pitch || 0) * D);
  const cr = Math.cos((view.roll || 0) * D),  sr = Math.sin((view.roll || 0) * D);
  const zoom = view.zoom == null ? 1 : view.zoom;
  const persp = Math.max(0, Math.min(1, view.persp || 0));
  const aspect = view.aspect > 0 ? view.aspect : 16 / 9;
  const P = src.positions, Q = out.positions;
  for(let i = 0; i < n; i++){
    const i3 = i * 3;
    let x = P[i3], y = P[i3 + 1], z = P[i3 + 2];
    // yaw about Y
    let x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
    // pitch about X
    let y1 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
    // roll about Z
    let x2 = x1 * cr - y1 * sr, y2 = x1 * sr + y1 * cr;
    const zc = Math.max(-1, Math.min(1, z2));
    const f = zoom / (1 - persp * zc * 0.5);        // nearer is bigger; denominator stays in 0.5..1.5
    Q[i3]     = 0.5 + (x2 * f * 0.5) / aspect;
    Q[i3 + 1] = 0.5 - (y2 * f * 0.5);
    Q[i3 + 2] = zc;
  }
  copyAttrs(src, out, n);
  out.space = "uv"; out.aspect = aspect;
  return bump(out);
}

/** Map a uv laid out for `srcAspect` into a frame of `dstAspect`, contain-fit,
 *  so a circle stays a circle whatever shape the consumer's canvas is. */
function fitUV(u, v, srcAspect, dstAspect, out){
  out = out || [0, 0];
  const k = srcAspect / dstAspect;
  if(k <= 1){ out[0] = 0.5 + (u - 0.5) * k; out[1] = v; }
  else      { out[0] = u; out[1] = 0.5 + (v - 0.5) / k; }
  return out;
}

function copyAttrs(src, out, n){
  const cp = (key, per, fill) => {
    const s = src[key], d = out[key];
    if(s && s.length >= n * per){ d.set(s.subarray(0, n * per)); }
    else if(fill != null){ d.fill(fill, 0, n * per); }
  };
  cp("colors", 3, 1);
  cp("sizes", 1, 1);
  cp("presence", 1, 1);
  if(src.tangents){
    if(!out.tangents || out.tangents.length < out.capacity * 3) out.tangents = new Float32Array(out.capacity * 3);
    out.tangents.set(src.tangents.subarray(0, n * 3));
  }
  if(src.offsets) out.offsets = src.offsets;
  if(src.parents) out.parents = src.parents;
}

/** Pack a "3d" points value into volume-renderer.html's 16-float source
 *  layout (xyz at 0-2, rgb at 4-6, alpha at 7), dropping points under
 *  `cutoff` presence. Reuses `out` when it has room. */
function packVolume(src, cutoff, out){
  cutoff = cutoff == null ? 0.02 : cutoff;
  const n = src.count | 0, pre = src.presence, col = src.colors, pos = src.positions;
  let live = 0;
  for(let i = 0; i < n; i++) if(!pre || pre[i] >= cutoff) live++;
  if(!out || out.capacity < live){
    let cap = 1; while(cap < live) cap <<= 1;
    out = { capacity: cap, count: 0, packed: new Float32Array(cap * 16), positions: new Float32Array(cap * 3) };
  }
  const K = out.packed, X = out.positions;
  let w = 0;
  for(let i = 0; i < n; i++){
    const a = pre ? pre[i] : 1;
    if(a < cutoff) continue;
    const i3 = i * 3, o = w * 16, w3 = w * 3;
    X[w3] = K[o] = pos[i3]; X[w3 + 1] = K[o + 1] = pos[i3 + 1]; X[w3 + 2] = K[o + 2] = pos[i3 + 2];
    K[o + 3] = 0;
    K[o + 4] = col ? col[i3] : 1; K[o + 5] = col ? col[i3 + 1] : 1; K[o + 6] = col ? col[i3 + 2] : 1;
    K[o + 7] = a;
    w++;
  }
  // the renderer reads covariance at 8-13 only for gaussian sources; keep it clean anyway
  if(out.count > w) K.fill(0, w * 16, out.count * 16);
  out.count = w;
  return out;
}

/* ---------------- the contract ---------------- */

let published = null;

/** A tool declares its ports. Throws on a malformed contract so the mistake
 *  shows up while the tool is being written, not later inside a host. */
function publish(contract){
  if(!contract || typeof contract.tool !== "string") throw new Error("UnlimiterPorts.publish: {tool} required");
  const norm = { schemaVersion: SCHEMA_VERSION, tool: contract.tool, label: contract.label || contract.tool,
                 outputs: {}, inputs: {} };
  for(const side of ["outputs", "inputs"]){
    const src = contract[side] || {};
    for(const id in src){
      const p = src[id];
      if(!p || !TYPES[p.type]) throw new Error("UnlimiterPorts.publish: " + side + "." + id + " has unknown type " + (p && p.type));
      if(side === "outputs" && typeof p.get !== "function") throw new Error("UnlimiterPorts.publish: output " + id + " needs get()");
      if(side === "inputs"  && typeof p.set !== "function") throw new Error("UnlimiterPorts.publish: input " + id + " needs set()");
      norm[side][id] = Object.assign({ id, label: p.label || id }, p);
    }
  }
  published = norm;
  return norm;
}

/** Host side: read a tool's contract off its window, or null. */
function read(win){
  try{
    const mod = win && win.UnlimiterPorts;
    const c = mod && mod.contract;
    return c && c.schemaVersion === SCHEMA_VERSION ? c : null;
  }catch(e){ return null; }       // cross-origin frames throw on access
}

function compatible(outType, inType){ return !!TYPES[outType] && outType === inType; }

return {
  SCHEMA_VERSION, TYPES, SPACES,
  makePoints, ensurePoints, makeField, makeMask, bump,
  isType, isPoints, isField, isMask, isImage,
  normalize3d, project, fitUV, packVolume,
  publish, read, compatible,
  get contract(){ return published; }
};
})();

/* Publish it the way unlimiter-drive.js does: a top-level const in a classic
   <script> is never a window property, so without this line a host reading
   `toolWindow.UnlimiterPorts` would find nothing. */
if(typeof globalThis !== "undefined") globalThis.UnlimiterPorts = UnlimiterPorts;
if(typeof module !== "undefined" && module.exports) module.exports = UnlimiterPorts;
