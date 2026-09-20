// ==UserScript==
// @name         OM30 - Procedimentos PA
// @namespace    https://om30.com.br/
// @version      0.4.0
// @description  Busca rápida de Exames, Procedimentos/CIDs e Medicamentos no Pronto Atendimento.
// @updateURL    https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Procedimentos-PA.user.js
// @downloadURL  https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Procedimentos-PA.user.js
// @author       Pedro Sampaio - Samp
// @match        https://guaruja.saudesimples.net/prontuarios/*
// @match        https://guarujahomolog.saudesimples.net/prontuarios/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  if (window.__OM30_PA_V040__) return;
  window.__OM30_PA_V040__ = true;

  const $ = window.jQuery;
  const q = (s,r=document) => r.querySelector(s);
  const qa = (s,r=document) => [...r.querySelectorAll(s)];
  const clean = v => String(v ?? '').replace(/\s+/g,' ').trim();
  const norm = v => clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
  const esc = v => String(v ?? '').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

  if (!q('#prontuario_exame_token') || !q('#prontuario_procedimento_token') || !q('#prontuario_medicamento_token')) return;

  const STORE = 'OM30_PA_FAVORITOS_PC_V1';
  const STORE_UNIT = 'OM30_PA_FAVORITOS_UNIDADE_V2';
  const STORE_POS = 'OM30_PA_POSICAO_V1';

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

  function unitStore(){try{return JSON.parse(localStorage.getItem(STORE_UNIT)||'{}')}catch{return {}}}
  function setUnitStore(v){localStorage.setItem(STORE_UNIT,JSON.stringify(v))}
  function unitCustom(){return unitStore()[UNITKEY]||[]}
  function saveUnitCustom(list){const s=unitStore();s[UNITKEY]=list;setUnitStore(s)}

  function logicalFromText(v){
    const n=norm(v);
    if(/RAIO|RADIOGRAF|\\bRX\\b/.test(n)) return 'raiox';
    if(/MEDIC/.test(n)) return 'medicacao';
    if(/ENFERMAG|PROCED/.test(n)) return 'enfermagem';
    if(/EXAME|COLETA|LABORAT/.test(n)) return 'exames';
    return '';
  }

  function nativeFromLogical(g){
    if(g==='raiox'||g==='exames') return 'exame';
    if(g==='medicacao') return 'medicamento';
    if(g==='enfermagem') return 'procedimento';
    return '';
  }

  function parseUnitTxt(text,hint=''){
    let grupo=logicalFromText(hint);
    const out=[];
    for(const raw of String(text||'').split(/\\r?\\n/)){
      const line=clean(raw);
      if(!line||/^#|^\\/\\//.test(line)) continue;
      const heading=line.replace(/^\\[|\\]$/g,'');
      const hg=logicalFromText(heading);
      if(/^\\[.*\\]$/.test(line)||/^(RAIO X|RX|RADIOGRAFIA|EXAMES?|MEDICA(CAO|ÇÃO)|ENFERMAGEM|PROCEDIMENTOS?)$/i.test(line)){
        if(hg) grupo=hg;
        continue;
      }

      let parts=line.split(/\\s*[|;\\t]\\s*/).filter(Boolean);
      let lineGrupo='';
      if(parts.length>=3){
        const g=logicalFromText(parts[0]);
        if(g){lineGrupo=g;parts.shift()}
      }
      const g=lineGrupo||grupo||logicalFromText(line);
      if(!g) continue;

      let codigo='',nome='';
      if(parts.length>=2){codigo=clean(parts[0]);nome=clean(parts.slice(1).join(' | '))}
      else {
        const m=line.match(/^(\\d{3,14})\\s*[-–—:]\\s*(.+)$/);
        if(m){codigo=m[1];nome=clean(m[2])}
        else {nome=line}
      }
      if(!nome) continue;
      out.push({type:nativeFromLogical(g),group:g,code:codigo,name:nome,query:codigo||nome});
    }
    return out;
  }

  function mergeUnitCustom(items){
    const map=new Map();
    for(const x of [...unitCustom(),...items]){
      const k=(x.group||'')+'|'+(x.code||'')+'|'+norm(x.name||'');
      map.set(k,x);
    }
    const list=[...map.values()];
    saveUnitCustom(list);
    return list;
  }

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
    if(!f) return null;

    const todos=qa('a,button,input[type="button"],input[type="submit"]')
      .filter(el=>/INCLUIR/.test(norm(el.innerText||el.value)));

    // Prioriza o + Incluir mais próximo e posterior ao campo,
    // mesmo quando a seção da Evolução está fechada/oculta.
    const posteriores=todos
      .filter(el=>f.compareDocumentPosition(el)&Node.DOCUMENT_POSITION_FOLLOWING)
      .sort((a,b)=>{
        const pa=f.parentElement?.contains(a)?0:1;
        const pb=f.parentElement?.contains(b)?0:1;
        return pa-pb;
      });

    return posteriores[0]||null;
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
  #om30pa{
    position:fixed;right:14px;bottom:14px;width:370px;max-width:calc(100vw - 28px);
    max-height:66vh;background:#fff;border:1px solid #e8ecef;border-radius:16px;
    box-shadow:0 16px 44px rgba(26,45,58,.17);z-index:2147483646;
    font-family:"Segoe UI",Arial,sans-serif;color:#263942;overflow:hidden
  }
  #om30pa *{box-sizing:border-box}
  .oh{background:#123f68;color:#fff;padding:10px 12px;display:flex;align-items:center;justify-content:space-between}
  .ot{font-size:13px;font-weight:750;letter-spacing:.05px}
  .ha{display:flex;align-items:center;gap:2px}
  .oh{cursor:move;user-select:none}.og,.omin,.ox{width:27px;height:27px;border:0;background:transparent;color:#fff;border-radius:7px;cursor:pointer;display:grid;place-items:center;padding:0}.og,.omin,.ox{cursor:pointer}
  .og{font-size:15px}.omin{font-size:14px}.ox{font-size:18px;line-height:1}.og:hover,.omin:hover,.ox:hover{background:rgba(255,255,255,.12)}
  .oinfo{padding:5px 10px;background:#fbfcfd;border-bottom:1px solid #edf1f3;font-size:9px;color:#7b8a92}
  .tabs{display:grid;grid-template-columns:repeat(4,1fr);gap:2px;padding:5px 6px;background:#f6f8f9;border-bottom:1px solid #edf1f3}
  .tab{border:0;background:transparent;color:#718089;padding:7px 3px;border-radius:8px;cursor:pointer;font-size:10px;font-weight:700;transition:.15s}
  .tab:hover{background:#edf2f5;color:#3d5968}
  .tab.on{background:#fff;color:#123f68;box-shadow:0 1px 5px rgba(32,55,70,.11)}
  .obody{padding:8px;overflow:auto;max-height:calc(66vh - 93px)}
  .searchrow{display:flex;align-items:center;background:#f4f6f7;border:1px solid transparent;border-radius:999px;padding:3px 4px 3px 11px;transition:.15s}
  .searchrow:focus-within{background:#fff;border-color:#cbd8df;box-shadow:0 0 0 3px rgba(18,63,104,.07)}
  .search{flex:1;border:0;background:transparent;outline:none;padding:6px 2px;font-size:10.5px;color:#2d434f;min-width:0}
  .search::placeholder{color:#99a5ab}
  .searchbtn{width:29px;height:29px;border:0;border-radius:50%;background:#123f68;color:#fff;cursor:pointer;font-size:0;padding:0;position:relative;flex:none}
  .searchbtn:before{content:"⌕";font-size:17px;line-height:29px}
  .sect{margin-top:7px}
  .stitle{display:flex;align-items:center;justify-content:space-between;gap:5px;font-size:9px;font-weight:750;color:#50636d;margin-bottom:4px}
  .muted{font-weight:500;color:#a0aaaf;font-size:8px}
  .rxpick{position:relative}
  .rxtrigger{width:100%;border:1px solid #e3e8eb;background:#fff;border-radius:10px;padding:8px 9px;display:flex;align-items:center;gap:7px;cursor:pointer;text-align:left;color:#405660}
  .rxtrigger:hover{background:#fafcfd}
  .rxlabel{font-size:8px;color:#93a0a6;text-transform:uppercase;letter-spacing:.4px}
  .rxvalue{flex:1;font-size:10px;font-weight:700;color:#2e4856}
  .rxchev{font-size:12px;color:#91a0a7}
  .rxmenu{display:none;position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:50;background:#fff;border:1px solid #e2e8eb;border-radius:10px;padding:4px;box-shadow:0 10px 25px rgba(30,50,63,.16)}
  .rxmenu.open{display:grid;grid-template-columns:1fr 1fr;gap:2px}
  .rxopt{border:0;background:transparent;border-radius:7px;padding:7px 8px;text-align:left;font-size:9px;color:#405b69;cursor:pointer}
  .rxopt:hover{background:#f0f5f7;color:#123f68}
  .grid{display:grid;grid-template-columns:1fr;gap:3px}
  .fav{display:flex;align-items:center;gap:5px;border:1px solid #e8ecef;border-radius:9px;padding:5px 6px;background:#fff}
  .fmain{flex:1;min-width:0}.fcode{font:700 8px Consolas,monospace;color:#8b989e}.fname{font-size:9.5px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#304750}
  .star{border:0;background:transparent;font-size:15px;color:#c2c9cd;cursor:pointer;padding:0 2px}.star.on{color:#d5a021}
  .fuse,.use{border:0;background:#eef4f7;color:#285970;border-radius:6px;padding:4px 7px;font-size:8.5px;font-weight:700;cursor:pointer;white-space:nowrap}
  .use{background:#123f68;color:#fff}
  .wrap{border:1px solid #e6ebee;border-radius:9px;overflow:auto;max-height:205px}
  .tbl{width:100%;border-collapse:collapse;font-size:9px}.tbl th{background:#f7f9fa;padding:5px;text-align:left;position:sticky;top:0;color:#7e8c93;font-size:8px}.tbl td{padding:5px;border-top:1px solid #eef1f3}
  .code{font:700 8px Consolas,monospace;color:#5c7582;white-space:nowrap}.nm{font-weight:650;line-height:1.15;color:#324852}
  .status{margin-top:5px;min-height:12px;color:#8a989f;font-size:8px}.status.ok{color:#4a7a5b}.status.err{color:#b14a4a}
  .empty{padding:7px;text-align:center;color:#9ca8ad;font-size:8.5px}
  .med{border:1px solid #e5eaed;background:#fbfcfd;border-radius:9px;padding:7px}.medname{font-size:10px;font-weight:800;color:#2d4f61;margin-bottom:6px}
  .mgrid{display:grid;grid-template-columns:1fr 1fr;gap:6px}.field label{display:block;font-size:8px;font-weight:700;margin-bottom:3px;color:#697b84}
  .field select,.field input,.field textarea{width:100%;border:1px solid #dfe5e8;border-radius:7px;padding:6px 7px;font:10px "Segoe UI";background:#fff;outline:none}.field textarea{min-height:42px;resize:vertical}
  .mactions{text-align:right;margin-top:6px}.mactions .btn{border:0;border-radius:7px;background:#123f68;color:#fff;padding:6px 9px;font-size:9px;font-weight:700;cursor:pointer}
  .settings{display:none;position:absolute;inset:0;background:#fff;z-index:100;overflow:auto}.settings.open{display:block}
  .shead{position:sticky;top:0;background:#fff;border-bottom:1px solid #edf1f3;padding:10px 11px;display:flex;align-items:center;justify-content:space-between;z-index:2}
  .stxt{font-size:12px;font-weight:750;color:#2d4653}.sclose{border:0;background:#f2f5f7;color:#506671;width:27px;height:27px;border-radius:7px;cursor:pointer;font-size:16px}
  .sbody{padding:10px}.sunit{font-size:9px;color:#85939a;margin-bottom:8px}.snote{font-size:8.5px;color:#7b8b93;line-height:1.35;margin-bottom:8px}
  .sactions{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px}.sbtn{border:1px solid #dce4e8;background:#fff;color:#34586a;border-radius:8px;padding:6px 8px;font-size:9px;font-weight:700;cursor:pointer}.sbtn.primary{background:#123f68;color:#fff;border-color:#123f68}.sbtn.danger{color:#a34d4d}
  .stextarea{width:100%;min-height:155px;border:1px solid #dfe5e8;border-radius:9px;padding:8px;font:9px/1.4 Consolas,monospace;outline:none;resize:vertical}.stextarea:focus{border-color:#b9cbd4;box-shadow:0 0 0 3px rgba(18,63,104,.06)}
  .sfoot{font-size:8px;color:#9aa5aa;margin-top:7px}
  .launch{position:fixed;right:10px;bottom:18px;z-index:2147483645;border:0;border-radius:999px;background:#123f68;color:#fff;width:46px;height:46px;font-size:9px;font-weight:800;cursor:pointer;display:none;box-shadow:0 6px 18px rgba(20,45,65,.22)}
  #om30pa.om30-inline{position:relative;inset:auto;width:100%;max-width:none;max-height:none;border:0;border-radius:0;box-shadow:none;background:#fff}
  #om30pa.om30-inline .oh{cursor:default;border-radius:0;background:#fff;color:#294858;padding:8px 10px;border-bottom:1px solid #e8edef}
  #om30pa.om30-inline .ot{font-size:11px}
  #om30pa.om30-inline .og{color:#315a70;background:#eef4f7}
  #om30pa.om30-inline .omin,#om30pa.om30-inline .ox{display:none}
  #om30pa.om30-inline .oinfo{background:#fff;padding:5px 10px}
  #om30pa.om30-inline .obody{max-height:none}
  .om30-cs-wrap{margin:10px 0}
  .om30-cs-head{height:39px;display:flex;align-items:center;justify-content:space-between;padding:0 10px;border:1px solid #c8c8c8;background:linear-gradient(#f4f4f4,#e2e2e2);color:#202020;font:700 11px Arial,sans-serif;cursor:pointer;box-shadow:inset 0 1px 0 #fff}
  .om30-cs-head:hover{background:linear-gradient(#f8f8f8,#e8e8e8)}
  .om30-cs-icon{width:16px;height:16px;border-radius:50%;background:#999;color:#fff;display:grid;place-items:center;font-size:11px;line-height:1}
  .om30-cs-body{display:none;border:1px solid #d9dfe2;border-top:0;background:#fff;padding:0}
  .om30-cs-wrap.open .om30-cs-body{display:block}
  .om30-cs-wrap.open .om30-cs-icon{transform:rotate(180deg)}
  @media(max-width:420px){#om30pa{width:calc(100vw - 20px);right:10px;bottom:10px}.tabs{grid-template-columns:repeat(2,1fr)}.mgrid{grid-template-columns:1fr}}
  `;
  document.head.appendChild(css);

  const panel=document.createElement('div');
  panel.id='om30pa';
  panel.innerHTML=`
  <div class="oh">
    <div class="ot">Procedimentos</div>
    <div class="ha"><button class="og" title="Configurar favoritos da unidade">⚙</button><button class="omin" title="Minimizar">—</button><button class="ox" title="Fechar">×</button></div>
  </div>
  <div class="oinfo"><b>${esc(UNIT)}</b></div>
  <div class="tabs">
    <button class="tab on" data-t="raiox" title="Radiografias e RX">Raio X</button>
    <button class="tab" data-t="exames" title="Coletas e exames internos">Exames</button>
    <button class="tab" data-t="medicacao" title="Medicação aplicada no local">Medicação</button>
    <button class="tab" data-t="enfermagem" title="Procedimentos de enfermagem">Enfermagem</button>
  </div>
  <div class="obody">
    <div class="searchrow"><input class="search" placeholder="Buscar radiografia..."><button class="searchbtn" title="Pesquisar">Pesquisar</button></div>
    <div class="rx sect"></div><div class="uf sect"></div><div class="lf sect"></div><div class="medc sect"></div><div class="res sect"></div><div class="status"></div>
  </div>
  <div class="settings">
    <div class="shead"><div class="stxt">Favoritos da unidade</div><button class="sclose">×</button></div>
    <div class="sbody">
      <div class="sunit">${esc(UNIT)}</div>
      <div class="snote">Importe um ou mais arquivos .txt ou cole a lista abaixo. Pode separar por [RAIO X], [EXAMES], [MEDICAÇÃO] e [ENFERMAGEM].</div>
      <div class="sactions">
        <button class="sbtn primary simpor">Importar TXT</button>
        <button class="sbtn sadd">Adicionar texto</button>
        <button class="sbtn danger sclear">Limpar importados</button>
        <input class="sfile" type="file" accept=".txt,text/plain" multiple hidden>
      </div>
      <textarea class="stextarea" placeholder="[RAIO X]&#10;0204030153 | RADIOGRAFIA DE TORAX (PA E PERFIL)&#10;&#10;[EXAMES]&#10;0202020380 | HEMOGRAMA COMPLETO&#10;&#10;[ENFERMAGEM]&#10;0214010015 | GLICEMIA CAPILAR"></textarea>
      <div class="sfoot">v0.4.0 · Os favoritos importados ficam vinculados à unidade identificada nesta máquina.</div>
    </div>
  </div>`;
  document.body.appendChild(panel);

  function textoLimpo(el){
    return norm(el?.innerText||el?.textContent||'').replace(/^\\(\\*\\)\\s*/,'');
  }

  function localizarEvolucao(){
    const candidatos=qa('h1,h2,h3,h4,h5,div,a,span,button')
      .filter(el=>{
        const t=textoLimpo(el);
        return t==='EVOLUCAO CLINICA'||t.startsWith('EVOLUCAO CLINICA ');
      })
      .sort((a,b)=>(a.innerText||'').length-(b.innerText||'').length);

    if(!candidatos.length) return null;

    const el=candidatos[0];
    return el.closest('.ui-accordion-header,.panel-heading,.card-header,.accordion-heading')||el;
  }

  function montarComoSecao(){
    const evo=localizarEvolucao();
    if(!evo) return false;

    let ponto=evo;

    if(evo.matches?.('.ui-accordion-header') &&
       evo.nextElementSibling?.classList?.contains('ui-accordion-content')){
      ponto=evo.nextElementSibling;
    } else {
      const pai=evo.parentElement;
      if(pai){
        const r=pai.getBoundingClientRect();
        if(r.width>500 && r.height<180) ponto=pai;
      }
    }

    const wrap=document.createElement('div');
    wrap.className='om30-cs-wrap';
    wrap.innerHTML='<div class="om30-cs-head"><span>CONTROLE DE SALAS</span><span class="om30-cs-icon">⌄</span></div><div class="om30-cs-body"></div>';

    ponto.insertAdjacentElement('afterend',wrap);
    q('.om30-cs-body',wrap).appendChild(panel);

    panel.classList.add('om30-inline');
    panel.style.cssText='';
    panel.classList.add('om30-inline');

    const head=q('.om30-cs-head',wrap);
    head.onclick=()=>{
      wrap.classList.toggle('open');
      if(wrap.classList.contains('open')){
        setTimeout(()=>E?.s?.focus(),60);
      }
    };

    return true;
  }

  const INLINE_MODE=montarComoSecao();

  function loadPos(){
    try{return JSON.parse(localStorage.getItem(STORE_POS)||'null')}catch{return null}
  }
  function savePos(){
    const r=panel.getBoundingClientRect();
    localStorage.setItem(STORE_POS,JSON.stringify({left:Math.round(r.left),top:Math.round(r.top)}));
  }
  function applyPos(){
    if(INLINE_MODE) return;
    const p=loadPos();
    if(!p) return;
    const maxL=Math.max(0,window.innerWidth-panel.offsetWidth);
    const maxT=Math.max(0,window.innerHeight-panel.offsetHeight);
    panel.style.left=Math.min(Math.max(0,p.left),maxL)+'px';
    panel.style.top=Math.min(Math.max(0,p.top),maxT)+'px';
    panel.style.right='auto';
    panel.style.bottom='auto';
  }

  let dragging=false,dragDX=0,dragDY=0;
  const head=q('.oh',panel);
  head.addEventListener('mousedown',e=>{
    if(INLINE_MODE) return;
    if(e.target.closest('button')) return;
    const r=panel.getBoundingClientRect();
    dragging=true;
    dragDX=e.clientX-r.left;
    dragDY=e.clientY-r.top;
    panel.style.left=r.left+'px';
    panel.style.top=r.top+'px';
    panel.style.right='auto';
    panel.style.bottom='auto';
    e.preventDefault();
  });
  document.addEventListener('mousemove',e=>{
    if(!dragging) return;
    const w=panel.offsetWidth,h=panel.offsetHeight;
    const left=Math.min(Math.max(0,e.clientX-dragDX),Math.max(0,window.innerWidth-w));
    const top=Math.min(Math.max(0,e.clientY-dragDY),Math.max(0,window.innerHeight-h));
    panel.style.left=left+'px';
    panel.style.top=top+'px';
  });
  document.addEventListener('mouseup',()=>{
    if(!dragging) return;
    dragging=false;
    savePos();
  });
  window.addEventListener('resize',()=>applyPos());
  setTimeout(applyPos,0);

  const launch=document.createElement('button'); launch.className='launch'; launch.textContent='OM30'; document.body.appendChild(launch); if(INLINE_MODE) launch.style.display='none';
  const E={s:q('.search',panel),r:q('.res',panel),uf:q('.uf',panel),lf:q('.lf',panel),rx:q('.rx',panel),mc:q('.medc',panel),st:q('.status',panel),settings:q('.settings',panel),sta:q('.stextarea',panel),file:q('.sfile',panel)};
  let tipo='raiox',timer;

  function status(t,k=''){E.st.textContent=t;E.st.className='status'+(k?' '+k:'')}
  function tipoNativo(t=tipo){
    if(t==='raiox'||t==='exames') return 'exame';
    if(t==='medicacao') return 'medicamento';
    if(t==='enfermagem') return 'procedimento';
    return t;
  }
  function defs(){const nt=tipoNativo();const custom=unitCustom();const src=custom.length?custom:(favoritosUnidade[UNITKEY]||[]);return src.filter(x=>x.type===nt).filter(x=>!x.group||x.group===tipo).filter(x=>tipo!=='raiox'||/RADIOGRAFIA/i.test(x.name||'')).filter(x=>tipo!=='exames'||!/RADIOGRAFIA/i.test(x.name||''))}

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
    const nt=tipoNativo();
    const base=defs();
    const locais=favLocal(nt)
      .filter(x=>tipo!=='raiox'||/RADIOGRAFIA/i.test(name(nt,x)))
      .filter(x=>tipo!=='exames'||!/RADIOGRAFIA/i.test(name(nt,x)));

    const itens=[];
    const seen=new Set();

    base.forEach(d=>{
      const k=(d.code||'')+'|'+d.name;
      if(!seen.has(k)){seen.add(k);itens.push({kind:'base',data:d})}
    });

    locais.forEach(x=>{
      const k=code(nt,x)+'|'+name(nt,x);
      if(!seen.has(k)){seen.add(k);itens.push({kind:'local',data:x})}
    });

    if(!itens.length){
      E.uf.innerHTML='';
      E.lf.innerHTML='';
      return;
    }

    E.uf.innerHTML='<div class="stitle"><span>Favoritos</span></div><div class="grid">'+itens.map((it,i)=>{
      const d=it.data;
      const cd=it.kind==='base'?(d.code||''):code(nt,d);
      const nm=it.kind==='base'?d.name:name(nt,d);
      return '<div class="fav" data-i="'+i+'"><button class="star '+(it.kind==='local'?'on':'')+'">'+(it.kind==='local'?'★':'☆')+'</button><div class="fmain"><div class="fcode">'+esc(cd)+'</div><div class="fname">'+esc(nm)+'</div></div><button class="fuse">Usar</button></div>'
    }).join('')+'</div>';

    E.lf.innerHTML='';

    qa('.fav',E.uf).forEach(c=>{
      const it=itens[+c.dataset.i];
      const star=q('.star',c);
      const btn=q('.fuse',c);

      if(it.kind==='base'){
        star.onclick=async()=>{
          try{
            const resolved=await resolveDef(it.data);
            if(!resolved) throw new Error('Não localizado.');
            const on=toggleFav(nt,resolved);
            star.textContent=on?'★':'☆';
            star.classList.toggle('on',on);
          }catch(e){status(e.message,'err')}
        };
        btn.onclick=async()=>{
          try{
            status('Localizando '+it.data.name+'...');
            const resolved=await resolveDef(it.data);
            if(!resolved) throw new Error('Não localizado.');
            usar(tipo,resolved);
          }catch(e){status(e.message,'err')}
        };
      } else {
        star.onclick=()=>{toggleFav(nt,it.data);renderFavs()};
        btn.onclick=()=>usar(tipo,it.data);
      }
    });
  }

  function renderTable(xs){
    if(!xs.length){E.r.innerHTML='<div class="stitle">Tabela SIGTAP / resultados</div><div class="wrap"><div class="empty">Nenhum resultado.</div></div>';return}
    const nt=tipoNativo();
    const med=nt==='medicamento';
    E.r.innerHTML='<div class="stitle"><span>'+(med?'Medicamentos disponíveis no local':'Tabela SIGTAP — resultados')+'</span><span class="muted">'+xs.length+' resultado(s)</span></div><div class="wrap"><table class="tbl"><thead><tr><th>★</th><th>'+(med?'Código':'Código SIGTAP')+'</th><th>'+(med?'Medicamento':'Procedimento')+'</th><th></th></tr></thead><tbody>'+xs.map((x,i)=>'<tr data-i="'+i+'"><td><button class="star '+(isFav(nt,x)?'on':'')+'">'+(isFav(nt,x)?'★':'☆')+'</button></td><td class="code">'+esc(code(tipo,x))+'</td><td><div class="nm">'+esc(name(tipo,x))+'</div></td><td><button class="use">'+(med?'Selecionar':'Usar + incluir')+'</button></td></tr>').join('')+'</tbody></table></div>';
    qa('tbody tr',E.r).forEach(tr=>{const it=xs[+tr.dataset.i];const st=q('.star',tr);st.onclick=()=>{const on=toggleFav(nt,it);st.textContent=on?'★':'☆';st.classList.toggle('on',on);renderFavs()};q('.use',tr).onclick=()=>usar(tipo,it)});
  }

  function renderRX(){
    E.rx.innerHTML='<div class="rxpick"><button class="rxtrigger"><span class="rxlabel">Região</span><span class="rxvalue">Escolher região</span><span class="rxchev">⌄</span></button><div class="rxmenu">'+gruposRX.map((g,i)=>'<button class="rxopt" data-i="'+i+'">'+esc(g[0])+'</button>').join('')+'</div></div>';
    const menu=q('.rxmenu',E.rx),trigger=q('.rxtrigger',E.rx),value=q('.rxvalue',E.rx);
    trigger.onclick=()=>menu.classList.toggle('open');
    qa('.rxopt',E.rx).forEach(b=>b.onclick=()=>{
      const g=gruposRX[+b.dataset.i];
      value.textContent=g[0];
      menu.classList.remove('open');
      pesquisar(g[1],true);
    });
  }

  function updatePlaceholder(){
    const map={raiox:'Buscar radiografia...',exames:'Buscar exame ou código SIGTAP...',medicacao:'Buscar medicamento...',enfermagem:'Buscar procedimento ou código...'};
    E.s.placeholder=map[tipo]||'Pesquisar...';
  }

  function openSettings(){E.settings.classList.add('open')}
  function closeSettings(){E.settings.classList.remove('open')}

  async function importFiles(files){
    const all=[];
    for(const file of files){
      const txt=await file.text();
      all.push(...parseUnitTxt(txt,file.name));
    }
    if(!all.length){status('Nenhum favorito reconhecido nos TXT.','err');return}
    const list=mergeUnitCustom(all);
    renderFavs();
    status(list.length+' favorito(s) configurado(s) para a unidade.','ok');
    closeSettings();
  }

  function addTextFavorites(){
    const list=parseUnitTxt(E.sta.value,'');
    if(!list.length){status('Não consegui reconhecer itens no texto.','err');return}
    const merged=mergeUnitCustom(list);
    E.sta.value='';
    renderFavs();
    status(merged.length+' favorito(s) configurado(s) para a unidade.','ok');
    closeSettings();
  }

  function clearUnitFavorites(){
    const s=unitStore();
    delete s[UNITKEY];
    setUnitStore(s);
    renderFavs();
    status('Lista importada da unidade removida.','ok');
    closeSettings();
  }

  function composer(item){
    E.mc.innerHTML='<div class="stitle"><span>Preparar medicamento</span><span class="muted">preencha e inclua direto no prontuário</span></div><div class="med"><div class="medname">'+esc(name('medicamento',item))+'</div><div class="mgrid"><div class="field"><label>Via de administração *</label><select class="mvia"><option value="">Selecione...</option>'+vias().map(x=>'<option value="'+esc(x.v)+'">'+esc(x.t)+'</option>').join('')+'</select></div><div class="field"><label>Posologia *</label><input class="mpos" placeholder="Ex.: 1 comprimido agora"></div><div class="field" style="grid-column:1/-1"><label>Observação</label><textarea class="mobs" placeholder="Opcional"></textarea></div></div><div class="mactions"><button class="btn madd">Incluir medicamento</button></div></div>';
    q('.madd',E.mc).onclick=async()=>{try{status('Incluindo medicamento...');await incluirMedicamento(item,q('.mvia',E.mc).value,q('.mpos',E.mc).value,q('.mobs',E.mc).value);E.mc.innerHTML='';status('Medicamento incluído.','ok')}catch(e){status(e.message,'err')}};
    q('.mpos',E.mc)?.focus();
  }

  async function pesquisar(forcado=null,grupo=false){
    const termo=clean(forcado??E.s.value);
    if(tipo==='raiox'&&!termo){renderRX();E.r.innerHTML='';status('');return}
    if(termo.length<2){status('Digite pelo menos 2 caracteres.');return}
    const nt=tipoNativo();
    const n=norm(termo);
    if(tipo==='raiox'&&!grupo&&['RADIOGRAFIA','RX','RAIO X','RAIO-X'].includes(n)){renderRX();E.r.innerHTML='';status('');return}
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

  qa('.tab',panel).forEach(b=>b.onclick=()=>{qa('.tab',panel).forEach(x=>x.classList.remove('on'));b.classList.add('on');tipo=b.dataset.t;E.s.value='';E.r.innerHTML='';E.rx.innerHTML='';E.mc.innerHTML='';renderFavs();updatePlaceholder();if(tipo==='raiox'){renderRX()}status('');E.s.focus()});
  q('.searchbtn',panel).onclick=()=>pesquisar();
  E.s.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();pesquisar()}};
  E.s.oninput=()=>{clearTimeout(timer);if(E.s.value.trim().length>=3)timer=setTimeout(()=>pesquisar(),350)};
  q('.og',panel).onclick=openSettings;
  q('.omin',panel).onclick=()=>{if(INLINE_MODE)return;panel.style.display='none';launch.style.display='block'};
  q('.sclose',panel).onclick=closeSettings;
  q('.simpor',panel).onclick=()=>E.file.click();
  E.file.onchange=async()=>{await importFiles([...E.file.files]);E.file.value=''};
  q('.sadd',panel).onclick=addTextFavorites;
  q('.sclear',panel).onclick=clearUnitFavorites;
  q('.ox',panel).onclick=()=>{if(INLINE_MODE)return;panel.style.display='none';launch.style.display='block'};
  launch.onclick=()=>{launch.style.display='none';panel.style.display='block';applyPos();E.s.focus()};

  renderFavs();
  renderRX();
  updatePlaceholder();
  status('');
  console.info('[OM30 PA] v0.4.0 carregada para',UNIT);
})();