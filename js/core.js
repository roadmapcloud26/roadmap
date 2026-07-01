/* ============================================================
   CORE COMPARTIDO  (home + roadmap)
   - Config de Firebase (pública por diseño en apps web)
   - Utilidades de fecha / texto / ids
   - Estado por defecto + migración
   - Inicialización perezosa de Firebase
   ============================================================ */

/* ---- Firebase ---- */
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyC_wP-RKvN_bD-gYliXYIfU0BYdPF2dHVE",
  authDomain: "roadmap-97bfb.firebaseapp.com",
  projectId: "roadmap-97bfb",
  storageBucket: "roadmap-97bfb.firebasestorage.app",
  messagingSenderId: "263627962035",
  appId: "1:263627962035:web:2d3544981382015793a2c6",
  measurementId: "G-7KH6W78TP6"
};
const ROADMAPS_COL = 'roadmaps';
/*
 * Backend activo:
 * - 'local'    mientras la cuenta de Firebase está suspendida.
 * - 'firebase' cuando se recupere la cuenta.
 *
 * Los documentos locales conservan el mismo id y JSON que Firestore para
 * poder migrarlos después sin transformar su contenido.
 */
const STORAGE_MODE = 'firebase';
const LOCAL_DOC_PREFIX = 'roadmap-doc-';
const LOCAL_META_KEY = 'roadmap-local-meta-v1';
const LOCAL_CHANGE_EVENT = 'roadmap:local-change';
/* Clave madre: desbloquea ver/editar cualquier roadmap (privacidad casual). */
const MASTER_PASS = 'jefa26';
const MASTER_SESSION_KEY = 'roadmap-master-unlocked-v1';
const EDIT_SESSION_PREFIX = 'roadmap-edit-unlocked-';

let _fb = null;
async function getFB(){
  if(_fb) return _fb;
  const appMod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
  const fsMod  = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
  const app = appMod.initializeApp(FIREBASE_CONFIG);
  // autoDetectLongPolling: funciona también detrás de proxies/redes corporativas
  let db;
  try{
    db = fsMod.initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
  }catch(e){
    db = fsMod.getFirestore(app);
  }
  _fb = { app, db, fs: fsMod };
  return _fb;
}

/* ---- Backend local temporal ---- */
function localDocKey(id){ return LOCAL_DOC_PREFIX + id; }

function readLocalMeta(){
  try{ return JSON.parse(localStorage.getItem(LOCAL_META_KEY)||'{}') || {}; }
  catch(e){ return {}; }
}

function writeLocalMeta(meta){
  localStorage.setItem(LOCAL_META_KEY,JSON.stringify(meta));
}

function listLocalRoadmapDocs(){
  const items=[];
  const seen=new Set();
  const meta=readLocalMeta();
  try{
    for(let i=0;i<localStorage.length;i++){
      const key=localStorage.key(i);
      if(!key || !key.startsWith(LOCAL_DOC_PREFIX)) continue;
      const id=key.slice(LOCAL_DOC_PREFIX.length);
      const json=localStorage.getItem(key);
      const st=JSON.parse(json);
      const m=meta[id]||{};
      items.push({
        id,
        data:{
          name:m.name||(st.config&&st.config.title)||'Roadmap local',
          json,
          createdAt:m.createdAt||0,
          updatedAt:m.updatedAt||0,
          passwordHash:m.passwordHash||'',
          clientId:'local'
        },
        localOnly:true,
        localPrimary:STORAGE_MODE==='local'
      });
      seen.add(id);
    }

    // Respaldo creado por la versión monolítica anterior.
    const legacy=localStorage.getItem('roadmap-cloud-v1');
    if(legacy && !seen.has('main')){
      const st=JSON.parse(legacy);
      const m=meta.main||{};
      items.push({
        id:'main',
        data:{
          name:m.name||(st.config&&st.config.title)||'Roadmap anterior',
          json:legacy,
          createdAt:m.createdAt||0,
          updatedAt:m.updatedAt||0,
          passwordHash:m.passwordHash||'',
          clientId:'local'
        },
        localOnly:true,
        localPrimary:STORAGE_MODE==='local'
      });
    }
  }catch(e){ console.warn('No se pudieron leer los roadmaps locales',e); }
  items.sort((a,b)=>(b.data.updatedAt||0)-(a.data.updatedAt||0));
  return items;
}

