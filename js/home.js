/* ============================================================
   HOME  (listado de roadmaps)
   Depende de core.js
   ============================================================ */

let HFB = null; // {db, fs}
let homeUnsubscribe = null;
let homeLoadTimer = null;
let lastItems = [];
let accessRequest = null; // {id, action:'edit'|'delete'}

async function startHome(){
  clearTimeout(homeLoadTimer);
  if(homeUnsubscribe){
    homeUnsubscribe();
    homeUnsubscribe = null;
  }

  // Almacenamiento solo en Firebase: limpia cualquier copia local antigua del navegador.
  purgeLocalRoadmapStorage();

  setHomeStatus('Conectando con la nube…', 'loading', false);
  homeLoadTimer = setTimeout(()=>{
    setHomeStatus('La nube está tardando en responder. Puedes reintentar; el listado puede estar incompleto.', 'warning', true);
  }, 8000);

  try{
    const { db, fs } = await getFB();
    HFB = { db, fs };
    homeUnsubscribe = fs.onSnapshot(fs.collection(db, ROADMAPS_COL), snap=>{
      clearTimeout(homeLoadTimer);
      const items=[];
      snap.forEach(d=> items.push({ id:d.id, data:d.data() }));
      items.sort((a,b)=> (b.data.updatedAt||0) - (a.data.updatedAt||0));
      lastItems = items;
      renderCards(items);
      setHomeStatus('', '', false);
    }, err=>{
      clearTimeout(homeLoadTimer);
      console.warn(err);
      setHomeStatus(friendlyCloudError(err), 'error', true);
    });
  }catch(e){
    clearTimeout(homeLoadTimer);
    console.warn(e);
    setHomeStatus(friendlyCloudError(e), 'error', true);
  }
}

function cachedRoadmaps(){
  return listLocalRoadmapDocs().map(it=>({...it,localPrimary:false}));
}

function mergeWithCached(remote, cached){
  const ids=new Set(remote.map(it=>it.id));
  return remote.concat(cached.filter(it=>!ids.has(it.id)));
}

function friendlyCloudError(err){
  const detail = String((err && (err.message || err.code)) || err || '').toLowerCase();
  if(detail.includes('suspend')){
    return 'El proyecto de Firebase está suspendido. Hay que reactivarlo o conectar otro proyecto para recuperar el listado.';
  }
  if(detail.includes('permission') || detail.includes('denied')){
    return 'Firestore rechazó el acceso al listado. Revisa el estado del proyecto y sus reglas de seguridad.';
  }
  return 'No se pudo conectar con Firestore. El listado puede estar incompleto; revisa la conexión y el estado del proyecto.';
}

function setHomeStatus(message, kind, canRetry){
  const box = document.getElementById('homeStatus');
  const text = document.getElementById('homeStatusText');
  const retry = document.getElementById('homeRetry');
  text.textContent = message;
  box.className = 'home-status' + (kind ? ' ' + kind : '');
  box.hidden = !message;
  retry.hidden = !canRetry;
}

function subtitleOf(data){
  try{ return (JSON.parse(data.json).config.subtitle) || ''; }catch(e){ return ''; }
}
function accentOf(data){
  try{ return (JSON.parse(data.json).config.accent) || '#2F6FED'; }catch(e){ return '#2F6FED'; }
}

function renderCards(items){
  const el = document.getElementById('cards');
  lastItems = items;
  const allUnlocked=masterUnlocked();
  let h = `<div class="card new-card" id="newCard">
    <div class="plus">+</div>
    <div class="nc-t">Nuevo roadmap</div>
    <div class="c-sub" style="padding:0">Crea uno desde cero</div>
  </div>`;
  items.forEach(it=>{
    const name = roadmapName(it.data);
    const sub = subtitleOf(it.data);
    const accent = accentOf(it.data);
    const when = fmtWhen(it.data.updatedAt);
    const meta = it.localOnly
      ? `<span class="c-local">${it.localPrimary?'Guardado localmente':'Copia local de este navegador'}</span>`
      : (when?('Actualizado '+escapeHtml(when)):'Sin cambios aún');
    const canDelete = !it.localOnly || it.localPrimary;
    const hasKey=!!it.data.passwordHash;
    const access=allUnlocked
      ? '<span class="c-lock unlocked">🔓 Acceso total</span>'
      : (hasKey?'<span class="c-lock">🔒 Con clave</span>':'<span class="c-lock legacy">⚠ Sin clave propia</span>');
    h += `<div class="card" data-card-id="${escapeAttr(it.id)}">
      <div class="c-accent" style="background:${escapeAttr(accent)}"></div>
      <h3>${escapeHtml(name)}</h3>
      <div class="c-sub">${escapeHtml(sub)}</div>
      <div class="c-meta">${meta}${access}</div>
      <div class="c-actions">
        <button class="btn btn-ok" data-edit="${escapeAttr(it.id)}">${allUnlocked?'Editar':'Entrar con clave'}</button>
        ${canDelete?`<button class="btn btn-del" data-del="${escapeAttr(it.id)}" data-name="${escapeAttr(name)}">Eliminar</button>`:''}
      </div>
    </div>`;
  });
  el.innerHTML = h;
  document.getElementById('newCard').addEventListener('click', openNewModal);
  el.querySelectorAll('[data-edit]').forEach(b=> b.addEventListener('click', ()=> requestAccess(b.dataset.edit,'edit')));
  el.querySelectorAll('[data-del]').forEach(b=> b.addEventListener('click', ()=> requestAccess(b.dataset.del,'delete')));
}

