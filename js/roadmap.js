/* ============================================================
   ROADMAP  (editor / visor de UN roadmap, identificado por ?id=)
   Depende de core.js
   ============================================================ */

const ROADMAP_PARAMS = new URLSearchParams(location.search);
const ROADMAP_ID = ROADMAP_PARAMS.get('id') || '';
const FORCE_VIEW = ROADMAP_PARAMS.get('view')==='1';
const LS_KEY  = 'roadmap-doc-' + ROADMAP_ID;
const LS_FBCFG = 'roadmap-fbcfg';
const LS_VIEW  = 'roadmap-view-v1';

/* ---- estado global ---- */
let state = defaultState();
let view = 'month';
let zoom = 1;
let editMode = false;
let canEdit = false;
let accessReady = false;
let roadmapPasswordHash = '';
let selected = null;          // {pi,ii,phi}
let filterCountry = '';
let filterBU = '';
let scale = null;
let layout = [];
let isDragging = false;
let pendingRemote = null;
let presentPrevEdit = true;
let localUnsubscribe = null;
let dragSrc = null;           // {pi,ii} iniciativa que se está arrastrando

const PX_PER_DAY = { year:0.5, cuatri:1.1, month:2.45, week:7.2 };

/* ---- lookups ---- */
function getType(id){ return state.phaseTypes.find(t=>t.id===id) || {id,name:id,color:'#888'}; }
function getCountry(code){ return state.countries.find(c=>c.code===code); }
function getBU(code){ return state.businessUnits.find(b=>b.code===code); }
function getIState(id){ return state.initiativeStates.find(s=>s.id===id) || {id,name:'—',color:'#94A3B8'}; }
/* Unidades de negocio de una fase (soporta multi-BU y el campo antiguo bu). */
function phaseBUCodes(ph){ if(Array.isArray(ph.bus)) return ph.bus; return ph.bu?[ph.bu]:[]; }
function phaseBUs(ph){ return phaseBUCodes(ph).map(getBU).filter(Boolean); }
function rangeStart(){ return parseD(state.config.rangeStart); }
function rangeEnd(){ return parseD(state.config.rangeEnd); }

/* ===================== ESCALA TEMPORAL ===================== */
function buildScale(){
  const rs=rangeStart(), re=rangeEnd();
  const pxPerDay = PX_PER_DAY[view]*zoom;
  const totalDays = daysBetween(rs,re)+1;
  const totalWidth = Math.max(800, totalDays*pxPerDay);
  function x(dt){ return daysBetween(rs,clampDate(dt,rs,re))*pxPerDay; }
  function xRaw(dt){ return daysBetween(rs,dt)*pxPerDay; }

  const t2=[]; const lines=[]; const shades=[];
  function pushPeriod(s,e,label,groupKey,groupLabel,shadeIdx){
    const cs=clampDate(s,rs,re), ce=clampDate(e,rs,re);
    const left=xRaw(cs), right=xRaw(addDays(ce,1));
    t2.push({label,left,width:right-left,start:cs,end:ce,groupKey,groupLabel});
    lines.push({x:left,strong:!!groupLabel});
    if(shadeIdx%2===1) shades.push({left,width:right-left});
  }
  if(view==='year'){
    for(let y=rs.getFullYear(); y<=re.getFullYear(); y++){
      pushPeriod(new Date(y,0,1),new Date(y,11,31),String(y),String(y),'',y-rs.getFullYear());
    }
  } else if(view==='cuatri'){
    // Cuatrimestres Falabella: C1 empieza en Febrero, C2 en Junio, C3 en Octubre.
    // Van DESFASADOS un mes respecto al año calendario (el año se dibuja aparte, más abajo).
    const startAM=rs.getFullYear()*12+rs.getMonth();
    const endAM=re.getFullYear()*12+re.getMonth();
    let a=startAM-(((startAM-1)%4)+4)%4; // primer inicio de cuatri (mes 1,5,9) <= inicio del rango
    while(a<=endAM){
      const sy=Math.floor(a/12), sm=((a%12)+12)%12;
      const s=new Date(sy,sm,1), e=new Date(sy,sm+4,0);
      if(!(e<rs||s>re)){
        const label= sm===1?'C1':sm===5?'C2':sm===9?'C3':'C';
        // groupLabel vacío => línea de cuatri SUAVE; shadeIdx 0 => sin sombra aquí.
        // El tier1 (años) y su sombreado se arman después, alineados al calendario.
        pushPeriod(s,e,label,'y'+sy,'',0);
      }
      a+=4;
    }
  } else if(view==='month'){
    let cur=new Date(rs.getFullYear(),rs.getMonth(),1); let i=0;
    while(cur<=re){
      const e=new Date(cur.getFullYear(),cur.getMonth()+1,0);
      pushPeriod(cur,e,MONTHS_ES[cur.getMonth()],String(cur.getFullYear()),String(cur.getFullYear()),cur.getMonth());
      cur=addMonths(cur,1); i++;
    }
  } else { // week
    let cur=mondayOf(rs); let i=0;
    while(cur<=re){
      const e=addDays(cur,6);
      const mk=cur.getFullYear()+'-'+cur.getMonth();
      pushPeriod(cur,e,String(cur.getDate()),mk,MONTHS_ES[cur.getMonth()]+' '+cur.getFullYear(),i);
      cur=addDays(cur,7); i++;
    }
  }
  const t1=[]; const seen=new Map();
  t2.forEach(p=>{
    let g=seen.get(p.groupKey);
    if(!g){ g={label:p.groupLabel||p.groupKey,left:p.left,right:p.left+p.width}; seen.set(p.groupKey,g); t1.push(g); }
    else { g.right=Math.max(g.right,p.left+p.width); g.left=Math.min(g.left,p.left); }
  });
  if(view==='cuatri'){
    // Año calendario REAL (ene–dic): línea fuerte en enero y bandas por año.
    // Así el año NO calza con los cuatrimestres (C1 arranca en febrero, un mes a la derecha).
    t1.length=0;
    for(let y=rs.getFullYear(); y<=re.getFullYear(); y++){
      const s=clampDate(new Date(y,0,1),rs,re), e=clampDate(new Date(y,11,31),rs,re);
      if(e<rs || s>re) continue;
      const left=xRaw(s), right=xRaw(addDays(e,1));
      if(right-left<=1) continue;
      t1.push({label:String(y),left,right});
      if(left>0.5) lines.push({x:left,strong:true});
      if(y%2===1) shades.push({left,width:right-left});
    }
  }
  t1.forEach(g=>g.width=g.right-g.left);

  scale={pxPerDay,totalDays,totalWidth,x,xRaw,t1,t2,lines,shades,rs,re,singleTier:view==='year'};
  return scale;
}

/* ===================== LAYOUT (filas) ===================== */
function assignLanes(phases){
  const items=phases.map((p,idx)=>({idx,s:parseD(p.start),e:parseD(p.end)}))
    .sort((a,b)=> a.s-b.s || a.e-b.e);
  const laneEnd=[];
  let prevLane=-1;
  items.forEach(it=>{
    // Escalera: si la fase se solapa con la anterior baja al siguiente carril libre;
    // si no se solapa vuelve a subir al carril libre más alto (compacto).
    let lane = (prevLane>=0 && it.s<=laneEnd[prevLane]) ? prevLane+1 : 0;
    while(lane<laneEnd.length && !(it.s>laneEnd[lane])) lane++;
    laneEnd[lane]=it.e;
    prevLane=lane;
    phases[it.idx]._lane=lane;
  });
  return Math.max(1,laneEnd.length);
}
function computeLayout(){
  layout=[];
  state.projects.forEach((proj,pi)=>{
    layout.push({kind:'project',pi,height:36});
    if(!proj.collapsed){
      proj.initiatives.forEach((ini,ii)=>{
        const lanes=assignLanes(ini.phases);
        const height=Math.max(50, lanes*27+19);
        layout.push({kind:'initiative',pi,ii,height,lanes});
      });
    }
  });
  return layout;
}

