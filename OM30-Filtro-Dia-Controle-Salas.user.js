// ==UserScript==
// @name         OM30 - Filtro de Dia Controle de Salas
// @namespace    https://om30.com.br/
// @version      1.2.0
// @description  Mantém a data escolhida no Controle de Salas - Medicação, com seletor visível e restauração após F5 ou retorno da ficha.
// @author       OM30
// @match        https://guaruja.saudesimples.net/aplicacoes_medicamentos*
// @updateURL    https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Filtro-Dia-Controle-Salas.user.js
// @downloadURL  https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Filtro-Dia-Controle-Salas.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const KEY = 'om30_controle_salas_filtro_dia_v3';
  const LEGACY = ['om30_controle_salas_filtro_dia_v2', 'om30_controle_salas_filtro_dia_v1'];
  const state = { applying: false, control: null, fetchVM: null };
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function log(...a) { console.log('[OM30 FILTRO DIA]', ...a); }
  function pageOk() { return /^\/aplicacoes_medicamentos(?:\/\d+)?\/?$/.test(location.pathname); }
  function norm(v) { return String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase(); }

  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  function validISO(v) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))) return false;
    const [y,m,d] = v.split('-').map(Number), x = new Date(y,m-1,d);
    return x.getFullYear() === y && x.getMonth() === m-1 && x.getDate() === d;
  }

  function toISO(v) {
    if (!v) return '';
    if (v instanceof Date && !Number.isNaN(v.getTime())) {
      return `${v.getFullYear()}-${String(v.getMonth()+1).padStart(2,'0')}-${String(v.getDate()).padStart(2,'0')}`;
    }
    const s = String(v).trim();
    if (validISO(s)) return s;
    const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return m && validISO(`${m[3]}-${m[2]}-${m[1]}`) ? `${m[3]}-${m[2]}-${m[1]}` : '';
  }

  function br(iso) { return validISO(iso) ? `${iso.slice(8,10)}/${iso.slice(5,7)}/${iso.slice(0,4)}` : ''; }
  function sameType(old, iso) { return old instanceof Date ? new Date(`${iso}T00:00:00`) : iso; }

  function readObj(k) {
    try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; }
  }

  function getSaved() {
    let o = readObj(KEY), d = toISO(o?.data || o?.dataInicial);
    if (d) return d;
    for (const k of LEGACY) {
      o = readObj(k); d = toISO(o?.data || o?.dataInicial);
      if (d) { save(d); return d; }
    }
    return '';
  }

  function save(d) {
    if (!validISO(d)) return false;
    localStorage.setItem(KEY, JSON.stringify({ data:d, dataInicial:d, dataFinal:d, salvoEm:new Date().toISOString() }));
    setStatus(`Salvo: ${br(d)}`, 'ok', d);
    return true;
  }

  function clearSaved() {
    localStorage.removeItem(KEY); LEGACY.forEach(k => localStorage.removeItem(k));
    setStatus('Sem data salva', '', '');
  }

  function roots(vm) {
    const out=[], seen=new Set();
    while (vm && !seen.has(vm)) { seen.add(vm); out.push(vm); vm=vm.$parent; }
    return out;
  }

  function tree(root, limit=180) {
    const out=[], q=[root], seen=new Set();
    while (q.length && out.length < limit) {
      const vm=q.shift(); if (!vm || seen.has(vm)) continue;
      seen.add(vm); out.push(vm); if (Array.isArray(vm.$children)) q.push(...vm.$children);
    }
    return out;
  }

  function findControl() {
    const candidates=[], seen=new Set();
    const test = vm => {
      if (!vm || seen.has(vm)) return; seen.add(vm);
      if (vm.$refs?.filtroMunicipe && vm.$refs?.listagemFila && typeof vm.atualizarListagemFila === 'function') candidates.push(vm);
    };
    for (const seed of document.querySelectorAll('.atualizar-listagem,#btn_filtro_modal,.botao-chamar,.botao-atender')) {
      let n=seed;
      for (let i=0; n && i<15; i++, n=n.parentElement) if (n.__vue__) roots(n.__vue__).forEach(test);
    }
    if (!candidates.length) {
      for (const el of document.querySelectorAll('body *')) if (el.__vue__) roots(el.__vue__).forEach(test);
    }
    return candidates.find(vm => String(vm.salaValorSelecionado||'').includes('medicacao') || String(vm.dataSource||'').includes('/aplicacoes_medicamentos')) || candidates[0] || null;
  }

  async function waitControl() {
    const start=Date.now();
    while (Date.now()-start < 30000 && pageOk()) {
      const c=findControl(); if (c?.$refs?.filtroMunicipe) return c;
      await sleep(250);
    }
    return null;
  }

  function conditionObject(filter) {
    const list=[];
    for (const vm of tree(filter,120)) {
      for (const obj of [vm.conditions, vm.$data?.conditions, vm.$props?.conditions]) {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
        const ks=Object.keys(obj).map(norm);
        const score=(ks.some(k=>k.includes('datainicial')||k.includes('datainicio'))?10:0)+(ks.some(k=>k.includes('datafinal')||k.includes('datafim'))?10:0);
        list.push({obj,score});
      }
    }
    return list.sort((a,b)=>b.score-a.score)[0] || null;
  }

  function dateKey(obj, initial) {
    return Object.keys(obj||{}).find(k => {
      const n=norm(k); return initial ? (n.includes('datainicial')||n.includes('datainicio')) : (n.includes('datafinal')||n.includes('datafim'));
    });
  }

  function setDates(filter, iso) {
    let changed=0;
    for (const vm of tree(filter,140)) {
      for (const box of [vm.$data, vm.$props]) {
        if (!box || typeof box !== 'object') continue;
        for (const k of Object.keys(box)) {
          const n=norm(k);
          if (!(n.includes('datainicial')||n.includes('datainicio')||n.includes('datafinal')||n.includes('datafim'))) continue;
          try {
            const v=sameType(box[k], iso);
            if (box === vm.$data && typeof vm.$set === 'function') vm.$set(box,k,v); else box[k]=v;
            changed++;
          } catch {}
        }
      }
    }
    const c=conditionObject(filter);
    if (c?.score >= 20) {
      const a=dateKey(c.obj,true), b=dateKey(c.obj,false);
      if (a) { c.obj[a]=sameType(c.obj[a],iso); changed++; }
      if (b) { c.obj[b]=sameType(c.obj[b],iso); changed++; }
    }
    return changed;
  }

  function currentDates(filter) {
    const c=conditionObject(filter); let a='',b='';
    if (c?.score >= 20) { const ka=dateKey(c.obj,true), kb=dateKey(c.obj,false); if (ka) a=toISO(c.obj[ka]); if (kb) b=toISO(c.obj[kb]); }
    if (a && b) return [a,b];
    for (const vm of tree(filter,120)) {
      for (const box of [vm.$data, vm.$props]) {
        if (!box) continue;
        for (const [k,v] of Object.entries(box)) {
          const n=norm(k); if (!a && (n.includes('datainicial')||n.includes('datainicio'))) a=toISO(v); if (!b && (n.includes('datafinal')||n.includes('datafim'))) b=toISO(v);
        }
      }
      if (a&&b) break;
    }
    return [a,b];
  }

  function findFetch(filter) { return tree(filter,120).find(vm => typeof vm.fetchFilter === 'function') || null; }

  function installHooks(control) {
    const filter=control?.$refs?.filtroMunicipe; if (!filter) return;
    const f=findFetch(filter); state.fetchVM=f;

    if (f && !f.__om30Dia120) {
      const original=f.fetchFilter;
      f.fetchFilter=function(...args) {
        const r=original.apply(this,args);
        const capture=()=>setTimeout(()=>{
          if (state.applying) return;
          const [a,b]=currentDates(filter);
          if (a && b && a===b) { save(a); const input=document.querySelector('#om30fd-data'); if (input) input.value=a; }
        },100);
        if (r?.then) return r.then(x=>{capture();return x;},e=>Promise.reject(e));
        capture(); return r;
      };
      f.__om30Dia120=true;
    }

    if (!control.__om30Dia120) {
      const original=control.atualizarListagemFila;
      control.atualizarListagemFila=function(...args) {
        const d=getSaved(); if (d) setDates(this.$refs?.filtroMunicipe,d);
        return original.apply(this,args);
      };
      control.__om30Dia120=true;
    }
  }

  async function applySaved(force=true) {
    if (state.applying) return;
    const d=getSaved(); if (!d) return;
    let c=findControl(); if (!c) c=await waitControl();
    if (!c) throw new Error('Controle de Salas não encontrado.');
    state.control=c; installHooks(c);
    const filter=c.$refs.filtroMunicipe, f=findFetch(filter);
    state.applying=true; setStatus(`Aplicando ${br(d)}...`,'loading',d);
    try {
      if (!setDates(filter,d)) throw new Error('Campos de Data Inicial/Data Final não encontrados.');
      for (const vm of tree(filter,120)) if (typeof vm.$nextTick==='function') await new Promise(r=>vm.$nextTick(r));
      await sleep(250);
      let r=f?.fetchFilter ? f.fetchFilter() : c.atualizarListagemFila();
      if (r?.then) await r;
      setStatus(`Ativo: ${br(d)}`,'ok',d); log('Data restaurada:',d);
    } finally { state.applying=false; }
  }

  function style() {
    if (document.querySelector('#om30fd-style')) return;
    const s=document.createElement('style'); s.id='om30fd-style'; s.textContent=`
#om30-filtro-dia{position:fixed;right:18px;top:84px;z-index:2147483000;width:270px;background:#fff;border:1px solid #cbd5e1;border-radius:8px;box-shadow:0 8px 24px rgba(15,23,42,.14);font-family:Arial,sans-serif;color:#172033;overflow:hidden}
#om30-filtro-dia .h{background:#132238;color:#fff;padding:9px 11px}#om30-filtro-dia .h strong{font-size:12px}#om30-filtro-dia .h small{display:block;color:#cbd5e1;font-size:10px;margin-top:2px}
#om30-filtro-dia .b{padding:10px 11px}#om30-filtro-dia label{display:block;font-size:10px;font-weight:700;margin-bottom:5px;color:#334155}#om30-filtro-dia input{width:100%;height:32px;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:6px;padding:4px 7px;font-size:12px}
#om30-filtro-dia .a{display:grid;grid-template-columns:1fr auto auto;gap:6px;margin-top:8px}#om30-filtro-dia button{height:30px;border:1px solid #b8c4d2;border-radius:6px;background:#f8fafc;color:#172033;font-size:10px;font-weight:700;cursor:pointer;padding:0 9px}#om30-filtro-dia #om30fd-aplicar{background:#203a5f;color:#fff;border-color:#203a5f}
#om30fd-status{margin-top:8px;font-size:10px;min-height:14px;color:#64748b}#om30fd-status.ok{color:#166534}#om30fd-status.err{color:#b42318}#om30fd-status.loading{color:#1d4ed8}.note{margin-top:5px;font-size:9px;color:#7c8798}`; document.head.appendChild(s);
  }

  function setStatus(msg, cls='', date='') {
    const box=document.querySelector('#om30-filtro-dia'); if (!box) return;
    const st=box.querySelector('#om30fd-status'), input=box.querySelector('#om30fd-data');
    if (date && input) input.value=date; if (st) { st.className=cls; st.textContent=msg; }
  }

  function panel() {
    if (!pageOk() || document.querySelector('#om30-filtro-dia')) return;
    style(); const saved=getSaved();
    const p=document.createElement('div'); p.id='om30-filtro-dia'; p.innerHTML=`<div class="h"><strong>OM30 · Filtro do dia</strong><small>Controle de Salas · Medicação</small></div><div class="b"><label>Data da fila</label><input id="om30fd-data" type="date" value="${saved||today()}"><div class="a"><button id="om30fd-aplicar">Aplicar e salvar</button><button id="om30fd-hoje">Hoje</button><button id="om30fd-limpar">Limpar</button></div><div id="om30fd-status" class="${saved?'ok':''}">${saved?'Salvo: '+br(saved):'Escolha uma data e clique em Aplicar e salvar.'}</div><div class="note">Data Inicial e Data Final ficam iguais. Nenhum outro filtro é alterado.</div></div>`;
    document.body.appendChild(p);
    const input=p.querySelector('#om30fd-data');
    p.querySelector('#om30fd-aplicar').onclick=async()=>{ if(!validISO(input.value)) return setStatus('Selecione uma data válida.','err'); save(input.value); try{await applySaved(true);}catch(e){setStatus('Falha: '+e.message,'err',input.value);} };
    p.querySelector('#om30fd-hoje').onclick=async()=>{ input.value=today(); save(input.value); try{await applySaved(true);}catch(e){setStatus('Falha: '+e.message,'err',input.value);} };
    p.querySelector('#om30fd-limpar').onclick=()=>{ clearSaved(); input.value=today(); };
  }

  async function init() {
    if (!pageOk()) return;
    panel();
    const c=await waitControl(); if (!c) return setStatus('Controle de Salas não encontrado.','err');
    state.control=c; installHooks(c);
    if (getSaved()) {
      try { await applySaved(true); } catch(e) { setStatus('Falha: '+e.message,'err',getSaved()); }
      setTimeout(()=>applySaved(true).catch(()=>{}),1400);
      setTimeout(()=>applySaved(true).catch(()=>{}),3500);
    }
    setInterval(async()=>{
      if (!pageOk() || state.applying) return;
      const now=findControl(); if (!now) return;
      const f=findFetch(now.$refs?.filtroMunicipe);
      if (now!==state.control || f!==state.fetchVM) { state.control=now; state.fetchVM=f; installHooks(now); if(getSaved()) try{await applySaved(true);}catch{} }
    },1500);
  }

  window.OM30FiltroDia={ get salvo(){return getSaved();}, aplicar:async d=>{if(d)save(d);return applySaved(true);}, limpar:clearSaved };
  init();
})();