function openRoadmapEdit(id){
  location.href = 'roadmap.html?id=' + encodeURIComponent(id);
}

function roadmapItem(id){ return lastItems.find(it=>it.id===id); }

function requestAccess(id,action){
  if(roadmapEditUnlocked(id)){
    if(action==='edit') openRoadmapEdit(id);
    else delRoadmap(id,(roadmapItem(id)&&roadmapName(roadmapItem(id).data))||'Roadmap');
    return;
  }
  const it=roadmapItem(id);
  if(!it) return;
  accessRequest={id,action};
  document.getElementById('accessTitle').textContent=action==='delete'?'Autorizar eliminación':'Desbloquear edición';
  document.getElementById('accessText').textContent=it.data.passwordHash
    ? 'Ingresa la clave de este roadmap o la clave madre.'
    : 'Este roadmap es anterior al sistema de claves. Usa la clave madre y luego asígnale una clave desde Configuración.';
  document.getElementById('accessPass').value='';
  document.getElementById('accessErr').textContent='';
  document.getElementById('accessSubmit').textContent=action==='delete'?'Continuar':'Desbloquear';
  document.getElementById('accessModal').classList.add('open');
  setTimeout(()=>document.getElementById('accessPass').focus(),50);
}

function closeAccessModal(){
  document.getElementById('accessModal').classList.remove('open');
  accessRequest=null;
}

async function submitAccess(){
  if(!accessRequest) return;
  const pass=document.getElementById('accessPass').value;
  const err=document.getElementById('accessErr');
  const it=roadmapItem(accessRequest.id);
  if(!it){ closeAccessModal(); return; }
  if(!pass){ err.textContent='Ingresa una clave.'; return; }
  const isMaster=pass===MASTER_PASS;
  const valid=isMaster || await passwordMatches(pass,it.data.passwordHash||'');
  if(!valid){
    err.textContent=it.data.passwordHash?'Clave incorrecta.':'Este roadmap aún no tiene clave propia; usa la clave madre.';
    return;
  }
  const request={...accessRequest};
  if(isMaster) grantMasterAccess(); else grantRoadmapEdit(request.id);
  closeAccessModal();
  renderMasterAccess();
  renderCards(lastItems);
  if(request.action==='edit') openRoadmapEdit(request.id);
  else delRoadmap(request.id,roadmapName(it.data));
}

async function delRoadmap(id, name){
  if(!confirm('¿Eliminar el roadmap «'+name+'»? Esta acción no se puede deshacer.')) return;
  try{
    const { db, fs } = HFB || await getFB();
    await fs.deleteDoc(fs.doc(db, ROADMAPS_COL, id));
    showToast('«'+name+'» eliminado con éxito.', true);
  }catch(e){
    showToast('Operación fallida: no se pudo eliminar «'+name+'». '+(e.message||e), false);
  }
}

/* Muestra un aviso flotante temporal (éxito/error). */
function showToast(message, ok){
  const wrap=document.getElementById('toastWrap');
  if(!wrap){ alert(message); return; }
  const t=document.createElement('div');
  t.className='toast '+(ok?'ok':'err');
  t.textContent=message;
  wrap.appendChild(t);
  requestAnimationFrame(()=>t.classList.add('show'));
  setTimeout(()=>{ t.classList.remove('show'); setTimeout(()=>t.remove(),300); }, 3400);
}

