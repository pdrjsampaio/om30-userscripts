// ==UserScript==
// @name         OM30 | Terapia CAPS - Procedimentos RAAS e BPA nas tabelas
// @namespace    https://om30.com.br/
// @version      2.0.6
// @description  Listas RAAS/BPA com inclusao nativa automatica, preservando botoes e formularios originais do Saude Simples.
// @author       OM30
// @match        https://guaruja.saudesimples.net/sessoes_terapia_ocupacional/*/prontuario_terapia_ocupacional/*
// @match        https://guarujahomolog.saudesimples.net/sessoes_terapia_ocupacional/*/prontuario_terapia_ocupacional/*
// @updateURL    https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Terapia-CAPS-RAAS-BPA.user.js
// @downloadURL  https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Terapia-CAPS-RAAS-BPA.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
  OM30 Terapia CAPS 2.0.6
  - Interface dentro do portlet correto, ANTES do conteudo nativo; nunca dentro da tabela.
  - Exibe a tabela da agenda e o formulario nativo RAAS/BPA, com classificacao/local/CID.
  - Nenhum campo, botao, linha ou controle nativo e removido, ocultado ou substituido.
  - Clique no procedimento e INCLUA via TokenInput('add'), SEM selecionar sugestoes
    ou abrir o dropdown. Usa o ID interno retornado pelas APIs do modulo
    (search_raas.json / search.json), como o script OM30 Odonto do GitHub.
  - Botoes nativos CONFIRMADOS no diagnostico do prontuario:
    RAAS: #raas_adicional_incluir
    BPA: a[onclick*="add_procedimentos_lancamentos_bpa_temporarios_fields"]
    Ambos continuam disponiveis e clicaveis para inclusao manual.
    Se a API nao retornar o codigo exato, NAO inventa ID nem adiciona incorreto.
  - BPA usa primeiro o campo confirmado no modulo de Terapia:
    #prontuario_procedimento_faturamento. O #prontuario_procedimento_token
    usado no script PA/Odonto sera apenas fallback quando o outro nao existir.
  - Reconhece procedimentos JA incluidos pelo codigo OU nome oficial, sem repetir inclusao.
  - Nao exige interacao com autocomplete; busca API direta + fallback quando necessario.
  - A lista JA É o acesso rápido: sem estrelas, favoritos ou filtros extras.
  - Para acrescentar codigo novo, a area "Adicionar procedimento" mostra o
    PROPRIO TokenInput do Saude Simples, temporariamente reposicionado ali.
    As buscas/sugestoes sao 100% as nativas, sem requisicoes paralelas/404.
    Ao fechar o cadastro o controle e recolocado na posicao original.
    Selecionar uma sugestao real e clicar "Adicionar à lista".
    NAO aciona o botao +Incluir, nao cria lancamento, e remove somente o token
    que foi selecionado para este cadastro, restaurando o campo nativo.
  - Limpeza unica nesta versao do armazenamento de extras RAAS/BPA das
    versoes anteriores; os 16 itens originais permanecem inalterados.
  - A partir da segunda execucao, extras novos sao mantidos no navegador.
  - Nao altera evolucao, nao salva, nao finaliza, nao envia POST proprio.
  - Conferir faturamento gravado no modulo de producao apos o salvamento manual.
  - Os 16 codigos da foto sao uma LISTA DE APOIO. Aplicabilidade depende do CNES,
    CBO, competencia e habilitacao do CAPS Infantil. O acolhimento noturno da foto
    tinha codigo divergente; conferir habilitacao antes do uso.
  - Diagnostico seguro: OM30_Terapia_Debug() / OM30_Terapia_CopiarDebug()
