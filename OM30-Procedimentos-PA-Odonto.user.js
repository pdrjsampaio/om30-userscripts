// ==UserScript==
// @name         OM30 - Odonto U/E - Faturamento BPA
// @namespace    https://om30.com.br/
// @version      1.0.0
// @description  Procedimentos odontológicos no Faturamento BPA da Urgência e Emergência para CBO 223208.
// @author       OM30
// @match        https://guaruja.saudesimples.net/prontuarios*
// @match        https://guaruja.saudesimples.net/prontuarios/*
// @match        https://guaruja.saudesimples.net/atendimentos_pas/*/prontuario*
// @match        https://guarujahomolog.saudesimples.net/prontuarios*
// @match        https://guarujahomolog.saudesimples.net/prontuarios/*
// @match        https://guarujahomolog.saudesimples.net/atendimentos_pas/*/prontuario*
// @updateURL    https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Procedimentos-PA-Odonto.user.js
// @downloadURL  https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Procedimentos-PA-Odonto.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '1.0.0';
  if (window.__OM30_ODONTO_UE_BPA__ === VERSION) return;
  window.__OM30_ODONTO_UE_BPA__ = VERSION;

  const CBO = '223208';
  const $ = window.jQuery;
  const q = (s, r = document) => r.querySelector(s);
  const qa = (s, r = document) => [...r.querySelectorAll(s)];
  const clean = v => String(v ?? '').replace(/\s+/g, ' ').trim();
  const norm = v => clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  const digits = v => String(v ?? '').replace(/\D/g, '');
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const PROCEDIMENTOS = [
    { reduz:"1108", codigo:"0301060061", nome:"ATENDIMENTO DE URGÊNCIA EM ATENÇÃO ESPECIALIZADA" },
    { reduz:"1644", codigo:"0307020010", nome:"ACESSO À POLPA DENTÁRIA E MEDICAÇÃO (POR DENTE)" },
    { reduz:"4393", codigo:"0307040151", nome:"AJUSTE OCLUSAL" },
    { reduz:"1639", codigo:"0307010015", nome:"CAPEAMENTO PULPAR DIRETO/INDIRETO EM DECÍDUOS E PERMANENTES" },
    { reduz:"4391", codigo:"0307040135", nome:"CIMENTAÇÃO DE PRÓTESE DENTÁRIA" },
    { reduz:"1965", codigo:"0404020445", nome:"CONTENÇÃO DE DENTES POR SPLINTAGEM" },
    { reduz:"1645", codigo:"0307020029", nome:"CURATIVO DE DEMORA C/ OU S/ PREPARO BIOMECÂNICO" },
    { reduz:"3184", codigo:"0414020073", nome:"CURETAGEM PERIAPICAL" },
    { reduz:"1717", codigo:"0401010031", nome:"DRENAGEM DE ABSCESSO" },
    { reduz:"1933", codigo:"0404020054", nome:"DRENAGEM DE ABSCESSO DA BOCA E ANEXOS" },
    { reduz:"3175", codigo:"0414010345", nome:"EXCISÃO DE CÁLCULO DE GLÂNDULA SALIVAR" },
    { reduz:"1937", codigo:"0404020097", nome:"EXCISÃO E SUTURA DE LESÃO NA BOCA" },
    { reduz:"1719", codigo:"0401010058", nome:"EXCISÃO DE LESÃO E/OU SUTURA DE FERIMENTO DA PELE ANEXOS E MUCOSA" },
    { reduz:"3187", codigo:"0414020120", nome:"EXODONTIA DE DENTE DECÍDUO" },
    { reduz:"3188", codigo:"0414020138", nome:"EXODONTIA DE DENTE PERMANENTE" },
    { reduz:"3189", codigo:"0414020146", nome:"EXODONTIA MÚLTIPLA COM ALVEOLOPLASTIA POR SEXTANTE" },
    { reduz:"1724", codigo:"0401010104", nome:"INCISÃO E DRENAGEM DE ABSCESSO" },
    { reduz:"3192", codigo:"0414020170", nome:"GLOSSORRAFIA (SUTURA DE LÍNGUA)" },
    { reduz:"3190", codigo:"0414020154", nome:"GENGIVECTOMIA (POR SEXTANTE)" },
    { reduz:"3191", codigo:"0414020162", nome:"GENGIVOPLASTIA (POR SEXTANTE)" },
    { reduz:"3194", codigo:"0414020219", nome:"ODONTOSECÇÃO / RADILECTOMIA / TUNELIZAÇÃO" },
    { reduz:"4854", codigo:"0101020104", nome:"ORIENTAÇÃO DE HIGIENE BUCAL" },
    { reduz:"1969", codigo:"0404020488", nome:"OSTEOTOMIA DAS FRATURAS ALVEOLO-DENTÁRIAS" },
    { reduz:"1650", codigo:"0307020070", nome:"PULPOTOMIA DENTÁRIA" },
    { reduz:"4871", codigo:"0204010217", nome:"RADIOGRAFIA INTERPROXIMAL (BITE WING)" },
    { reduz:"4872", codigo:"0204010225", nome:"RADIOGRAFIA PERIAPICAL" },
    { reduz:"1657", codigo:"0307030032", nome:"RASPAGEM CORONO-RADICULAR (POR SEXTANTE)" },
    { reduz:"1978", codigo:"0404020577", nome:"REDUÇÃO DE FRATURA ALVEOLO-DENTÁRIA SEM OSTEOSSÍNTESE" },
    { reduz:"1982", codigo:"0404020615", nome:"REDUÇÃO DE LUXAÇÃO TÊMPORO-MANDIBULAR" },
    { reduz:"3195", codigo:"0414020243", nome:"REIMPLANTE E TRANSPLANTE DENTAL (POR ELEMENTO)" },
    { reduz:"1163", codigo:"0301100152", nome:"RETIRADA DE PONTOS DE CIRURGIAS (POR PACIENTE)" },
    { reduz:"13", codigo:"0101020090", nome:"SELAMENTO PROVISÓRIO DE CAVIDADE DENTÁRIA" },
    { reduz:"3201", codigo:"0414020383", nome:"TRATAMENTO DE ALVEOLITE" },
    { reduz:"4924", codigo:"0307030067", nome:"TRATAMENTO DE GENGIVITE ULCERATIVA NECROSANTE AGUDA (GUNA)" },
    { reduz:"4925", codigo:"0307030075", nome:"TRATAMENTO DE LESÕES DA MUCOSA ORAL" },
    { reduz:"3178", codigo:"0414010388", nome:"TRATAMENTO CIRÚRGICO DE FÍSTULA INTRA / EXTRAORAL" },
    { reduz:"1646", codigo:"0307020037", nome:"TRATAMENTO ENDODÔNTICO DE DENTE DECÍDUO" },
    { reduz:"3198", codigo:"0414020359", nome:"TRATAMENTO CIRÚRGICO DE HEMORRAGIA BUCO-DENTAL" },
    { reduz:"1643", codigo:"0307010058", nome:"TRATAMENTO DE NEVRALGIAS FACIAIS" },
    { reduz:"4926", codigo:"0307030083", nome:"TRATAMENTO DE PERICORONARITE" },
    { reduz:"4914", codigo:"0307010066", nome:"TRATAMENTO INICIAL DO DENTE TRAUMATIZADO" },
    { reduz:"3202", codigo:"0414020405", nome:"ULOTOMIA/ULECTOMIA" }
  ];

  const state = {
    bypassWarning: false,
    busy: false,
    eligible: false,
    observer: null,
    lastEligibility: ''
  };

  function tipoProntuariavel() {
    return clean(
      q('#prontuario_prontuariavel_type')?.value ||
      q('input[name="prontuario[prontuariavel_type]"]')?.value ||
      new URLSearchParams(location.search).get('prontuariavel_type') ||
      ''
    );
  }

  function ehUrgenciaEmergencia() {
    const p = location.pathname;
    const tipo = norm(tipoProntuariavel());

    if (/\/atendimentos_pas\/\d+\/prontuario/i.test(p)) return true;
    if (tipo === 'ATENDIMENTOPA' || tipo === 'ATENDIMENTO PA') return true;
    return false;
  }

  function occupationValue(v) {
    const s = clean(v);
    if (!s) return '';
    const m = s.match(/-(\d+)$/);
    if (m) return m[1];
    if (/^\d+$/.test(s)) return s;
    return '';
  }

  function occupationId() {
    const direto = q('#prontuario_ocupacao_id');
    const idDireto = occupationValue(direto?.value);
    if (idDireto) return idDireto;

    const sels = [
      'input[name*="[ocupacao_id]"]',
      'select[name*="[ocupacao_id]"]',
      'input[name*="profissional_ocupacao_id"]',
      'input[id*="profissional_ocupacao_id"]'
    ];

    for (const sel of sels) {
      for (const el of qa(sel)) {
        const id = occupationValue(el.value);
        if (id) return id;
      }
    }
    return '';
  }

  function textoEspecialidadeAtual() {
    const diretos = [
      q('#prontuario_ocupacao_id')?.selectedOptions?.[0]?.textContent,
      q('#prontuario_ocupacao_id')?.getAttribute?.('data-name'),
      q('select[name*="[ocupacao_id]"]')?.selectedOptions?.[0]?.textContent
    ].map(clean).filter(Boolean);

    const labels = qa('li,strong,label,span,div')
      .filter(el => /ESPECIALIDADE|OCUPA[CÇ][AÃ]O|CBO/i.test(clean(el.textContent)))
      .slice(0, 80)
      .map(el => clean(el.parentElement?.textContent || el.textContent));

    return clean([...diretos, ...labels].join(' | '));
  }

  function ehDentistaClinicoGeral() {
    const texto = norm(textoEspecialidadeAtual() + ' ' + document.body?.innerText?.slice(0, 35000));
    if (texto.includes(CBO)) return true;
    return /CIRURGIAO\s*DENTISTA\s*-?\s*CLINICO\s*GERAL/.test(texto);
  }

  function elegivel() {
    const ok = ehUrgenciaEmergencia() && ehDentistaClinicoGeral();
    state.eligible = ok;
    return ok;
  }

  async function api(url) {
    const r = await fetch(url, {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest'
      }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  }

  function codigoItem(item) {
    return clean(item?.codigo || item?.codigo_externo || '');
  }

  function nomeItem(item) {
    return clean(item?.nome || item?.descricao || '');
  }

  async function buscarProcedimento(proc) {
    const occ = occupationId();
    if (!occ) throw new Error('Não consegui identificar a ocupação atual do prontuário.');

    const params = new URLSearchParams({ ocupacao_id: occ, q: proc.codigo });
    let xs = await api('/procedimentos/procedimentos_ocupacoes.json?' + params.toString());
    if (!Array.isArray(xs)) xs = [];

    let exato = xs.find(x => digits(codigoItem(x)) === proc.codigo);

    if (!exato) {
      const p2 = new URLSearchParams({ ocupacao_id: occ, q: proc.nome });
      xs = await api('/procedimentos/procedimentos_ocupacoes.json?' + p2.toString());
      if (!Array.isArray(xs)) xs = [];
      exato = xs.find(x => digits(codigoItem(x)) === proc.codigo);
    }

    if (!exato) {
      throw new Error(
        proc.codigo + ' não foi disponibilizado pelo Saúde Simples para a ocupação atual.'
      );
    }

    if (exato.revogado === true) {
      throw new Error(proc.codigo + ' está marcado como revogado no Saúde Simples.');
    }

    return exato;
  }

  function rowAtiva(row) {
    if (!row) return false;
    if (row.hidden) return false;
    if (getComputedStyle(row).display === 'none') return false;

    const destroy = row.querySelector(
      'input[name*="[_destroy]"], input[id*="_destroy"]'
    );
    if (destroy && ['1', 'true'].includes(String(destroy.value).toLowerCase())) return false;

    return true;
  }

  function codigoLinha(row) {
    const texto = clean(row?.innerText || row?.textContent || '');
    const m = texto.match(/\b\d{10}\b/);
    if (m) return m[0];

    for (const el of qa('input,select', row)) {
      const d = digits(el.value);
      if (d.length === 10) return d;
    }
    return '';
  }

  function linhaComCodigo(codigo) {
    return qa('tr.prontuario-lancamento-bpa-row')
      .find(r => rowAtiva(r) && codigoLinha(r) === codigo) || null;
  }

  function tokenGet(selector) {
    if (!$ || typeof $(selector).tokenInput !== 'function') return [];
    try {
      const xs = $(selector).tokenInput('get');
      return Array.isArray(xs) ? xs : [];
    } catch {
      return [];
    }
  }

  function tokenTemCodigo(selector, codigo) {
    return tokenGet(selector).some(x => digits(codigoItem(x) || x?.name) === codigo);
  }

  function tokenAdd(selector, item) {
    if (!$ || typeof $(selector).tokenInput !== 'function') {
      throw new Error('TokenInput do Faturamento BPA não está disponível.');
    }
    const cd = codigoItem(item);
    const nm = nomeItem(item);
    $(selector).tokenInput('add', {
      ...item,
      id: item.id,
      name: cd + ' - ' + nm
    });
  }

  function botaoIncluirProcedimento() {
    return q('#add_fields_lancamento_bpa_procedimentos_cids a[onclick*="add_lancamentos_bpa_fields"]') ||
           qa('a,button,input[type="button"]')
             .find(el => /INCLUIR/.test(norm(el.innerText || el.value)) &&
               el.closest?.('#add_fields_lancamento_bpa_procedimentos_cids'));
  }

  async function esperarNovaLinha(antes, timeout = 3500) {
    const ini = Date.now();
    while (Date.now() - ini < timeout) {
      const nova = qa('tr.prontuario-lancamento-bpa-row')
        .find(r => rowAtiva(r) && !antes.has(r));
      if (nova) return nova;
      await sleep(80);
    }
    return null;
  }

  function ajustarQuantidadeSeVazia(row) {
    if (!row) return;
    const inputs = qa('input', row).filter(el =>
      /quantidade|qtd/i.test(el.name || el.id || '') &&
      el.type !== 'hidden'
    );
    for (const input of inputs) {
      if (!clean(input.value) || Number(input.value) <= 0) {
        input.value = '1';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }

  async function incluirNoBpa(proc) {
    if (state.busy) return;
    state.busy = true;
    setStatus('Validando ' + proc.codigo + '…', 'busy');

    try {
      if (!elegivel()) {
        throw new Error('Esta função é exclusiva da U/E para CBO 223208.');
      }

      const existente = linhaComCodigo(proc.codigo);
      if (existente) {
        existente.scrollIntoView({ behavior: 'smooth', block: 'center' });
        piscarLinha(existente);
        setStatus('Procedimento já está no Faturamento BPA.', 'ok');
        return;
      }

      const item = await buscarProcedimento(proc);
      const selector = '#prontuario_procedimento_token';

      const tokens = tokenGet(selector);
      const mesmo = tokenTemCodigo(selector, proc.codigo);

      if (tokens.length && !mesmo) {
        throw new Error(
          'Há outro procedimento aguardando inclusão no campo nativo de Faturamento BPA.'
        );
      }

      const antes = new Set(qa('tr.prontuario-lancamento-bpa-row'));

      if (!mesmo) tokenAdd(selector, item);
      await sleep(120);

      const btn = botaoIncluirProcedimento();
      if (!btn) {
        throw new Error('Botão nativo + Incluir do Faturamento BPA não foi encontrado.');
      }

      btn.click();

      let row = await esperarNovaLinha(antes);
      if (!row) row = linhaComCodigo(proc.codigo);

      if (!row && tokenTemCodigo(selector, proc.codigo)) {
        throw new Error('O Saúde Simples não confirmou a inclusão do procedimento.');
      }

      if (row) {
        row.dataset.om30OdontoAdicional = '1';
        row.dataset.om30Codigo = proc.codigo;
        ajustarQuantidadeSeVazia(row);
        piscarLinha(row);
      }

      setStatus(proc.codigo + ' incluído no Faturamento BPA.', 'ok');
      atualizarContador();
    } catch (e) {
      console.error('[OM30 Odonto U/E BPA]', e);
      setStatus(e?.message || String(e), 'error');
    } finally {
      state.busy = false;
    }
  }

  function piscarLinha(row) {
    if (!row) return;
    const old = row.style.outline;
    row.style.outline = '3px solid #0B6A88';
    setTimeout(() => { row.style.outline = old; }, 1300);
  }

  function procedimentosBpaAtivos() {
    return qa('tr.prontuario-lancamento-bpa-row').filter(rowAtiva);
  }

  function temProcedimentoAdicional() {
    return procedimentosBpaAtivos().length > 0;
  }

  function atualizarContador() {
    const el = q('#om30-odonto-count');
    if (el) el.textContent = String(procedimentosBpaAtivos().length);
  }

  function isProtectedAction(el) {
    if (!el || el.closest?.('#om30-odonto-ue')) return false;
    const t = norm(
      el.value ||
      el.textContent ||
      el.getAttribute?.('title') ||
      el.getAttribute?.('aria-label') ||
      ''
    );

    return /^SALVAR(?:\b|\s)/.test(t) ||
           /^FINALIZAR(?:\b|\s)/.test(t) ||
           /FINALIZAR ATENDIMENTO/.test(t);
  }

  function showWarning(actionEl) {
    if (q('#om30-odonto-warning')) return;

    const bg = document.createElement('div');
    bg.id = 'om30-odonto-warning';
    bg.innerHTML = `
      <div class="om30-odonto-modal">
        <div class="om30-odonto-modal-title">OM30 • Conferência de Procedimentos</div>
        <div class="om30-odonto-modal-body">
          <b>Nenhum procedimento adicional foi informado no Faturamento BPA deste atendimento.</b>
          <br><br>
          Deseja continuar mesmo assim?
        </div>
        <div class="om30-odonto-modal-actions">
          <button type="button" data-back>Voltar e informar procedimento</button>
          <button type="button" class="danger" data-go>Continuar mesmo assim</button>
        </div>
      </div>
    `;
    document.body.appendChild(bg);

    bg.querySelector('[data-back]').addEventListener('click', () => {
      bg.remove();
      q('#om30-odonto-ue')?.classList.remove('collapsed');
      q('#om30-odonto-search')?.focus();
    });

    bg.querySelector('[data-go]').addEventListener('click', () => {
      bg.remove();
      state.bypassWarning = true;
      actionEl.click();
      setTimeout(() => { state.bypassWarning = false; }, 1200);
    });
  }

  document.addEventListener('click', e => {
    if (!state.eligible || state.bypassWarning) return;
    const el = e.target.closest?.('button,a,input[type="button"],input[type="submit"]');
    if (!isProtectedAction(el)) return;
    if (temProcedimentoAdicional()) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    showWarning(el);
  }, true);

  function estilos() {
    if (q('#om30-odonto-style')) return;
    const s = document.createElement('style');
    s.id = 'om30-odonto-style';
    s.textContent = `
      #om30-odonto-ue{
        position:fixed;right:14px;bottom:14px;width:390px;max-height:72vh;
        z-index:2147483600;background:#fff;border:1px solid #C9D7DE;border-radius:12px;
        box-shadow:0 14px 40px rgba(10,37,52,.24);font-family:Segoe UI,Arial,sans-serif;
        color:#25343C;overflow:hidden
      }
      #om30-odonto-ue.collapsed .om30-odonto-body{display:none}
      .om30-odonto-head{
        background:#123A52;color:#fff;padding:10px 11px;display:flex;align-items:center;
        justify-content:space-between;gap:8px
      }
      .om30-odonto-title{font-size:13px;font-weight:900}
      .om30-odonto-sub{font-size:9.5px;opacity:.8;margin-top:2px}
      .om30-odonto-head button{
        border:0;border-radius:7px;background:rgba(255,255,255,.14);color:#fff;
        width:28px;height:26px;cursor:pointer;font-weight:900
      }
      .om30-odonto-body{padding:9px}
      .om30-odonto-meta{
        display:flex;gap:5px;align-items:center;flex-wrap:wrap;margin-bottom:7px
      }
      .om30-odonto-pill{
        padding:3px 6px;border-radius:999px;background:#EEF5F8;color:#365766;
        font-size:9px;font-weight:800
      }
      #om30-odonto-search{
        width:100%;box-sizing:border-box;border:1px solid #BCD0DA;border-radius:8px;
        padding:7px 8px;font-size:11px;outline:none;margin-bottom:7px
      }
      #om30-odonto-list{
        display:grid;grid-template-columns:1fr;gap:4px;max-height:46vh;overflow:auto;
        padding-right:2px
      }
      .om30-odonto-proc{
        text-align:left;border:1px solid #D6E1E7;background:#fff;border-radius:8px;
        padding:6px 7px;cursor:pointer;display:grid;grid-template-columns:50px 1fr;
        gap:7px;align-items:start
      }
      .om30-odonto-proc:hover{border-color:#0B6A88;background:#F3FAFC}
      .om30-odonto-code{font:700 9px/1.25 Consolas,monospace;color:#0B6A88}
      .om30-odonto-name{font-size:10px;line-height:1.25;font-weight:700;color:#31464F}
      #om30-odonto-status{
        margin-top:7px;padding:6px 7px;border-radius:8px;background:#F2F6F8;
        font-size:9.5px;line-height:1.3;color:#4C626D
      }
      #om30-odonto-status.ok{background:#ECF8F2;color:#176842}
      #om30-odonto-status.error{background:#FFF0F0;color:#9A2F2F}
      #om30-odonto-status.busy{background:#FFF8E8;color:#805D16}
      #om30-odonto-warning{
        position:fixed;inset:0;z-index:2147483646;background:rgba(10,26,36,.45);
        display:flex;align-items:center;justify-content:center;padding:16px
      }
      .om30-odonto-modal{
        width:min(460px,95vw);background:#fff;border-radius:12px;
        box-shadow:0 20px 60px rgba(0,0,0,.35);overflow:hidden
      }
      .om30-odonto-modal-title{
        background:#123A52;color:#fff;padding:11px 13px;font-size:13px;font-weight:900
      }
      .om30-odonto-modal-body{padding:16px;font-size:12px;line-height:1.45}
      .om30-odonto-modal-actions{
        padding:10px 13px 13px;display:flex;justify-content:flex-end;gap:7px
      }
      .om30-odonto-modal-actions button{
        border:0;border-radius:8px;padding:8px 10px;cursor:pointer;font-weight:800;
        background:#E9EFF2;color:#31464F
      }
      .om30-odonto-modal-actions .danger{background:#A72E2E;color:#fff}
    `;
    document.head.appendChild(s);
  }

  function setStatus(text, cls = '') {
    const el = q('#om30-odonto-status');
    if (!el) return;
    el.className = cls;
    el.textContent = text;
  }

  function renderLista(filtro = '') {
    const list = q('#om30-odonto-list');
    if (!list) return;

    const termo = norm(filtro);
    const itens = PROCEDIMENTOS.filter(p => {
      if (!termo) return true;
      return norm(p.reduz + ' ' + p.codigo + ' ' + p.nome).includes(termo);
    });

    list.innerHTML = itens.map(p => `
      <button type="button" class="om30-odonto-proc" data-code="${p.codigo}">
        <span class="om30-odonto-code">${p.reduz}<br>${p.codigo}</span>
        <span class="om30-odonto-name">${p.nome}</span>
      </button>
    `).join('');

    qa('.om30-odonto-proc', list).forEach(btn => {
      btn.addEventListener('click', () => {
        const proc = PROCEDIMENTOS.find(p => p.codigo === btn.dataset.code);
        if (proc) incluirNoBpa(proc);
      });
    });
  }

  function mount() {
    if (!elegivel()) {
      q('#om30-odonto-ue')?.remove();
      return;
    }

    if (q('#om30-odonto-ue')) {
      atualizarContador();
      return;
    }

    estilos();

    const box = document.createElement('section');
    box.id = 'om30-odonto-ue';
    box.innerHTML = `
      <div class="om30-odonto-head">
        <div>
          <div class="om30-odonto-title">OM30 • Odonto U/E</div>
          <div class="om30-odonto-sub">CBO 223208 • Faturamento BPA • v${VERSION}</div>
        </div>
        <button type="button" id="om30-odonto-collapse" title="Recolher">−</button>
      </div>
      <div class="om30-odonto-body">
        <div class="om30-odonto-meta">
          <span class="om30-odonto-pill">42 procedimentos</span>
          <span class="om30-odonto-pill">BPA adicionados: <b id="om30-odonto-count">0</b></span>
        </div>
        <input id="om30-odonto-search" type="search"
               placeholder="Buscar por nome, código reduzido ou SIGTAP…">
        <div id="om30-odonto-list"></div>
        <div id="om30-odonto-status">Pronto para incluir no Faturamento BPA.</div>
      </div>
    `;

    document.body.appendChild(box);
    renderLista();
    atualizarContador();

    q('#om30-odonto-collapse').addEventListener('click', () => {
      box.classList.toggle('collapsed');
      q('#om30-odonto-collapse').textContent = box.classList.contains('collapsed') ? '+' : '−';
    });

    q('#om30-odonto-search').addEventListener('input', e => renderLista(e.target.value));

    console.info('[OM30 Odonto U/E BPA] v' + VERSION + ' carregado para CBO 223208.');
  }

  function assinaturaElegibilidade() {
    return [
      location.pathname,
      tipoProntuariavel(),
      textoEspecialidadeAtual().slice(0, 300),
      occupationId()
    ].join('|');
  }

  function refresh() {
    const sig = assinaturaElegibilidade();
    if (sig !== state.lastEligibility) {
      state.lastEligibility = sig;
      mount();
    } else if (state.eligible) {
      if (!q('#om30-odonto-ue')) mount();
      atualizarContador();
    }
  }

  const observer = new MutationObserver(() => {
    clearTimeout(observer._t);
    observer._t = setTimeout(refresh, 180);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  state.observer = observer;

  setInterval(refresh, 1500);
  refresh();
})();