/* ---- modal nuevo roadmap ---- */
function openNewModal(){
  const m = document.getElementById('newModal');
  m.classList.add('open');
  const inp = document.getElementById('nrName');
  inp.value='';
  document.getElementById('nrPass').value='';
  document.getElementById('nrPass2').value='';
  document.getElementById('nrErr').textContent='';
  const btn=document.getElementById('nrCreate');
  btn.disabled=false;
  btn.textContent='Crear y abrir';
  setTimeout(()=>inp.focus(), 50);
}
function closeNewModal(){ document.getElementById('newModal').classList.remove('open'); }

async function createRoadmap(){
  const name = document.getElementById('nrName').value.trim();
  const pass = document.getElementById('nrPass').value;
  const pass2 = document.getElementById('nrPass2').value;
  const err = document.getElementById('nrErr');
  if(!name){ err.textContent='Ponle un nombre al roadmap.'; return; }
  if(!pass){ err.textContent='Crea una clave de edición.'; return; }
  if(pass!==pass2){ err.textContent='Las claves no coinciden.'; return; }
  const btn = document.getElementById('nrCreate');
  if(btn.disabled) return;
  btn.disabled = true; btn.textContent='Creando…';
  try{
    const id = randomId();
    const passwordHash=await hashPassword(pass);
    const st = defaultState();
    st.config.title = name;
    st.projects = []; // Roadmap nuevo empieza vacío (sin proyectos de ejemplo).
    const { db, fs } = HFB || await getFB();
    await fs.setDoc(fs.doc(db, ROADMAPS_COL, id), {
      name,
      json: JSON.stringify(st),
      clientId: 'home',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      passwordHash
    });
    grantRoadmapEdit(id);
    location.href = 'roadmap.html?id=' + id;
  }catch(e){
    err.textContent = STORAGE_MODE==='local'
      ? 'No se pudo guardar en este navegador: '+(e.message||e)
      : friendlyCloudError(e);
    btn.disabled = false; btn.textContent='Crear y abrir';
  }
}

function renderMasterAccess(){
  const unlocked=masterUnlocked();
  const box=document.getElementById('masterBox');
  const input=document.getElementById('masterPass');
  const msg=document.getElementById('masterMsg');
  const button=document.getElementById('masterUnlock');
  box.classList.toggle('unlocked',unlocked);
  input.hidden=unlocked;
  msg.textContent=unlocked?'Acceso total activado':'';
  button.textContent=unlocked?'Bloquear':'Desbloquear todo';
  if(!unlocked) input.value='';
}

function toggleMasterAccess(){
  const input=document.getElementById('masterPass');
  const msg=document.getElementById('masterMsg');
  if(masterUnlocked()){
    revokeMasterAccess();
    renderMasterAccess();
    renderCards(lastItems);
    return;
  }
  if(input.value!==MASTER_PASS){
    msg.textContent='Clave incorrecta';
    input.select();
    return;
  }
  grantMasterAccess();
  renderMasterAccess();
  renderCards(lastItems);
}

function bindHome(){
  document.getElementById('nrCancel').addEventListener('click', closeNewModal);
  document.getElementById('nrCreate').addEventListener('click', createRoadmap);
  document.getElementById('newModal').addEventListener('click', e=>{ if(e.target.id==='newModal') closeNewModal(); });
  ['nrName','nrPass','nrPass2'].forEach(id=>document.getElementById(id).addEventListener('keydown',e=>{if(e.key==='Enter')createRoadmap();if(e.key==='Escape')closeNewModal();}));
  document.getElementById('accessCancel').addEventListener('click',closeAccessModal);
  document.getElementById('accessSubmit').addEventListener('click',submitAccess);
  document.getElementById('accessModal').addEventListener('click',e=>{if(e.target.id==='accessModal')closeAccessModal();});
  document.getElementById('accessPass').addEventListener('keydown',e=>{if(e.key==='Enter')submitAccess();if(e.key==='Escape')closeAccessModal();});
  document.getElementById('masterUnlock').addEventListener('click',toggleMasterAccess);
  document.getElementById('masterPass').addEventListener('keydown',e=>{if(e.key==='Enter')toggleMasterAccess();});
  document.getElementById('homeRetry').addEventListener('click', startHome);
  document.getElementById('newCard').addEventListener('click', openNewModal);
}

document.addEventListener('DOMContentLoaded', ()=>{ bindHome(); renderMasterAccess(); startHome(); });
