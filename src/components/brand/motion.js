// Equivalent production adapter of logo/final/motion/motion.js (coupled OUTER → CORE).
// Event grammar, axes, palette, timings and displacement curves are preserved.
const core={x:78,y:95}; // Frozen negative-space disk center (69,79) + master wrapper (9,16).
const random=(min,max)=>min+Math.random()*(max-min);
const mix=(a,b,t)=>a+(b-a)*t;
const clamp=t=>Math.max(0,Math.min(1,t));
const ease=t=>{t=clamp(t);return t*t*(3-2*t);};
const neutralPart=()=>({inward:0,light:0,flow:-.22});
const neutral=()=>Array.from({length:3},neutralPart);
const atRest=pose=>pose.every(part=>part.inward===0 && part.light===0);
const svgNS='http://www.w3.org/2000/svg';

function localAxis(path){
  const box=path.getBBox(), center={x:box.x+box.width/2,y:box.y+box.height/2};
  const dx=core.x-center.x,dy=core.y-center.y,length=Math.hypot(dx,dy);
  const direction={x:dx/length,y:dy/length};
  const projections=Array.from({length:192},(_,i)=>{
    const p=path.getPointAtLength(path.getTotalLength()*i/192);
    return (p.x-center.x)*direction.x+(p.y-center.y)*direction.y;
  });
  const min=Math.min(...projections),max=Math.max(...projections);
  return {direction,outer:{x:center.x+min*direction.x,y:center.y+min*direction.y},span:max-min};
}
function material(svg,id){
  let defs=svg.querySelector('defs');
  if(!defs){defs=document.createElementNS(svgNS,'defs');svg.prepend(defs);}
  const gradient=document.createElementNS(svgNS,'linearGradient');
  gradient.id=id;gradient.setAttribute('gradientUnits','userSpaceOnUse');gradient.setAttribute('spreadMethod','pad');
  const stops=[0,.25,.5,.75,1].map(offset=>{
    const stop=document.createElementNS(svgNS,'stop');
    stop.setAttribute('offset',String(offset));stop.setAttribute('stop-color','currentColor');
    gradient.append(stop);return stop;
  });
  defs.append(gradient);return {gradient,stops};
}
function tint(base,color,amount){return `rgb(${base.map((value,i)=>Math.round(mix(value,color[i],amount))).join(' ')})`;}
function render(mark){
  mark.svg.style.transform='';
  mark.paths.forEach((path,i)=>{
    const part=mark.pose[i],axis=mark.axes[i],mat=mark.materials[i];
    const distance=part.inward*mark.units;
    path.style.transform=distance===0?'':`translate(${axis.direction.x*distance}px,${axis.direction.y*distance}px)`;
    if(part.light===0){
      path.style.fill='';mat.stops.forEach(stop=>stop.setAttribute('stop-color','currentColor'));
    }else{
      path.style.fill=`url(#${mat.gradient.id})`;
      const {base,shade,middle,highlight}=mark.palette;
      [shade,middle,highlight,middle,shade].forEach((color,j)=>mat.stops[j].setAttribute('stop-color',tint(base,color,part.light*mark.light)));
    }
    // One local band. Its center travels along the fixed outside → core axis only.
    for(const [side,progress] of [[1,part.flow-.2],[2,part.flow+.2]]){
      mat.gradient.setAttribute(`x${side}`,String(axis.outer.x+axis.direction.x*axis.span*progress));
      mat.gradient.setAttribute(`y${side}`,String(axis.outer.y+axis.direction.y*axis.span*progress));
    }
  });
}
function coupledEvent(mark,index,start,{idle=false,complete=false,handoff=0}={}){
  const from={...mark.pose[index]};
  const lead=complete?90:random(80,105);
  const peakAt=complete?260:idle?random(680,820):random(1000,1220);
  const innerMs=complete?60:idle?random(110,150):random(150,190);
  const holdMs=complete?35:random(20,45);
  const fadeMs=complete?65:random(85,115);
  const settleMs=complete?155:idle?random(200,240):random(270,320);
  const fadeStart=peakAt+innerMs+holdMs,fadeEnd=fadeStart+fadeMs;
  return {start,from,handoff,lead,peakAt,innerMs,fadeStart,fadeEnd,settleMs,duration:handoff+fadeEnd+settleMs,peakFlow:.82,amplitude:Math.max(from.inward,complete?1.1:idle?random(.55,.9):random(2,2.2)),light:complete?.95:idle?random(.5,.65):random(.82,.94)};
}
function eventPose(event,now){
  const elapsed=Math.max(0,now-event.start);
  if(elapsed<event.handoff){
    // Finish the old light, then reset its origin only while invisible. Geometry holds.
    const fading=elapsed<event.handoff*.6;
    return {...event.from,light:fading?event.from.light*(1-ease(elapsed/(event.handoff*.6))):0,flow:fading?mix(event.from.flow,1.22,ease(elapsed/(event.handoff*.6))):0};
  }
  const t=elapsed-event.handoff;
  let flow=t<=event.peakAt?event.peakFlow*ease(t/event.peakAt):mix(event.peakFlow,1,ease((t-event.peakAt)/event.innerMs));
  if(t>event.fadeStart)flow=mix(1,1.22,ease((t-event.fadeStart)/(event.fadeEnd-event.fadeStart)));
  const light=event.light*ease(t/36)*(1-ease((t-event.fadeStart)/(event.fadeEnd-event.fadeStart)));
  // Geometry follows the very same light progress, rather than a second motion curve.
  const flowAtLead=event.peakFlow*ease(event.lead/event.peakAt);
  const following=clamp((flow-flowAtLead)/(event.peakFlow-flowAtLead));
  let inward=mix(event.from.inward,event.amplitude,following);
  if(t>=event.fadeEnd)inward=event.amplitude*(1-ease((t-event.fadeEnd)/event.settleMs));
  return {inward,light,flow};
}
function beginGroup(mark,now){
  const permutations=[[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];
  const orientation=order=>order[(order.indexOf(0)+1)%3]===1;
  const choices=permutations.filter(order=>!mark.lastOrder || (orientation(order)!==orientation(mark.lastOrder) && order[0]!==mark.lastOrder[0]));
  const order=choices[Math.floor(random(0,choices.length))];mark.lastOrder=order;
  const handoff=atRest(mark.pose)?0:75;
  let delay=0;
  order.forEach(index=>{mark.tracks[index]=coupledEvent(mark,index,now+delay,{handoff});delay+=random(175,260);});
}
function beginSettle(mark,now){mark.settle={start:now,duration:420,from:mark.pose.map(part=>({...part}))};}
function restart(mark,now,complete=false,active=mark.active){
  mark.tracks=[null,null,null];mark.settle=null;mark.nextIdle=now+random(3000,5000);
  if(!active(mark)){mark.pose=neutral();render(mark);}
  else if(complete)mark.tracks=mark.pose.map((_,i)=>coupledEvent(mark,i,now,{complete:true,handoff:75}));
  else if(mark.state==='THINKING')beginGroup(mark,now);
  else if(!atRest(mark.pose))beginSettle(mark,now);
}
function settlePose(settle,now){
  const elapsed=Math.max(0,now-settle.start);
  return settle.from.map(from=>({inward:from.inward*(1-ease((elapsed-160)/260)),light:from.light*(1-ease(elapsed/160)),flow:mix(from.flow,1.22,ease(elapsed/160))}));
}
function tickMark(mark,now,active=mark.active){
  if(!active(mark))return;
  if(mark.settle){
    mark.pose=settlePose(mark.settle,now);
    if(now>=mark.settle.start+mark.settle.duration){mark.pose=neutral();mark.settle=null;}
    render(mark);return;
  }
  if(mark.state==='THINKING' && !mark.tracks.some(Boolean) && now>=mark.nextGroup)beginGroup(mark,now);
  if(mark.state==='IDLE' && !mark.tracks.some(Boolean) && now>=mark.nextIdle){
    const index=Math.floor(random(0,3));mark.tracks[index]=coupledEvent(mark,index,now,{idle:true});
  }
  let changed=false;
  mark.tracks.forEach((track,i)=>{
    if(!track || now<track.start)return;
    changed=true;mark.pose[i]=eventPose(track,now);
    if(now>=track.start+track.duration){
      mark.pose[i]=neutralPart();
      mark.tracks[i]=null;
      if(!mark.tracks.some(Boolean)){
        if(mark.state==='THINKING')mark.nextGroup=now+random(450,750);
        if(mark.state==='IDLE')mark.nextIdle=now+random(3000,5000);
      }
    }
  });
  if(changed)render(mark);
}


export function mountVocatryaMotion(svg, id, initialState = 'idle') {
  const systemReduced = matchMedia('(prefers-reduced-motion: reduce)');
  let frame = 0, timer = 0, disposed = false;
  const paths = [...svg.querySelectorAll('path')];
  const mark = {svg, paths, axes: paths.map(localAxis), materials: paths.map((_, i) => material(svg, id + '-' + i)), pose: neutral(), state: initialState.toUpperCase(), size: 0, light: 0, units: 0, nextIdle: 0, nextGroup: 0, lastOrder: null, tracks: [null, null, null], settle: null};
  mark.active = active;
  function palette() {
    const dark = document.documentElement.classList.contains('dark');
    const base = getComputedStyle(svg).color.match(/[\d.]+/g)?.slice(0,3).map(Number) ?? [0,0,0];
    mark.palette = {base, shade: dark?[156,156,156]:[23,23,23], middle: dark?[216,216,216]:[105,105,105], highlight: dark?[255,255,255]:[204,204,204]};
  }
  function wake() {
    clearTimeout(timer);
    if (!disposed && !frame && !document.hidden && !systemReduced.matches) frame = requestAnimationFrame(tick);
  }
  function tick(now) {
    frame = 0;
    tickMark(mark, now);
    // COMPLETE is a one-shot event. Return to mostly-static IDLE when it lands.
    if (mark.state === 'COMPLETE' && !mark.tracks.some(Boolean)) {
      mark.state = 'IDLE'; svg.dataset.state = 'idle'; mark.nextIdle = now + random(3000,5000);
    }
    if (active(mark) && (mark.settle || mark.tracks.some(track => track && now >= track.start))) wake();
    else if (active(mark)) {
      const delay = mark.state === 'IDLE' ? mark.nextIdle-now : mark.tracks.some(Boolean) ? Math.min(...mark.tracks.filter(Boolean).map(track => track.start-now)) : mark.state === 'THINKING' ? mark.nextGroup-now : Infinity;
      if (Number.isFinite(delay)) timer = setTimeout(wake, Math.max(0,delay));
    }
  }
  function reset() {
    cancelAnimationFrame(frame); frame = 0; clearTimeout(timer);
    mark.pose = neutral(); render(mark);
    restart(mark, performance.now(), mark.state === 'COMPLETE'); wake();
  }
  const observer = new ResizeObserver(([entry]) => {
    const size = entry.contentRect.width;
    if (size === mark.size) return;
    const geometry = size<24?0:size<32?.08:size<48?.65:1;
    mark.size=size; mark.light=size<24?0:size<32?.9:1; mark.units=geometry?geometry*144/Math.min(size,48):0;
    reset();
  });
  const themeObserver = new MutationObserver(() => {palette(); render(mark);});
  palette(); observer.observe(svg); themeObserver.observe(document.documentElement, {attributes:true, attributeFilter:['class','style']});
  systemReduced.addEventListener('change', reset); document.addEventListener('visibilitychange', reset);
  return {
    setState(state) {
      const next = state.toUpperCase();
      if (next === mark.state && next !== 'COMPLETE') return;
      mark.state=next; svg.dataset.state=state;
      restart(mark, performance.now(), next==='COMPLETE'); wake();
    },
    dispose() {
      disposed=true; cancelAnimationFrame(frame); clearTimeout(timer); observer.disconnect(); themeObserver.disconnect();
      systemReduced.removeEventListener('change', reset); document.removeEventListener('visibilitychange', reset);
      mark.pose=neutral(); render(mark); svg.querySelector('defs')?.remove();
    }
  };
  function active(mark) {return !systemReduced.matches && !document.hidden && mark.light>0;}
}
