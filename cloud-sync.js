/* Meu Mundinho: sincronização segura com Cloudflare Pages D1.
   Sem envio automático na primeira conexão; preserva backup local ao importar. */
(() => {
'use strict';
const API='/api/sync';
const KEYS=['cardapio-v1','cardapio-diary-v2','cardapio-checks-v2','meu-cardapio-wellness-v3','mundinho-v26-favorites','mundinho-v26-pantry','meu-mundinho-ceias-v23','meu-mundinho-shopping-custom-v1'];
const META='mm-cloud-sync-metadata-v1';
let version=null, baseline=null, busy=false, enabled=false, paused=false, timer=null;
const el=(id)=>document.getElementById(id);
const readMeta=()=>{try{return JSON.parse(localStorage.getItem(META)||'null')}catch{return null}};
const getSnapshot=()=>{const obj={};for(const k of KEYS){const v=localStorage.getItem(k);if(v!==null)obj[k]=v;}return obj;};
const canonical=obj=>JSON.stringify(KEYS.map(k=>obj[k]??null));
const status=(s,bad=false)=>{const e=el('mmCloudText');if(e){e.textContent=s;e.style.color=bad?'#b23f55':'#775468';}};
const controls=(show)=>{el('mmCloudStart').hidden=!show;el('mmCloudSave').hidden=show;el('mmCloudResolve').hidden=!paused;};
const request=async (method='GET',body)=>{
 const r=await fetch(API,{method,credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
 let data;try{data=await r.json()}catch{throw Error('A API não respondeu em JSON (HTTP '+r.status+').');}
 if(!r.ok){const e=Error(data.error||'Erro HTTP '+r.status);e.conflict=r.status===409;throw e;}return data;
};
const snapshotValid=obj=>obj&&typeof obj==='object'&&!Array.isArray(obj)&&Object.keys(obj).every(k=>KEYS.includes(k)&&typeof obj[k]==='string')&&Object.keys(obj).length>0;
function downloadBackup(snapshot){const b=new Blob([JSON.stringify({created:new Date().toISOString(),source:'antes-de-importar-cloudflare',localStorage:snapshot},null,2)],{type:'application/json'});const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download='meu-mundinho-copia-antes-da-nuvem-'+new Date().toISOString().slice(0,10)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(u),1500);}
function writeSnapshot(snapshot){for(const k of KEYS){if(Object.hasOwn(snapshot,k))localStorage.setItem(k,snapshot[k]);else localStorage.removeItem(k);}}
function remember(snapshot,v){version=v;baseline=canonical(snapshot);localStorage.setItem(META,JSON.stringify({version:v,baseline}));enabled=true;paused=false;controls(false);}
async function firstConnect(){
 if(busy)return;busy=true;el('mmCloudStart').disabled=true;status('Verificando nuvem…');
 try{
  const remote=await request();const local=getSnapshot();
  if(!remote.found){
   if(!confirm('A nuvem está vazia. Enviar uma cópia dos dados deste aparelho para começar a sincronização?')){status('Nuvem não ativada neste aparelho.');return;}
   const saved=await request('PUT',{data:local,baseVersion:null});remember(local,saved.version);status('✓ Cópia inicial salva na nuvem');return;
  }
  if(!snapshotValid(remote.data)){status('A nuvem contém dados em formato inesperado. Nada foi alterado.',true);return;}
  if(canonical(remote.data)===canonical(local)){remember(local,remote.version);status('✓ Aparelho conectado à nuvem');return;}
  const useCloud=confirm('Já há um diário salvo na nuvem e ele é diferente deste aparelho.\n\nOK = baixar o diário da nuvem (fazemos cópia de segurança dos dados deste aparelho).\nCancelar = manter os dados deste aparelho sem sincronizar agora.');
  if(!useCloud){status('Dados locais preservados. Toque em Conectar para decidir depois.');return;}
  downloadBackup(local);
  writeSnapshot(remote.data);remember(remote.data,remote.version);status('✓ Dados da nuvem recebidos. Reabrindo…');location.reload();
 }catch(e){status('Não foi possível conectar: '+e.message,true);}finally{busy=false;el('mmCloudStart').disabled=false;}
}
async function flush(){
 if(busy||!enabled||paused||!navigator.onLine)return;
 const local=getSnapshot(), hash=canonical(local);if(hash===baseline)return;
 busy=true;status('☁️ Salvando alterações…');
 try{const result=await request('PUT',{data:local,baseVersion:version});remember(local,result.version);status('✓ Salvo na nuvem');}
 catch(e){if(e.conflict){paused=true;controls(false);status('⚠️ Alterações em dois aparelhos. Resolver antes de sincronizar.',true);}else status('⚠️ Sem sincronização: '+e.message,true);}
 finally{busy=false;}
}
async function checkRemote(){
 if(busy||!enabled||paused||!navigator.onLine)return;
 busy=true;
 try{
  const result=await request();
  if(!result.found){paused=true;status('⚠️ O registro na nuvem não foi encontrado.',true);controls(false);return;}
  if(result.version===version)return;
  const current=getSnapshot();
  if(canonical(current)!==baseline){paused=true;status('⚠️ Há mudanças locais e na nuvem. Resolva antes de continuar.',true);controls(false);return;}
  // Não sobrescrever automaticamente ao receber modificações de outro dispositivo:
  paused=true;controls(false);status('☁️ Há novos dados na nuvem. Toque em Resolver para recebê-los.');
 }catch(e){status('⚠️ Não foi possível conferir a nuvem: '+e.message,true);}
 finally{busy=false;}
}
async function resolve(){
 if(busy)return;busy=true;status('Verificando versões…');
 try{
  const remote=await request(),local=getSnapshot();
  if(!remote.found||!snapshotValid(remote.data))throw Error('Não há um diário válido na nuvem.');
  if(canonical(remote.data)===canonical(local)){remember(local,remote.version);status('✓ Sincronização retomada');return;}
  const choice=confirm('O diário da nuvem é diferente dos dados deste aparelho.\n\nOK = usar a versão da NUVEM e baixar uma cópia dos dados locais.\nCancelar = manter os dados locais e ver outra opção.');
  if(choice){downloadBackup(local);writeSnapshot(remote.data);remember(remote.data,remote.version);location.reload();return;}
  if(!confirm('Deseja ENVIAR os dados deste aparelho e substituir o diário da nuvem?\n\nIsso pode apagar alterações feitas no outro aparelho. Só confirme se tiver certeza.')){status('Sincronização pausada; seus dados locais estão preservados.');return;}
  // Compare-and-swap ensures no intervening remote writes were lost.
  const saved=await request('PUT',{data:local,baseVersion:remote.version});remember(local,saved.version);status('✓ Dados deste aparelho enviados');
 }catch(e){status('⚠️ Não foi possível resolver: '+e.message,true);}finally{busy=false;}
}
function init(){
 const meta=readMeta(),local=getSnapshot();
 if(meta&&typeof meta.version==='string'&&typeof meta.baseline==='string'){
  version=meta.version;baseline=meta.baseline;enabled=true;controls(false);
  status(canonical(local)===baseline?'☁️ Conferindo diário na nuvem…':'☁️ Alterações locais aguardando envio');
  // Read remote before any PUT, so a second device's changes are never overwritten.
  setTimeout(async()=>{await checkRemote();if(!paused)flush();},200);
 }else{controls(true);status('☁️ Nuvem pronta para conectar (seus dados estão preservados)');}
 el('mmCloudStart').addEventListener('click',firstConnect);
 el('mmCloudSave').addEventListener('click',()=>{if(!paused)flush();else resolve();});
 el('mmCloudResolve').addEventListener('click',resolve);
 timer=setInterval(()=>{if(enabled&&!paused)flush();},4000);
 window.addEventListener('focus',()=>{if(enabled)checkRemote();});
 window.addEventListener('online',()=>{if(enabled)checkRemote();});
 document.addEventListener('visibilitychange',()=>{if(!document.hidden&&enabled)checkRemote();});
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);else init();
})();