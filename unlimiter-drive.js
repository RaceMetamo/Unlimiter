/* =====================================================================
   UNLIMITER DRIVE — shared modulation layer for the Unlimiter tool suite
   ---------------------------------------------------------------------
   Drop this file next to any tool and load it before the tool's script:
       <script src="unlimiter-drive.js"></script>

   It gives a host tool:
     - audio analysis   (band energies, envelope, onset detection)
     - MIDI             (clock, CC, notes, learn)
     - a musical clock  (MIDI clock > tap tempo > free-run)
     - LFOs             (free or clock-divided)
     - a mod matrix     (any source -> any registered parameter)
     - an output window (clean canvas mirror for OBS capture)

   REQUIRES A SECURE CONTEXT. Microphone and WebMIDI are blocked on
   file:// in Chrome. Serve the tools over https or http://localhost.

   Host integration, in four lines:
     const Drive = UnlimiterDrive.create({ onChange: rebuildIfNeeded });
     Drive.mountPanel(document.getElementById("drivePanel"));
     Drive.registerTarget("sizeS", "Stamp size start", 0.5, 300);
     const Q = Drive.resolve(P);      // per frame; Q is P with modulation applied
   ===================================================================== */
(function(global){
"use strict";

const VERSION = "1.1";
const TAU = Math.PI*2;
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
const lerp=(a,b,t)=>a+(b-a)*t;

const CSS = `
.udrv{font-family:var(--sans,system-ui);font-size:13px;color:var(--text,#e8e6e1)}
.udrv .r{display:flex;align-items:center;gap:10px;padding:5px 0;min-height:28px}
.udrv .r > label{flex:none;width:104px;color:var(--dim,#8d9490);font-size:12px}
.udrv .r .c{flex:1;min-width:0;display:flex;align-items:center;gap:8px}
.udrv .v{font-family:var(--mono,monospace);font-size:11px;width:52px;text-align:right;flex:none}
.udrv .sub{font-size:11.5px;font-weight:600;padding:10px 0 2px;border-top:1px solid var(--line,#2e3338);margin-top:8px}
.udrv .sub:first-child{border-top:none;margin-top:0}
.udrv .note{color:var(--dim,#8d9490);font-size:11.5px;padding:2px 0 6px;line-height:1.5}
.udrv .brow{display:flex;gap:6px;padding:6px 0}
.udrv .brow button{flex:1}
.udrv .meter{height:6px;background:var(--line,#2e3338);border-radius:3px;overflow:hidden;flex:1}
.udrv .meter i{display:block;height:100%;width:0;background:var(--accent,#7fd1c0)}
.udrv .meter.hot i{background:var(--hot,#e0714f)}
.udrv .mrow{border:1px solid var(--line,#2e3338);border-radius:3px;padding:6px 8px;margin:6px 0;
  background:var(--panel-2,#24282b)}
.udrv .mhead{display:flex;gap:6px;align-items:center}
.udrv .mhead select{flex:1;min-width:0}
.udrv .x{flex:none;width:24px;padding:4px 0;text-align:center;line-height:1}
.udrv .tiny{font-family:var(--mono,monospace);font-size:10.5px;color:var(--dim,#8d9490)}
.udrv .on{border-color:var(--accent,#7fd1c0) !important;color:var(--accent,#7fd1c0) !important}
.udrv .beatdot{width:9px;height:9px;border-radius:50%;background:var(--line,#2e3338);flex:none}
.udrv .beatdot.lit{background:var(--accent,#7fd1c0)}
.udrv select,.udrv input[type=text],.udrv input[type=number]{width:100%;
  background:var(--panel-2,#24282b);color:var(--text,#e8e6e1);border:1px solid var(--line,#2e3338);
  border-radius:3px;padding:4px 6px;font-size:11.5px;font-family:inherit}
.udrv input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:18px;background:transparent}
.udrv input[type=range]::-webkit-slider-runnable-track{height:2px;background:var(--line,#2e3338)}
.udrv input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:11px;height:11px;
  border-radius:50%;background:var(--accent,#7fd1c0);margin-top:-4.5px;border:none}
.udrv button{background:var(--panel-2,#24282b);color:var(--text,#e8e6e1);
  border:1px solid var(--line,#2e3338);border-radius:3px;padding:5px 9px;font-size:11.5px;
  cursor:pointer;font-family:inherit}
.udrv button:hover{border-color:#4a5157}
`;

const DIVISIONS = {
  "8 bars":32, "4 bars":16, "2 bars":8, "1 bar":4,
  "1/2":2, "1/4":1, "1/8":0.5, "1/8T":1/3, "1/16":0.25
};

function create(opts){
  opts = opts||{};
  const targets = {};          // key -> {key,label,min,max}
  let panelEl = null;
  const ui = {};

  const S = {
    audio:{
      on:false, err:"", stream:null, ac:null, analyser:null, src:null,
      freq:null, byteFreq:null, prevFlux:null,
      gain:1.0, smoothing:0.6, attack:0.35, release:0.12,
      xoverLo:180, xoverHi:2200, floorDb:-72, ceilDb:-18, auto:true,
      raw:[0,0,0], env:[0,0,0], level:0, peak:[0.02,0.02,0.02],
      flux:0, fluxAvg:0, fluxVar:1, onset:0, onsetSens:1.6, lastOnset:0
    },
    midi:{
      on:false, err:"", access:null, input:null, inputs:[],
      clockOk:false, pulses:0, lastPulseT:0, pulseIvl:0, playing:true,
      cc:{}, notes:{}, lastCC:null, lastNote:null
    },
    clock:{
      src:"internal", bpm:124, beats:0, lastT:0, taps:[], running:true
    },
    lfos:[
      {shape:"sine", free:false, div:"1 bar", hz:0.25, phase:0, val:0, sh:0, shLast:-1},
      {shape:"tri",  free:false, div:"2 bars", hz:0.1,  phase:0, val:0, sh:0, shLast:-1},
      {shape:"saw",  free:true,  div:"1/4",   hz:0.5,  phase:0, val:0, sh:0, shLast:-1},
      {shape:"snh",  free:false, div:"1/4",   hz:1,    phase:0, val:0, sh:0, shLast:-1}
    ],
    matrix:[],
    master:1,
    learn:null,
    randBeat:0, lastBeatInt:-1
  };

  /* ---------------- sources ---------------- */
  function sourceList(){
    const out=[
      ["audio.low","Audio — low"],["audio.mid","Audio — mid"],["audio.high","Audio — high"],
      ["audio.level","Audio — level"],["audio.onset","Audio — onset"],
      ["clock.beat","Clock — beat ramp"],["clock.beatPulse","Clock — beat pulse"],
      ["clock.bar","Clock — bar ramp"],["clock.barPulse","Clock — bar pulse"],
      ["random.beat","Random per beat"]
    ];
    for(let i=0;i<4;i++) out.push(["lfo."+i,"LFO "+(i+1)]);
    Object.keys(S.midi.cc).sort((a,b)=>a-b).forEach(n=>out.push(["cc."+n,"MIDI CC "+n]));
    Object.keys(S.midi.notes).sort((a,b)=>a-b).forEach(n=>out.push(["note."+n,"MIDI note "+n]));
    return out;
  }

  function sourceValue(id){
    if(!id) return 0;
    const a=S.audio;
    switch(id){
      case "audio.low": return a.env[0];
      case "audio.mid": return a.env[1];
      case "audio.high": return a.env[2];
      case "audio.level": return a.level;
      case "audio.onset": return a.onset;
      case "clock.beat": return beatPhase();
      case "clock.beatPulse": return Math.pow(1-beatPhase(),3);
      case "clock.bar": return barPhase();
      case "clock.barPulse": return Math.pow(1-barPhase(),3);
      case "random.beat": return S.randBeat;
    }
    if(id.startsWith("lfo.")) return S.lfos[+id.slice(4)].val;
    if(id.startsWith("cc.")) return (S.midi.cc[id.slice(3)]||0)/127;
    if(id.startsWith("note.")) return S.midi.notes[id.slice(5)]||0;
    return 0;
  }

  /* ---------------- clock ---------------- */
  function beatPhase(){ return S.clock.beats - Math.floor(S.clock.beats); }
  function barPhase(){ const b=S.clock.beats/4; return b-Math.floor(b); }

  function advanceClock(dt){
    const c=S.clock;
    // clock goes stale if the device stops sending
    if(S.midi.clockOk && performance.now()-S.midi.lastPulseT>1200){
      S.midi.clockOk=false; S.midi.pulseIvl=0;
    }
    if(S.midi.clockOk && S.midi.playing!==false){
      // beats come from counted MIDI pulses, interpolated between them
      const ppq=24;
      let b=S.midi.pulses/ppq;
      if(S.midi.pulseIvl>0){
        const since=(performance.now()-S.midi.lastPulseT)/S.midi.pulseIvl;
        b += clamp(since,0,1.5)/ppq;
      }
      c.beats=b;
      if(S.midi.pulseIvl>0) c.bpm=clamp(60000/(S.midi.pulseIvl*24),20,300);
      c.src="midi";
    } else {
      if(c.running) c.beats += dt*c.bpm/60;
      c.src = c.taps.length>1 ? "tap" : "internal";
    }
    const bi=Math.floor(c.beats);
    if(bi!==S.lastBeatInt){ S.lastBeatInt=bi; S.randBeat=Math.random(); }
  }
  function tap(){
    const now=performance.now(), c=S.clock;
    if(c.taps.length && now-c.taps[c.taps.length-1]>2400) c.taps.length=0;
    c.taps.push(now);
    if(c.taps.length>6) c.taps.shift();
    if(c.taps.length>1){
      let sum=0;
      for(let i=1;i<c.taps.length;i++) sum+=c.taps[i]-c.taps[i-1];
      const ivl=sum/(c.taps.length-1);
      c.bpm=clamp(60000/ivl,40,220);
    }
    c.beats=Math.round(c.beats);   // land the downbeat on the tap
  }

  /* ---------------- LFOs ---------------- */
  function updateLFOs(dt){
    for(const L of S.lfos){
      if(L.free){ L.phase=(L.phase+dt*L.hz)%1; }
      else {
        const beatsPer=DIVISIONS[L.div]||4;
        L.phase=(S.clock.beats/beatsPer)%1;
        if(L.phase<0) L.phase+=1;
      }
      const p=L.phase;
      switch(L.shape){
        case "sine": L.val=Math.sin(p*TAU); break;
        case "tri": L.val=4*Math.abs(p-0.5)-1; break;
        case "saw": L.val=1-2*p; break;
        case "ramp": L.val=2*p-1; break;
        case "square": L.val=p<0.5?1:-1; break;
        case "snh": {
          const step=Math.floor(S.clock.beats/(DIVISIONS[L.div]||1));
          if(step!==L.shLast){ L.shLast=step; L.sh=Math.random()*2-1; }
          L.val=L.sh; break;
        }
        default: L.val=0;
      }
    }
  }

  /* ---------------- audio ---------------- */
  async function audioStart(deviceId){
    const a=S.audio;
    try{
      const constraints={audio:{
        echoCancellation:false, noiseSuppression:false, autoGainControl:false,
        channelCount:1
      }};
      if(deviceId) constraints.audio.deviceId={exact:deviceId};
      a.stream=await navigator.mediaDevices.getUserMedia(constraints);
      a.ac=new (window.AudioContext||window.webkitAudioContext)();
      if(a.ac.state==="suspended") await a.ac.resume();
      a.src=a.ac.createMediaStreamSource(a.stream);
      a.analyser=a.ac.createAnalyser();
      a.analyser.fftSize=2048;
      a.analyser.smoothingTimeConstant=a.smoothing;
      a.src.connect(a.analyser);
      a.freq=new Float32Array(a.analyser.frequencyBinCount);
      a.byteFreq=new Uint8Array(a.analyser.frequencyBinCount);
      a.prevFlux=new Uint8Array(a.analyser.frequencyBinCount);
      a.on=true; a.err="";
      listDevices();
    }catch(e){
      a.err = (location.protocol==="file:")
        ? "blocked on file:// — serve over localhost or https"
        : (e && e.message) || "no audio";
      a.on=false;
    }
    refreshPanel();
  }
  function audioStop(){
    const a=S.audio;
    if(a.stream) a.stream.getTracks().forEach(t=>t.stop());
    if(a.ac) a.ac.close();
    a.stream=null; a.ac=null; a.analyser=null; a.on=false;
    a.env=[0,0,0]; a.level=0; a.onset=0;
    refreshPanel();
  }
  async function listDevices(){
    try{
      const devs=await navigator.mediaDevices.enumerateDevices();
      const ins=devs.filter(d=>d.kind==="audioinput");
      if(ui.audioDev){
        const cur=ui.audioDev.value;
        ui.audioDev.innerHTML="";
        ins.forEach(d=>{
          const o=document.createElement("option");
          o.value=d.deviceId; o.textContent=d.label||("input "+(ui.audioDev.length+1));
          ui.audioDev.appendChild(o);
        });
        if(cur) ui.audioDev.value=cur;
      }
    }catch(e){}
  }

  function analyseAudio(dt){
    const a=S.audio;
    if(!a.on||!a.analyser) return;
    a.analyser.smoothingTimeConstant=a.smoothing;
    a.analyser.getFloatFrequencyData(a.freq);
    a.analyser.getByteFrequencyData(a.byteFreq);
    const nyq=a.ac.sampleRate/2, n=a.freq.length;
    const binOf=f=>clamp(Math.round(f/nyq*n),0,n-1);
    const edges=[binOf(25),binOf(a.xoverLo),binOf(a.xoverHi),binOf(14000)];
    for(let b=0;b<3;b++){
      let sum=0,c=0;
      for(let i=edges[b];i<edges[b+1];i++){ sum+=a.freq[i]; c++; }
      const db=c?sum/c:-120;
      let v=(db-a.floorDb)/(a.ceilDb-a.floorDb);
      v=clamp(v,0,1)*a.gain;
      if(a.auto){
        a.peak[b]=Math.max(v, a.peak[b]*(1-dt*0.25));
        v = a.peak[b]>0.04 ? clamp(v/a.peak[b],0,1) : 0;
      }
      a.raw[b]=clamp(v,0,1);
      const k = a.raw[b]>a.env[b] ? 1-Math.exp(-dt/Math.max(0.001,a.attack*0.25))
                                  : 1-Math.exp(-dt/Math.max(0.001,a.release*0.8));
      a.env[b]=a.env[b]+(a.raw[b]-a.env[b])*k;
    }
    a.level=(a.env[0]+a.env[1]+a.env[2])/3;
    // spectral flux onset
    let flux=0;
    for(let i=0;i<n;i++){
      const d=a.byteFreq[i]-a.prevFlux[i];
      if(d>0) flux+=d;
      a.prevFlux[i]=a.byteFreq[i];
    }
    flux/=n*255;
    const df=flux-a.fluxAvg;
    a.fluxAvg+=df*0.06;
    a.fluxVar+=(Math.abs(df)-a.fluxVar)*0.06;
    a.flux=flux;
    const now=performance.now();
    if(flux > a.fluxAvg + a.fluxVar*a.onsetSens*2 && now-a.lastOnset>90){
      a.onset=1; a.lastOnset=now;
    } else {
      a.onset=Math.max(0, a.onset - dt/Math.max(0.02,a.release));
    }
  }

  /* ---------------- midi ---------------- */
  async function midiStart(){
    const m=S.midi;
    try{
      m.access=await navigator.requestMIDIAccess({sysex:false});
      m.inputs=[...m.access.inputs.values()];
      m.on=true; m.err="";
      if(m.inputs.length) selectInput(m.inputs[0].id);
      m.access.onstatechange=()=>{ m.inputs=[...m.access.inputs.values()]; refreshPanel(); };
    }catch(e){
      m.err = (location.protocol==="file:")
        ? "blocked on file:// — serve over localhost or https"
        : "WebMIDI unavailable in this browser";
      m.on=false;
    }
    refreshPanel();
  }
  function selectInput(id){
    const m=S.midi;
    m.inputs.forEach(i=>i.onmidimessage=null);
    const inp=m.inputs.find(i=>i.id===id);
    if(!inp) return;
    m.input=inp;
    inp.onmidimessage=onMIDI;
    refreshPanel();
  }
  function onMIDI(e){
    const m=S.midi, d=e.data, st=d[0];
    if(st===0xF8){                              // clock pulse
      const now=performance.now();
      if(m.lastPulseT){
        const ivl=now-m.lastPulseT;
        m.pulseIvl = m.pulseIvl ? m.pulseIvl*0.85+ivl*0.15 : ivl;
      }
      m.lastPulseT=now; m.pulses++; m.clockOk=true;
      return;
    }
    if(st===0xFA){ m.pulses=0; m.playing=true; return; }           // start
    if(st===0xFB){ m.playing=true; return; }                        // continue
    if(st===0xFC){ m.playing=false; return; }                       // stop
    const type=st&0xF0;
    if(type===0xB0){                                                // CC
      const num=d[1], val=d[2];
      m.cc[num]=val; m.lastCC=num;
      if(S.learn!=null){ assignLearn("cc."+num); }
      else refreshSourceSelects();
    } else if(type===0x90 && d[2]>0){                               // note on
      m.notes[d[1]]=1; m.lastNote=d[1];
      if(S.learn!=null) assignLearn("note."+d[1]);
      else refreshSourceSelects();
    } else if(type===0x80 || (type===0x90&&d[2]===0)){
      m.notes[d[1]]=0;
    }
  }
  function assignLearn(srcId){
    const row=S.matrix[S.learn];
    if(row){ row.source=srcId; }
    S.learn=null;
    buildMatrix();
    if(opts.onChange) opts.onChange();
  }

  /* ---------------- matrix ---------------- */
  function addRow(){
    const keys=Object.keys(targets);
    S.matrix.push({
      target: keys[0]||"", source:"audio.low", depth:0.4,
      mode:"add", smooth:0.3, on:true, sm:null
    });
    buildMatrix();
  }
  function resolve(base){
    if(!S.matrix.length) return base;
    const out=Object.assign({},base);
    for(const r of S.matrix){
      if(r.on===false) continue;
      const t=targets[r.target];
      if(!t) continue;
      let v=sourceValue(r.source);
      r.sm = (r.sm==null) ? v : r.sm + (v-r.sm)*(1-clamp(r.smooth,0,0.98));
      v=r.sm;
      const span=t.max-t.min;
      const b=Number(out[r.target])||0;
      const depth=r.depth*S.master;
      let nv;
      if(r.mode==="scale") nv = b*(1+depth*v);
      else nv = b + depth*span*v;
      out[r.target]=clamp(nv,t.min,t.max);
    }
    return out;
  }
  function isLive(){
    if(!S.matrix.length || S.master<=0) return false;
    return S.audio.on || S.midi.clockOk || S.midi.on || S.matrix.some(r=>r.source.startsWith("lfo.")||r.source.startsWith("clock.")||r.source==="random.beat");
  }

  /* ---------------- output window ---------------- */
  let outWin=null;
  function openOutput(getCanvas){
    if(outWin && !outWin.closed){ outWin.focus(); return; }
    outWin=window.open("","UnlimiterOutput","width=1280,height=720");
    if(!outWin) return;
    outWin.document.write(
      '<!DOCTYPE html><html><head><title>UNLIMITER OUTPUT</title><style>'+
      'html,body{margin:0;height:100%;background:#000;overflow:hidden;cursor:none}'+
      'canvas{display:block;width:100%;height:100%;object-fit:contain}'+
      '</style></head><body><canvas id="o"></canvas></body></html>');
    outWin.document.close();
    const oc=outWin.document.getElementById("o");
    const octx=oc.getContext("2d");
    outWin.document.body.addEventListener("click",()=>{
      const el=outWin.document.documentElement;
      if(outWin.document.fullscreenElement) outWin.document.exitFullscreen();
      else el.requestFullscreen&&el.requestFullscreen();
    });
    (function loop(){
      if(!outWin||outWin.closed){ outWin=null; return; }
      const src=getCanvas&&getCanvas();
      if(src&&src.width){
        if(oc.width!==src.width||oc.height!==src.height){ oc.width=src.width; oc.height=src.height; }
        octx.drawImage(src,0,0);
      }
      outWin.requestAnimationFrame(loop);
    })();
  }

  /* ---------------- panel ---------------- */
  function el(tag,cls,txt){
    const e=document.createElement(tag);
    if(cls) e.className=cls;
    if(txt!=null) e.textContent=txt;
    return e;
  }
  function prow(parent,label,nodes){
    const r=el("div","r"); const l=el("label",null,label); const c=el("div","c");
    nodes.forEach(n=>c.appendChild(n));
    r.appendChild(l); r.appendChild(c); parent.appendChild(r);
    return r;
  }
  function sld(parent,label,get,set,min,max,step,fmt){
    const i=document.createElement("input");
    i.type="range"; i.min=min; i.max=max; i.step=step; i.value=get();
    const v=el("span","v");
    const show=()=>v.textContent=(fmt?fmt(get()):get());
    show();
    i.addEventListener("input",()=>{ set(Number(i.value)); show(); });
    prow(parent,label,[i,v]);
    return {input:i,show};
  }
  function sel(parent,label,options,get,set){
    const s=document.createElement("select");
    options.forEach(([v,t])=>{ const o=document.createElement("option"); o.value=v; o.textContent=t; s.appendChild(o); });
    s.value=get();
    s.addEventListener("change",()=>set(s.value));
    prow(parent,label,[s]);
    return s;
  }
  function sub(parent,t){ const d=el("div","sub",t); parent.appendChild(d); return d; }
  function note(parent,t){ const d=el("div","note",t); parent.appendChild(d); return d; }

  function mountPanel(host){
    if(!document.getElementById("udrv-css")){
      const st=el("style"); st.id="udrv-css"; st.textContent=CSS;
      document.head.appendChild(st);
    }
    panelEl=host; host.classList.add("udrv");
    host.innerHTML="";

    /* --- audio --- */
    sub(host,"Audio in");
    const arow=el("div","brow");
    ui.audioBtn=el("button",null,"Start audio");
    ui.audioBtn.addEventListener("click",()=>{
      if(S.audio.on) audioStop();
      else audioStart(ui.audioDev&&ui.audioDev.value);
    });
    arow.appendChild(ui.audioBtn);
    host.appendChild(arow);
    ui.audioDev=document.createElement("select");
    ui.audioDev.addEventListener("change",()=>{ if(S.audio.on){ audioStop(); audioStart(ui.audioDev.value); } });
    prow(host,"Device",[ui.audioDev]);
    ui.audioErr=note(host,"");
    const mk=name=>{
      const m=el("div","meter"); const i=el("i"); m.appendChild(i);
      prow(host,name,[m]); return i;
    };
    ui.mLow=mk("Low"); ui.mMid=mk("Mid"); ui.mHigh=mk("High");
    const om=el("div","meter hot"); const omi=el("i"); om.appendChild(omi);
    prow(host,"Onset",[om]); ui.mOnset=omi;
    sld(host,"Gain",()=>S.audio.gain,v=>S.audio.gain=v,0.1,4,0.05,v=>v.toFixed(2));
    sld(host,"Low / mid",()=>S.audio.xoverLo,v=>S.audio.xoverLo=v,60,600,5,v=>v+"hz");
    sld(host,"Mid / high",()=>S.audio.xoverHi,v=>S.audio.xoverHi=v,800,8000,50,v=>(v/1000).toFixed(1)+"k");
    sld(host,"Attack",()=>S.audio.attack,v=>S.audio.attack=v,0.01,1.5,0.01,v=>v.toFixed(2));
    sld(host,"Release",()=>S.audio.release,v=>S.audio.release=v,0.02,2,0.01,v=>v.toFixed(2));
    sld(host,"Smoothing",()=>S.audio.smoothing,v=>S.audio.smoothing=v,0,0.95,0.01,v=>v.toFixed(2));
    sld(host,"Onset sens",()=>S.audio.onsetSens,v=>S.audio.onsetSens=v,0.4,4,0.05,v=>v.toFixed(2));
    const acr=el("div","r");
    const acc=document.createElement("input"); acc.type="checkbox"; acc.checked=S.audio.auto;
    acc.addEventListener("change",()=>S.audio.auto=acc.checked);
    acr.appendChild(el("label",null,"Auto level")); const acw=el("div","c"); acw.appendChild(acc);
    acr.appendChild(acw); host.appendChild(acr);
    note(host,"Feed a line input from the mixer if you can. Auto level tracks a decaying peak per band so quiet passages still reach the top of the range.");

    /* --- midi --- */
    sub(host,"MIDI");
    const mrow=el("div","brow");
    ui.midiBtn=el("button",null,"Enable MIDI");
    ui.midiBtn.addEventListener("click",midiStart);
    mrow.appendChild(ui.midiBtn); host.appendChild(mrow);
    ui.midiIn=document.createElement("select");
    ui.midiIn.addEventListener("change",()=>selectInput(ui.midiIn.value));
    prow(host,"Input",[ui.midiIn]);
    ui.midiErr=note(host,"");
    ui.beatDot=el("div","beatdot");
    ui.clockLbl=el("span","tiny","—");
    prow(host,"Clock",[ui.beatDot,ui.clockLbl]);
    const trow=el("div","brow");
    ui.tapBtn=el("button",null,"Tap tempo");
    ui.tapBtn.addEventListener("click",tap);
    const resetBtn=el("button",null,"Reset phase");
    resetBtn.addEventListener("click",()=>{ S.clock.beats=0; S.midi.pulses=0; });
    trow.appendChild(ui.tapBtn); trow.appendChild(resetBtn); host.appendChild(trow);
    sld(host,"Free BPM",()=>S.clock.bpm,v=>S.clock.bpm=v,40,220,0.5,v=>v.toFixed(1));
    note(host,"MIDI clock from your hardware overrides the free BPM whenever it is arriving. Tap tempo is the fallback.");

    /* --- lfos --- */
    sub(host,"LFOs");
    ui.lfoWrap=el("div"); host.appendChild(ui.lfoWrap);
    buildLFOs();

    /* --- matrix --- */
    sub(host,"Mod matrix");
    ui.masterSld=sld(host,"Drive amount",()=>S.master,v=>S.master=v,0,1,0.01,v=>v.toFixed(2));
    const prow2=el("div","brow");
    ui.panicBtn=el("button",null,"Bypass all");
    ui.panicBtn.addEventListener("click",()=>{
      S.master = S.master>0 ? 0 : 1;
      ui.masterSld.input.value=S.master; ui.masterSld.show();
      ui.panicBtn.classList.toggle("on",S.master===0);
      ui.panicBtn.textContent = S.master===0 ? "Bypassed" : "Bypass all";
      if(opts.onChange) opts.onChange();
    });
    prow2.appendChild(ui.panicBtn); host.appendChild(prow2);
    note(host,"Drive amount scales every route at once — the one control to reach for when something is wrong in the room.");
    ui.matrixWrap=el("div"); host.appendChild(ui.matrixWrap);
    const brow=el("div","brow");
    const addBtn=el("button",null,"Add route");
    addBtn.addEventListener("click",addRow);
    const clrBtn=el("button",null,"Clear all");
    clrBtn.addEventListener("click",()=>{ S.matrix.length=0; buildMatrix(); if(opts.onChange)opts.onChange(); });
    brow.appendChild(addBtn); brow.appendChild(clrBtn); host.appendChild(brow);
    buildMatrix();

    /* --- output --- */
    sub(host,"Output");
    const orow=el("div","brow");
    const outBtn=el("button",null,"Open output window");
    outBtn.addEventListener("click",()=>openOutput(opts.getOutputCanvas));
    orow.appendChild(outBtn); host.appendChild(orow);
    note(host,"A bare canvas in its own window, titled UNLIMITER OUTPUT. Point an OBS window capture at it. Click inside it for fullscreen.");

    refreshPanel();
  }

  function buildLFOs(){
    if(!ui.lfoWrap) return;
    ui.lfoWrap.innerHTML="";
    S.lfos.forEach((L,i)=>{
      const box=el("div","mrow");
      const head=el("div","mhead");
      head.appendChild(el("span","tiny","LFO "+(i+1)));
      const sh=document.createElement("select");
      [["sine","Sine"],["tri","Triangle"],["saw","Saw down"],["ramp","Ramp up"],
       ["square","Square"],["snh","Sample & hold"]].forEach(([v,t])=>{
        const o=document.createElement("option"); o.value=v; o.textContent=t; sh.appendChild(o);
      });
      sh.value=L.shape;
      sh.addEventListener("change",()=>L.shape=sh.value);
      head.appendChild(sh);
      const dv=document.createElement("select");
      Object.keys(DIVISIONS).forEach(k=>{ const o=document.createElement("option"); o.value=k; o.textContent=k; dv.appendChild(o); });
      const freeOpt=document.createElement("option"); freeOpt.value="__free"; freeOpt.textContent="free";
      dv.appendChild(freeOpt);
      dv.value=L.free?"__free":L.div;
      dv.addEventListener("change",()=>{
        if(dv.value==="__free") L.free=true; else { L.free=false; L.div=dv.value; }
        buildLFOs();
      });
      head.appendChild(dv);
      box.appendChild(head);
      if(L.free) sld(box,"Rate",()=>L.hz,v=>L.hz=v,0.01,8,0.01,v=>v.toFixed(2)+"hz");
      ui.lfoWrap.appendChild(box);
    });
  }

  function buildMatrix(){
    if(!ui.matrixWrap) return;
    ui.matrixWrap.innerHTML="";
    const tkeys=Object.keys(targets);
    if(!tkeys.length){ note(ui.matrixWrap,"This tool has not registered any parameters yet."); return; }
    S.matrix.forEach((r,idx)=>{
      const box=el("div","mrow");
      const head=el("div","mhead");
      const tsel=document.createElement("select");
      tkeys.forEach(k=>{ const o=document.createElement("option"); o.value=k; o.textContent=targets[k].label; tsel.appendChild(o); });
      tsel.value=r.target;
      tsel.addEventListener("change",()=>{ r.target=tsel.value; r.sm=null; });
      head.appendChild(tsel);
      const mute=el("button","x",r.on===false?"○":"●");
      mute.title="Mute this route";
      if(r.on!==false) mute.classList.add("on");
      mute.addEventListener("click",()=>{ r.on=(r.on===false); r.sm=null; buildMatrix(); if(opts.onChange)opts.onChange(); });
      head.appendChild(mute);
      const x=el("button","x","×");
      x.addEventListener("click",()=>{ S.matrix.splice(idx,1); buildMatrix(); if(opts.onChange)opts.onChange(); });
      head.appendChild(x);
      box.appendChild(head);

      const srow=el("div","mhead"); srow.style.marginTop="6px";
      const ssel=document.createElement("select");
      ssel.dataset.srcSelect="1";
      sourceList().forEach(([v,t])=>{ const o=document.createElement("option"); o.value=v; o.textContent=t; ssel.appendChild(o); });
      ssel.value=r.source;
      ssel.addEventListener("change",()=>{ r.source=ssel.value; r.sm=null; });
      srow.appendChild(ssel);
      const lrn=el("button","x","L");
      lrn.title="MIDI learn — move a knob or hit a pad";
      lrn.addEventListener("click",()=>{
        S.learn = (S.learn===idx) ? null : idx;
        buildMatrix();
      });
      if(S.learn===idx) lrn.classList.add("on");
      srow.appendChild(lrn);
      box.appendChild(srow);

      sld(box,"Depth",()=>r.depth,v=>r.depth=v,-1,1,0.01,v=>v.toFixed(2));
      const msel=document.createElement("select");
      [["add","Add"],["scale","Scale"]].forEach(([v,t])=>{ const o=document.createElement("option"); o.value=v; o.textContent=t; msel.appendChild(o); });
      msel.value=r.mode;
      msel.addEventListener("change",()=>r.mode=msel.value);
      prow(box,"Mode",[msel]);
      sld(box,"Smooth",()=>r.smooth,v=>r.smooth=v,0,0.98,0.01,v=>v.toFixed(2));
      ui.matrixWrap.appendChild(box);
    });
  }

  function refreshSourceSelects(){
    if(!ui.matrixWrap) return;
    const list=sourceList();
    ui.matrixWrap.querySelectorAll("select[data-src-select]").forEach((s,i)=>{
      if(s.options.length===list.length) return;
      const cur=s.value; s.innerHTML="";
      list.forEach(([v,t])=>{ const o=document.createElement("option"); o.value=v; o.textContent=t; s.appendChild(o); });
      s.value=cur;
    });
  }

  function refreshPanel(){
    if(!panelEl) return;
    if(ui.audioBtn){
      ui.audioBtn.textContent=S.audio.on?"Stop audio":"Start audio";
      ui.audioBtn.classList.toggle("on",S.audio.on);
    }
    if(ui.audioErr) ui.audioErr.textContent=S.audio.err||"";
    if(ui.midiBtn){
      ui.midiBtn.textContent=S.midi.on?"MIDI on":"Enable MIDI";
      ui.midiBtn.classList.toggle("on",S.midi.on);
    }
    if(ui.midiErr) ui.midiErr.textContent=S.midi.err||"";
    if(ui.midiIn && S.midi.inputs.length!==ui.midiIn.options.length){
      ui.midiIn.innerHTML="";
      S.midi.inputs.forEach(i=>{
        const o=document.createElement("option"); o.value=i.id; o.textContent=i.name; ui.midiIn.appendChild(o);
      });
      if(S.midi.input) ui.midiIn.value=S.midi.input.id;
    }
    refreshSourceSelects();
  }

  /* ---------------- internal update loop ---------------- */
  let lastT=performance.now();
  let meterT=0;
  function loop(now){
    const dt=Math.min(0.1,(now-lastT)/1000); lastT=now;
    analyseAudio(dt);
    advanceClock(dt);
    updateLFOs(dt);
    if(now-meterT>60){
      meterT=now;
      if(ui.mLow){
        ui.mLow.style.width=(S.audio.env[0]*100).toFixed(0)+"%";
        ui.mMid.style.width=(S.audio.env[1]*100).toFixed(0)+"%";
        ui.mHigh.style.width=(S.audio.env[2]*100).toFixed(0)+"%";
        ui.mOnset.style.width=(S.audio.onset*100).toFixed(0)+"%";
      }
      if(ui.beatDot){
        ui.beatDot.classList.toggle("lit",beatPhase()<0.18);
        const c=S.clock;
        ui.clockLbl.textContent=
          (c.src==="midi"?"midi clock":c.src==="tap"?"tapped":"free")+
          " · "+c.bpm.toFixed(1)+" bpm · bar "+(Math.floor(c.beats/4)%8+1);
      }
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  /* ---------------- public ---------------- */
  return {
    version:VERSION,
    registerTarget(key,label,min,max){
      targets[key]={key,label,min:Number(min),max:Number(max)};
      return this;
    },
    // bulk form: [{key,label,min,max}, ...] or {key:[label,min,max], ...}
    registerTargets(list){
      if(Array.isArray(list)) list.forEach(t=>this.registerTarget(t.key,t.label,t.min,t.max));
      else for(const k in list){ const v=list[k]; this.registerTarget(k,v[0],v[1],v[2]); }
      buildMatrix();
      return this;
    },
    get targets(){ return targets; },
    get master(){ return S.master; },
    set master(v){ S.master=clamp(v,0,1); },
    clearTargets(){ for(const k in targets) delete targets[k]; },
    resolve, sourceValue, isLive,
    get beatPhase(){ return beatPhase(); },
    get barPhase(){ return barPhase(); },
    get bpm(){ return S.clock.bpm; },
    get audio(){ return S.audio; },
    get state(){ return S; },
    mountPanel, openOutput, tap,
    rebuildMatrix:buildMatrix,
    serialize(){
      return {
        master:S.master,
        matrix:S.matrix.map(r=>({target:r.target,source:r.source,depth:r.depth,mode:r.mode,smooth:r.smooth,on:r.on!==false})),
        lfos:S.lfos.map(L=>({shape:L.shape,free:L.free,div:L.div,hz:L.hz})),
        audio:{gain:S.audio.gain,xoverLo:S.audio.xoverLo,xoverHi:S.audio.xoverHi,
               attack:S.audio.attack,release:S.audio.release,smoothing:S.audio.smoothing,
               onsetSens:S.audio.onsetSens,auto:S.audio.auto},
        bpm:S.clock.bpm
      };
    },
    load(o){
      if(!o) return;
      if(typeof o.master==="number") S.master=o.master;
      if(o.matrix){ S.matrix=o.matrix.map(r=>Object.assign({on:true,sm:null},r)); }
      if(o.lfos) o.lfos.forEach((L,i)=>{ if(S.lfos[i]) Object.assign(S.lfos[i],L); });
      if(o.audio) Object.assign(S.audio,o.audio);
      if(o.bpm) S.clock.bpm=o.bpm;
      buildLFOs(); buildMatrix(); refreshPanel();
    }
  };
}

global.UnlimiterDrive={create,version:VERSION};
})(window);
