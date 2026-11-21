/* ============================================================
   unlimiter-bus.js — The Unlimiter signal bus (schemaVersion 1)
   A typed scalar channel registry: register({id,type,range}),
   publish, get/subscribe, list.

   Status, as of the September 2026 architecture audit: no page loads
   this file. control-surface.html and volume-renderer.html each carry
   an inline copy, and unlimiter-drive.js does NOT publish here — the
   drive keeps its own source registry (registerSource). See
   ARCHITECTURE.md for where scalars are heading.

   It is a top-level const, so it is NOT a window property: read it
   by its bare name, UnlimiterBus, never window.UnlimiterBus.
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