/* ===================== RENDER ===================== */
function renderAll(){
  applyConfig();
  buildScale();
  computeLayout();
  renderHead();
  renderRows();
  renderSidebar();
  renderTodayLine();
  renderLegend();
  syncTransforms();
}

function applyConfig(){
  document.documentElement.style.setProperty('--accent', state.config.accent||'#2F6FED');
  document.body.classList.toggle('dark', state.config.theme==='dark');
  const t=document.getElementById('brTitle'), s=document.getElementById('brSub');
  if(document.activeElement!==t) t.textContent=state.config.title;
  if(document.activeElement!==s) s.textContent=state.config.subtitle;
  const img=document.getElementById('logoImg');
  if(state.config.logo){ img.src=state.config.logo; img.style.display='block'; } else img.style.display='none';
  document.querySelectorAll('#viewSwitcher button').forEach(b=>b.classList.toggle('active',b.dataset.view===view));
  const fc=document.getElementById('filterCountry');
  if(fc.options.length-1!==state.countries.length){
    fc.innerHTML='<option value="">🌎 Todos los países</option>'+state.countries.map(c=>`<option value="${c.code}">${c.flag} ${c.name}</option>`).join('');
  }
  fc.value=filterCountry;
  const fb=document.getElementById('filterBU');
  if(fb.options.length-1!==state.businessUnits.length){
    fb.innerHTML='<option value="">🏢 Todas las BU</option>'+state.businessUnits.map(b=>`<option value="${b.code}">${b.code} · ${b.name}</option>`).join('');
  }
  fb.value=filterBU;
}

function renderHead(){
  const host=document.getElementById('tlHeadInner');
  host.style.width=scale.totalWidth+'px';
  const now=new Date();
  if(scale.singleTier){
    let html='<div class="tier-single">';
    scale.t2.forEach((p,i)=>{
      const isNow= now>=p.start && now<=addDays(p.end,0.99);
      html+=`<div class="t2cell big ${i%2?'alt':''} ${isNow?'now':''}" style="width:${p.width}px">${p.label}</div>`;
    });
    html+='</div>';
    host.innerHTML=html;
    return;
  }
  let t1='<div class="tier1">';
  scale.t1.forEach(g=>{ t1+=`<div class="t1cell" style="width:${g.width}px;left:${g.left}px">${g.label}</div>`; });
  t1+='</div>';
  let t2='<div class="tier2">';
  scale.t2.forEach((p,i)=>{
    const isNow= now>=p.start && now<=addDays(p.end,0.99);
    t2+=`<div class="t2cell ${i%2?'alt':''} ${isNow?'now':''}" style="width:${p.width}px">${p.label}</div>`;
  });
  t2+='</div>';
  host.innerHTML=t1+t2;
  host.querySelector('.tier1').style.position='relative';
  host.querySelectorAll('.t1cell').forEach(el=>{ el.style.position='absolute'; });
}

/* Líneas verticales de la grilla según el modo actual (año/C/mes/semana).
   Se dibujan DENTRO de cada fila de iniciativa —no en las de proyecto— para que
   todas las iniciativas de un proyecto compartan exactamente las mismas
   separaciones y las filas de proyecto queden en blanco, distinguiendo cada
   proyecto visualmente. */
function gridInnerHTML(){
  let h='';
  scale.lines.forEach(l=>{ if(l.x<0.5) return; h+=`<div class="grid-line ${l.strong?'strong':''}" style="left:${l.x}px"></div>`; });
  return h;
}

function renderRows(){
  const host=document.getElementById('rowsHost');
  host.style.width=scale.totalWidth+'px';
  document.getElementById('tlContent').style.width=scale.totalWidth+'px';
  if(!state.projects.length){ host.innerHTML='<div class="empty-hint">No hay proyectos todavía. Usa «＋ Proyecto» para empezar.</div>'; return; }
  const grid=gridInnerHTML();
  let h='';
  layout.forEach(r=>{
    if(r.kind==='project'){
      // Fila de proyecto: en blanco, sin líneas verticales (separa cada proyecto).
      h+=`<div class="brow proj" style="height:${r.height}px"></div>`;
    } else {
      // Fila de iniciativa: comparte las líneas verticales del modo actual.
      const ini=state.projects[r.pi].initiatives[r.ii];
      h+=`<div class="brow ini" data-pi="${r.pi}" data-ii="${r.ii}" style="height:${r.height}px"><div class="row-grid">${grid}</div>`;
      ini.phases.forEach((ph,phi)=>{
        h+=barHTML(ph,r.pi,r.ii,phi);
      });
      h+='</div>';
    }
  });
  host.innerHTML=h;
  attachBarEvents();
}

const CORP_ICON='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEEAAABBCAIAAAABlV4SAAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAQaADAAQAAAABAAAAQQAAAAD8l6BDAAACTElEQVRoBWO0tbNlGFIgOjoOzb1MaPyhyB31w+CItdF4GI0HaoXAaFqiVkhSZs5oPFAWftTSPRoP1ApJyswZDvHAQlkQYNEtKyklKiqipKSMRQ630JcvX06fOf32wwfcSnDKUM0PnBwc3h6eCUnJfPx8OG3DKzGpv3/NhvV4lYAkBdYeQFZzmesPdfwADPuOri5ZOTlk02nEFnn2C9lkRwYGKvgB6IHpM2eRHfzIDiKPTYU8XVFVNYAeAHqbUj8Y6enp6umRF37U0kVpWrK2tsHqlNUrVjx//hyrFFbBFy9eXL9xHasUQUFK/aChpYVpR2py0s07dzDFaSRCaVrCTEiXL12ipweA4UKpHzCD9vPHT5iCNBWhvh9o6lysho/6AWuw0F1wNB7oHuRYLaS0fsA0VFZeLiQgEFMclwikdiOv1Q0xkwZ+kJPLKyzE5WKs4kS2urHqBQqO5gdcIUNf8eEQD9TPD7SOg+eVzMhW/OD9SakfgE1UZBPJYH/7+u3x82fEa3wn8RFNMaV+oHMTFc31EC6lflBXUUEzl9RwRdNOBpdSP8yeOw/N1mOHj1TUVKEJ0pQ7HMqlUT/QNIkQbfhoPBAdVDRVOBoPNA1eog0fjQeig4qmCkfjgabBS7ThlMbD40eP0Oy6Se7wNZo5xHMpbfOlpKbIycgg20f/1jilfvj+4wedHf3ykRRykD28xk+pH5CNow/70FY7NIsozQ9oxg0Id9QPAxLsGJaOxgNGkAyIwGg8DEiwY1g6Gg8YQTIgAqPxMCDBjmEpAJpIcn3Ov13GAAAAAElFTkSuQmCC';
const MINW={year:12,cuatri:18,month:26,week:26};
function barHTML(ph,pi,ii,phi){
  const t=getType(ph.typeId);
  const left=scale.xRaw(parseD(ph.start));
  const right=scale.xRaw(addDays(parseD(ph.end),1));
  const width=Math.max(MINW[view]||26,right-left);
  const top=10+(ph._lane||0)*27;
  const col=t.color, tcol=textColor(col);
  const buCodes=phaseBUCodes(ph);
  const buHTML=phaseBUs(ph).map(b=>{
    const ico=iconURL(buIcon(b));
    return ico?`<img class="b-bu-ico" src="${ico}" alt="${escapeAttr(b.code)}" title="${escapeAttr(b.name)}">`:`<span class="b-bu">${escapeHtml(b.code)}</span>`;
  }).join('');
  const flagStr=(ph.countries||[]).map(c=>{const o=getCountry(c);if(!o)return '';const ico=iconURL(countryIcon(o));return ico?`<img class="b-flag-ico" src="${ico}" alt="${escapeAttr(o.code)}" title="${escapeAttr(o.name)}">`:escapeHtml(o.flag||'');}).join('');
  const flags=flagStr;
  const dim = (filterCountry && !(ph.countries||[]).includes(filterCountry)) || (filterBU && !buCodes.includes(filterBU));
  const sel = selected && selected.pi===pi && selected.ii===ii && selected.phi===phi;
  const compact = width < 56;
  const tiny = width < 26;
  const tip = `${ph.name||t.name} · ${t.name} · ${fmtNice(parseD(ph.start))}–${fmtNice(parseD(ph.end))}`;
  return `<div class="bar ${dim?'dim':''} ${sel?'sel':''} ${compact?'compact':''} ${tiny?'tiny':''}" data-pi="${pi}" data-ii="${ii}" data-phi="${phi}" title="${escapeAttr(tip)}"
    style="left:${left}px;width:${width}px;top:${top}px;background:${col};color:${tcol}">
    <span class="b-label">${escapeHtml(ph.name||t.name)}</span>
    ${buHTML?`<span class="b-bus">${buHTML}</span>`:''}
    ${flags?`<span class="b-flags">${flags}</span>`:''}
    <span class="b-resize"></span>
  </div>`;
}