*/
(() => {
  'use strict';
  const VERSION='2.0.6';
  const KEY='__OM30_TERAPIA_RAAS_BPA__';
  const STYLE_ID='om30-terapia-206-style';
  const MOUNT_CLASS='om30-caps-v200';
  const CUSTOM_KEY='om30:terapia-caps:procedimentos:validados:v203'; // extras cadastrados por busca nativa
  const RESET_MARKER='om30:terapia-caps:extras-limpos:v206';
  // Pedido do usuario: limpar os dois procedimentos extras que foram testados.
  // Exclusivamente esta lista customizada RAAS/BPA, sem limpar o localStorage inteiro.
  // Executa UMA vez: os novos codigos cadastrados na v2.0.6 persistem normalmente.
  try {
    if(localStorage.getItem(RESET_MARKER)!=='1'){
      localStorage.removeItem(CUSTOM_KEY);
      localStorage.setItem(RESET_MARKER,'1');
      console.info('[OM30 Terapia] Lista adicional RAAS/BPA anterior limpa uma única vez. Os 16 padrões permanecem.');
    }
  } catch(e) {
    console.warn('[OM30 Terapia] Não foi possível concluir a limpeza automática dos extras.',e);
  }
  const PATH=/^\/sessoes_terapia_ocupacional\/\d+\/prontuario_terapia_ocupacional\/(?:new|edit)(?:\/|$)/i;
  if (!PATH.test(location.pathname)) {
    console.warn('[OM30 Terapia] Execute na tela de prontuario /new ou /edit.');
    return;
  }
  // Desliga observers/intervalos da versao anterior para nao reaparecerem.
  try { window[KEY]?.destruir?.(); } catch(e) { console.warn('[OM30 Terapia] Versao anterior:',e); }
  document.querySelectorAll('.om30-caps-selector-row, #om30-terapia-raas-bpa, .om30-caps-v130, .om30-caps-v140, .om30-caps-v150, .om30-caps-v160, .om30-caps-v170, .om30-caps-v180, .om30-caps-v190, .'+MOUNT_CLASS).forEach(el=>el.remove());
  ['om30-terapia-raas-bpa-css','om30-terapia-131-style','om30-terapia-130-style','om30-terapia-140-style','om30-terapia-150-style','om30-terapia-160-style','om30-terapia-170-style','om30-terapia-180-style','om30-terapia-190-style','om30-terapia-204-style','om30-terapia-205-style',STYLE_ID].forEach(id=>document.getElementById(id)?.remove());

  const $=window.jQuery;
  const sel=(s,root=document)=>root.querySelector(s);
  const all=(s,root=document)=>[...root.querySelectorAll(s)];
  const str=x=>String(x??'').replace(/\s+/g,' ').trim();
  const norm=x=>str(x).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toUpperCase();
  const digits=x=>String(x??'').replace(/\D/g,'');
  const wait=ms=>new Promise(ok=>setTimeout(ok,ms));

  const PADRAO=[
    ['RAAS','0301080208','Atendimento individual de paciente em CAPS'],
    ['RAAS','0301080020','Acolhimento noturno de paciente em CAPS'],
    ['RAAS','0301080194','Acolhimento diurno de paciente em CAPS'],
    ['RAAS','0301080216','Atendimento em grupo de paciente em CAPS'],
    ['RAAS','0301080224','Atendimento familiar em CAPS'],
    ['RAAS','0301080240','Atendimento domiciliar em CAPS e/ou familiares'],
    ['RAAS','0301080275','Práticas corporais em CAPS'],
    ['RAAS','0301080283','Práticas expressivas e comunicativas em CAPS'],
    ['RAAS','0301080291','Atenção às situações de crise'],
    ['RAAS','0301080348','Ações de reabilitação psicossocial'],
    ['RAAS','0301080356','Promoção de contratualidade no território'],
    ['BPA','0301080267','Fortalecimento do protagonismo de usuários e familiares'],
    ['BPA','0301080305','Matriciamento de equipes da Atenção Básica'],
    ['BPA','0301080232','Acolhimento inicial por CAPS'],
    ['BPA','0301080259','Ações de articulação de redes intra e intersetoriais'],
    ['BPA','0301080313','Ações de redução de danos']
  ].map(([grupo,codigo,nome])=>({grupo,codigo,nome,padrao:true}));
  const FIELDS={
    RAAS:{id:'#raas_adicional_procedimento_token',vis:'#token-input-raas_adicional_procedimento_token',candidatos:['#raas_adicional_procedimento_token'],rota:'/procedimentos/search_raas.json'},
    BPA:{id:'#prontuario_procedimento_faturamento',vis:'#token-input-prontuario_procedimento_faturamento',candidatos:['#prontuario_procedimento_faturamento','#prontuario_procedimento_token'],rota:'/procedimentos/search.json'}
  };
  // Nenhum ID interno hardcoded: IDs podem variar por ambiente ou competencia.
  const state={
    busy:false,custom:[],mounts:{RAAS:null,BPA:null},observer:null,timer:null,refreshTimeout:0,
    apiLog:[],last:{RAAS:'',BPA:''},destroyed:false,requests:[],procedureCache:new Map(),
    revealed:{RAAS:false,BPA:false},borrowed:{RAAS:null,BPA:null},
    customSearch:{RAAS:{seq:0,timer:0,selected:null,ctrl:null},BPA:{seq:0,timer:0,selected:null,ctrl:null}}
  };
  try {
    const data=JSON.parse(localStorage.getItem(CUSTOM_KEY)||'[]');
    if(Array.isArray(data))state.custom=data.filter(p=>/^(RAAS|BPA)$/.test(p?.grupo)&&/^\d{10}$/.test(p?.codigo)&&typeof p?.nome==='string'&&p.validado===true).slice(0,100);
  } catch(_) {}
  const lista=grupo=>[...PADRAO,...state.custom.filter(p=>!PADRAO.some(x=>x.grupo===p.grupo&&x.codigo===p.codigo))].filter(p=>p.grupo===grupo);
  function gravarExtras(){
    try{localStorage.setItem(CUSTOM_KEY,JSON.stringify(state.custom));return true;}
    catch(e){console.warn('[OM30 Terapia] Nao foi possivel guardar a lista adicional.',e);return false;}
  }

  const css=document.createElement('style');
  css.id=STYLE_ID;
  css.textContent=`
    .${MOUNT_CLASS},.${MOUNT_CLASS} *{box-sizing:border-box!important}
    tr.${MOUNT_CLASS}-row>td{padding:10px!important;background:#fff!important;text-align:left!important;vertical-align:top!important;border-bottom:1px solid #e9e9ed!important}
    .${MOUNT_CLASS}{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Arial,sans-serif!important;font-size:12px!important;line-height:1.45!important;color:#27272a!important;max-width:100%;background:#fff!important;border:1px solid #e5e7eb!important;border-radius:12px!important;padding:13px!important;box-shadow:none!important}
    .${MOUNT_CLASS} button,.${MOUNT_CLASS} input{font-family:inherit!important;box-shadow:none!important;text-transform:none!important;letter-spacing:normal!important}
    .${MOUNT_CLASS} .om30-head{display:flex!important;align-items:center!important;justify-content:space-between!important;gap:9px!important;margin:0 0 12px!important}
    .${MOUNT_CLASS} .om30-title{font-size:13px!important;line-height:1.4!important;font-weight:650!important;color:#18181b!important;margin:0!important}
    .${MOUNT_CLASS} .om30-tag{font-size:10px!important;background:#f4f4f5!important;color:#52525b!important;border:1px solid #e4e4e7!important;border-radius:999px!important;padding:4px 8px!important;white-space:nowrap!important;font-weight:500!important}
    .${MOUNT_CLASS} .om30-search{display:block!important;width:100%!important;height:38px!important;padding:8px 11px!important;margin:0 0 11px!important;border:1px solid #dcdce1!important;border-radius:9px!important;background:#fff!important;color:#27272a!important;font-size:12px!important;outline:none!important}
    .${MOUNT_CLASS} .om30-search:focus{border-color:#81818a!important;box-shadow:0 0 0 2px #f2f2f4!important}
    .${MOUNT_CLASS} .om30-grid{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:8px!important;max-height:245px!important;overflow-y:auto!important;overflow-x:hidden!important;padding:2px!important;align-items:stretch!important}
    .${MOUNT_CLASS} .om30-proc{display:grid!important;grid-template-columns:87px minmax(0,1fr)!important;gap:2px 10px!important;align-items:start!important;justify-content:initial!important;min-width:0!important;min-height:56px!important;width:100%!important;margin:0!important;padding:10px 11px!important;text-align:left!important;border:1px solid #e4e4e7!important;border-radius:10px!important;background:#fff!important;color:#27272a!important;cursor:pointer!important;transition:background .12s,border-color .12s!important}
    .${MOUNT_CLASS} .om30-proc:hover:not(:disabled){background:#f7f7f8!important;border-color:#a9a9b1!important}
    .${MOUNT_CLASS} .om30-proc.om30-included{order:-1!important}
    .${MOUNT_CLASS} .om30-proc:focus-visible{outline:2px solid #66666e!important;outline-offset:1px!important}
    .${MOUNT_CLASS} .om30-proc:disabled:not(.om30-included){opacity:.5!important;cursor:wait!important}
    .${MOUNT_CLASS} .om30-proc.om30-included{background:#f4f9f6!important;border-color:#c7dfd0!important;cursor:default!important;opacity:1!important}
    .${MOUNT_CLASS} .om30-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace!important;font-size:11px!important;font-weight:650!important;line-height:1.5!important;white-space:nowrap!important;letter-spacing:-.1px!important;color:#52525b!important;display:block!important;padding-top:1px!important;min-width:0!important}
    .${MOUNT_CLASS} .om30-name{font-family:inherit!important;font-size:12px!important;line-height:1.45!important;font-weight:500!important;display:block!important;color:#29292d!important;min-width:0!important;overflow-wrap:break-word!important;word-break:normal!important;white-space:normal!important;letter-spacing:0!important}
    .${MOUNT_CLASS} .om30-included .om30-code{color:#276749!important}
    .${MOUNT_CLASS} .om30-done{grid-column:2!important;grid-row:2!important;display:block!important;color:#276749!important;font-size:10px!important;font-weight:650!important;margin:3px 0 0!important;white-space:nowrap!important}
    .${MOUNT_CLASS} .om30-extra{margin:12px 0 0!important;padding:10px 0 0!important;border-top:1px solid #ededf0!important}
    .${MOUNT_CLASS} .om30-extra summary{font-size:11.5px!important;line-height:1.5!important;color:#3f3f46!important;cursor:pointer!important;font-weight:500!important;list-style:disclosure-closed!important}
    .${MOUNT_CLASS} .om30-extra[open] summary{list-style:disclosure-open!important}
    .${MOUNT_CLASS} .om30-extra-inner{display:flex!important;gap:7px!important;align-items:center!important;flex-wrap:wrap!important;margin-top:10px!important}
    .${MOUNT_CLASS} .om30-extra-input{flex:1 1 160px!important;min-width:130px!important;width:auto!important;height:36px!important;padding:8px 9px!important;border:1px solid #dcdce1!important;border-radius:8px!important;background:#fff!important;font-size:11px!important}
    .${MOUNT_CLASS} .om30-candidates{display:grid!important;grid-template-columns:1fr!important;gap:5px!important;max-height:180px!important;overflow:auto!important;margin:8px 0!important;padding:0!important}
    .${MOUNT_CLASS} .om30-candidate{display:grid!important;grid-template-columns:90px minmax(0,1fr)!important;gap:10px!important;align-items:start!important;text-align:left!important;font:inherit!important;border:1px solid #e4e4e7!important;border-radius:8px!important;background:#fff!important;color:#27272a!important;padding:9px 10px!important;cursor:pointer!important;width:100%!important;min-width:0!important;line-height:1.45!important}
    .${MOUNT_CLASS} .om30-candidate:hover{background:#f7f7f8!important;border-color:#a9a9b1!important}
    .${MOUNT_CLASS} .om30-candidate[aria-pressed="true"]{background:#eff6f3!important;border-color:#73a78d!important}
    .${MOUNT_CLASS} .om30-candidate-code{font:600 11px/1.5 Consolas,monospace!important;color:#4b5563!important}
    .${MOUNT_CLASS} .om30-candidate-name{overflow-wrap:break-word!important;white-space:normal!important;font-size:11.5px!important}
    .${MOUNT_CLASS} .om30-query-status{color:#71717a!important;font-size:11px!important;margin:6px 0!important}
    .${MOUNT_CLASS} .om30-native-slot{display:block!important;min-height:37px!important;width:100%!important;margin-top:9px!important;overflow:visible!important;position:relative!important}
    .${MOUNT_CLASS} .om30-native-slot .om30-native-token-moved{display:block!important;width:100%!important;min-height:36px!important;margin:0!important;list-style:none!important;border:1px solid #dcdce1!important;border-radius:8px!important;padding:4px 8px!important;background:#fff!important}
    .${MOUNT_CLASS} .om30-native-slot input[id^="token-input-"]{display:inline-block!important;min-height:25px!important;max-width:100%!important;font-size:12px!important;outline:none!important}
    .${MOUNT_CLASS} .om30-native-slot .token-input-input-token{float:none!important;display:inline-block!important;max-width:100%!important}
    .${MOUNT_CLASS} .om30-native-slot .token-input-token{display:inline-block!important;max-width:100%!important}
    .${MOUNT_CLASS} .om30-native-slot .token-input-dropdown{z-index:2147483300!important}

    .${MOUNT_CLASS} .om30-validated{font-size:11px!important;color:#276749!important;margin:7px 0!important}
    .${MOUNT_CLASS} .om30-add:disabled{background:#a1a1aa!important;cursor:not-allowed!important}
    .${MOUNT_CLASS} .om30-add{background:#252528!important;color:#fff!important;border:0!important;border-radius:8px!important;padding:9px 12px!important;cursor:pointer!important;font-weight:600!important;font-size:11px!important;min-height:35px!important;width:auto!important}
    .${MOUNT_CLASS} .om30-hint{font-size:10.5px!important;line-height:1.45!important;color:#71717a!important;margin:7px 0 0!important}
    .${MOUNT_CLASS} .om30-status{font-size:11px!important;line-height:1.5!important;color:#62626a!important;margin:11px 0 0!important;min-height:0!important;padding:9px 10px!important;border:1px solid #ebebed!important;border-radius:8px!important;background:#fafafa!important;white-space:pre-wrap!important}
    .${MOUNT_CLASS} .om30-status.ok{color:#276749!important;background:#f5faf6!important;border-color:#dcebe1!important}
    .${MOUNT_CLASS} .om30-status.warn{color:#855b15!important;background:#fffcf4!important;border-color:#efe3c4!important}
    .${MOUNT_CLASS} .om30-status.error{color:#a12d2d!important;background:#fff8f8!important;border-color:#f1dfe0!important}
    .${MOUNT_CLASS} .om30-status.busy{color:#1c597d!important;background:#f5f9fc!important;border-color:#e1eaf0!important}
    .${MOUNT_CLASS} .om30-empty{font-size:11.5px!important;color:#71717a!important;padding:9px!important}
    .${MOUNT_CLASS}-placeholder{margin:10px 12px 12px!important;clear:both!important}
    @media(max-width:1000px){.${MOUNT_CLASS} .om30-grid{grid-template-columns:1fr!important}}
  `;
  document.head.appendChild(css);

  function visivel(el){
    // Evita inserir na tabela de um modal fechado, template ou aba escondida.
    if(!el||!el.isConnected)return false;
    for(let p=el;p&&p.nodeType===1;p=p.parentElement){
      if(p.hidden||p.getAttribute('aria-hidden')==='true'||p.tagName==='TEMPLATE')return false;
      const c=getComputedStyle(p);
      if(c.display==='none'||c.visibility==='hidden'||c.visibility==='collapse')return false;
    }
    return !!el.getClientRects().length;
  }
  function nativeTable(grupo,onlyVisible=true){
    const scored=[];
    for(const t of all('table')){
      if(t.closest('.'+MOUNT_CLASS)||t.closest('template'))continue;
      if(onlyVisible&&!visivel(t))continue;
      const heads=all('th',t).filter(h=>h.closest('table')===t).map(h=>norm(h.textContent));
      if(!heads.some(h=>h.includes('PROCEDIMENTO')))continue;
      const txt=heads.join('|');
      const label=norm([t.id,t.className,t.parentElement?.id,t.parentElement?.className].join(' '));
      let score=0;
      if(heads.some(h=>h.includes('PROFISSIONAL')))score+=20;
      if(grupo==='RAAS'){
        if(txt.includes('CLASSIFICACAO'))score+=100;
        if(txt.includes('LOCAL'))score+=45;
        if(txt.includes('CID'))score-=120;
      }else{
        if(txt.includes('CID'))score+=120;
        if(txt.includes('CLASSIFICACAO'))score-=120;
        if(txt.includes('LOCAL')&&!txt.includes('CID'))score-=60;
      }
      if(label.includes(grupo))score+=20;
      if(score<=20)continue;
      const section=t.closest('section,fieldset,.panel,.card,.box,.accordion-body');
      if(section&&norm(section.textContent.slice(0,250)).includes('FATURAMENTO '+grupo))score+=30;
      scored.push({t,score});
    }
    scored.sort((a,b)=>b.score-a.score);
    return scored[0]?.t||null;
  }
  function heading(grupo){
    const wanted='FATURAMENTO '+grupo;
    const nodes=all('h2,h3,h4,h5,h6,legend,.panel-heading,.panel-title,.box-header,.accordion-heading,a,span,strong,div')
      .filter(el=> !el.closest('.'+MOUNT_CLASS) && visivel(el) && el.children.length<6 &&
        norm(el.textContent).includes(wanted) && str(el.textContent).length<95);
    nodes.sort((a,b)=>{
      const aa=norm(a.textContent)===wanted?0:1,bb=norm(b.textContent)===wanted?0:1;
      return aa-bb||str(a.textContent).length-str(b.textContent).length;
    });
    return nodes[0]||null;
  }
  function bpaAnchor(){
    // Diferente do RAAS, o BPA com zero lancamentos NAO possui tabela nativa.
    // O ponto fixo e o proprio painel "FATURAMENTO BPA" que contem os campos.
    const field=sel('#prontuario_procedimento_faturamento') || sel('#token-input-prontuario_procedimento_faturamento');
    const wanted='FATURAMENTO BPA';
    const hs=all('h2,h3,h4,h5,h6,legend,.panel-heading,.panel-title,.box-header,.accordion-heading,a,span,strong,div')
      .filter(el=>!el.closest('.'+MOUNT_CLASS) && !el.closest('.'+MOUNT_CLASS+'-placeholder') &&
        visivel(el) && norm(el.textContent)===wanted);
    hs.sort((a,b)=>{
      const aa=a.closest('.panel,.box,.card,fieldset')?.contains(field)?1:0;
      const bb=b.closest('.panel,.box,.card,fieldset')?.contains(field)?1:0;
      return bb-aa || a.textContent.length-b.textContent.length;
    });
    if(hs.length){
      const head=hs[0].closest('.panel-heading,.box-header,.accordion-heading,.panel-title')||hs[0];
      return {type:'afterHeader',element:head};
    }
    if(field){
      // Ultimo recurso: inserir ANTES do formulario, nunca embaixo da tabela RAAS.
      const quantity=sel('#prontuario_quantidade_procedimento_faturamento');
      const raas=sel('#raas_adicional_procedimento_token');
      let node=field.parentElement;
      let candidate=field.parentElement;
      for(let i=0;i<7&&node&&node!==document.body;i++,node=node.parentElement){
        if(raas&&node.contains(raas))break;
        if(quantity&&node.contains(quantity)){candidate=node;break;}
        if(node.matches('.row,.form-row,.panel-body,.fields'))candidate=node;
      }
      return {type:'beforeForm',element:candidate};
    }
    return null;
  }

  function nativeAnchor(grupo){
    if(grupo==='BPA')return bpaAnchor();
    // Tabela VISIVEL tem prioridade absoluta: nunca colocar seletor em template oculto.
    const table=nativeTable(grupo,true);
    if(table)return {type:'table',element:table};
    // Quando a tabela BPA ainda nao foi criada, ancorar no titulo da secao.
    const h=heading(grupo);
    if(h)return {type:'heading',element:h};
    const input=FIELDS[grupo].candidatos.map(x=>sel(x)).find(Boolean);
    if(input){
      let wrap=input.parentElement;
      while(wrap&&wrap!==document.body&&!visivel(wrap))wrap=wrap.parentElement;
      if(wrap&&wrap!==document.body)return {type:'field',element:wrap};
    }
    if(grupo==='BPA'){
      // Garantia visual: caso o sistema ainda nao tenha desenhado o BPA,
      // o seletor fica temporariamente APOS a tabela RAAS, nunca dentro dela.
      const raas=nativeTable('RAAS',true);
      if(raas)return {type:'fallback',element:raas};
    }
    return null;
  }

  function setStatus(grupo,msg,tipo=''){
    state.last[grupo]=msg;
    const status=state.mounts[grupo]?.querySelector('.om30-status');
    if(status){status.textContent=msg;status.className='om30-status '+tipo;}
    console.info('[OM30 Terapia '+grupo+'] '+msg);
  }

  function renderOptions(grupo){
    const holder=state.mounts[grupo];
    if(!holder)return;
    const search=sel('.om30-search',holder);
    const list=sel('.om30-grid',holder);
    const term=norm(search?.value);
    const items=lista(grupo).filter(p=>norm(p.codigo+' '+p.nome).includes(term))
      .sort((a,b)=>Number(!!rowByCode(grupo,b.codigo))-Number(!!rowByCode(grupo,a.codigo)));
    list.replaceChildren();
    for(const p of items){
      const btn=document.createElement('button');
      btn.type='button';btn.className='om30-proc';btn.dataset.codigo=p.codigo;
      btn.title=p.codigo+' – '+p.nome;
      const code=document.createElement('span');code.className='om30-code';code.textContent=p.codigo;
      const name=document.createElement('span');name.className='om30-name';name.textContent=p.nome;
      btn.append(code,name);
      const inserted=!!rowByCode(grupo,p.codigo);
      btn.dataset.included=String(inserted);
      if(inserted){
        btn.classList.add('om30-included');
        const badge=document.createElement('span');badge.className='om30-done';badge.textContent='✓ Incluído';btn.appendChild(badge);
      }
      btn.disabled=state.busy||inserted;
      btn.addEventListener('click',()=>incluir({...p}));
      list.appendChild(btn);
    }
    if(!items.length){const empty=document.createElement('div');empty.className='om30-empty';empty.textContent='Nenhum procedimento encontrado para esta busca.';list.appendChild(empty);}
    const count=sel('.om30-tag',holder);if(count)count.textContent=lista(grupo).length+' procedimentos';
  }

  function atualizarIncluidos(grupo){
    const ui=state.mounts[grupo];if(!ui?.isConnected)return;
    for(const btn of all('.om30-proc',ui)){
      const yes=!!rowByCode(grupo,btn.dataset.codigo);
      if(btn.dataset.included===String(yes))continue;
      btn.dataset.included=String(yes);
      btn.classList.toggle('om30-included',yes);
      const old=sel('.om30-done',btn);if(old)old.remove();
      if(yes){const tag=document.createElement('span');tag.className='om30-done';tag.textContent='✓ Incluído';btn.appendChild(tag);}
      btn.disabled=state.busy||yes;
    }
  }
  function createUI(grupo){
    const ui=document.createElement('section');
    ui.className=MOUNT_CLASS;ui.dataset.grupo=grupo;
    ui.innerHTML=`
      <div class="om30-head"><div class="om30-title">Selecionar procedimento · ${grupo}</div><span class="om30-tag"></span></div>
      <input class="om30-search" type="search" placeholder="Buscar por procedimento ou código SIGTAP" aria-label="Buscar procedimento ${grupo}" autocomplete="off">
      <div class="om30-grid"></div>
      <details class="om30-extra">
        <summary>Adicionar procedimento à lista ${grupo}</summary>
        <div class="om30-hint">Pesquise e selecione um procedimento válido na busca oficial. Ele será salvo apenas nesta lista, sem lançamento no atendimento.</div>
        <div class="om30-native-slot" aria-label="Pesquisa oficial de procedimentos ${grupo}"></div>
        <div class="om30-query-status" role="status">Digite no campo acima para pesquisar.</div>
        <div class="om30-validated" aria-live="polite"></div>
        <button class="om30-add" type="button" disabled>Adicionar à lista ${grupo}</button>
      </details>
      <div class="om30-status">Clique em um procedimento para incluí-lo na tabela ${grupo}.</div>
      `;
    ui.addEventListener('keydown',e=>{if(e.key==='Enter' && e.target.tagName==='INPUT'){e.preventDefault();e.stopPropagation();}});
    sel('.om30-search',ui).addEventListener('input',()=>renderOptions(grupo));
    sel('details.om30-extra',ui).addEventListener('toggle', e => {
      if(e.currentTarget.open) mostrarBuscaNativaAqui(grupo);
      else restaurarBuscaNativa(grupo);
    });
    sel('.om30-add',ui).addEventListener('click',()=>incluirNovoNaLista(grupo));
    state.mounts[grupo]=ui;
    renderOptions(grupo);
    if(state.last[grupo])sel('.om30-status',ui).textContent=state.last[grupo];
    return ui;
  }

  // Cadastro adicional sem busca paralela: a única fonte de validação é
  // o resultado já selecionado no autocomplete NATIVO do Saúde Simples.
  function setBuscaExtraStatus(grupo,msg){
    const el=sel('.om30-query-status',state.mounts[grupo]);
    if(el)el.textContent=msg;
  }
  function extraAberto(grupo){
    const ui=state.mounts[grupo];
    return !!ui?.isConnected && !!sel('details.om30-extra',ui)?.open;
  }
  function lerSelecaoNativa(grupo){
    let campo;
    try{campo=tokenExists(grupo);}catch(_){return null;}
    const xs=tokenList(campo.selector);
    if(xs.length!==1)return null;
    const item=xs[0];
    const codigo=(rawCode(item).match(/\d{10}/)||[])[0] || codeFromName(item);
    const nome=rawName(item).replace(/^\s*\d{10}\s*[-–—:]?\s*/, '').trim();
    if(!/^\d{10}$/.test(codigo)||!nome || !item?.id || item.revogado===true||String(item.revogado)==='1')return null;
    return {codigo,nome,item};
  }
  function verificarListaSelecionada(grupo,p){
    if(!p)return 'Digite e selecione uma sugestão da busca oficial do Saúde Simples.';
    const outro=grupo==='RAAS'?'BPA':'RAAS';
    if(lista(outro).some(x=>x.codigo===p.codigo))return 'Este código já está na lista '+outro+'. Confira o tipo de faturamento.';
    if(lista(grupo).some(x=>x.codigo===p.codigo))return 'Este procedimento já faz parte desta lista.';
    if(state.custom.length>=100)return 'Limite de 100 códigos adicionais no navegador.';
    return '';
  }
  function sincronizarSelecao(grupo){
    if(!extraAberto(grupo))return;
    const ui=state.mounts[grupo];
    const bt=sel('.om30-add',ui);
    if(!bt)return;
    const p=lerSelecaoNativa(grupo);
    const erro=verificarListaSelecionada(grupo,p);
    const label=sel('.om30-validated',ui);
    if(label)label.textContent=p?'Selecionado: '+p.codigo+' — '+p.nome:'';
    bt.disabled=state.busy||!!erro;
    const status=sel('.om30-query-status',ui);
    // Não apagar mensagens finais de confirmação/erro enquanto o campo estiver vazio.
    if(status&&p)status.textContent=erro||'Procedimento validado pela seleção original do Saúde Simples.';
  }
  // Em vez de imitar a API, desloca SOMENTE o elemento VISUAL do
  // TokenInput ja inicializado. O input original com name/id e seus handlers
  // permanecem no formulario real do Saude Simples, bem como todos os botoes.
  // Assim a busca, sugestoes e validacao seguem a configuracao nativa exata.
  function mostrarBuscaNativaAqui(grupo){
    const ui=state.mounts[grupo];
    const slot=sel('.om30-native-slot',ui);
    if(!slot)return;
    if(state.borrowed[grupo]?.node?.isConnected){
      slot.appendChild(state.borrowed[grupo].node);
      return;
    }
    // Nunca mover a busca de um grupo para o cadastro do outro.
    const outro=grupo==='RAAS'?'BPA':'RAAS';
    if(state.borrowed[outro]){
      restaurarBuscaNativa(outro);
      const detalhes=sel('details.om30-extra',state.mounts[outro]);
      if(detalhes)detalhes.open=false;
    }
    try{
      const {original,visible}=tokenExists(grupo);
      if(!visible || !visible.isConnected)throw new Error('O campo de busca nativo não está montado.');
      // Não apropriar uma seleção que o profissional já deixou pendente no
      // formulário original. Nessa situação, o cadastro não pode limpá-la.
      const selNativo=tokenExists(grupo).selector;
      if(tokenList(selNativo).length){
        throw new Error('Já existe procedimento selecionado no formulário original de '+grupo+'. Inclua-o ou remova-o antes de cadastrar outro na lista.');
      }
      // jquery-tokeninput injeta #token-input-* dentro de um UL token-input-list.
      // Nunca mover o input oculto #raas_adicional_procedimento_token ou
      // #prontuario_procedimento_faturamento: eles pertencem ao formulario.
      let widget=visible.closest('ul[class*="token-input-list"],ul.token-input-list');
      if(!widget){
        const li=visible.closest('li[class*="token-input-input-token"]');
        widget=li?.parentElement?.tagName==='UL'?li.parentElement:null;
      }
      if(!widget){
        throw new Error('Não reconheci o layout nativo do autocomplete. Nenhum campo foi alterado.');
      }
      if(widget.contains(original) || !widget.parentNode){
        throw new Error('Estrutura da busca diferente da esperada. Nenhum campo foi alterado.');
      }
      const place=document.createComment('OM30 - restaurar pesquisa nativa '+grupo);
      widget.parentNode.insertBefore(place,widget);
      state.borrowed[grupo]={node:widget,place,style:widget.getAttribute('style')};
      widget.classList.add('om30-native-token-moved');
      slot.appendChild(widget);
      setBuscaExtraStatus(grupo,'Selecione uma sugestão da busca oficial do Saúde Simples.');
      // Espera a transicao do <details> concluir antes de posicionar o foco.
      setTimeout(()=>{
        if(!state.destroyed&&state.borrowed[grupo]?.node===widget&&extraAberto(grupo)){
          visible.focus();
        }
      },40);
    }catch(e){
      setBuscaExtraStatus(grupo,e.message||String(e));
      console.warn('[OM30 Terapia '+grupo+'] Busca nativa:',e);
    }
  }
  function restaurarBuscaNativa(grupo){
    const item=state.borrowed[grupo];
    if(!item)return;
    state.borrowed[grupo]=null;
    try{
      const {node,place,style}=item;
      node.classList.remove('om30-native-token-moved');
      if(style===null)node.removeAttribute('style');
      else node.setAttribute('style',style);
      if(place.parentNode)place.parentNode.replaceChild(node,place);
      else{
        const original=sel(FIELDS[grupo].id);
        if(original?.parentNode)original.parentNode.insertBefore(node,original);
      }
    }catch(e){console.error('[OM30 Terapia '+grupo+'] Restauração da busca:',e);}
  }
  // Cadastro rápido é independente do faturamento do atendimento corrente:
  // seleção válida nativa -> grava lista -> limpa SOMENTE o token deste cadastro.
  // Jamais chama o botão nativo +Incluir ou escreve linhas no prontuário.
  function adicionarSomenteNaLista(grupo){
    if(state.busy)return;
    if(!state.borrowed[grupo]){
      setBuscaExtraStatus(grupo,'Abra a pesquisa nativa desta seção e selecione um resultado antes de adicionar.');
      return;
    }
    const p=lerSelecaoNativa(grupo);
    const erro=verificarListaSelecionada(grupo,p);
    if(erro){setBuscaExtraStatus(grupo,erro);return;}
    // Confere novamente que a seleção é a única presente no campo original.
    // Não permite cadastro com texto digitado que não virou token real.
    const field=tokenExists(grupo);
    const atuais=tokenList(field.selector);
    if(atuais.length!==1 ||
       !(rawCode(atuais[0])===p.codigo || codeFromName(atuais[0])===p.codigo)){
      setBuscaExtraStatus(grupo,'Seleção inválida: escolha um resultado real na busca do Saúde Simples.');
      return;
    }
    const novo={grupo,codigo:p.codigo,nome:p.nome,validado:true};
    state.custom.push(novo);
    if(!gravarExtras()){
      state.custom.pop();
      setBuscaExtraStatus(grupo,'Não foi possível salvar a lista no navegador. Nenhum lançamento foi realizado.');
      return;
    }
    // A informação retornada pela busca nativa também agiliza o uso posterior.
    OFICIAIS[p.codigo]=p.nome;
    state.procedureCache.set(grupo+':'+p.codigo,p.item);
    renderOptions(grupo);
    try {
      // O token foi selecionado EXCLUSIVAMENTE para o cadastro auxiliar.
      // Esvaziá-lo impede que entre acidentalmente no atendimento ao salvar.
      $(field.selector).tokenInput('clear');
      if(tokenList(field.selector).length){
        throw new Error('O Saúde Simples manteve o token selecionado após a limpeza.');
      }
      cleanNativeSearch(field.visible);
    } catch(e) {
      console.warn('[OM30 Terapia '+grupo+'] Procedimento salvo na lista, mas a limpeza do token não foi confirmada:',e);
      setBuscaExtraStatus(grupo,'✓ Salvo na lista. Atenção: remova manualmente a seleção do campo nativo antes de salvar o atendimento.');
      return;
    }
    restaurarBuscaNativa(grupo);
    const details=sel('details.om30-extra',state.mounts[grupo]);
    if(details)details.open=false;
    setStatus(grupo,'✓ '+p.codigo+' adicionado à lista '+grupo+'. Nenhum procedimento foi lançado no atendimento.','ok');
    setBuscaExtraStatus(grupo,'✓ Adicionado somente à lista de '+grupo+'.');
  }
  function incluirNovoNaLista(grupo){
    adicionarSomenteNaLista(grupo);
  }
  // +Incluir original não tem qualquer efeito nos itens salvos na lista.
  // O sistema continua com seu próprio formulário de faturamento, intacto.
  // CONFIRMADO: ambos os faturamentos ficam em portlets distintos. Inserimos
  // exclusivamente uma interface auxiliar ANTES do .portlet-content; jamais
  // dentro das linhas da tabela nativa, que podem vir prontas da agenda.
  function portletNativo(grupo){
    const id=FIELDS[grupo].id;
    const field=sel(id);
    if(!field)return null;
    const portlet=field.closest('.portlet');
    if(!portlet||!portlet.querySelector('.portlet-content'))return null;
    if(portlet.querySelector(FIELDS[grupo==='RAAS'?'BPA':'RAAS'].id))return null;
    return portlet;
  }
  function conteudoNativo(grupo){
    return portletNativo(grupo)?.querySelector('.portlet-content')||null;
  }
  function formularioVisivel(grupo){
    const body=conteudoNativo(grupo);
    return !!body && !body.hidden && getComputedStyle(body).display!=='none';
  }
  function abrirFormularioNativo(grupo){
    const body=conteudoNativo(grupo);
    if(!body)return false;
    // Somente reabre o proprio corpo; nao mexe nos campos, registros, eventos,
    // IDs, opcoes, links ou formularios originais.
    body.hidden=false;
    if(getComputedStyle(body).display==='none'){
      body.style.display='block';
    }
    return true;
  }
  function attach(grupo){
    const portlet=portletNativo(grupo);
    if(!portlet)return false;
    let ui=state.mounts[grupo];
    if(!ui)ui=createUI(grupo);
    let slot=portlet.querySelector('.'+MOUNT_CLASS+'-placeholder[data-grupo="'+grupo+'"]');
    if(!slot){
      slot=document.createElement('div');
      slot.className=MOUNT_CLASS+'-placeholder';
      slot.dataset.grupo=grupo;
      slot.style.cssText='margin:10px 12px 12px;clear:both;';
    }
    const body=conteudoNativo(grupo);
    if(body && slot.nextElementSibling!==body)portlet.insertBefore(slot,body);
    if(ui.parentElement!==slot)slot.appendChild(ui);
    if(!state.revealed[grupo]){
      // A agenda costuma deixar o conteudo recolhido; exibir os lançamentos ja
      // existentes e o botao +Incluir manual logo abaixo do seletor OM30.
      abrirFormularioNativo(grupo);
      state.revealed[grupo]=true;
    }
    return true;
  }
  function refresh(){if(state.destroyed)return;attach('RAAS');attach('BPA');atualizarIncluidos('RAAS');atualizarIncluidos('BPA');sincronizarSelecao('RAAS');sincronizarSelecao('BPA');}

  // OM30 PA/Odonto: o TokenInput recebe um OBJETO com o id interno da API.
  // Selecionar sugestao visualmente NAO faz parte da inclusao automatica.
  const rawCode=x=>digits(x?.codigo||x?.codigo_externo||x?.id_externo||'');
  const rawName=x=>str(x?.nome||x?.descricao||x?.name||'');
  const parseItems=x=>Array.isArray(x)?x:(Array.isArray(x?.results)?x.results:(Array.isArray(x?.data)?x.data:[]));
  const codeFromName=x=>str(x?.name||x?.nome).match(/\b\d{10}\b/)?.[0]||'';
  const exactItem=(xs,proc)=>parseItems(xs).find(x=>
    (rawCode(x)===proc.codigo||codeFromName(x)===proc.codigo)&&
    x.id!==undefined&&x.id!==null&&String(x.id).length&&
    x.revogado!==true&&String(x.revogado)!=='1');

  function tokenList(id){try{const xs=$(id).tokenInput('get');return Array.isArray(xs)?xs:(xs?[xs]:[]);}catch{return[];}}
  function tokenSelected(id,code){return tokenList(id).some(x=>rawCode(x)===code||codeFromName(x)===code);}
  function nativeTokenSettings(el){
    if(!$||!el)return {};
    const obj=$(el).data('tokenInputObject');
    return obj?.settings||$(el).data('settings')||{};
  }
  function tokenExists(grupo){
    if(!$||typeof $.fn?.tokenInput!=='function')throw new Error('TokenInput nativo do Saúde Simples indisponível.');
    const cfg=FIELDS[grupo];
    const candidates=cfg.candidatos.map(selector=>({selector,el:sel(selector)})).filter(x=>x.el && !x.el.disabled);
    if(!candidates.length)throw new Error('Campo de faturamento '+grupo+' não encontrado no prontuário.');
    // BPA de Terapia: procedimento_faturamento foi confirmado no diagnostico;
    // procedimento_token é usado no PA/Odonto e nao deve substitui-lo se presente.
    candidates.sort((a,b)=>Number(b.selector===cfg.id)-Number(a.selector===cfg.id));
    const item=candidates[0];
    return {original:item.el,selector:item.selector,cfg,visible:sel('#token-input-'+item.el.id)};
  }
  function appendRequestLog(grupo,rota,status,count){
    state.apiLog.push({grupo,rota,status,total:count});
    if(state.apiLog.length>35)state.apiLog.shift();
  }
  // O plugin TokenInput no prontuario utiliza XHR. Capturamos apenas resultados
  // das duas APIs de procedimentos, SEM armazenar dados do atendimento.
  const oldOpen=XMLHttpRequest.prototype.open;
  const oldSend=XMLHttpRequest.prototype.send;
  const xhrRoutes=new WeakMap();
  const xhrOpenWrapper=function(method,url,...args){
    try{const u=new URL(url,location.origin);if(u.origin===location.origin&&
      /^\/procedimentos\/(?:search_raas|search)\.json$/i.test(u.pathname))xhrRoutes.set(this,u.pathname);
    }catch(_){}
    return oldOpen.call(this,method,url,...args);
  };
  const xhrSendWrapper=function(...args){
    const path=xhrRoutes.get(this);
    if(path){
      this.addEventListener('loadend',()=>{
        try{
          if(this.status!==200||this.responseType&&this.responseType!=='text'&&this.responseType!=='json')return;
          const data=this.responseType==='json'?this.response:JSON.parse(this.responseText);
          const list=parseItems(data);
          state.requests.push({rota:path,at:Date.now(),items:list});
          if(state.requests.length>15)state.requests.shift();
          appendRequestLog(path.includes('raas')?'RAAS':'BPA',path,200,list.length);
        }catch(_){}
      },{once:true});
    }
    return oldSend.apply(this,args);
  };
  XMLHttpRequest.prototype.open=xhrOpenWrapper;
  XMLHttpRequest.prototype.send=xhrSendWrapper;

  async function fetchResults(url,grupo){
    let status=0;
    try{
      const ctrl=new AbortController();const timeout=setTimeout(()=>ctrl.abort(),2100);
      let response;
      try{response=await fetch(url,{credentials:'same-origin',signal:ctrl.signal,headers:{
        'Accept':'application/json, text/javascript, */*; q=0.01','X-Requested-With':'XMLHttpRequest'
      }});}finally{clearTimeout(timeout);}
      status=response.status;
      if(!response.ok){appendRequestLog(grupo,new URL(url,location.href).pathname,status,0);return [];}
      const xs=parseItems(await response.json());
      appendRequestLog(grupo,new URL(url,location.href).pathname,status,xs.length);
      return xs;
    }catch(e){appendRequestLog(grupo,new URL(url,location.href).pathname,status||'erro',0);return [];}
  }
  async function buscarDireto(proc,original){
    const cfg=FIELDS[proc.grupo], settings=nativeTokenSettings(original);
    // Usar o endpoint CONFIRMADO nos diagnosticos: RAAS search_raas.json,
    // BPA search.json. Uma busca com o queryParam nativo, sem tentar 5 URLs.
    let path=cfg.rota;
    try{
      if(settings.url){
        const url=new URL(settings.url,location.origin);
        if(url.origin===location.origin&&url.pathname===cfg.rota)path=url.pathname+url.search;
      }
    }catch(_){ }
    const u=new URL(path,location.origin);
    const query=/^[a-z_]+$/i.test(settings.queryParam||'')?settings.queryParam:'q';
    u.searchParams.set(query,proc.codigo);
    const xs=await fetchResults(u.toString(),proc.grupo);
    // Os demais codigos retornados pela mesma consulta tambem podem ser reutilizados.
    for(const p of lista(proc.grupo)){
      const candidate=exactItem(xs,p);
      if(candidate)state.procedureCache.set(p.grupo+':'+p.codigo,candidate);
    }
    return exactItem(xs,proc);
  }
  function triggerPluginSearch(input,code){
    if(!input||!input.isConnected)return false;
    input.focus();input.value=code;
    input.dispatchEvent(new Event('input',{bubbles:true}));
    if($&&typeof $.Event==='function'){
      const ev=$.Event('keyup');ev.which=65;ev.keyCode=65;$(input).trigger(ev);
    }else input.dispatchEvent(new KeyboardEvent('keyup',{key:'a',keyCode:65,bubbles:true}));
    return true;
  }
  async function buscarPeloPlugin(proc,visible){
    const route=FIELDS[proc.grupo].rota;
    const previous=state.requests.length;
    if(!triggerPluginSearch(visible,proc.codigo))return null;
    const limit=Date.now()+1700;
    do{
      const xs=state.requests.slice(previous).filter(x=>x.rota===route);
      for(const x of xs){const found=exactItem(x.items,proc);if(found)return found;}
      await wait(70);
    }while(Date.now()<limit);
    return null;
  }
  async function resolverProcedimento(proc,original,visible){
    const key=proc.grupo+':'+proc.codigo;
    if(state.procedureCache.has(key))return state.procedureCache.get(key);
    let item=await buscarDireto(proc,original);
    if(!item)item=await buscarPeloPlugin(proc,visible);
    if(!item)throw new Error('O Saúde Simples não retornou o código '+proc.codigo+
      ' na API de '+proc.grupo+'. Nada foi incluído. Verifique a habilitação/competência desse procedimento.');
    state.procedureCache.set(key,item);
    return item;
  }
  function inserirToken(id,proc,item){
    $(id).tokenInput('add',{...item,id:item.id,codigo:proc.codigo,name:proc.codigo+' - '+(rawName(item)||proc.nome)});
    if(!tokenSelected(id,proc.codigo))throw new Error('O TokenInput do Saúde Simples não confirmou a seleção do código '+proc.codigo+'.');
  }
  function cleanNativeSearch(visible){
    if(!visible||!visible.isConnected)return;
    // Somente campo de busca do autocomplete, nunca o token efetivamente selecionado.
    visible.value='';visible.dispatchEvent(new Event('input',{bubbles:true}));visible.blur();
  }

  // Nomes originais da relacao CAPS, para reconhecer linhas que mostram nome sem codigo.
  const OFICIAIS={
    '0301080208':'ATENDIMENTO INDIVIDUAL DE PACIENTE EM CENTRO DE ATENCAO PSICOSSOCIAL',
    '0301080020':'ACOLHIMENTO NOTURNO DE PACIENTE EM CENTRO DE ATENCAO PSICOSSOCIAL',
    '0301080194':'ACOLHIMENTO DIURNO DE PACIENTE EM CENTRO DE ATENCAO PSICOSSOCIAL',
    '0301080216':'ATENDIMENTO EM GRUPO DE PACIENTE EM CENTRO DE ATENCAO PSICOSSOCIAL',
    '0301080224':'ATENDIMENTO FAMILIAR EM CENTRO DE ATENCAO PSICOSSOCIAL',
    '0301080240':'ATENDIMENTO DOMICILIAR PARA PACIENTES DE CENTRO DE ATENCAO PSICOSSOCIAL E OU FAMILIARES',
    '0301080275':'PRATICAS CORPORAIS EM CENTRO DE ATENCAO PSICOSSOCIAL',
    '0301080283':'PRATICAS EXPRESSIVAS E COMUNICATIVAS EM CENTRO DE ATENCAO PSICOSSOCIAL',
    '0301080291':'ATENCAO AS SITUACOES DE CRISE',
    '0301080348':'ACOES DE REABILITACAO PSICOSSOCIAL',
    '0301080356':'PROMOCAO DE CONTRATUALIDADE NO TERRITORIO',
    '0301080267':'FORTALECIMENTO DO PROTAGONISMO DE USUARIOS DE CENTRO DE ATENCAO PSICOSSOCIAL E SEUS FAMILIARES',
    '0301080305':'MATRICIAMENTO DE EQUIPES DA ATENCAO BASICA',
    '0301080232':'ACOLHIMENTO INICIAL POR CENTRO DE ATENCAO PSICOSSOCIAL',
    '0301080259':'ACOES DE ARTICULACAO DE REDES INTRA E INTERSETORIAIS',
    '0301080313':'ACOES DE REDUCAO DE DANOS'
  };
  function tituloProc(txt){
    return norm(txt).replace(/\bCAPS\b/g,'CENTRO DE ATENCAO PSICOSSOCIAL')
      .replace(/[^A-Z0-9]+/g,' ').replace(/\s+/g,' ').trim();
  }
  function rows(grupo){
    const t=nativeTable(grupo,false);
    if(!t)return [];
    return all('tr',t).filter(r=>!r.classList.contains(MOUNT_CLASS+'-row') && !r.hidden &&
      getComputedStyle(r).display!=='none' && all('td',r).length>1 &&
      !all('input[name*="[_destroy]"],input[id*="_destroy"]',r).some(x=>['1','true'].includes(String(x.value).toLowerCase())));
  }
  function rowByCode(grupo,code){
    const proc=lista(grupo).find(p=>p.codigo===code);
    const aliases=[OFICIAIS[code],proc?.nome].filter(Boolean).map(tituloProc);
    return rows(grupo).find(r=>{
      if(r.dataset.om30Codigo===code)return true;
      if(new RegExp('(^|\\D)'+code+'(\\D|$)').test(str(r.textContent)))return true;
      if(all('input',r).some(x=>digits(x.value)===code))return true;
      const cells=all('td',r);
      const nomes=[cells[1]?.textContent,cells[1]?.querySelector('input[type="text"]')?.value,
        cells[1]?.querySelector('textarea')?.value].filter(Boolean);
      return nomes.some(v=>{
        const n=tituloProc(v);
        if(!n||n.length<16)return false;
        return aliases.some(alias=>alias.length>=16&&(n===alias||n.startsWith(alias+' ')||n.endsWith(' '+alias)));
      });
    })||null;
  }
  async function awaitRow(grupo,proc,antes,ms=1600){
    const limit=Date.now()+ms;
    do{
      const row=rowByCode(grupo,proc.codigo);
      if(row)return row;
      const added=rows(grupo).filter(r=>!antes.has(r));
      if(added.length===1&&str(added[0].querySelectorAll('td')[1]?.textContent).length>5)return added[0];
      await wait(65);
    }while(Date.now()<limit);
    return rowByCode(grupo,proc.codigo);
  }
  function highlight(row){if(!row)return;row.scrollIntoView({behavior:'smooth',block:'center'});const prev=row.style.outline;row.style.outline='2px solid #71717a';setTimeout(()=>{if(row.isConnected)row.style.outline=prev;},1400);}

  function nativeSection(grupo,field){
    // Encontra o painel que tem o titulo NATIVO correto e o TokenInput deste grupo.
    // Prefere o menor ancestral para nao misturar botoes de RAAS e BPA.
    const visible=sel('#token-input-'+field.id);
    const anchor=visivel(visible)?visible:field;
    const other=sel(FIELDS[grupo==='RAAS'?'BPA':'RAAS'].id);
    const title='FATURAMENTO '+grupo;
    let node=anchor?.parentElement||null;
    for(let i=0;node&&node!==document.body&&i<14;i++,node=node.parentElement){
      if(other&&node.contains(other))break;
      const headings=all('h2,h3,h4,h5,h6,legend,.panel-heading,.panel-title,.box-header,.accordion-heading,span,strong,a',node)
        .filter(e=>!e.closest('.'+MOUNT_CLASS) && norm(e.textContent)===title);
      if(headings.length)return node;
      if(node.matches('.panel,.card,.box,fieldset') && norm(node.textContent.slice(0,100)).includes(title))return node;
    }
    // Outros layouts têm o cabecalho fora do bloco do formulario.
    const allTitles=all('.panel-heading,.panel-title,.box-header,.accordion-heading,h3,h4,h5,legend')
      .filter(e=>!e.closest('.'+MOUNT_CLASS) && norm(e.textContent)===title);
    for(const h of allTitles){
      let panel=h.parentElement;
      for(let i=0;panel&&panel!==document.body&&i<5;i++,panel=panel.parentElement){
        if(panel.contains(anchor)&&(!other||!panel.contains(other)))return panel;
      }
    }
    return null;
  }
  // MAPEADO NO DIAGNOSTICO 2.1.0 (sem adivinhar pelo texto nem posicao):
  // - RAAS: <a id="raas_adicional_incluir" ...>
  // - BPA:  <a onclick="add_procedimentos_lancamentos_bpa_temporarios_fields(...)" ...>
  function botaoNativoExato(grupo){
    const panel=portletNativo(grupo);
    if(!panel)return null;
    const candidates=grupo==='RAAS'
      ? all('a#raas_adicional_incluir',panel)
      : all('a[onclick*="add_procedimentos_lancamentos_bpa_temporarios_fields"]',panel);
    const validos=candidates.filter(el=>el.isConnected&&!el.disabled&&!el.closest('template'));
    return validos.length===1?validos[0]:null;
  }
  function nativeButtonOptions(grupo,field){
    const el=botaoNativoExato(grupo);
    return el?[{el,score:999,name:str(el.innerText||el.textContent),id:el.id||'',
      onclick:str(el.getAttribute('onclick')).slice(0,100),inPanel:true}]:[];
  }
  function chooseAddButton(grupo,field){
    return botaoNativoExato(grupo);
  }
  function clearStaleSelected(grupo,selector){
    // Se TODOS os tokens pendentes ja constarem na propria tabela, e seguro
    // limpar o seletor, preservando os lancamentos ja feitos.
    const selected=tokenList(selector);
    if(!selected.length)return 0;
    const found=selected.every(x=>{
      const cd=rawCode(x)||codeFromName(x);
      if(cd&&rowByCode(grupo,cd))return true;
      const nome=tituloProc(rawName(x)||x?.name||'');
      return nome.length>=16 && rows(grupo).some(r=>{
        const cells=all('td',r);
        const text=tituloProc(cells[1]?.textContent||'');
        return text===nome||text===nome.replace(/^\d{10}\s*/,'');
      });
    });
    if(!found)return 0;
    try{$(selector).tokenInput('clear');return selected.length;}
    catch(_){return 0;}
  }
  function setBusy(b){state.busy=b;for(const ui of Object.values(state.mounts)){
    if(!ui)continue;all('.om30-proc',ui).forEach(el=>{el.disabled=b||el.dataset.included==='true';});
    sincronizarSelecao(ui.dataset.grupo);
  }}

  function preencherQuantidadeSeVazia(row){
    if(!row)return;
    all('input[type="number"],input[type="text"]',row).filter(x=>/quantidade|qtd/i.test(x.name+' '+x.id)).forEach(x=>{
      if(!str(x.value)||Number(x.value)<=0){x.value='1';x.dispatchEvent(new Event('input',{bubbles:true}));x.dispatchEvent(new Event('change',{bubbles:true}));}
    });
  }
  async function incluir(proc){
    if(state.busy)return;
    const grupo=proc.grupo;
    setBusy(true);
    setStatus(grupo,'Incluindo '+proc.codigo+' automaticamente...', 'busy');
    try{
      const existing=rowByCode(grupo,proc.codigo);
      if(existing){highlight(existing);atualizarIncluidos(grupo);setStatus(grupo,'✓ '+proc.codigo+' já está incluído em '+grupo+'.','ok');return existing;}
      abrirFormularioNativo(grupo);
      const {original,selector,visible}=tokenExists(grupo);
      clearStaleSelected(grupo,selector);
      const existingTokens=tokenList(selector);
      const already=tokenSelected(selector,proc.codigo);
      if(existingTokens.length&&!already)throw new Error('Há outro procedimento aguardando inclusão no faturamento '+grupo+'. Inclua-o ou remova-o primeiro.');
      const item=already?null:await resolverProcedimento(proc,original,visible);
      const before=new Set(rows(grupo));
      if(!already)inserirToken(selector,proc,item);
      cleanNativeSearch(visible);
      await wait(20);
      let row=rowByCode(grupo,proc.codigo);
      if(!row){
        const btn=chooseAddButton(grupo,original);
        if(!btn){
          console.warn('[OM30 Terapia '+grupo+'] Botao incluir nao identificado. Candidatos:',nativeButtonOptions(grupo,original).map(x=>({score:x.score,label:x.name,id:x.id,onclick:x.onclick,inPanel:x.inPanel})));
          setStatus(grupo,proc.codigo+' selecionado no formulário nativo. Use o botão original + Incluir procedimento. A seleção foi preservada.','warn');
          return null;
        }
        btn.click();
        row=await awaitRow(grupo,proc,before,1400);
      }
      if(!row){
        const newRows=rows(grupo).filter(r=>!before.has(r));
        if(newRows.length===1){
          const c=all('td',newRows[0])[1];
          const desc=tituloProc(c?.textContent||'');
          const expected=tituloProc(OFICIAIS[proc.codigo]||proc.nome);
          if(desc&&(desc.includes(proc.codigo)||desc===expected||desc.startsWith(expected+' ')))row=newRows[0];
        }
      }
      if(row){
        row.dataset.om30Codigo=proc.codigo;
        atualizarIncluidos(grupo);
        preencherQuantidadeSeVazia(row);
        highlight(row);
        setStatus(grupo,'Procedimento '+proc.codigo+' incluído na tabela '+grupo+'. Confira os dados antes de salvar.','ok');
        return row;
      }else{
        atualizarIncluidos(grupo);
        setStatus(grupo,'O botão original foi acionado, mas a linha '+proc.codigo+' não foi confirmada. Confira classificação, local, CID ou outros campos no formulário original antes de repetir.','warn');
        return null;
      }
    }catch(e){console.error('[OM30 Terapia '+grupo+']',e);setStatus(grupo,e?.message||String(e),'error');return null;}
    finally{setBusy(false);}
  }

  function debug(){
    const report={script:'OM30-Terapia-CAPS',versao:VERSION,grupoBpaPrincipal:'#prontuario_procedimento_faturamento',grupos:{},consultas:state.apiLog};
    for(const grupo of ['RAAS','BPA']){
      const cfg=FIELDS[grupo],t=nativeTable(grupo,false);
      const encontrados=cfg.candidatos.map(id=>({id,existe:!!sel(id),tokenInput:!!sel(id)&&!!$&&typeof $(id).tokenInput==='function'}));
      let current=null;
      try{current=tokenExists(grupo);}catch(_){}
      const settings=current?.original?nativeTokenSettings(current.original):{};
      const b=current?.original?chooseAddButton(grupo,current.original):null;
      report.grupos[grupo]={tabela:!!t,tabelaOculta:!!t&&!visivel(t),formularioOriginalVisivel:formularioVisivel(grupo),interface:!!state.mounts[grupo]?.isConnected,ancora:nativeAnchor(grupo)?.type||null,
        campos:encontrados,campoEscolhido:current?.selector||null,
        endpoint:cfg.rota,queryParam:settings.queryParam||null,
        botao:b?{id:b.id||'',onclick:str(b.getAttribute('onclick')).slice(0,120),texto:str(b.textContent).slice(0,70)}:null,
        campoNativoVisivel:current?visivel(current.original):false,
        campoBuscaVisivel:current?visivel(current.visible):false,
        buscaNativaNaLista:!!state.borrowed[grupo],setorEncontrado:!!(current&&nativeSection(grupo,current.original)),
        candidatosInclusao:current?nativeButtonOptions(grupo,current.original).slice(0,9).map(x=>({score:x.score,texto:x.name,id:x.id,onclick:x.onclick,inPanel:x.inPanel})):[],
        botoesVisiveis:all('a,button,input[type=button]').filter(e=>!e.closest('.'+MOUNT_CLASS)&&visivel(e)&&/INCLUIR/i.test(e.innerText||e.value||'')).slice(0,15).map(e=>({texto:str(e.innerText||e.value).slice(0,65),id:e.id||'',onclick:str(e.getAttribute('onclick')).slice(0,100)})),
        tokensPendentes:current?tokenList(current.selector).map(x=>({codigo:rawCode(x)||codeFromName(x),id:String(x.id||'')})):[],
        linhasNativas:rows(grupo).length,jaIncluidos:lista(grupo).filter(p=>!!rowByCode(grupo,p.codigo)).map(p=>p.codigo),procedimentosDaLista:lista(grupo).length,listaRendered:all('.om30-proc',state.mounts[grupo]||document.createElement('div')).length};
    }
    console.log('[OM30 Terapia] Diagnóstico sem dados do paciente:\n'+JSON.stringify(report,null,2));return report;
  }
  window.OM30_Terapia_Debug=debug;
  window.OM30_Terapia_CopiarDebug=()=>{
    const out=JSON.stringify(debug(),null,2);
    if(typeof copy==='function'){copy(out);console.info('[OM30 Terapia] Copiado.');}
    else if(navigator.clipboard?.writeText)navigator.clipboard.writeText(out).catch(()=>console.log(out));
    else console.log(out);
    return out;
  };

  const observer=new MutationObserver(()=>{
    if(state.refreshTimeout)return;
    state.refreshTimeout=setTimeout(()=>{state.refreshTimeout=0;refresh();},260);
  });
  observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class','style','hidden','aria-hidden','aria-expanded']});
  const interval=setInterval(refresh,1800);
  const tokenTimer=setInterval(()=>{if(state.destroyed)return;sincronizarSelecao('RAAS');sincronizarSelecao('BPA');},280);
  window[KEY]={version:VERSION,destruir(){
    state.destroyed=true;
    restaurarBuscaNativa('RAAS');restaurarBuscaNativa('BPA');
    for(const st of Object.values(state.customSearch)){clearTimeout(st.timer);st.ctrl?.abort();}
    observer.disconnect();clearInterval(interval);clearInterval(tokenTimer);clearTimeout(state.refreshTimeout);
  
    if(XMLHttpRequest.prototype.open===xhrOpenWrapper)XMLHttpRequest.prototype.open=oldOpen;
    if(XMLHttpRequest.prototype.send===xhrSendWrapper)XMLHttpRequest.prototype.send=oldSend;
    all('.'+MOUNT_CLASS+'-row,.'+MOUNT_CLASS+'-placeholder,.'+MOUNT_CLASS).forEach(el=>el.remove());
    css.remove();if(window[KEY]?.version===VERSION)delete window[KEY];
    delete window.OM30_Terapia_Debug;delete window.OM30_Terapia_CopiarDebug;
  }};
  refresh();
  console.info('[OM30 Terapia] v'+VERSION+' carregado: cadastro SOMENTE na lista. Inclusões no faturamento apenas ao clicar itens da lista ou botões originais. Diagnóstico: OM30_Terapia_CopiarDebug().');
})();