function saveLocalRoadmapDoc(id,state,clientId,extraMeta){
  const now=Date.now();
  const json=JSON.stringify(state);
  localStorage.setItem(localDocKey(id),json);
  const meta=readLocalMeta();
  const prev=meta[id]||{};
  meta[id]={
    ...prev,
    ...(extraMeta||{}),
    name:(state.config&&state.config.title)||'Roadmap',
    createdAt:prev.createdAt||now,
    updatedAt:now
  };
  writeLocalMeta(meta);
  window.dispatchEvent(new CustomEvent(LOCAL_CHANGE_EVENT,{detail:{id,clientId:clientId||'',action:'save'}}));
}

function getLocalRoadmapMeta(id){
  return readLocalMeta()[id]||{};
}

function setLocalRoadmapPasswordHash(id,passwordHash,clientId){
  const meta=readLocalMeta();
  const prev=meta[id]||{};
  meta[id]={...prev,passwordHash,updatedAt:Date.now()};
  writeLocalMeta(meta);
  window.dispatchEvent(new CustomEvent(LOCAL_CHANGE_EVENT,{detail:{id,clientId:clientId||'',action:'access'}}));
}

function deleteLocalRoadmapDoc(id,clientId){
  localStorage.removeItem(localDocKey(id));
  if(id==='main') localStorage.removeItem('roadmap-cloud-v1');
  const meta=readLocalMeta();
  delete meta[id];
  writeLocalMeta(meta);
  window.dispatchEvent(new CustomEvent(LOCAL_CHANGE_EVENT,{detail:{id,clientId:clientId||'',action:'delete'}}));
}

function subscribeLocalRoadmaps(callback){
  const refresh=()=>callback(listLocalRoadmapDocs());
  const onCustom=()=>refresh();
  const onStorage=e=>{
    if(e.key===LOCAL_META_KEY || (e.key&&e.key.startsWith(LOCAL_DOC_PREFIX)) || e.key==='roadmap-cloud-v1') refresh();
  };
  window.addEventListener(LOCAL_CHANGE_EVENT,onCustom);
  window.addEventListener('storage',onStorage);
  refresh();
  return ()=>{
    window.removeEventListener(LOCAL_CHANGE_EVENT,onCustom);
    window.removeEventListener('storage',onStorage);
  };
}

function subscribeLocalRoadmapDoc(id,clientId,callback){
  const read=()=>{
    const raw=localStorage.getItem(localDocKey(id)) || (id==='main'?localStorage.getItem('roadmap-cloud-v1'):null);
    if(raw) callback(raw);
  };
  const onCustom=e=>{
    const d=e.detail||{};
    if(d.id===id && d.clientId!==clientId && d.action==='save') read();
  };
  const onStorage=e=>{ if(e.key===localDocKey(id) || (id==='main'&&e.key==='roadmap-cloud-v1')) read(); };
  window.addEventListener(LOCAL_CHANGE_EVENT,onCustom);
  window.addEventListener('storage',onStorage);
  return ()=>{
    window.removeEventListener(LOCAL_CHANGE_EVENT,onCustom);
    window.removeEventListener('storage',onStorage);
  };
}

/* Elimina cualquier copia local de roadmaps guardada en el navegador.
   El almacenamiento es solo Firebase; esto limpia restos del modo local
   (documentos, metadatos y el respaldo del monolito), conservando la
   preferencia de vista. */
function purgeLocalRoadmapStorage(){
  try{
    const del=[];
    for(let i=0;i<localStorage.length;i++){
      const k=localStorage.key(i);
      if(k && (k.startsWith(LOCAL_DOC_PREFIX) || k===LOCAL_META_KEY || k==='roadmap-cloud-v1')) del.push(k);
    }
    del.forEach(k=>localStorage.removeItem(k));
  }catch(e){}
}

/* ---- Acceso casual (sin autenticación de servidor) ---- */
async function hashPassword(password){
  const bytes=new TextEncoder().encode(String(password));
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}

async function passwordMatches(password,passwordHash){
  if(!passwordHash) return false;
  return (await hashPassword(password))===passwordHash;
}

function roadmapEditSessionKey(id){ return EDIT_SESSION_PREFIX+id; }
function masterUnlocked(){ try{ return sessionStorage.getItem(MASTER_SESSION_KEY)==='1'; }catch(e){ return false; } }
function roadmapEditUnlocked(id){ try{ return masterUnlocked()||sessionStorage.getItem(roadmapEditSessionKey(id))==='1'; }catch(e){ return false; } }
function grantMasterAccess(){ try{ sessionStorage.setItem(MASTER_SESSION_KEY,'1'); }catch(e){} }
function revokeMasterAccess(){ try{ sessionStorage.removeItem(MASTER_SESSION_KEY); }catch(e){} }
function grantRoadmapEdit(id){ try{ sessionStorage.setItem(roadmapEditSessionKey(id),'1'); }catch(e){} }
function revokeRoadmapEdit(id){ try{ sessionStorage.removeItem(roadmapEditSessionKey(id)); }catch(e){} }