function renderSidebar(){
  const host=document.getElementById('sidebarRows');
  let h='';
  layout.forEach(r=>{
    if(r.kind==='project'){
      const p=state.projects[r.pi];
      h+=`<div class="srow proj" data-pi="${r.pi}" style="height:${r.height}px">
        <span class="chev ${p.collapsed?'collapsed':''}" data-act="toggle">▾</span>
        <span class="proj-name" data-act="projname">${escapeHtml(p.name)}</span>
        ${editMode
          ? `<button class="mini" data-act="addini" title="Agregar iniciativa">＋</button>
             <button class="mini" data-act="projup" title="Subir">▲</button>
             <button class="mini" data-act="projdown" title="Bajar">▼</button>
             <button class="mini danger" data-act="projdel" title="Eliminar proyecto">✕</button>`
          : `<span class="proj-count">${p.initiatives.length}</span>`}
      </div>`;
    } else {
      const ini=state.projects[r.pi].initiatives[r.ii];
      const st=getIState(ini.stateId);
      if(editMode){
        h+=`<div class="srow ini edit" data-pi="${r.pi}" data-ii="${r.ii}" style="height:${r.height}px">
          <div class="ini-line1">
            <span class="ini-drag" data-act="drag" draggable="true" title="Arrastrar para reordenar dentro del proyecto">⠿</span>
            <span class="ini-name" data-act="ininame">${escapeHtml(ini.name)}</span>
            <button class="mini" data-act="addphase" title="Agregar fase">＋</button>
            <button class="mini danger" data-act="inidel" title="Eliminar iniciativa">✕</button>
          </div>
          <div class="ini-line2">
            <input class="owner-in" data-act="owner" placeholder="Responsable" value="${escapeAttr(ini.owner||'')}">
            <select class="state-in" data-act="state">${state.initiativeStates.map(s=>`<option value="${s.id}" ${s.id===ini.stateId?'selected':''}>${escapeHtml(s.name)}</option>`).join('')}</select>
          </div>
        </div>`;
      } else {
        h+=`<div class="srow ini" data-pi="${r.pi}" data-ii="${r.ii}" style="height:${r.height}px">
          <span class="ini-name">${escapeHtml(ini.name)}</span>
          <span class="ini-meta">
            ${ini.owner?`<span class="owner">👤 ${escapeHtml(ini.owner)}</span>`:''}
            <span class="state-pill" style="background:${st.color}">${escapeHtml(st.name)}</span>
          </span>
        </div>`;
      }
    }
  });
  host.innerHTML=h;
  attachSidebarEvents();
}

function renderTodayLine(){
  const line=document.getElementById('todayLine');
  const now=new Date();
  if(now<scale.rs || now>scale.re){ line.style.display='none'; removeTodayBadge(); return; }
  line.style.display='block';
  const x=scale.xRaw(now);
  line.style.left=x+'px';
  line.style.height=document.getElementById('tlContent').scrollHeight+'px';
  let badge=document.getElementById('todayBadge');
  if(!badge){ badge=document.createElement('div'); badge.id='todayBadge'; badge.className='today-badge'; document.getElementById('tlHeadInner').appendChild(badge); }
  badge.style.left=x+'px';
  badge.textContent='HOY · '+fmtNice(now);
}
function removeTodayBadge(){ const b=document.getElementById('todayBadge'); if(b) b.remove(); }

function renderLegend(){
  document.getElementById('legend').innerHTML=state.phaseTypes.map(t=>
    `<span class="lg"><span class="sw" style="background:${t.color}"></span>${escapeHtml(t.name)}</span>`
  ).join('');
}

/* ===================== SCROLL SYNC ===================== */
function syncTransforms(){
  const body=document.getElementById('tlBody');
  document.getElementById('tlHeadInner').style.transform=`translateX(${-body.scrollLeft}px)`;
  document.getElementById('sidebarRows').style.transform=`translateY(${-body.scrollTop}px)`;
}

/* ===================== EVENTOS BARRAS ===================== */
function attachBarEvents(){
  document.querySelectorAll('.bar').forEach(bar=>{
    const pi=+bar.dataset.pi, ii=+bar.dataset.ii, phi=+bar.dataset.phi;
    const ph=state.projects[pi].initiatives[ii].phases[phi];
    if(!editMode){
      bar.addEventListener('mouseenter',e=>showTip(e,pi,ii,phi));
      bar.addEventListener('mousemove',moveTip);
      bar.addEventListener('mouseleave',hideTip);
      return;
    }
    bar.addEventListener('pointerdown',e=>{
      if(e.target.classList.contains('b-resize')) return;
      e.preventDefault();
      const startX=e.clientX, startY=e.clientY;
      const s0=parseD(ph.start), e0=parseD(ph.end);
      const dur=daysBetween(s0,e0);
      let moved=false;
      isDragging=true;
      bar.setPointerCapture&&bar.setPointerCapture(e.pointerId);
      function mv(ev){
        const dx=ev.clientX-startX, dy=ev.clientY-startY;
        if(Math.abs(dx)>3||Math.abs(dy)>3) moved=true;
        const dd=Math.round(dx/scale.pxPerDay);
        let ns=addDays(s0,dd);
        ns=clampDate(ns,scale.rs,addDays(scale.re,-dur));
        ph.start=isoD(ns); ph.end=isoD(addDays(ns,dur));
        bar.style.left=scale.xRaw(ns)+'px';
      }
      function up(ev){
        document.removeEventListener('pointermove',mv);
        document.removeEventListener('pointerup',up);
        isDragging=false;
        if(moved){ commit(); } else { selectBar(pi,ii,phi); }
        flushPending();
      }
      document.addEventListener('pointermove',mv);
      document.addEventListener('pointerup',up);
    });
    const handle=bar.querySelector('.b-resize');
    handle.addEventListener('pointerdown',e=>{
      e.preventDefault(); e.stopPropagation();
      const startX=e.clientX; const s0=parseD(ph.start); const e0=parseD(ph.end);
      isDragging=true;
      function mv(ev){
        const dd=Math.round((ev.clientX-startX)/scale.pxPerDay);
        let ne=addDays(e0,dd);
        if(ne<s0) ne=new Date(s0);
        ne=clampDate(ne,scale.rs,scale.re);
        ph.end=isoD(ne);
        bar.style.width=Math.max(MINW[view]||26,scale.xRaw(addDays(ne,1))-scale.xRaw(s0))+'px';
      }
      function up(){
        document.removeEventListener('pointermove',mv);
        document.removeEventListener('pointerup',up);
        isDragging=false; commit(); flushPending();
      }
      document.addEventListener('pointermove',mv);
      document.addEventListener('pointerup',up);
    });
  });
}

