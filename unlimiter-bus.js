/* ============================================================
   unlimiter-bus.js — The Unlimiter signal bus (schemaVersion 1)
   Load this before unlimiter-drive.js and before any tool script.
   drive.js publishes channels here; tools and the Control Surface
   read them with get()/subscribe() and discover them with list().
   Identical to the bus embedded in control-surface.html — keep in
   sync until the surface imports this file directly.
   ============================================================ */
const UnlimiterBus = (() => {
  const SCHEMA_VERSION = 1;
  const channels = new Map();   // id -> {id, type, range, updateHz}
  const values   = new Map();   // id -> number
  const subs     = new Map();   // id -> Set<fn>  (event channels: onset)

  function register(spec){
    if(!spec || !spec.id || !spec.type) throw new Error("UnlimiterBus.register: {id, type} required");
    channels.set(spec.id, { range:[0,1], updateHz:60, ...spec });
    if(!values.has(spec.id)) values.set(spec.id, 0);
  }
  function publish(id, value){
    values.set(id, value);
    const s = subs.get(id);
    if(s) s.forEach(fn => { try{ fn(value); }catch(e){ console.error(e); } });
  }
  function get(id){ return values.get(id) ?? 0; }
  function subscribe(id, fn){
    if(!subs.has(id)) subs.set(id, new Set());
    subs.get(id).add(fn);
    return () => subs.get(id).delete(fn);
  }
  function list(){ return [...channels.values()]; }
  function has(id){ return channels.has(id); }
  return { SCHEMA_VERSION, register, publish, get, subscribe, list, has };
})();
// Browser global + optional module export
if (typeof module !== "undefined" && module.exports) module.exports = UnlimiterBus;
