/* =====================================================================
   UNLIMITER DEPTH AI — monocular depth estimation in the browser
   ---------------------------------------------------------------------
   The scene depth buffer for footage that never had one. Depth Anything V2
   (small) runs on the GPU through transformers.js (WebGPU, falling back to
   WASM), so any picture — a video file, a camera, a Rack cable — gets a
   per-pixel "how near is this" map that post effects can blend against,
   the way Unreal's post-process materials read SceneDepth.

       <script src="unlimiter-depthai.js"></script>
       const AI = UnlimiterDepthAI.create({ size:"mid" });
       await AI.load();                       // fetches library + model once, then cached by the browser
       const [h, w] = AI.inputSize();         // draw your frame at this size
       const r = await AI.estimate(rgba);     // { data:Uint8Array nearness 0..255, w, h }, rows top-down

   Nearness is relative, not metric: 255 is the nearest thing in the frame,
   0 the farthest. It is normalised per frame on robust percentiles and the
   range is eased over time, so it doesn't pump.

   Needs http(s) (GitHub Pages or localhost). The first load downloads the
   library from jsDelivr and the model (~100 MB fp32 on WebGPU, ~27 MB q8
   on WASM) from Hugging Face; after that both come from the browser cache.
   ===================================================================== */
(function(global){
"use strict";
const TJS = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1";
const MODEL = "onnx-community/depth-anything-v2-small";
/* input sizes, height × width, multiples of 14 (the ViT patch), roughly 16:9 */
const SIZES = { low:[140, 252], mid:[196, 350], high:[266, 476] };
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

function halfToFloat(h){
  const s = (h & 0x8000) ? -1 : 1, e = (h & 0x7C00) >> 10, f = h & 0x03FF;
  if(e === 0) return s * Math.pow(2, -14) * (f / 1024);
  if(e === 31) return f ? 0 : s * 65504;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

function create(opts){
  opts = opts || {};
  const st = { state:"idle", err:"", device:"", ms:0, size:SIZES[opts.size] ? opts.size : "mid",
               model:null, Tensor:null, lo:null, hi:null, frames:0 };
  let loading = null;

  async function load(){
    if(st.model) return true;
    if(loading) return loading;
    loading = (async () => {
      try{
        st.state = "loading library";
        const T = await import(TJS);
        T.env.allowLocalModels = false;
        let webgpu = false;
        try{ webgpu = !!(navigator.gpu && await navigator.gpu.requestAdapter()); }catch(e){ webgpu = false; }
        st.device = webgpu ? "webgpu" : "wasm";
        st.state = "downloading model";
        st.model = await T.AutoModel.from_pretrained(MODEL, {
          device:st.device, dtype: webgpu ? "fp32" : "q8",
          progress_callback: p => { if(p && p.status === "progress" && p.total) st.state = "downloading model " + Math.round(p.loaded / p.total * 100) + "%"; }
        });
        st.Tensor = T.Tensor;
        st.state = "ready";
        return true;
      }catch(e){
        st.state = "failed"; st.err = (e && e.message) || String(e);
        loading = null;
        return false;
      }
    })();
    return loading;
  }

  /* rgba: Uint8ClampedArray of inputSize() pixels, rows top-down */
  async function estimate(rgba){
    if(!st.model) throw new Error("depth model not loaded");
    const [H, W] = SIZES[st.size], N = H * W;
    if(!rgba || rgba.length < N * 4) throw new Error("depth input is the wrong size");
    const px = new Float32Array(3 * N);
    for(let i = 0, j = 0; i < N; i++, j += 4){
      px[i]         = (rgba[j]     / 255 - MEAN[0]) / STD[0];
      px[N + i]     = (rgba[j + 1] / 255 - MEAN[1]) / STD[1];
      px[2 * N + i] = (rgba[j + 2] / 255 - MEAN[2]) / STD[2];
    }
    const t0 = performance.now();
    const out = await st.model({ pixel_values:new st.Tensor("float32", px, [1, 3, H, W]) });
    const pd = out.predicted_depth || out[Object.keys(out)[0]];
    const dims = pd.dims, oh = dims[dims.length - 2], ow = dims[dims.length - 1];
    let d = pd.data;
    if(d instanceof Uint16Array){ const f = new Float32Array(d.length); for(let i = 0; i < d.length; i++) f[i] = halfToFloat(d[i]); d = f; }
    // robust range: 2nd and 98th percentiles, eased over time so the map doesn't pump
    let mn = Infinity, mx = -Infinity;
    for(let i = 0; i < d.length; i += 7){ const v = d[i]; if(v < mn) mn = v; if(v > mx) mx = v; }
    const span = Math.max(1e-6, mx - mn), hist = new Uint32Array(256);
    let cnt = 0;
    for(let i = 0; i < d.length; i += 3){ hist[Math.min(255, ((d[i] - mn) / span * 255) | 0)]++; cnt++; }
    let acc = 0, lo = mn, hi = mx;
    for(let b = 0; b < 256; b++){ acc += hist[b]; if(acc >= cnt * 0.02){ lo = mn + b / 255 * span; break; } }
    acc = 0;
    for(let b = 255; b >= 0; b--){ acc += hist[b]; if(acc >= cnt * 0.02){ hi = mn + (b + 1) / 255 * span; break; } }
    if(st.lo === null){ st.lo = lo; st.hi = hi; }
    else { st.lo += (lo - st.lo) * 0.2; st.hi += (hi - st.hi) * 0.2; }
    const L = st.lo, R = Math.max(1e-6, st.hi - st.lo), data = new Uint8Array(ow * oh);
    for(let i = 0; i < data.length; i++){ const v = (d[i] - L) / R; data[i] = v <= 0 ? 0 : v >= 1 ? 255 : (v * 255) | 0; }
    st.ms = st.ms ? st.ms * 0.8 + (performance.now() - t0) * 0.2 : performance.now() - t0;
    st.frames++;
    return { data, w:ow, h:oh };
  }

  return {
    load, estimate,
    inputSize(){ return SIZES[st.size].slice(); },
    setSize(s){ if(SIZES[s]){ st.size = s; st.lo = st.hi = null; } },
    get ready(){ return !!st.model; },
    get state(){ return st.state; },
    get error(){ return st.err; },
    get device(){ return st.device; },
    get ms(){ return st.ms; },
    get frames(){ return st.frames; }
  };
}

global.UnlimiterDepthAI = { create, SIZES, MODEL, VERSION:"1.0" };
})(typeof window !== "undefined" ? window : globalThis);