/* ---- IDs ---- */
// id corto para items internos (fases, iniciativas, etc.)
function uid(){ return Math.random().toString(36).slice(2,9); }
// id largo e imposible de adivinar para documentos de roadmap (links seguros)
function randomId(len){
  len = len || 20;
  const a = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  if(window.crypto && crypto.getRandomValues){
    const arr = new Uint8Array(len); crypto.getRandomValues(arr);
    for(let i=0;i<len;i++) s += a[arr[i]%a.length];
  } else {
    for(let i=0;i<len;i++) s += a[Math.floor(Math.random()*a.length)];
  }
  return s;
}

/* ---- Texto ---- */
function escapeHtml(s){ return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function escapeAttr(s){ return escapeHtml(s).replace(/'/g,'&#39;'); }

/* ---- Fechas ---- */
const MONTHS_ES = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
const MONTHS_ES_FULL = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const DAY_MS = 86400000;
function parseD(s){ const [y,m,d]=String(s).split('-').map(Number); return new Date(y,(m||1)-1,d||1); }
function isoD(dt){ return dt.getFullYear()+'-'+String(dt.getMonth()+1).padStart(2,'0')+'-'+String(dt.getDate()).padStart(2,'0'); }
function addDays(dt,n){ return new Date(dt.getFullYear(),dt.getMonth(),dt.getDate()+n); }
function addMonths(dt,n){ return new Date(dt.getFullYear(),dt.getMonth()+n,1); }
function startDay(dt){ return new Date(dt.getFullYear(),dt.getMonth(),dt.getDate()); }
function daysBetween(a,b){ return Math.round((startDay(b)-startDay(a))/DAY_MS); }
function mondayOf(dt){ const d=startDay(dt); const wd=(d.getDay()+6)%7; return addDays(d,-wd); }
function clampDate(dt,lo,hi){ return dt<lo?new Date(lo):(dt>hi?new Date(hi):dt); }
function fmtNice(dt){ return dt.getDate()+' '+MONTHS_ES[dt.getMonth()]+' '+dt.getFullYear(); }
function fmtWhen(ms){
  if(!ms) return '';
  const d=new Date(ms);
  return d.getDate()+' '+MONTHS_ES[d.getMonth()]+' '+d.getFullYear()+' · '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
}
function textColor(hex){
  if(!hex) return '#fff';
  const c=hex.replace('#',''); if(c.length<6) return '#fff';
  const r=parseInt(c.slice(0,2),16),g=parseInt(c.slice(2,4),16),b=parseInt(c.slice(4,6),16);
  return (r*299+g*587+b*114)/1000 >= 150 ? '#1A2433' : '#fff';
}

/* ---- Iconos de unidades de negocio (BU) ---- */
// Respaldo por código para roadmaps antiguos que no tienen el campo icon.
const BU_ICONS={
  SO:'iconos/BU_SODIMAC.png', SODIMAC:'iconos/BU_SODIMAC.png',
  TO:'iconos/BU_TOTTUS.png', TOTTUS:'iconos/BU_TOTTUS.png',
  FA:'iconos/BU_F RETAIL.png', FRET:'iconos/BU_F RETAIL.png',
  FCOM:'iconos/BU_F COM.png',
  CORP:'iconos/BU_F CORP.png', FCORP:'iconos/BU_F CORP.png',
  MPLAZA:'iconos/BU_M PLAZA.png',
  BANCO:'iconos/BU_BANCO.png'
};
// Catálogo de iconos disponibles para el selector de Configuración.
const BU_ICON_CHOICES=[
  {label:'Falabella.com', path:'iconos/BU_F COM.png'},
  {label:'Falabella Retail', path:'iconos/BU_F RETAIL.png'},
  {label:'Falabella Corp', path:'iconos/BU_F CORP.png'},
  {label:'Sodimac', path:'iconos/BU_SODIMAC.png'},
  {label:'Tottus', path:'iconos/BU_TOTTUS.png'},
  {label:'Mall Plaza', path:'iconos/BU_M PLAZA.png'},
  {label:'Banco Falabella', path:'iconos/BU_BANCO.png'}
];
function buIcon(bu){
  if(!bu) return '';
  return bu.icon || BU_ICONS[bu.code] || BU_ICONS[(bu.name||'').toUpperCase()] || '';
}
// Codifica rutas con espacios (ej. "BU_F COM.png") para usarlas en src/href.
function iconURL(path){ return path ? encodeURI(path) : ''; }

/* ---- Iconos de país (banderas circulares) ---- */
const COUNTRY_ICONS={
  CL:'iconos/COUNTRY_CHILE.png',
  PE:'iconos/COUNTRY_PERU.png',
  CO:'iconos/COUNTRY_COLOMBIA.png',
  AR:'iconos/COUNTRY_ARGENTINA.png',
  UY:'iconos/COUNTRY_URUGUAY.png',
  MX:'iconos/COUNTRY_MEXICO.png',
  BR:'iconos/COUNTRY_BRASIL.png'
};
const COUNTRY_ICON_CHOICES=[
  {label:'Chile', path:'iconos/COUNTRY_CHILE.png'},
  {label:'Perú', path:'iconos/COUNTRY_PERU.png'},
  {label:'Colombia', path:'iconos/COUNTRY_COLOMBIA.png'},
  {label:'Argentina', path:'iconos/COUNTRY_ARGENTINA.png'},
  {label:'Uruguay', path:'iconos/COUNTRY_URUGUAY.png'},
  {label:'México', path:'iconos/COUNTRY_MEXICO.png'},
  {label:'Brasil', path:'iconos/COUNTRY_BRASIL.png'}
];
function countryIcon(c){
  if(!c) return '';
  return c.icon || COUNTRY_ICONS[c.code] || '';
}

/* ---- Estado por defecto de un roadmap ---- */
function defaultState(){
  return {
    config:{
      title:'Roadmap Interactivo',
      subtitle:'Plan estratégico 2026–2028',
      rangeStart:'2026-01-01',
      rangeEnd:'2028-12-31',
      view:'month',
      theme:'light',
      accent:'#3D4249',
      logo:''
    },
    phaseTypes:[
      {id:'discovery',name:'Discovery',color:'#2F6FED'},
      {id:'dev',name:'DEV',color:'#F4C20D'},
      {id:'qa',name:'QA',color:'#34A853'},
      {id:'e2e',name:'Testing (E2E)',color:'#17B0BE'},
      {id:'ff',name:'F&F',color:'#8E5BEF'},
      {id:'piloto',name:'PILOTO',color:'#FF8A24'},
      {id:'roll',name:'ROLL',color:'#1F4E8C'},
      {id:'live',name:'LIVE',color:'#0F9D58'},
      {id:'atrasado',name:'ATRASADO',color:'#C9D2DD'}
    ],
    countries:[
      {code:'CL',name:'Chile',flag:'🇨🇱',icon:'iconos/COUNTRY_CHILE.png'},
      {code:'PE',name:'Perú',flag:'🇵🇪',icon:'iconos/COUNTRY_PERU.png'},
      {code:'CO',name:'Colombia',flag:'🇨🇴',icon:'iconos/COUNTRY_COLOMBIA.png'},
      {code:'AR',name:'Argentina',flag:'🇦🇷',icon:'iconos/COUNTRY_ARGENTINA.png'},
      {code:'UY',name:'Uruguay',flag:'🇺🇾',icon:'iconos/COUNTRY_URUGUAY.png'},
      {code:'MX',name:'México',flag:'🇲🇽',icon:'iconos/COUNTRY_MEXICO.png'},
      {code:'BR',name:'Brasil',flag:'🇧🇷',icon:'iconos/COUNTRY_BRASIL.png'}
    ],
    businessUnits:[
      {code:'FCOM',name:'Falabella.com',color:'#8CC63F',icon:'iconos/BU_F COM.png'},
      {code:'FRET',name:'Falabella Retail',color:'#C4D22E',icon:'iconos/BU_F RETAIL.png'},
      {code:'CORP',name:'Falabella Corp',color:'#3D4249',icon:'iconos/BU_F CORP.png'},
      {code:'SO',name:'Sodimac',color:'#1B75BB',icon:'iconos/BU_SODIMAC.png'},
      {code:'TO',name:'Tottus',color:'#54A93B',icon:'iconos/BU_TOTTUS.png'},
      {code:'MPLAZA',name:'Mall Plaza',color:'#D6356A',icon:'iconos/BU_M PLAZA.png'},
      {code:'BANCO',name:'Banco Falabella',color:'#3A9B3C',icon:'iconos/BU_BANCO.png'}
    ],
    initiativeStates:[
      {id:'plan',name:'Planificado',color:'#94A3B8'},
      {id:'dev',name:'En desarrollo',color:'#2F6FED'},
      {id:'curso',name:'En curso',color:'#F4A40D'},
      {id:'riesgo',name:'En riesgo',color:'#E0322B'},
      {id:'listo',name:'Listo',color:'#0F9D58'}
    ],
    projects:[
      {id:uid(),name:'KIOSKOS',collapsed:false,initiatives:[
        {id:uid(),name:'Falabella Perú',owner:'Viole',stateId:'dev',phases:[
          {id:uid(),name:'Discovery',typeId:'discovery',countries:['CL','PE'],bus:['FRET'],start:'2026-02-01',end:'2026-03-15'},
          {id:uid(),name:'DEV',typeId:'dev',countries:['PE'],bus:['FRET'],start:'2026-03-16',end:'2026-06-30'},
          {id:uid(),name:'QA',typeId:'qa',countries:['PE'],bus:['FRET'],start:'2026-07-01',end:'2026-08-15'},
          {id:uid(),name:'Piloto',typeId:'piloto',countries:['PE'],bus:['FRET'],start:'2026-08-16',end:'2026-09-30'}
        ]},
        {id:uid(),name:'Sodimac Chile',owner:'Juan',stateId:'curso',phases:[
          {id:uid(),name:'Discovery',typeId:'discovery',countries:['CL'],bus:['SO'],start:'2026-01-15',end:'2026-02-28'},
          {id:uid(),name:'DEV',typeId:'dev',countries:['CL'],bus:['SO'],start:'2026-03-01',end:'2026-07-31'},
          {id:uid(),name:'E2E',typeId:'e2e',countries:['CL'],bus:['SO'],start:'2026-08-01',end:'2026-09-15'},
          {id:uid(),name:'Live',typeId:'live',countries:['CL'],bus:['SO'],start:'2026-10-01',end:'2026-10-31'}
        ]}
      ]},
      {id:uid(),name:'Motor de Cotizaciones',collapsed:false,initiatives:[
        {id:uid(),name:'Rollout regional',owner:'Caro',stateId:'dev',phases:[
          {id:uid(),name:'Discovery',typeId:'discovery',countries:[],bus:['CORP'],start:'2026-04-01',end:'2026-06-30'},
          {id:uid(),name:'DEV',typeId:'dev',countries:['CL','PE','MX'],bus:['CORP','FRET'],start:'2026-07-01',end:'2026-12-31'},
          {id:uid(),name:'F&F',typeId:'ff',countries:[],bus:['CORP'],start:'2027-01-01',end:'2027-02-15'},
          {id:uid(),name:'Roll',typeId:'roll',countries:['CL','PE'],bus:['CORP'],start:'2027-02-16',end:'2027-05-31'}
        ]}
      ]},
      {id:uid(),name:'Legados',collapsed:false,initiatives:[
        {id:uid(),name:'Migración Siebel',owner:'Pato',stateId:'riesgo',phases:[
          {id:uid(),name:'Discovery',typeId:'discovery',countries:['CL'],bus:['TO'],start:'2026-02-01',end:'2026-04-30'},
          {id:uid(),name:'DEV (atrasado)',typeId:'atrasado',countries:['CL'],bus:['TO'],start:'2026-05-01',end:'2026-10-31'},
          {id:uid(),name:'QA',typeId:'qa',countries:['CL'],bus:['TO'],start:'2026-11-01',end:'2027-01-31'}
        ]}
      ]}
    ]
  };
}

function migrate(d){
  const base=defaultState();
  d.config={...base.config,...(d.config||{})};
  ['phaseTypes','countries','businessUnits','initiativeStates','projects'].forEach(k=>{ if(!Array.isArray(d[k])) d[k]=base[k]; });
  // Normaliza fases: campo antiguo bu (texto) -> bus (arreglo, multi-BU).
  (d.projects||[]).forEach(p=>(p.initiatives||[]).forEach(i=>(i.phases||[]).forEach(ph=>{
    if(!Array.isArray(ph.bus)) ph.bus = ph.bu ? [ph.bu] : [];
    if('bu' in ph) delete ph.bu;
  })));
  return d;
}

/* nombre legible de un roadmap a partir de su documento Firestore */
function roadmapName(data){
  if(!data) return 'Sin nombre';
  if(data.name) return data.name;
  try{ const s=JSON.parse(data.json); return (s.config && s.config.title) || 'Sin nombre'; }catch(e){ return 'Sin nombre'; }
}