/* ===================== TOOLTIP ===================== */
function showTip(e,pi,ii,phi){
  const ini=state.projects[pi].initiatives[ii];
  const ph=ini.phases[phi]; const t=getType(ph.typeId);
  const flags=(ph.countries||[]).map(c=>{const o=getCountry(c);return o?o.flag+' '+o.code:'';}).join(', ');
  const buNames=phaseBUs(ph).map(b=>b.name).join(', ');
  const tip=document.getElementById('tip');
  tip.innerHTML=`<b>${escapeHtml(ini.name)} · ${escapeHtml(ph.name||t.name)}</b><br>
    <span class="t-sub">${escapeHtml(t.name)}${buNames?' · '+escapeHtml(buNames):''}</span><br>
    <span class="t-sub">${fmtNice(parseD(ph.start))} → ${fmtNice(parseD(ph.end))}</span>
    ${flags?`<br><span class="t-sub">${flags}</span>`:''}`;
  tip.style.display='block'; moveTip(e);
}
function moveTip(e){
  const tip=document.getElementById('tip');
  let x=e.clientX+14, y=e.clientY+14;
  if(x+tip.offsetWidth>window.innerWidth) x=e.clientX-tip.offsetWidth-14;
  tip.style.left=x+'px'; tip.style.top=y+'px';
}
function hideTip(){ document.getElementById('tip').style.display='none'; }

/* ===================== EVENTOS SIDEBAR ===================== */
function attachSidebarEvents(){
  document.querySelectorAll('#sidebarRows .srow').forEach(row=>{
    const pi=+row.dataset.pi;
    if(row.classList.contains('proj')){
      const toggle=e=>{e.stopPropagation();state.projects[pi].collapsed=!state.projects[pi].collapsed;commit();};
      row.querySelector('[data-act="toggle"]').addEventListener('click',toggle);
      const nameEl=row.querySelector('.proj-name');
      if(editMode){
        nameEl.addEventListener('dblclick',e=>{e.stopPropagation();inlineRename(nameEl,v=>{state.projects[pi].name=v;commit();});});
        const b=sel=>row.querySelector(`[data-act="${sel}"]`);
        b('addini').addEventListener('click',e=>{e.stopPropagation();addInitiative(pi);});
        b('projup').addEventListener('click',e=>{e.stopPropagation();moveProject(pi,-1);});
        b('projdown').addEventListener('click',e=>{e.stopPropagation();moveProject(pi,1);});
        b('projdel').addEventListener('click',e=>{e.stopPropagation();if(confirm('¿Eliminar el proyecto «'+state.projects[pi].name+'» y todas sus iniciativas?')){state.projects.splice(pi,1);commit();}});
      } else {
        nameEl.style.cursor='pointer';
        nameEl.addEventListener('click',toggle);
      }
    } else {
      const ii=+row.dataset.ii;
      const ini=state.projects[pi].initiatives[ii];
      const nameEl=row.querySelector('.ini-name');
      if(editMode){
        nameEl.addEventListener('dblclick',()=>inlineRename(nameEl,v=>{ini.name=v;commit();}));
        row.querySelector('[data-act="owner"]').addEventListener('change',e=>{ini.owner=e.target.value;commit();});
        row.querySelector('[data-act="state"]').addEventListener('change',e=>{ini.stateId=e.target.value;commit();});
        row.querySelector('[data-act="addphase"]').addEventListener('click',()=>addPhase(pi,ii));
        row.querySelector('[data-act="inidel"]').addEventListener('click',()=>{if(confirm('¿Eliminar la iniciativa «'+ini.name+'»?')){state.projects[pi].initiatives.splice(ii,1);commit();}});
        const dragH=row.querySelector('[data-act="drag"]');
        if(dragH){
          dragH.addEventListener('dragstart',e=>{dragSrc={pi,ii};e.dataTransfer.effectAllowed='move';try{e.dataTransfer.setData('text/plain',pi+':'+ii);}catch(_){}row.classList.add('dragging');});
          dragH.addEventListener('dragend',()=>{row.classList.remove('dragging');clearDropMarks();dragSrc=null;});
        }
        row.addEventListener('dragover',e=>{if(!dragSrc||dragSrc.pi!==pi)return;e.preventDefault();e.dataTransfer.dropEffect='move';const before=dropBefore(e,row);row.classList.toggle('drop-before',before);row.classList.toggle('drop-after',!before);});
        row.addEventListener('dragleave',()=>{row.classList.remove('drop-before','drop-after');});
        row.addEventListener('drop',e=>{if(!dragSrc||dragSrc.pi!==pi)return;e.preventDefault();const before=dropBefore(e,row);moveInitiative(dragSrc.pi,dragSrc.ii,ii,before);});
      }
    }
  });
}
function inlineRename(el,onDone){
  const old=el.textContent;
  const input=document.createElement('input');
  input.type='text'; input.value=old;
  input.style.cssText='width:100%;border:1px solid var(--accent);border-radius:6px;padding:2px 6px;font:inherit';
  el.replaceWith(input); input.focus(); input.select();
  let done=false;
  const finish=(commitIt)=>{ if(done)return; done=true; const v=input.value.trim()||old; const span=document.createElement('span'); span.className=el.className; span.textContent=commitIt?v:old; input.replaceWith(span); if(commitIt&&v!==old) onDone(v); else renderAll(); };
  input.addEventListener('keydown',e=>{if(e.key==='Enter')finish(true);if(e.key==='Escape')finish(false);});
  input.addEventListener('blur',()=>finish(true));
}

/* ===================== CRUD estructura ===================== */
function addProject(){
  // Proyecto nuevo vacío: sin iniciativas al comienzo.
  state.projects.push({id:uid(),name:'Nuevo proyecto',collapsed:false,initiatives:[]});
  commit();
}
function addInitiative(pi){
  state.projects[pi].initiatives.push({id:uid(),name:'Nueva iniciativa',owner:'',stateId:state.initiativeStates[0].id,phases:[
    {id:uid(),name:'Discovery',typeId:state.phaseTypes[0].id,countries:[],bus:[],start:isoD(clampDate(new Date(),scale.rs,scale.re)),end:isoD(clampDate(addDays(new Date(),45),scale.rs,scale.re))}
  ]});
  state.projects[pi].collapsed=false; commit();
}
function addPhase(pi,ii){
  const ini=state.projects[pi].initiatives[ii];
  let s=new Date();
  if(ini.phases.length){ const last=ini.phases.reduce((a,b)=>parseD(b.end)>parseD(a.end)?b:a); s=addDays(parseD(last.end),1); }
  s=clampDate(s,scale.rs,scale.re);
  const ph={id:uid(),name:'Nueva fase',typeId:state.phaseTypes[0].id,countries:[],bus:[],start:isoD(s),end:isoD(clampDate(addDays(s,30),scale.rs,scale.re))};
  ini.phases.push(ph); commit();
  selectBar(pi,ii,ini.phases.length-1);
}
function moveProject(pi,dir){
  const ni=pi+dir; if(ni<0||ni>=state.projects.length) return;
  const [it]=state.projects.splice(pi,1); state.projects.splice(ni,0,it); commit();
}
function dropBefore(e,row){ const r=row.getBoundingClientRect(); return (e.clientY-r.top) < r.height/2; }
function clearDropMarks(){ document.querySelectorAll('.srow.ini.drop-before,.srow.ini.drop-after').forEach(el=>el.classList.remove('drop-before','drop-after')); }
function moveInitiative(pi,from,target,before){
  const arr=state.projects[pi].initiatives;
  let to = before?target:target+1;
  if(from<to) to--;
  clearDropMarks();
  if(to===from) return;
  const [it]=arr.splice(from,1);
  arr.splice(Math.max(0,Math.min(arr.length,to)),0,it);
  commit();
}

