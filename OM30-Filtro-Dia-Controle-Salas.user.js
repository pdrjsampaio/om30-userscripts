// ==UserScript==
// @name         OM30 - Filtro de Dia Controle de Salas
// @namespace    https://om30.com.br/
// @version      1.3.0
// @description  Substitui o filtro visual nativo por um filtro OM30 de data, mantendo a escolha após F5 e retorno da ficha.
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

    // Sempre que o próprio Saúde Simples refizer a busca, recoloca a data salva
    // antes da chamada nativa. Assim a atualização da fila não apaga o filtro.
    if (f && !f.__om30Dia130) {
      const original=f.fetchFilter;
      f.fetchFilter=function(...args) {
        const d=getSaved();
        if (d && !state.applying) setDates(filter,d);
        return original.apply(this,args);
      };
      f.__om30Dia130=true;
    }

    if (!control.__om30Dia130) {
      const original=control.atualizarListagemFila;
      control.atualizarListagemFila=function(...args) {
        const d=getSaved(); if (d) setDates(this.$refs?.filtroMunicipe,d);
        return original.apply(this,args);
      };
      control.__om30Dia130=true;
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

  function nativeFilterButton(control) {
    return control?.$el?.querySelector?.('#btn_filtro_modal') || document.querySelector('#btn_filtro_modal');
  }

  function hideNativeFilter(control) {
    const btn=nativeFilterButton(control);
    if (!btn) return;
    btn.classList.add('om30fd-native-hidden');
    btn.setAttribute('aria-hidden','true');
    btn.tabIndex=-1;
  }

  function style() {
    if (document.querySelector('#om30fd-style')) return;
    const s=document.createElement('style'); s.id='om30fd-style'; s.textContent=`
#btn_filtro_modal.om30fd-native-hidden{display:none!important}
#om30-filtro-dia{display:block;width:100%;box-sizing:border-box;margin:8px 0 10px 0;padding:9px 10px;background:#f8fafc;border:1px solid #cbd5e1;border-radius:6px;font-family:Arial,sans-serif;color:#172033}
#om30-filtro-dia .om30fd-row{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap}
#om30-filtro-dia .om30fd-field{min-width:180px;max-width:230px;flex:0 0 210px}
#om30-filtro-dia label{display:block;font-size:11px;font-weight:700;margin:0 0 4px;color:#334155}
#om30-filtro-dia input{width:100%;height:34px;box-sizing:border-box;border:1px solid #b8c4d2;border-radius:5px;background:#fff;padding:4px 8px;font-size:12px;color:#172033}
#om30-filtro-dia button{height:34px;border:1px solid #b8c4d2;border-radius:5px;background:#fff;color:#172033;font-size:11px;font-weight:700;cursor:pointer;padding:0 12px}
#om30-filtro-dia #om30fd-aplicar{background:#203a5f;color:#fff;border-color:#203a5f}
#om30-filtro-dia button:hover{filter:brightness(.98)}
#om30fd-status{align-self:center;margin-left:2px;font-size:10px;color:#64748b;min-width:115px}
#om30fd-status.ok{color:#166534}#om30fd-status.err{color:#b42318}#om30fd-status.loading{color:#1d4ed8}
#om30-filtro-dia .om30fd-note{width:100%;margin-top:5px;font-size:9px;color:#7c8798}
@media(max-width:700px){#om30-filtro-dia .om30fd-field{flex:1 1 170px;max-width:none}#om30fd-status{width:100%;margin-top:2px}}
`; document.head.appendChild(s);
  }

  function setStatus(msg, cls='', date='') {
    const box=document.querySelector('#om30-filtro-dia'); if (!box) return;
    const st=box.querySelector('#om30fd-status'), input=box.querySelector('#om30fd-data');
    if (date && input) input.value=date;
    if (st) { st.className=cls; st.textContent=msg; }
  }

  function mountPanel(control, p) {
    if (!p || !control) return false;

    // Preferência: logo abaixo do componente onde o Saúde Simples mostra o nome/local selecionado.
    const nomeLocal=control?.$refs?.selecaoGuiche?.$el;
    if (nomeLocal?.parentNode) {
      if (nomeLocal.nextSibling !== p) nomeLocal.parentNode.insertBefore(p, nomeLocal.nextSibling);
      return true;
    }

    // Fallback: ocupa exatamente a região do filtro nativo que foi ocultado.
    const native=nativeFilterButton(control);
    if (native?.parentNode) {
      if (native.previousSibling !== p) native.parentNode.insertBefore(p,native);
      return true;
    }

    // Último fallback: imediatamente antes da listagem da fila.
    const list=control?.$refs?.listagemFila?.$el;
    if (list?.parentNode) {
      if (list.previousSibling !== p) list.parentNode.insertBefore(p,list);
      return true;
    }
    return false;
  }

  function panel(control) {
    if (!pageOk()) return null;
    style();
    hideNativeFilter(control);

    let p=document.querySelector('#om30-filtro-dia');
    if (!p) {
      const saved=getSaved();
      p=document.createElement('div');
      p.id='om30-filtro-dia';
      p.innerHTML=`<div class="om30fd-row"><div class="om30fd-field"><label>Data da fila</label><input id="om30fd-data" type="date" value="${saved||today()}"></div><button id="om30fd-aplicar" type="button">Aplicar</button><button id="om30fd-hoje" type="button">Hoje</button><span id="om30fd-status" class="${saved?'ok':''}">${saved?'Ativo: '+br(saved):'Selecione a data.'}</span><div class="om30fd-note">A mesma data é usada em Data Inicial e Data Final. O filtro antigo do sistema fica oculto.</div></div>`;

      const input=p.querySelector('#om30fd-data');
      p.querySelector('#om30fd-aplicar').onclick=async()=>{
        if(!validISO(input.value)) return setStatus('Selecione uma data válida.','err');
        save(input.value);
        try{await applySaved(true);}catch(e){setStatus('Falha: '+e.message,'err',input.value);}
      };
      p.querySelector('#om30fd-hoje').onclick=async()=>{
        input.value=today(); save(input.value);
        try{await applySaved(true);}catch(e){setStatus('Falha: '+e.message,'err',input.value);}
      };
      input.addEventListener('keydown', e=>{ if(e.key==='Enter') p.querySelector('#om30fd-aplicar').click(); });
    }

    mountPanel(control,p);
    const saved=getSaved();
    if (saved) setStatus(`Ativo: ${br(saved)}`,'ok',saved);
    return p;
  }

  async function init() {
    if (!pageOk()) return;
    style();

    const c=await waitControl();
    if (!c) return;

    state.control=c;
    installHooks(c);
    panel(c);

    if (getSaved()) {
      try { await applySaved(true); } catch(e) { setStatus('Falha: '+e.message,'err',getSaved()); }
      // O Rails/Vue ainda pode terminar de montar a tela após o primeiro carregamento.
      setTimeout(()=>applySaved(true).catch(()=>{}),1400);
      setTimeout(()=>applySaved(true).catch(()=>{}),3500);
    }

    setInterval(async()=>{
      if (!pageOk() || state.applying) return;
      const now=findControl(); if (!now) return;
      hideNativeFilter(now);
      panel(now);
      const f=findFetch(now.$refs?.filtroMunicipe);
      if (now!==state.control || f!==state.fetchVM) {
        state.control=now;
        state.fetchVM=f;
        installHooks(now);
        panel(now);
        if(getSaved()) try{await applySaved(true);}catch{}
      }
    },1500);
  }

  window.OM30FiltroDia={ get salvo(){return getSaved();}, aplicar:async d=>{if(d)save(d);return applySaved(true);}, limpar:clearSaved };
  init();
})();