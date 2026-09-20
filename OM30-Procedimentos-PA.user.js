// ==UserScript==
// @name         OM30 - Procedimentos PA
// @namespace    https://om30.com.br/
// @version      0.2.0
// @description  Busca rápida de Exames, Procedimentos/CIDs e Medicamentos no Pronto Atendimento.
// @author       Pedro Sampaio - Samp
// @match        https://guaruja.saudesimples.net/prontuarios/*
// @match        https://guarujahomolog.saudesimples.net/prontuarios/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  if (window.__OM30_PA_V020__) return;
  window.__OM30_PA_V020__ = true;

  const $ = window.jQuery;
  const q = (s,r=document) => r.querySelector(s);
  const qa = (s,r=document) => [...r.querySelectorAll(s)];
  const clean = v => String(v ?? '').replace(/\s+/g,' ').trim();
  const norm = v => clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
  const esc = v => String(v ?? '').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

  if (!q('#prontuario_exame_token') || !q('#prontuario_procedimento_token') || !q('#prontuario_medicamento_token')) return;

  const STORE = 'OM30_PA_FAVORITOS_PC_V1';

  function unitName(){
    return qa('a.nav-link,.navbar a,.navbar-nav a').map(x=>clean(x.innerText)).find(t=>/\b(UPA|PRONTO|UNIDADE|USAFA|UBS|CAPS|CENTRO|PS\b|PA\b)/i.test(t)) || 'UNIDADE NÃO IDENTIFICADA';
  }

  function occupation(){
    for(const el of qa('input[name*="profissional_ocupacao_id"],input[id*="profissional_ocupacao_id"]')){
      const v=clean(el.value),m=v.match(/-(\d+)$/);
      if(m) return m[1];
      if(/^\d+$/.test(v)) return v;
    }
    return null;
  }

  const UNIT=unitName(), UNITKEY=norm(UNIT), OCC=occupation();

  const aliases={
    exame:{
      'RX':'RADIOGRAFIA','RAIO X':'RADIOGRAFIA','RAIO-X':'RADIOGRAFIA',
      'RX TORAX':'RADIOGRAFIA TORAX','RAIO X TORAX':'RADIOGRAFIA TORAX',
      'HC':'HEMOGRAMA COMPLETO','SANGUE':'HEMOGRAMA'
    },
    procedimento:{
      'HGT':'GLICEMIA','DEXTRO':'GLICEMIA','PA':'PRESSAO ARTERIAL',
      'PRESSAO':'PRESSAO ARTERIAL','AFERIR PRESSAO':'PRESSAO ARTERIAL'
    }
  };

  const gruposRX=[
    ['Tórax','RADIOGRAFIA TORAX'],
    ['Cabeça / Crânio','RADIOGRAFIA CRANIO'],
    ['Face','RADIOGRAFIA FACE'],
    ['Coluna','RADIOGRAFIA COLUNA'],
    ['Membro superior','RADIOGRAFIA MAO'],
    ['Membro inferior','RADIOGRAFIA PE'],
    ['Abdome','RADIOGRAFIA ABDOME'],
    ['Bacia / Pelve / Quadril','RADIOGRAFIA BACIA']
  ];

  const favoritosUnidade={
    'UNIDADE TESTE GUARUJA':[
      {type:'exame',code:'0202020380',name:'HEMOGRAMA COMPLETO',query:'HEMOGRAMA'},
      {type:'exame',code:'0204030153',name:'RADIOGRAFIA DE TORAX (PA E PERFIL)',query:'RADIOGRAFIA TORAX'},
      {type:'procedimento',code:'0214010015',name:'GLICEMIA CAPILAR',query:'GLICEMIA'},
      {type:'procedimento',code:'0301100039',name:'AFERIÇÃO DE PRESSÃO ARTERIAL',query:'PRESSAO'},
      {type:'medicamento',code:'1035',name:'DIPIRONA 500 MG CP',query:'DIPIRONA 500 MG'}
    ]
  };

  function traduz(tipo,txt){
    const n=norm(txt),map=aliases[tipo]||{};
    if(map[n]) return map[n];
    const k=Object.keys(map).sort((a,b)=>b.length-a.length).find(x=>n.includes(x));
    return k?map[k]:txt;
  }

  async function api(url){
    const r=await fetch(url,{credentials:'same-origin',headers:{Accept:'application/json, text/javascript, */*; q=0.01','X-Requested-With':'XMLHttpRequest'}});
    if(!r.ok) throw new Error('HTTP '+r.status);
    return await r.json();
  }

  async function buscar(tipo,termo){
    const t=traduz(tipo,termo);
    if(tipo==='exame') return api('/procedimentos/search.json?exame=1&q='+encodeURIComponent(t));
    if(tipo==='procedimento'){
      if(!OCC) throw new Error('Ocupação profissional não identificada.');
      return api('/procedimentos/procedimentos_ocupacoes.json?'+new URLSearchParams({ocupacao_id:OCC,q:t}));
    }
    if(tipo==='medicamento') return api('/estoque/produtos/aplicacao_local?q='+encodeURIComponent(t));
    return [];
  }

  function code(tipo,item){return clean(item.codigo||item.codigo_externo||'');}
  function name(tipo,item){return clean(tipo==='medicamento'?(item.nome||item.descricao):item.nome);}
  function key(tipo,item){return UNITKEY+'|'+tipo+'|'+(code(tipo,item)||item.id)+'|'+name(tipo,item);}

  function favs(){try{return JSON.parse(localStorage.getItem(STORE)||'{}')}catch{return {}}}
  function setFavs(v){localStorage.setItem(STORE,JSON.stringify(v))}
  function isFav(tipo,item){return !!favs()[key(tipo,item)]}
  function toggleFav(tipo,item){
    const f=favs(),k=key(tipo,item);
    if(f[k]) delete f[k]; else f[k]={unit:UNITKEY,type:tipo,item};
    setFavs(f); return !!f[k];
  }
  function favLocal(tipo){return Object.values(favs()).filter(x=>x.unit===UNITKEY&&x.type===tipo).map(x=>x.item)}

  function visible(el){
    if(!el) return false;
    const s=getComputedStyle(el),r=el.getBoundingClientRect();
    return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0;
  }

  function tokenAdd(selector,tipo,item){
    if(!$||typeof $(selector).tokenInput!=='function') throw new Error('TokenInput não disponível.');
    const nm=tipo==='medicamento'?name(tipo,item):code(tipo,item)+' - '+name(tipo,item);
    $(selector).tokenInput('add',{...item,id:item.id,name:nm});
  }

  function incluirDepois(campo){
    const f=q(campo);
    return qa('a,button,input[type="button"],input[type="submit"]').filter(visible).find(el=>
      /INCLUIR/.test(norm(el.innerText||el.value)) && (f.compareDocumentPosition(el)&Node.DOCUMENT_POSITION_FOLLOWING)
    );
  }

  const sleep=ms=>new Promise(r=>setTimeout(r,ms));

  async function incluirSimples(tipo,item){
    if(tipo==='exame'){
      const interno=q('#prontuario_exame_externo_false');
      if(interno){interno.checked=true;interno.dispatchEvent(new Event('change',{bubbles:true}))}
      tokenAdd('#prontuario_exame_token',tipo,item);
      await sleep(180);
      const b=incluirDepois('#prontuario_exame_token');
      if(!b) throw new Error('Botão + Incluir de Exame não encontrado.');
      b.click(); return;
    }
    tokenAdd('#prontuario_procedimento_token',tipo,item);
    await sleep(180);
    const b=incluirDepois('#prontuario_procedimento_token');
    if(!b) throw new Error('Botão + Incluir de Procedimento não encontrado.');
    b.click();
  }

  function vias(){
    const s=q('#prontuario_tipo_uso_medicamento_id');
    return s?[...s.options].filter(o=>clean(o.value)&&clean(o.textContent)).map(o=>({v:o.value,t:clean(o.textContent)})):[];
  }

  async function incluirMedicamento(item,via,pos,obs){
    if(!via) throw new Error('Selecione a via de administração.');
    if(!clean(pos)) throw new Error('Informe a posologia.');
    tokenAdd('#prontuario_medicamento_token','medicamento',item);
    await sleep(100);
    const v=q('#prontuario_tipo_uso_medicamento_id'),p=q('#prontuario_posologia_medicamento'),o=q('#prontuario_observacao_medicamento');
    v.value=via; v.dispatchEvent(new Event('change',{bubbles:true}));
    p.value=pos; p.dispatchEvent(new Event('input',{bubbles:true})); p.dispatchEvent(new Event('change',{bubbles:true}));
    if(o){o.value=obs||'';o.dispatchEvent(new Event('input',{bubbles:true}))}
    await sleep(120);
    const b=q('a.incluir_prontuario_medicamento')||incluirDepois('#prontuario_medicamento_token');
    if(!b) throw new Error('Botão + Incluir de Medicamento não encontrado.');
    b.click();
  }

  const css=document.createElement('style');
  css.textContent=`
  #om30pa{position:fixed;right:18px;bottom:18px;width:min(760px,calc(100vw - 36px));max-height:86vh;background:#fff;border:1px solid #d9e2e7;border-radius:16px;box-shadow:0 20px 60px rgba(10,30,45,.28);z-index:2147483646;font-family:Segoe UI,Arial,sans-serif;color:#243640;overflow:hidden}
  #om30pa *{box-sizing:border-box}.oh{background:#123f68;color:#fff;padding:15px 17px;display:flex;justify-content:space-between}.ot{font-size:16px;font-weight:750}.os{font-size:11px;opacity:.82;margin-top:3px}.ox{border:0;background:transparent;color:#fff;font-size:24px;cursor:pointer}
  .oinfo{padding:8px 12px;background:#f3f7f9;border-bottom:1px solid #e1e8ec;font-size:11px;color:#5d7481}.tabs{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px;padding:9px 12px;border-bottom:1px solid #e5ebee}.tab{border:0;background:#edf3f6;color:#496473;padding:9px 8px;border-radius:9px;font-weight:700;cursor:pointer;text-align:left}.tab b{display:block;font-size:12px}.tab small{display:block;font-size:9px;font-weight:500;opacity:.78;margin-top:2px;line-height:1.2}.tab.on{background:#123f68;color:#fff}
  .obody{padding:12px;overflow:auto;max-height:calc(86vh - 145px)}.searchrow{display:grid;grid-template-columns:1fr auto;gap:8px}.search{padding:11px 12px;border:1px solid #cbd7dd;border-radius:9px;font-size:14px;outline:none}.btn{border:0;border-radius:9px;background:#176aa7;color:#fff;padding:0 14px;font-weight:750;cursor:pointer}.hint{font-size:11px;color:#758995;margin:7px 0 10px}
  .sect{margin-top:13px}.stitle{display:flex;justify-content:space-between;gap:8px;font-size:12px;font-weight:800;color:#415b69;margin-bottom:7px}.muted{font-weight:500;color:#85959d}.chips{display:flex;flex-wrap:wrap;gap:7px}.chip{border:1px solid #d4e0e6;background:#fff;border-radius:999px;padding:7px 10px;font-size:11px;font-weight:700;color:#365b70;cursor:pointer}
  .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.fav{display:flex;gap:8px;align-items:center;border:1px solid #dce5e9;border-radius:9px;padding:8px;background:#fff}.fmain{flex:1;min-width:0}.fcode{font:700 11px Consolas,monospace;color:#46677a}.fname{font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fuse{border:0;background:#edf4f7;color:#285a76;border-radius:7px;padding:7px 9px;font-weight:700;cursor:pointer}
  .wrap{border:1px solid #dce5e9;border-radius:10px;overflow:auto}.tbl{width:100%;border-collapse:collapse;font-size:12px}.tbl th{background:#f2f6f8;padding:8px;text-align:left;position:sticky;top:0}.tbl td{padding:8px;border-top:1px solid #edf1f3}.code{font:700 11px Consolas,monospace;color:#355c74;white-space:nowrap}.nm{font-weight:650}.star{border:0;background:transparent;font-size:19px;color:#aab7bd;cursor:pointer}.star.on{color:#d49b00}.use{border:0;background:#176aa7;color:#fff;border-radius:7px;padding:7px 9px;font-size:11px;font-weight:750;cursor:pointer}
  .status{margin-top:10px;padding:8px 10px;border-radius:8px;background:#f2f6f8;color:#5e7380;font-size:11px}.status.ok{background:#e8f5ed;color:#2f7148}.status.err{background:#fdecec;color:#a23939}.empty{padding:16px;text-align:center;color:#7b8d96;font-size:12px}
  .med{border:1px solid #d8e2e7;background:#f9fbfc;border-radius:11px;padding:11px}.medname{font-size:13px;font-weight:800;color:#264e66;margin-bottom:9px}.mgrid{display:grid;grid-template-columns:1fr 1fr;gap:9px}.field label{display:block;font-size:11px;font-weight:750;margin-bottom:4px;color:#4d6573}.field select,.field input,.field textarea{width:100%;border:1px solid #cbd7dd;border-radius:8px;padding:9px;font:13px Segoe UI}.field textarea{min-height:64px}.mactions{text-align:right;margin-top:9px}.launch{position:fixed;right:18px;bottom:18px;z-index:2147483645;border:0;border-radius:999px;background:#123f68;color:#fff;padding:11px 14px;font-weight:800;cursor:pointer;display:none}
  @media(max-width:650px){.tabs{grid-template-columns:repeat(2,minmax(0,1fr))}.grid{grid-template-columns:1fr}.mgrid{grid-template-columns:1fr}}
  `;
  document.head.appendChild(css);

  const panel=document.createElement('div');
  panel.id='om30pa';
  panel.innerHTML=`
  <div class="oh"><div><div class="ot">OM30 — Procedimentos do Pronto Atendimento</div><div class="os">Favoritos da unidade, favoritos deste computador e busca SIGTAP</div></div><button class="ox">×</button></div>
  <div class="oinfo"><b>${esc(UNIT)}</b> · Ocupação ${esc(OCC||'—')} · v0.2.0</div>
  <div class="tabs"><button class="tab on" data-t="raiox"><b>Raio X</b><small>Radiografias e RX</small></button><button class="tab" data-t="exames"><b>Exames</b><small>Coletas e exames internos</small></button><button class="tab" data-t="medicacao"><b>Medicação</b><small>Aplicação no local</small></button><button class="tab" data-t="enfermagem"><b>Enfermagem</b><small>Procedimentos de enfermagem</small></button></div>
  <div class="obody">
    <div class="searchrow"><input class="search" placeholder="Ex.: tórax, hemograma, hgt, pressão, dipirona..."><button class="btn searchbtn">Pesquisar</button></div>
    <div class="hint">Aceita código SIGTAP, nome oficial e nomes populares. Ao escolher, o OM30 usa o fluxo nativo do Saúde Simples.</div>
    <div class="rx sect"></div><div class="uf sect"></div><div class="lf sect"></div><div class="medc sect"></div><div class="res sect"></div><div class="status">Pronto.</div>
  </div>`;
  document.body.appendChild(panel);

  const launch=document.createElement('button'); launch.className='launch'; launch.textContent='OM30 PA'; document.body.appendChild(launch);
  const E={s:q('.search',panel),r:q('.res',panel),uf:q('.uf',panel),lf:q('.lf',panel),rx:q('.rx',panel),mc:q('.medc',panel),st:q('.status',panel)};
  let tipo='raiox',timer;

  function status(t,k=''){E.st.textContent=t;E.st.className='status'+(k?' '+k:'')}
  function tipoNativo(t=tipo){
    if(t==='raiox'||t==='exames') return 'exame';
    if(t==='medicacao') return 'medicamento';
    if(t==='enfermagem') return 'procedimento';
    return t;
  }
  function defs(){const nt=tipoNativo();return (favoritosUnidade[UNITKEY]||[]).filter(x=>x.type===nt).filter(x=>tipo!=='raiox'||/RADIOGRAFIA/i.test(x.name||'')).filter(x=>tipo!=='exames'||!/RADIOGRAFIA/i.test(x.name||''))}

  async function resolveDef(d){
    const xs=await buscar(d.type,d.query||d.code||d.name);
    return xs.find(x=>norm(code(d.type,x))===norm(d.code))||xs[0]||null;
  }

  async function usar(tipo,item){
    try{
      const nt=tipoNativo(tipo);
      if(nt==='medicamento'){composer(item);status('Medicamento selecionado. Preencha via e posologia.');return}
      status('Incluindo '+name(nt,item)+'...');
      await incluirSimples(nt,item);
      status(name(nt,item)+' incluído. O destino da sala continua sendo definido pelo Saúde Simples.','ok');
    }catch(e){console.error(e);status(e.message||String(e),'err')}
  }

  function renderFavs(){
    const ds=defs();
    E.uf.innerHTML='<div class="stitle"><span>Favoritos da unidade</span><span class="muted">lista base</span></div>'+(ds.length?'<div class="grid">'+ds.map((d,i)=>'<div class="fav" data-i="'+i+'"><div class="fmain"><div class="fcode">'+esc(d.code||'')+'</div><div class="fname">'+esc(d.name)+'</div></div><button class="fuse">Usar</button></div>').join('')+'</div>':'<div class="empty">Nenhum favorito da unidade configurado.</div>');
    qa('.fav',E.uf).forEach(c=>q('.fuse',c).onclick=async()=>{try{const d=ds[+c.dataset.i];status('Localizando '+d.name+'...');const it=await resolveDef(d);if(!it)throw new Error('Não localizado.');usar(d.type,it)}catch(e){status(e.message,'err')}});

    const nt=tipoNativo();
    const fs=favLocal(nt).filter(x=>tipo!=='raiox'||/RADIOGRAFIA/i.test(name(nt,x))).filter(x=>tipo!=='exames'||!/RADIOGRAFIA/i.test(name(nt,x)));
    E.lf.innerHTML='<div class="stitle"><span>Favoritos deste computador</span><span class="muted">salvos só neste PC</span></div>'+(fs.length?'<div class="grid">'+fs.map((x,i)=>'<div class="fav" data-i="'+i+'"><button class="star on">★</button><div class="fmain"><div class="fcode">'+esc(code(tipo,x))+'</div><div class="fname">'+esc(name(tipo,x))+'</div></div><button class="fuse">Usar</button></div>').join('')+'</div>':'<div class="empty">Nenhum favorito local.</div>');
    qa('.fav',E.lf).forEach(c=>{const it=fs[+c.dataset.i];q('.star',c).onclick=()=>{toggleFav(nt,it);renderFavs()};q('.fuse',c).onclick=()=>usar(tipo,it)});
  }

  function renderTable(xs){
    if(!xs.length){E.r.innerHTML='<div class="stitle">Tabela SIGTAP / resultados</div><div class="wrap"><div class="empty">Nenhum resultado.</div></div>';return}
    const nt=tipoNativo();
    const med=nt==='medicamento';
    E.r.innerHTML='<div class="stitle"><span>'+(med?'Medicamentos disponíveis no local':'Tabela SIGTAP — resultados')+'</span><span class="muted">'+xs.length+' resultado(s)</span></div><div class="wrap"><table class="tbl"><thead><tr><th>★</th><th>'+(med?'Código':'Código SIGTAP')+'</th><th>'+(med?'Medicamento':'Procedimento')+'</th><th></th></tr></thead><tbody>'+xs.map((x,i)=>'<tr data-i="'+i+'"><td><button class="star '+(isFav(nt,x)?'on':'')+'">'+(isFav(nt,x)?'★':'☆')+'</button></td><td class="code">'+esc(code(tipo,x))+'</td><td><div class="nm">'+esc(name(tipo,x))+'</div></td><td><button class="use">'+(med?'Selecionar':'Usar + incluir')+'</button></td></tr>').join('')+'</tbody></table></div>';
    qa('tbody tr',E.r).forEach(tr=>{const it=xs[+tr.dataset.i];const st=q('.star',tr);st.onclick=()=>{const on=toggleFav(nt,it);st.textContent=on?'★':'☆';st.classList.toggle('on',on);renderFavs()};q('.use',tr).onclick=()=>usar(tipo,it)});
  }

  function renderRX(){
    E.rx.innerHTML='<div class="stitle"><span>Radiografia — escolha a região</span><span class="muted">depois aparecem as opções SIGTAP</span></div><div class="chips">'+gruposRX.map(g=>'<button class="chip" data-q="'+esc(g[1])+'">'+esc(g[0])+'</button>').join('')+'</div>';
    qa('.chip',E.rx).forEach(b=>b.onclick=()=>pesquisar(b.dataset.q,true));
  }

  function composer(item){
    E.mc.innerHTML='<div class="stitle"><span>Preparar medicamento</span><span class="muted">preencha e inclua direto no prontuário</span></div><div class="med"><div class="medname">'+esc(name('medicamento',item))+'</div><div class="mgrid"><div class="field"><label>Via de administração *</label><select class="mvia"><option value="">Selecione...</option>'+vias().map(x=>'<option value="'+esc(x.v)+'">'+esc(x.t)+'</option>').join('')+'</select></div><div class="field"><label>Posologia *</label><input class="mpos" placeholder="Ex.: 1 comprimido agora"></div><div class="field" style="grid-column:1/-1"><label>Observação</label><textarea class="mobs" placeholder="Opcional"></textarea></div></div><div class="mactions"><button class="btn madd">Incluir medicamento</button></div></div>';
    q('.madd',E.mc).onclick=async()=>{try{status('Incluindo medicamento...');await incluirMedicamento(item,q('.mvia',E.mc).value,q('.mpos',E.mc).value,q('.mobs',E.mc).value);E.mc.innerHTML='';status('Medicamento incluído.','ok')}catch(e){status(e.message,'err')}};
    q('.mpos',E.mc)?.focus();
  }

  async function pesquisar(forcado=null,grupo=false){
    const termo=clean(forcado??E.s.value);
    if(tipo==='raiox'&&!termo){renderRX();E.r.innerHTML='';status('Escolha uma região ou pesquise uma radiografia.');return}
    if(termo.length<2){status('Digite pelo menos 2 caracteres.');return}
    const nt=tipoNativo();
    const n=norm(termo);
    if(tipo==='raiox'&&!grupo&&['RADIOGRAFIA','RX','RAIO X','RAIO-X'].includes(n)){renderRX();E.r.innerHTML='';status('Escolha a região da radiografia.');return}
    E.rx.innerHTML='';
    try{
      status('Pesquisando “'+traduz(nt,termo)+'”...');
      let xs=await buscar(nt,termo);
      if(tipo==='raiox') xs=xs.filter(x=>/RADIOGRAFIA/i.test(name(nt,x)));
      if(tipo==='exames') xs=xs.filter(x=>!/RADIOGRAFIA/i.test(name(nt,x)));
      renderTable(xs);
      status(xs.length+' resultado(s).')
    }catch(e){console.error(e);status(e.message||String(e),'err')}
  }

  qa('.tab',panel).forEach(b=>b.onclick=()=>{qa('.tab',panel).forEach(x=>x.classList.remove('on'));b.classList.add('on');tipo=b.dataset.t;E.s.value='';E.r.innerHTML='';E.rx.innerHTML='';E.mc.innerHTML='';renderFavs();if(tipo==='raiox'){renderRX();status('Escolha uma região ou pesquise uma radiografia.')}else status('Pronto.');E.s.focus()});
  q('.searchbtn',panel).onclick=()=>pesquisar();
  E.s.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();pesquisar()}};
  E.s.oninput=()=>{clearTimeout(timer);if(E.s.value.trim().length>=3)timer=setTimeout(()=>pesquisar(),350)};
  q('.ox',panel).onclick=()=>{panel.style.display='none';launch.style.display='block'};
  launch.onclick=()=>{launch.style.display='none';panel.style.display='block';E.s.focus()};

  renderFavs();
  renderRX();
  status('Escolha uma região ou pesquise uma radiografia.','ok');
  console.info('[OM30 PA] v0.2.0 carregada para',UNIT);
})();