/* ===================== PANEL DE FASE ===================== */
function selectBar(pi,ii,phi){
  selected={pi,ii,phi};
  renderRows();
  openBarPanel();
}
function openBarPanel(){
  if(!selected) return;
  const ph=state.projects[selected.pi].initiatives[selected.ii].phases[selected.phi];
  document.getElementById('pfName').value=ph.name||'';
  const tsel=document.getElementById('pfType');
  tsel.innerHTML=state.phaseTypes.map(t=>`<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
  tsel.value=ph.typeId;
  const bc=document.getElementById('pfBUs');
  const activeBUs=phaseBUCodes(ph);
  bc.innerHTML=state.businessUnits.map(b=>{
    const ico=iconURL(buIcon(b));
    const on=activeBUs.includes(b.code);
    return `<span class="chip bu-chip ${on?'on':''}" data-bu="${escapeAttr(b.code)}" title="${escapeAttr(b.name)}">${ico?`<img class="c-ico" src="${ico}" alt="">`:''}${escapeHtml(b.code)}</span>`;
  }).join('');
  bc.querySelectorAll('.chip').forEach(ch=>ch.addEventListener('click',()=>{
    ph.bus=Array.isArray(ph.bus)?ph.bus:(ph.bu?[ph.bu]:[]);
    if('bu' in ph) delete ph.bu;
    const code=ch.dataset.bu; const i=ph.bus.indexOf(code);
    if(i>=0) ph.bus.splice(i,1); else ph.bus.push(code);
    ch.classList.toggle('on'); commit();
  }));
  const cc=document.getElementById('pfCountries');
  cc.innerHTML=state.countries.map(c=>{const ico=iconURL(countryIcon(c));return `<span class="chip ${(ph.countries||[]).includes(c.code)?'on':''}" data-code="${c.code}">${ico?`<img class="c-ico" src="${ico}" alt="">`:c.flag} ${c.code}</span>`;}).join('');
  cc.querySelectorAll('.chip').forEach(ch=>ch.addEventListener('click',()=>{
    ph.countries=ph.countries||[];
    const code=ch.dataset.code; const i=ph.countries.indexOf(code);
    if(i>=0) ph.countries.splice(i,1); else ph.countries.push(code);
    ch.classList.toggle('on'); commit();
  }));
  document.getElementById('pfStart').value=ph.start;
  document.getElementById('pfEnd').value=ph.end;
  document.getElementById('barPanel').classList.add('open');
}
function closeBarPanel(){ document.getElementById('barPanel').classList.remove('open'); selected=null; renderRows(); }
function currentPhase(){ return selected?state.projects[selected.pi].initiatives[selected.ii].phases[selected.phi]:null; }

/* ===================== PERSISTENCIA ===================== */
function commit(){ renderAll(); cloudSave(); }
/* El roadmap se guarda solo en Firebase; no se crean copias locales en el navegador. */
function saveLocal(){}
function loadLocal(){
  try{
    let r=localStorage.getItem(LS_KEY);
    // Compatibilidad con el monolito anterior, que guardaba el roadmap principal
    // bajo otra clave. Se copia una sola vez al nuevo espacio por documento.
    if(!r && ROADMAP_ID==='main'){
      r=localStorage.getItem('roadmap-cloud-v1');
      if(r) localStorage.setItem(LS_KEY,r);
    }
    if(r){ state=migrate(JSON.parse(r)); return true; }
  }catch(e){}
  return false;
}

/* ===================== NUBE (FIREBASE) ===================== */
let cloud={enabled:false,connected:false,fs:null,docRef:null,clientId:uid(),timer:null,connectTimer:null,_flushTimer:null};
async function initCloud(){
  if(STORAGE_MODE==='local'){
    const meta=getLocalRoadmapMeta(ROADMAP_ID);
    roadmapPasswordHash=meta.passwordHash||'';
    accessReady=true;
    setCloudStatus('localdev');
    localUnsubscribe=subscribeLocalRoadmapDoc(ROADMAP_ID,cloud.clientId,raw=>{
      let incoming; try{ incoming=JSON.parse(raw); }catch(e){ return; }
      if(isDragging || (document.activeElement && ['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName))){
        pendingRemote=incoming;
        return;
      }
      state=migrate(incoming);
      renderAll();
    });
    return;
  }
  if(!FIREBASE_CONFIG || !FIREBASE_CONFIG.apiKey){ setCloudStatus('local'); return; }
  setCloudStatus('connecting');
  clearTimeout(cloud.connectTimer);
  cloud.connectTimer=setTimeout(()=>{
    if(!cloud.connected) setCloudStatus('error');
  },8000);
  try{
    const {db,fs}=await getFB();
    const docRef=fs.doc(db,ROADMAPS_COL,ROADMAP_ID);
    cloud.enabled=true; cloud.fs=fs; cloud.docRef=docRef;
    fs.onSnapshot(docRef,snap=>{
      cloud.connected=true;
      clearTimeout(cloud.connectTimer);
      setCloudStatus('cloud');
      if(!snap.exists()){ accessReady=true; cloudSave(true); return; }
      const data=snap.data();
      roadmapPasswordHash=data.passwordHash||roadmapPasswordHash||'';
      accessReady=true;
      if(data.clientId===cloud.clientId) return;
      if(!data.json) return;
      let incoming; try{ incoming=JSON.parse(data.json); }catch(e){ return; }
      if(isDragging || (document.activeElement && ['INPUT','SELECT','TEXTAREA'].includes(document.activeElement.tagName))){ pendingRemote=incoming; return; }
      state=migrate(incoming); saveLocal(); renderAll();
    },err=>{
      cloud.connected=false;
      clearTimeout(cloud.connectTimer);
      setCloudStatus('error');
    });
    if(!cloud._flushTimer){
      cloud._flushTimer=setInterval(flushPending,1000);
      document.addEventListener('focusout',()=>setTimeout(flushPending,60));
    }
  }catch(e){
    console.warn(e);
    cloud.connected=false;
    clearTimeout(cloud.connectTimer);
    setCloudStatus('error');
  }
}
function cloudSave(seed){
  if(!cloud.enabled) return;
  clearTimeout(cloud.timer);
  cloud.timer=setTimeout(()=>{
    const payload={json:JSON.stringify(state),name:state.config.title,clientId:cloud.clientId,updatedAt:Date.now()};
    if(roadmapPasswordHash) payload.passwordHash=roadmapPasswordHash;
    cloud.fs.setDoc(cloud.docRef,payload,{merge:true})
      .then(()=>{
        cloud.connected=true;
        clearTimeout(cloud.connectTimer);
        setCloudStatus('cloud');
      })
      .catch(()=>{
        cloud.connected=false;
        setCloudStatus('error');
      });
  },seed?0:500);
}
function flushPending(){
  if(!pendingRemote || isDragging) return;
  const ae=document.activeElement;
  if(ae && ['INPUT','SELECT','TEXTAREA'].includes(ae.tagName)) return;
  state=migrate(pendingRemote); pendingRemote=null; saveLocal(); renderAll();
}
function setCloudStatus(s){
  const map={
    local:['','Local (este navegador)'],
    localdev:['local','Modo local temporal'],
    connecting:['','Conectando…'],
    cloud:['on','En la nube · tiempo real'],
    error:['err','Error de conexión']
  };
  const [cls,txt]=map[s]||map.local;
  ['cloudDot','cloudDot2'].forEach(id=>{const d=document.getElementById(id);if(d){d.className='cloud-dot '+cls;}});
  const t=document.getElementById('cloudStatusText'); if(t) t.textContent=txt;
  const cd=document.getElementById('cloudDot'); if(cd) cd.title='Nube: '+txt;
  const help=document.getElementById('cloudHelp');
  if(help && s==='localdev'){
    help.innerHTML='Modo temporal mientras Firebase está suspendido. Los cambios se guardan en <b>este navegador</b> y se sincronizan entre sus pestañas, pero no con otros computadores.';
  }
}

/* ===================== ACCESO / SOLO LECTURA ===================== */
function initAccessState(){
  if(STORAGE_MODE==='local'){
    const meta=getLocalRoadmapMeta(ROADMAP_ID);
    roadmapPasswordHash=meta.passwordHash||'';
    accessReady=true;
  }
  canEdit=roadmapEditUnlocked(ROADMAP_ID);
}

function openUnlockModal(){
  const modal=document.getElementById('unlockModal');
  const input=document.getElementById('unlockPass');
  const err=document.getElementById('unlockErr');
  input.value='';
  err.textContent=accessReady
    ? (roadmapPasswordHash?'':'Este roadmap aún no tiene clave propia. Usa la clave madre.')
    : 'Esperando la información de acceso desde la nube…';
  modal.classList.add('open');
  setTimeout(()=>input.focus(),50);
}

function closeUnlockModal(){
  document.getElementById('unlockModal').classList.remove('open');
  document.getElementById('unlockPass').value='';
}

async function submitUnlock(){
  const pass=document.getElementById('unlockPass').value;
  const err=document.getElementById('unlockErr');
  if(!accessReady && pass!==MASTER_PASS){
    err.textContent='Espera a que termine la conexión o usa la clave madre.';
    return;
  }
  if(!pass){ err.textContent='Ingresa una clave.'; return; }
  const isMaster=pass===MASTER_PASS;
  const valid=isMaster || await passwordMatches(pass,roadmapPasswordHash);
  if(!valid){
    err.textContent=roadmapPasswordHash?'Clave incorrecta.':'Este roadmap aún no tiene clave propia; usa la clave madre.';
    return;
  }
  if(isMaster) grantMasterAccess(); else grantRoadmapEdit(ROADMAP_ID);
  canEdit=true;
  closeUnlockModal();
  setEdit(true);
}

async function shareRoadmap(){
  const url=new URL('roadmap.html',location.href);
  url.search='?id='+encodeURIComponent(ROADMAP_ID)+'&view=1';
  const button=document.getElementById('shareBtn');
  try{
    await navigator.clipboard.writeText(url.href);
    const old=button.textContent;
    button.textContent='✓ Enlace copiado';
    setTimeout(()=>button.textContent=old,1600);
  }catch(e){
    prompt('Copia este enlace de solo lectura:',url.href);
  }
}

async function saveAccessPassword(){
  const pass=document.getElementById('settingsPass').value;
  const pass2=document.getElementById('settingsPass2').value;
  const err=document.getElementById('settingsPassErr');
  if(!pass){ err.textContent='Escribe una nueva clave.'; return; }
  if(pass!==pass2){ err.textContent='Las claves no coinciden.'; return; }
  const button=document.getElementById('settingsPassSave');
  button.disabled=true;
  button.textContent='Guardando…';
  try{
    const passwordHash=await hashPassword(pass);
    if(STORAGE_MODE==='local'){
      setLocalRoadmapPasswordHash(ROADMAP_ID,passwordHash,cloud.clientId);
    }else{
      if(!cloud.enabled) throw new Error('La nube todavía no está disponible.');
      await cloud.fs.setDoc(cloud.docRef,{passwordHash,updatedAt:Date.now()},{merge:true});
    }
    roadmapPasswordHash=passwordHash;
    accessReady=true;
    grantRoadmapEdit(ROADMAP_ID);
    canEdit=true;
    document.getElementById('settingsPass').value='';
    document.getElementById('settingsPass2').value='';
    err.textContent='Clave guardada correctamente.';
    err.classList.add('ok');
    renderAccessSettings();
  }catch(e){
    err.classList.remove('ok');
    err.textContent='No se pudo guardar: '+(e.message||e);
  }finally{
    button.disabled=false;
    button.textContent='Guardar nueva clave';
  }
}

function renderAccessSettings(){
  const status=document.getElementById('accessState');
  if(status){
    status.className='access-state '+(roadmapPasswordHash?'protected':'legacy');
    status.textContent=roadmapPasswordHash
      ? '🔒 Este roadmap tiene una clave de edición.'
      : '⚠ Este roadmap antiguo todavía no tiene clave propia; solo puede desbloquearse con la clave madre.';
  }
}

/* ===================== SETTINGS ===================== */
function openSettings(){
  if(!canEdit || !editMode){ openUnlockModal(); return; }
  document.getElementById('overlay').classList.add('open');
  document.getElementById('settings').classList.add('open');
  renderSettings();
}
function closeSettings(){ document.getElementById('overlay').classList.remove('open'); document.getElementById('settings').classList.remove('open'); }
function renderSettings(){
  document.getElementById('phasesList').innerHTML=state.phaseTypes.map((t,i)=>crudRow('phase',i,[
    {type:'text',val:t.name,key:'name',ph:'Nombre'},
    {type:'color',val:t.color,key:'color'}
  ])).join('');
  document.getElementById('countriesList').innerHTML=state.countries.map((c,i)=>crudRow('country',i,[
    {type:'flagicon',val:c.icon||'',key:'icon'},
    {type:'flag',val:c.flag,key:'flag'},
    {type:'code',val:c.code,key:'code'},
    {type:'text',val:c.name,key:'name',ph:'Nombre'}
  ])).join('');
  document.getElementById('buList').innerHTML=state.businessUnits.map((b,i)=>crudRow('bu',i,[
    {type:'buicon',val:b.icon||'',key:'icon'},
    {type:'code',val:b.code,key:'code'},
    {type:'text',val:b.name,key:'name',ph:'Nombre'},
    {type:'color',val:b.color,key:'color'}
  ])).join('');
  document.getElementById('statesList').innerHTML=state.initiativeStates.map((s,i)=>crudRow('state',i,[
    {type:'text',val:s.name,key:'name',ph:'Nombre'},
    {type:'color',val:s.color,key:'color'}
  ])).join('');
  bindCrud();
  document.getElementById('genTitle').value=state.config.title;
  document.getElementById('genSub').value=state.config.subtitle;
  document.getElementById('genStart').value=state.config.rangeStart;
  document.getElementById('genEnd').value=state.config.rangeEnd;
  document.getElementById('genView').value=state.config.view;
  document.getElementById('genTheme').value=state.config.theme;
  document.getElementById('genAccent').value=state.config.accent;
  document.getElementById('genLogo').value=state.config.logo||'';
  document.getElementById('settingsPass').value='';
  document.getElementById('settingsPass2').value='';
  const passErr=document.getElementById('settingsPassErr');
  passErr.textContent='';
  passErr.classList.remove('ok');
  renderAccessSettings();
}
function crudRow(kind,i,fields){
  let inner=fields.map(f=>{
    if(f.type==='color') return `<input type="color" value="${f.val}" data-kind="${kind}" data-i="${i}" data-key="${f.key}">`;
    if(f.type==='code') return `<input type="text" class="code-in" value="${escapeAttr(f.val)}" data-kind="${kind}" data-i="${i}" data-key="${f.key}">`;
    if(f.type==='flag') return `<input type="text" class="flag-in" value="${escapeAttr(f.val)}" data-kind="${kind}" data-i="${i}" data-key="${f.key}">`;
    if(f.type==='buicon'||f.type==='flagicon'){
      const choices=f.type==='flagicon'?COUNTRY_ICON_CHOICES:BU_ICON_CHOICES;
      const opts=['<option value="">— sin icono —</option>'].concat(
        choices.map(c=>`<option value="${escapeAttr(c.path)}" ${c.path===f.val?'selected':''}>${escapeHtml(c.label)}</option>`)
      ).join('');
      const prev=f.val?`<img class="bu-ico-prev" src="${escapeAttr(iconURL(f.val))}" alt="">`:'<span class="bu-ico-prev empty"></span>';
      return `<span class="bu-ico-cell">${prev}<select class="icon-in" data-kind="${kind}" data-i="${i}" data-key="${f.key}">${opts}</select></span>`;
    }
    return `<input type="text" value="${escapeAttr(f.val)}" placeholder="${f.ph||''}" data-kind="${kind}" data-i="${i}" data-key="${f.key}">`;
  }).join('');
  return `<div class="crud-row">${inner}<button class="mini danger" data-del="${kind}" data-i="${i}">✕</button></div>`;
}
function bindCrud(){
  const arr={phase:'phaseTypes',country:'countries',bu:'businessUnits',state:'initiativeStates'};
  document.querySelectorAll('.crud-row input').forEach(inp=>{
    inp.addEventListener('input',()=>{
      const a=state[arr[inp.dataset.kind]]; const it=a[+inp.dataset.i];
      it[inp.dataset.key]=inp.value;
      renderAll(); saveLocal(); cloudSave();
    });
  });
  document.querySelectorAll('.crud-row select').forEach(sel=>{
    sel.addEventListener('change',()=>{
      const a=state[arr[sel.dataset.kind]]; const it=a[+sel.dataset.i];
      it[sel.dataset.key]=sel.value;
      commit(); renderSettings();
    });
  });
  document.querySelectorAll('[data-del]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const a=state[arr[btn.dataset.del]];
      if(a.length<=1){ alert('Debe quedar al menos uno.'); return; }
      a.splice(+btn.dataset.i,1); commit(); renderSettings();
    });
  });
}

/* ===================== EXPORTAR ===================== */
async function exportImage(kind){
  if(!window.html2canvas){ alert('Librería no disponible.'); return; }
  hideTip();
  const board=document.querySelector('.board');
  const body=document.getElementById('tlBody');
  const sx=body.scrollLeft, sy=body.scrollTop;
  const sidebarW=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'))||322;
  const fullW=Math.ceil(sidebarW+scale.totalWidth);
  body.scrollLeft=0; body.scrollTop=0; syncTransforms();
  document.body.classList.add('exporting');
  board.style.width=fullW+'px';
  const fullH=Math.ceil(board.scrollHeight);
  let canvas;
  try{
    canvas=await html2canvas(board,{backgroundColor:'#ffffff',scale:2,useCORS:true,width:fullW,height:fullH,windowWidth:fullW,windowHeight:fullH});
  }catch(err){
    document.body.classList.remove('exporting'); board.style.width=''; body.scrollLeft=sx; body.scrollTop=sy; syncTransforms();
    alert('No se pudo exportar: '+err); return;
  }
  document.body.classList.remove('exporting'); board.style.width=''; body.scrollLeft=sx; body.scrollTop=sy; syncTransforms();
  if(kind==='png'){
    const a=document.createElement('a'); a.download='roadmap.png'; a.href=canvas.toDataURL('image/png'); a.click();
  } else {
    const {jsPDF}=window.jspdf||{};
    if(!jsPDF){ alert('Librería PDF no disponible.'); return; }
    const orient=canvas.width>=canvas.height?'landscape':'portrait';
    const pdf=new jsPDF({orientation:orient,unit:'mm',format:'a3'});
    const pw=pdf.internal.pageSize.getWidth(), ph=pdf.internal.pageSize.getHeight();
    const img=canvas.toDataURL('image/png');
    const r=Math.min(pw/canvas.width,ph/canvas.height);
    pdf.addImage(img,'PNG',(pw-canvas.width*r)/2,(ph-canvas.height*r)/2,canvas.width*r,canvas.height*r);
    pdf.save('roadmap.pdf');
  }
}

/* ===================== ARCHIVO (JSON / DUPLICAR) ===================== */
function exportJSON(){
  const data=JSON.stringify(state,null,2);
  const blob=new Blob([data],{type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download=((state.config.title||'roadmap').replace(/[^\w\-]+/g,'_')||'roadmap')+'.json';
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1500);
}
function importJSON(file){
  if(!canEdit||!editMode){ openUnlockModal(); return; }
  const reader=new FileReader();
  reader.onload=()=>{
    let parsed; try{ parsed=JSON.parse(reader.result); }catch(err){ alert('El archivo no es un JSON válido.'); return; }
    if(!parsed || !Array.isArray(parsed.projects)){ alert('El archivo no parece un roadmap válido.'); return; }
    if(!confirm('Esto reemplazará el contenido de ESTE roadmap con el archivo importado. ¿Continuar?')) return;
    state=migrate(parsed);
    view=state.config.view||view;
    commit();
    if(document.getElementById('settings').classList.contains('open')) renderSettings();
  };
  reader.readAsText(file);
}
async function duplicateRoadmap(){
  const copy=JSON.parse(JSON.stringify(state));
  copy.config.title=(copy.config.title||'Roadmap')+' (copia)';
  const newId=randomId(20);
  try{
    if(STORAGE_MODE==='local'){
      saveLocalRoadmapDoc(newId,copy,cloud.clientId,{name:copy.config.title});
    }else{
      const {db,fs}=await getFB();
      await fs.setDoc(fs.doc(db,ROADMAPS_COL,newId),{json:JSON.stringify(copy),name:copy.config.title,clientId:cloud.clientId,updatedAt:Date.now()});
    }
    location.href='roadmap.html?id='+encodeURIComponent(newId);
  }catch(e){
    alert('No se pudo duplicar: '+(e.message||e));
  }
}

/* ===================== MODO EDICIÓN / PRESENTACIÓN ===================== */
function setEdit(on){
  if(on&&!canEdit){ openUnlockModal(); return; }
  editMode=on;
  document.body.classList.toggle('edit-mode',on);
  const b=document.getElementById('editBtn');
  b.classList.toggle('active',on);
  b.textContent=on?'✏️ En modo edición':(canEdit?'👁️ En modo vista':'🔒 Desbloquear edición');
  document.getElementById('brTitle').contentEditable=on;
  document.getElementById('brSub').contentEditable=on;
  if(!on){
    if(scale) closeBarPanel(); else selected=null;
    closeSettings();
  }
  renderAll();
}
function enterPresent(){
  presentPrevEdit=editMode;
  if(editMode) setEdit(false);
  const now=new Date();
  document.getElementById('presentDate').textContent=MONTHS_ES_FULL[now.getMonth()].toUpperCase()+' '+now.getFullYear();
  document.body.classList.add('present-mode');
  document.getElementById('present').classList.add('on');
  const el=document.documentElement;
  if(el.requestFullscreen) el.requestFullscreen().catch(()=>{});
}
function exitPresent(){
  if(!document.body.classList.contains('present-mode')) return;
  document.body.classList.remove('present-mode');
  document.getElementById('present').classList.remove('on');
  if(document.fullscreenElement&&document.exitFullscreen) document.exitFullscreen().catch(()=>{});
  if(presentPrevEdit) setEdit(true);
}

/* ===================== SET VIEW / ZOOM ===================== */
function setView(v){ view=v; zoom=1; try{localStorage.setItem(LS_VIEW,v);}catch(e){} renderAll(); }
function setZoom(dir){ zoom=Math.max(0.4,Math.min(3,zoom*(dir==='in'?1.25:0.8))); renderAll(); }
function scrollToToday(){
  const now=new Date(); if(now<scale.rs||now>scale.re) return;
  const body=document.getElementById('tlBody');
  body.scrollLeft=Math.max(0,scale.xRaw(now)-body.clientWidth/2);
  syncTransforms();
}

/* ===================== EVENTOS GLOBALES ===================== */
function bindGlobal(){
  document.getElementById('viewSwitcher').addEventListener('click',e=>{const b=e.target.closest('button');if(b)setView(b.dataset.view);});
  document.getElementById('zoomIn').addEventListener('click',()=>setZoom('in'));
  document.getElementById('zoomOut').addEventListener('click',()=>setZoom('out'));
  document.getElementById('todayBtn').addEventListener('click',scrollToToday);
  document.getElementById('editBtn').addEventListener('click',()=>{ if(!canEdit)openUnlockModal();else setEdit(!editMode); });
  document.getElementById('shareBtn').addEventListener('click',shareRoadmap);
  document.getElementById('presentBtn').addEventListener('click',enterPresent);
  document.getElementById('presentExit').addEventListener('click',exitPresent);
  document.addEventListener('fullscreenchange',()=>{ if(!document.fullscreenElement) exitPresent(); });
  document.getElementById('settingsBtn').addEventListener('click',openSettings);
  document.getElementById('settingsClose').addEventListener('click',closeSettings);
  document.getElementById('overlay').addEventListener('click',closeSettings);
  document.getElementById('unlockCancel').addEventListener('click',closeUnlockModal);
  document.getElementById('unlockSubmit').addEventListener('click',submitUnlock);
  document.getElementById('unlockModal').addEventListener('click',e=>{if(e.target.id==='unlockModal')closeUnlockModal();});
  document.getElementById('unlockPass').addEventListener('keydown',e=>{if(e.key==='Enter')submitUnlock();if(e.key==='Escape')closeUnlockModal();});
  document.getElementById('addProjectBtn').addEventListener('click',addProject);
  document.getElementById('filterCountry').addEventListener('change',e=>{filterCountry=e.target.value;renderRows();});
  document.getElementById('filterBU').addEventListener('change',e=>{filterBU=e.target.value;renderRows();});

  const filePop=document.getElementById('fileMenuPop');
  document.getElementById('fileBtn').addEventListener('click',e=>{e.stopPropagation();filePop.classList.toggle('open');});
  document.addEventListener('click',()=>filePop.classList.remove('open'));
  filePop.addEventListener('click',e=>{
    const b=e.target.closest('button'); if(!b) return;
    filePop.classList.remove('open');
    const a=b.dataset.act;
    if(a==='png') exportImage('png');
    else if(a==='pdf') exportImage('pdf');
    else if(a==='json') exportJSON();
    else if(a==='import'){ if(!canEdit||!editMode){ openUnlockModal(); return; } document.getElementById('fileImport').click(); }
    else if(a==='dup') duplicateRoadmap();
  });
  document.getElementById('fileImport').addEventListener('change',e=>{const f=e.target.files[0];if(f)importJSON(f);e.target.value='';});

  document.getElementById('brTitle').addEventListener('blur',e=>{state.config.title=e.target.textContent.trim()||'Roadmap';commit();});
  document.getElementById('brSub').addEventListener('blur',e=>{state.config.subtitle=e.target.textContent.trim();commit();});

  document.getElementById('barPanelClose').addEventListener('click',closeBarPanel);
  document.getElementById('pfDone').addEventListener('click',closeBarPanel);
  document.getElementById('pfDelete').addEventListener('click',()=>{
    if(!selected)return;
    state.projects[selected.pi].initiatives[selected.ii].phases.splice(selected.phi,1);
    selected=null; document.getElementById('barPanel').classList.remove('open'); commit();
  });
  document.getElementById('pfName').addEventListener('input',e=>{const p=currentPhase();if(p){p.name=e.target.value;renderRows();saveLocal();cloudSave();}});
  document.getElementById('pfType').addEventListener('change',e=>{const p=currentPhase();if(p){p.typeId=e.target.value;commit();openBarPanel();}});
  document.getElementById('pfStart').addEventListener('change',e=>{const p=currentPhase();if(p){p.start=e.target.value;if(parseD(p.end)<parseD(p.start))p.end=p.start;commit();}});
  document.getElementById('pfEnd').addEventListener('change',e=>{const p=currentPhase();if(p){p.end=e.target.value;if(parseD(p.end)<parseD(p.start))p.start=p.end;commit();}});

  document.getElementById('settingsTabs').addEventListener('click',e=>{
    const b=e.target.closest('button'); if(!b)return;
    document.querySelectorAll('#settingsTabs button').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    document.querySelectorAll('.tabpane').forEach(p=>p.classList.remove('active'));
    document.getElementById('tab-'+b.dataset.tab).classList.add('active');
  });
  document.getElementById('addPhase').addEventListener('click',()=>{state.phaseTypes.push({id:uid(),name:'Nueva fase',color:'#888888'});commit();renderSettings();});
  document.getElementById('addCountry').addEventListener('click',()=>{state.countries.push({code:'XX',name:'País',flag:'🏳️',icon:''});commit();renderSettings();});
  document.getElementById('addBU').addEventListener('click',()=>{state.businessUnits.push({code:'NN',name:'Unidad',color:'#555555',icon:''});commit();renderSettings();});
  document.getElementById('addState').addEventListener('click',()=>{state.initiativeStates.push({id:uid(),name:'Nuevo estado',color:'#888888'});commit();renderSettings();});

  const g=(id,fn)=>document.getElementById(id).addEventListener('change',fn);
  g('genTitle',e=>{state.config.title=e.target.value;commit();});
  g('genSub',e=>{state.config.subtitle=e.target.value;commit();});
  g('genStart',e=>{state.config.rangeStart=e.target.value;commit();});
  g('genEnd',e=>{state.config.rangeEnd=e.target.value;commit();});
  g('genView',e=>{state.config.view=e.target.value;view=e.target.value;try{localStorage.setItem(LS_VIEW,view);}catch(e2){}commit();});
  g('genTheme',e=>{state.config.theme=e.target.value;commit();});
  g('genAccent',e=>{state.config.accent=e.target.value;commit();});
  g('genLogo',e=>{state.config.logo=e.target.value;commit();});
  document.getElementById('genReset').addEventListener('click',()=>{
    if(confirm('Esto borra TODO el contenido de ESTE roadmap y restaura el ejemplo. ¿Continuar?')){ state=defaultState(); view=state.config.view; commit(); renderSettings(); }
  });
  document.getElementById('settingsPassSave').addEventListener('click',saveAccessPassword);
  ['settingsPass','settingsPass2'].forEach(id=>document.getElementById(id).addEventListener('keydown',e=>{if(e.key==='Enter')saveAccessPassword();}));

  const body=document.getElementById('tlBody');
  body.addEventListener('scroll',()=>{ syncTransforms(); });

  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'){ exitPresent(); closeUnlockModal(); closeSettings(); if(document.getElementById('barPanel').classList.contains('open'))closeBarPanel(); }
  });
  window.addEventListener('resize',()=>{ renderTodayLine(); syncTransforms(); });
}

/* ===================== INIT ===================== */
function init(){
  if(!ROADMAP_ID){ location.replace('index.html'); return; }
  purgeLocalRoadmapStorage();
  initAccessState();
  view=localStorage.getItem(LS_VIEW)||state.config.view||'month';
  document.getElementById('present').classList.remove('on');
  bindGlobal();
  setEdit(canEdit&&!FORCE_VIEW);
  renderAll();
  scrollToToday();
  initCloud();
}
document.addEventListener('DOMContentLoaded',init);
