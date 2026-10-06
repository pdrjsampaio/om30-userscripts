// ==UserScript==
// @name         OM30 - Fila Médica | Risco + Retorno
// @namespace    https://om30.com.br/
// @version      2.4.6
// @description  Fila médica por risco/RT com paginação global de 10, filtro persistente após atualização automática e resumo clínico do atendimento médico anterior da mesma unidade, limitado a 36h, em modo somente leitura.
// @author       Pedro Sampaio - Samp
// @match        *://*.saudesimples.net/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  if (window.__OM30_FILA_MEDICA_RISCO_RETORNO_V246__) return;
  window.__OM30_FILA_MEDICA_RISCO_RETORNO_V246__ = true;

  const PREFIX = 'om30-fila-risco-retorno';
  const STORAGE_FILTRO = `${PREFIX}:filtro`;
  const SESSION_RETORNO = `${PREFIX}:contexto-retorno`;
  const BODY_CUSTOM = `${PREFIX}-custom-ativo`;
  const ITENS_POR_PAGINA = 10;
  const CACHE_FILA_MS = 5000;
  const CONTEXTO_MAX_MS = 8 * 60 * 60 * 1000;
  const JANELA_RETORNO_MS = 36 * 60 * 60 * 1000;

  const FILTROS = [
    { key: 'TODAS',    label: 'Todas',    cor: '#6c757d' },
    { key: 'VERMELHO', label: 'Vermelho', cor: '#dc3545' },
    { key: 'AMARELO',  label: 'Amarelo',  cor: '#ffc107' },
    { key: 'VERDE',    label: 'Verde',    cor: '#198754' },
    { key: 'AZUL',     label: 'Azul',     cor: '#0d6efd' },
    { key: 'RETORNO',  label: 'Retorno',  cor: '#6f42c1' }
  ];

  const FILTROS_VALIDOS = new Set(FILTROS.map(f => f.key));

  let filtroSelecionado = localStorage.getItem(STORAGE_FILTRO) || 'TODAS';
  if (!FILTROS_VALIDOS.has(filtroSelecionado)) filtroSelecionado = 'TODAS';

  let paginaCustom = 1;
  let filaCache = { at: 0, url: '', itens: [] };
  let carregandoFilaCompleta = null;
  let sequenciaAplicacao = 0;
  let aplicandoItensVue = false;
  let assinaturaCustom = '';
  let observerFila = null;
  let timerObserver = null;
  let timerCustom = null;
  let intervaloAtualizacao = null;
  const cacheHistoricoAnterior = new Map();
  const cacheDetalhesAnterior = new Map();
  const cacheProntuarioAnterior = new Map();
  const cacheUnidadeAtendimentoAnterior = new Map();
  let timerGuardiaoFiltro = null;
  let intervaloGuardiaoFiltro = null;
  let sincronizandoFonteNativa = false;
  let reativacaoFiltroEmCurso = null;

  // ---------------------------------------------------------------------------
  // Utilidades
  // ---------------------------------------------------------------------------

  const clean = valor => String(valor ?? '').replace(/\s+/g, ' ').trim();

  const norm = valor => clean(valor)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();

  const soDigitos = valor => String(valor ?? '').replace(/\D/g, '');

  function log(...args) {
    console.log('[OM30 Fila Médica v2.4.6]', ...args);
  }

  function warn(...args) {
    console.warn('[OM30 Fila Médica v2.4.6]', ...args);
  }

  function ehPaginaFila() {
    // Ao finalizar/sair do atendimento da Urgência e Emergência, o Saúde Simples
    // retorna para /prontuarios (sem o sufixo /urgencia_emergencia). Essa continua
    // sendo a mesma fila médica e precisa reaplicar o filtro persistido.
    return /\/prontuarios(?:\/urgencia_emergencia)?\/?$/i.test(location.pathname);
  }

  function origemEhFilaUrgenciaEmergencia(url) {
    try {
      const u = new URL(url || '', location.origin);
      // Aceita tanto a entrada explícita da U/E quanto o retorno nativo para
      // /prontuarios. O contexto ainda é validado abaixo como AtendimentoPa,
      // impedindo que o quadro de retorno seja usado em AtendimentoAmbulatorial.
      return /\/prontuarios(?:\/urgencia_emergencia)?\/?$/i.test(u.pathname);
    } catch (_) {
      return false;
    }
  }

  function contextoEhUrgenciaEmergencia(contexto) {
    if (!contexto || !origemEhFilaUrgenciaEmergencia(contexto.origem)) return false;
    const parsed = parseAtendimento(contexto.atendimentoStr);
    return parsed?.tipo === 'AtendimentoPa';
  }

  function tipoProntuariavelDaPagina() {
    return clean(
      document.querySelector('#prontuario_prontuariavel_type')?.value ||
      document.querySelector('input[name="prontuario[prontuariavel_type]"]')?.value ||
      new URLSearchParams(location.search).get('prontuariavel_type') ||
      ''
    );
  }

  function ehPaginaAtendimentoUrgenciaEmergencia(contexto) {
    if (!contextoEhUrgenciaEmergencia(contexto)) return false;

    // Rota observada no atendimento médico da Urgência e Emergência.
    if (/\/atendimentos_pas\/\d+\/prontuario/i.test(location.pathname)) return true;

    // Fallback para telas que exponham explicitamente o tipo do prontuário.
    return norm(tipoProntuariavelDaPagina()) === 'ATENDIMENTOPA';
  }

  function parseAtendimento(str) {
    const m = clean(str).match(/^(AtendimentoPa|AtendimentoAmbulatorial)#(\d+)$/);
    if (!m) return null;
    return { tipo: m[1], id: m[2] };
  }

  function itemEhRetorno(item) {
    // Regra definida para a operação: TODO retorno possui senha iniciada por RT.
    // Não usar prontuario_com_retorno: o próprio RT0001 foi observado com essa flag = false.
    return norm(item?.senha).startsWith('RT');
  }

  function riscoItem(item) {
    const risco = norm(item?.nome_grau_risco);
    if (['VERMELHO', 'AMARELO', 'VERDE', 'AZUL'].includes(risco)) return risco;

    const porId = {
      '1': 'VERMELHO',
      '2': 'AMARELO',
      '3': 'VERDE',
      '4': 'AZUL'
    };

    return porId[String(item?.grau_risco_id ?? '')] || null;
  }

  function chaveItem(item) {
    if (!item) return '';
    if (item.atendimento_str) return String(item.atendimento_str);

    return [
      clean(item.codigo_cns),
      clean(item.senha),
      clean(item.data_senha_timestamp || item.data_senha_formatada),
      norm(item.nome_municipe)
    ].join('|');
  }

  function assinaturaItens(itens) {
    return (Array.isArray(itens) ? itens : []).map(chaveItem).join('||');
  }

  function textoHtml(valor) {
    const div = document.createElement('div');
    div.innerHTML = valor || '';
    return clean(div.textContent);
  }

  // ---------------------------------------------------------------------------
  // Vue / tabela da fila
  // ---------------------------------------------------------------------------

  function acharVueFila() {
    return [...document.querySelectorAll('*')]
      .map(el => el.__vue__)
      .find(vm =>
        vm?.$options?.name === 'collection-with-search-atendimento' &&
        Array.isArray(vm?.$data?.items)
      ) || null;
  }

  function acharTabelaFila() {
    const raiz = document.querySelector('#classificacao');
    if (!raiz) return null;

    return [...raiz.querySelectorAll('table')].find(table => {
      const headers = [...table.querySelectorAll('thead th')]
        .map(th => norm(th.innerText || th.textContent));

      return headers[6] === 'SENHA' &&
             headers[7] === 'RISCO / VULNERABILIDADE' &&
             headers[8] === 'ACAO';
    }) || null;
  }

  function linhasFila() {
    const tabela = acharTabelaFila();
    return tabela ? [...tabela.querySelectorAll('tbody tr.collection-row')] : [];
  }

  function itemDaLinha(row, vm) {
    if (!row || !vm || !Array.isArray(vm.$data?.items)) return null;

    const senha = clean(row.cells?.[6]?.innerText || row.cells?.[6]?.textContent);
    const cns = clean(row.cells?.[1]?.innerText || row.cells?.[1]?.textContent);
    const nome = clean(
      row.cells?.[2]?.querySelector('span:not(.badge)')?.innerText ||
      row.cells?.[2]?.innerText ||
      row.cells?.[2]?.textContent
    );

    return vm.$data.items.find(item => {
      if (!item) return false;
      if (senha && norm(item.senha) === norm(senha)) return true;
      if (cns && clean(item.codigo_cns) === cns) return true;
      return nome && norm(item.nome_municipe) === norm(nome);
    }) || null;
  }

  function setItensVue(vm, itens) {
    if (!vm?.$data || !Array.isArray(vm.$data.items)) return false;

    aplicandoItensVue = true;
    try {
      vm.$data.items.splice(0, vm.$data.items.length, ...itens);
      assinaturaCustom = assinaturaItens(itens);
      vm.$forceUpdate?.();
      return true;
    } finally {
      setTimeout(() => {
        aplicandoItensVue = false;
      }, 0);
    }
  }

  function atualizarFilaNativa(vm) {
    assinaturaCustom = '';
    document.body.classList.remove(BODY_CUSTOM);

    let atual = vm;
    for (let i = 0; atual && i < 7; i++, atual = atual.$parent) {
      if (atual !== vm && typeof atual.atualizarListagemFila === 'function') {
        try {
          atual.atualizarListagemFila();
          log('Fila nativa restaurada pelo componente Vue.');
          return true;
        } catch (e) {
          warn('Falha ao atualizar fila pelo componente:', e);
        }
      }
    }

    const atualizar = document.querySelector('#classificacao .atualizar-listagem');
    if (atualizar) {
      atualizar.click();
      log('Fila nativa restaurada pelo link Atualizar fila.');
      return true;
    }

    return false;
  }

  // ---------------------------------------------------------------------------
  // Fonte completa da fila + paginação global
  // ---------------------------------------------------------------------------

  function pontuarUrlFila(urlOriginal) {
    try {
      const url = new URL(urlOriginal, location.origin);
      if (!/\/prontuarios\.json$/i.test(url.pathname)) return -1;

      let pontos = 1;
      // A fila médica nativa observada sempre leva contexto da especialidade/ocupação.
      // Uma chamada genérica /prontuarios.json pode devolver 0 ou uma fila diferente.
      if (url.searchParams.has('ocupacoes_ids[]')) pontos += 10;
      if (url.searchParams.has('especialidade')) pontos += 4;
      if (url.searchParams.has('status')) pontos += 2;
      if (url.searchParams.has('sortable')) pontos += 1;
      return pontos;
    } catch (_) {
      return -1;
    }
  }

  function descobrirUrlFila(vm) {
    const candidatos = [];

    for (const entrada of performance.getEntriesByType('resource')) {
      if (/\/prontuarios\.json(?:\?|$)/i.test(entrada.name)) candidatos.push(entrada.name);
    }

    candidatos.push(
      vm?.$props?.propsTable?.pathUrl,
      vm?.propsTable?.pathUrl,
      vm?.$parent?.sourceDataUrl,
      vm?.$parent?.$props?.sourceDataUrl
    );

    let melhor = null;
    let melhorPontos = -1;
    // Em empate, fica com o último recurso observado (mais recente).
    for (const candidato of candidatos.filter(Boolean)) {
      const pontos = pontuarUrlFila(candidato);
      if (pontos < 0) continue;
      if (pontos >= melhorPontos) {
        try {
          melhor = new URL(candidato, location.origin).href;
          melhorPontos = pontos;
        } catch (_) {}
      }
    }

    // Não usa mais fallback genérico. Se a fonte nativa ainda não apareceu,
    // primeiro mandamos o próprio componente carregar a fila correta.
    return melhorPontos >= 5 ? melhor : null;
  }

  function esperar(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function sincronizarFonteNativaFila(vm) {
    if (!vm) return null;
    if (sincronizandoFonteNativa) {
      for (let i = 0; i < 25; i++) {
        await esperar(80);
        const existente = descobrirUrlFila(vm);
        if (existente) return existente;
      }
      return descobrirUrlFila(vm);
    }

    sincronizandoFonteNativa = true;
    try {
      // Invalida qualquer lista obtida antes do componente terminar de montar
      // (é exatamente o caso ao voltar de um atendimento com Retorno já ativo).
      filaCache = { at: 0, url: '', itens: [] };
      carregandoFilaCompleta = null;
      assinaturaCustom = '';

      try {
        if (typeof vm.fetchCollection === 'function') {
          await Promise.resolve(vm.fetchCollection());
        } else {
          atualizarFilaNativa(vm);
        }
      } catch (e) {
        warn('Não consegui disparar a carga nativa da fila:', e);
      }

      // O request pode aparecer no Performance alguns ms depois do Promise do Vue.
      for (let i = 0; i < 30; i++) {
        const url = descobrirUrlFila(vm);
        if (url) return url;
        await esperar(100);
      }

      return descobrirUrlFila(vm);
    } finally {
      sincronizandoFonteNativa = false;
    }
  }

  function normalizarUrlFila(urlOriginal) {
    const url = new URL(urlOriginal, location.origin);
    url.searchParams.delete('page');
    url.searchParams.delete('per_page');
    return url;
  }

  async function buscarPaginaFila(urlBase, pagina) {
    const url = new URL(urlBase.href);
    url.searchParams.set('page', String(pagina));
    // Se o backend aceitar 100, reduz muito o número de chamadas.
    // Se ele limitar internamente, o laço continua pelas páginas seguintes.
    url.searchParams.set('per_page', '100');

    const resp = await fetch(url.href, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json, text/plain, */*' },
      cache: 'no-store'
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ao buscar página ${pagina}`);
    }

    const dados = await resp.json();
    if (!Array.isArray(dados)) {
      throw new Error('Resposta de /prontuarios.json não é uma lista.');
    }

    return dados;
  }

  async function carregarFilaCompleta(vm, force = false) {
    let urlDescoberta = descobrirUrlFila(vm);
    if (!urlDescoberta) urlDescoberta = await sincronizarFonteNativaFila(vm);
    if (!urlDescoberta) {
      throw new Error('A fonte nativa da fila médica ainda não foi identificada.');
    }

    const urlBase = normalizarUrlFila(urlDescoberta);
    const chaveUrl = urlBase.href;
    const agora = Date.now();

    if (!force &&
        filaCache.url === chaveUrl &&
        agora - filaCache.at < CACHE_FILA_MS &&
        Array.isArray(filaCache.itens)) {
      return filaCache.itens;
    }

    if (carregandoFilaCompleta) return carregandoFilaCompleta;

    const promessa = (async () => {
      const todos = [];
      const vistos = new Set();
      const MAX_PAGINAS = 50;

      for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
        const lote = await buscarPaginaFila(urlBase, pagina);
        if (!lote.length) break;

        let novos = 0;
        for (const item of lote) {
          const chave = chaveItem(item);
          if (!chave || vistos.has(chave)) continue;
          vistos.add(chave);
          todos.push(item);
          novos++;
        }

        // Protege contra backend que ignora o parâmetro page e devolve sempre o mesmo lote.
        if (!novos) break;

        // Quando o servidor realmente honra per_page=100, lote menor que 100 indica a última página.
        // Não encerramos por tamanho <=10 porque algumas versões limitam per_page internamente.
        if (lote.length > 10 && lote.length < 100) break;
      }

      filaCache = { at: Date.now(), url: chaveUrl, itens: todos };
      log(`Fila completa: ${todos.length} registro(s).`);
      return todos;
    })();

    carregandoFilaCompleta = promessa;

    try {
      return await promessa;
    } finally {
      if (carregandoFilaCompleta === promessa) carregandoFilaCompleta = null;
    }
  }

  function filtrarItens(itens, filtro) {
    if (filtro === 'RETORNO') return itens.filter(itemEhRetorno);
    if (['VERMELHO', 'AMARELO', 'VERDE', 'AZUL'].includes(filtro)) {
      return itens.filter(item => riscoItem(item) === filtro);
    }
    return itens;
  }

  // ---------------------------------------------------------------------------
  // Interface do filtro
  // ---------------------------------------------------------------------------

  function injetarCSS() {
    if (document.getElementById(`${PREFIX}-css`)) return;

    const style = document.createElement('style');
    style.id = `${PREFIX}-css`;
    style.textContent = `
      #${PREFIX}-box {
        box-sizing: border-box;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 7px;
        width: 100%;
        padding: 10px 12px;
        margin: 10px 0 14px;
        background: #fff;
        border: 1px solid rgba(0,0,0,.14);
        border-radius: 8px;
        box-shadow: 0 2px 8px rgba(0,0,0,.06);
        position: relative;
        z-index: 20;
        font-family: Arial, Helvetica, sans-serif;
      }

      #${PREFIX}-box .om30-titulo {
        font-weight: 700;
        color: #343a40;
        margin-right: 3px;
      }

      #${PREFIX}-box button.om30-filtro-btn {
        appearance: none;
        min-height: 34px;
        padding: 5px 12px;
        border: 2px solid var(--om30-cor);
        border-radius: 18px;
        background: #fff;
        color: #343a40;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
        line-height: 1.2;
      }

      #${PREFIX}-box button.om30-filtro-btn:hover { transform: translateY(-1px); }

      #${PREFIX}-box button.om30-filtro-btn.ativo {
        background: var(--om30-cor);
        color: #fff;
        box-shadow: 0 0 0 2px rgba(0,0,0,.06);
      }

      #${PREFIX}-box button[data-filtro="AMARELO"].ativo { color: #212529; }

      #${PREFIX}-box .om30-resumo {
        margin-left: auto;
        font-size: 12px;
        font-weight: 700;
        color: #6c757d;
      }

      #${PREFIX}-box .om30-aviso {
        width: 100%;
        font-size: 11px;
        color: #777;
        margin-top: 2px;
      }

      #${PREFIX}-pager {
        display: none;
        align-items: center;
        gap: 5px;
        width: 100%;
        margin-top: 3px;
        padding-top: 8px;
        border-top: 1px solid #eee;
      }

      #${PREFIX}-pager.ativo { display: flex; }

      #${PREFIX}-pager button {
        min-width: 30px;
        height: 30px;
        padding: 0 8px;
        border: 1px solid #ced4da;
        border-radius: 5px;
        background: #fff;
        color: #495057;
        cursor: pointer;
        font-weight: 700;
      }

      #${PREFIX}-pager button.pagina-ativa {
        background: #343a40;
        color: #fff;
        border-color: #343a40;
      }

      #${PREFIX}-pager button:disabled { opacity: .45; cursor: default; }
      #${PREFIX}-pager .om30-pager-info { margin-left: 6px; font-size: 12px; color: #6c757d; }

      body.${BODY_CUSTOM} #classificacao .pagination:not(#${PREFIX}-pager) {
        display: none !important;
      }

      tr.${PREFIX}-intruso {
        display: none !important;
      }

      .om30-profissional-retorno {
        margin-top: 3px;
        font-size: 11px;
        font-weight: 700;
        color: #4f6657;
      }

      #${PREFIX}-evolucao-anterior {
        box-sizing: border-box;
        width: 100%;
        margin: 12px 0 16px;
        border: 2px solid #6f42c1;
        border-radius: 8px;
        background: #fbf9ff;
        box-shadow: 0 2px 7px rgba(0,0,0,.06);
        overflow: hidden;
        font-family: Arial, Helvetica, sans-serif;
      }

      #${PREFIX}-evolucao-anterior .om30-card-topo {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 10px 12px;
        background: #6f42c1;
        color: #fff;
        font-weight: 800;
      }

      #${PREFIX}-evolucao-anterior .om30-somente-leitura {
        padding: 3px 8px;
        border: 1px solid rgba(255,255,255,.65);
        border-radius: 12px;
        font-size: 10px;
        white-space: nowrap;
      }

      #${PREFIX}-evolucao-anterior .om30-card-meta {
        padding: 9px 12px;
        border-bottom: 1px solid #ded5ee;
        font-size: 12px;
        color: #443652;
      }

      #${PREFIX}-evolucao-anterior .om30-card-texto {
        padding: 12px;
        white-space: pre-wrap;
        line-height: 1.45;
        color: #2f2933;
        font-size: 13px;
        user-select: text;
      }

      #${PREFIX}-evolucao-anterior .om30-card-erro {
        color: #8a5555;
        font-style: italic;
      }

      #${PREFIX}-retorno-host {
        display: block;
        width: 100%;
        margin: 12px 0 16px;
      }

      @media (max-width: 900px) {
        #${PREFIX}-box .om30-resumo { width: 100%; margin-left: 0; }
      }
    `;

    document.head.appendChild(style);
  }

  function criarFiltro() {
    if (!ehPaginaFila()) return null;

    const classificacao = document.querySelector('#classificacao');
    if (!classificacao) return null;

    let box = document.getElementById(`${PREFIX}-box`);
    if (box) return box;

    const cabecalho = [...classificacao.querySelectorAll('.content-box-header')]
      .find(el => norm(el.querySelector('h2')?.innerText) === 'FILA DE ATENDIMENTO');

    if (!cabecalho) return null;

    box = document.createElement('div');
    box.id = `${PREFIX}-box`;

    const titulo = document.createElement('span');
    titulo.className = 'om30-titulo';
    titulo.textContent = 'Filtrar fila:';
    box.appendChild(titulo);

    for (const filtro of FILTROS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'om30-filtro-btn';
      btn.dataset.filtro = filtro.key;
      btn.style.setProperty('--om30-cor', filtro.cor);
      btn.textContent = filtro.label;

      btn.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();

        const mudou = filtroSelecionado !== filtro.key;
        filtroSelecionado = filtro.key;
        paginaCustom = 1;
        localStorage.setItem(STORAGE_FILTRO, filtroSelecionado);
        atualizarBotoes();

        const vm = acharVueFila();
        if (!vm) return;

        if (filtroSelecionado === 'TODAS') {
          esconderPager();
          const resumo = box.querySelector('.om30-resumo');
          if (resumo) resumo.textContent = 'Exibindo paginação normal da fila';
          if (mudou) atualizarFilaNativa(vm);
          setTimeout(() => processarLinhasRetorno(acharVueFila()), 500);
          return;
        }

        await aplicarFiltroCustom(vm, true);
      });

      box.appendChild(btn);
    }

    const resumo = document.createElement('span');
    resumo.className = 'om30-resumo';
    resumo.textContent = 'Lendo fila...';
    box.appendChild(resumo);

    const aviso = document.createElement('span');
    aviso.className = 'om30-aviso';
    aviso.textContent = 'Filtros por cor e Retorno usam a fila completa e reorganizam a visualização em páginas de 10.';
    box.appendChild(aviso);

    const pager = document.createElement('div');
    pager.id = `${PREFIX}-pager`;
    box.appendChild(pager);

    const h2 = cabecalho.querySelector('h2');
    if (h2) h2.insertAdjacentElement('afterend', box);
    else cabecalho.insertAdjacentElement('afterbegin', box);

    atualizarBotoes();
    return box;
  }

  function atualizarBotoes() {
    const box = document.getElementById(`${PREFIX}-box`);
    if (!box) return;

    box.querySelectorAll('button[data-filtro]').forEach(btn => {
      const ativo = btn.dataset.filtro === filtroSelecionado;
      btn.classList.toggle('ativo', ativo);
      btn.setAttribute('aria-pressed', ativo ? 'true' : 'false');
    });
  }

  function esconderPager() {
    document.body.classList.remove(BODY_CUSTOM);
    const pager = document.getElementById(`${PREFIX}-pager`);
    if (pager) {
      pager.classList.remove('ativo');
      pager.replaceChildren();
    }
  }

  function renderizarPager(totalItens, totalPaginas, vm) {
    const pager = document.getElementById(`${PREFIX}-pager`);
    if (!pager) return;

    document.body.classList.add(BODY_CUSTOM);
    pager.classList.add('ativo');
    pager.replaceChildren();

    const criarBtn = (texto, pagina, disabled = false, ativo = false) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = texto;
      btn.disabled = disabled;
      btn.classList.toggle('pagina-ativa', ativo);
      btn.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        if (pagina === paginaCustom || disabled) return;
        paginaCustom = pagina;
        await aplicarFiltroCustom(vm, false);
      });
      return btn;
    };

    pager.appendChild(criarBtn('‹', Math.max(1, paginaCustom - 1), paginaCustom <= 1));

    const inicio = Math.max(1, Math.min(paginaCustom - 2, Math.max(1, totalPaginas - 4)));
    const fim = Math.min(totalPaginas, inicio + 4);

    for (let p = inicio; p <= fim; p++) {
      pager.appendChild(criarBtn(String(p), p, false, p === paginaCustom));
    }

    pager.appendChild(criarBtn('›', Math.min(totalPaginas, paginaCustom + 1), paginaCustom >= totalPaginas));

    const info = document.createElement('span');
    info.className = 'om30-pager-info';
    info.textContent = `${totalItens} registro(s) · ${ITENS_POR_PAGINA} por página · página ${paginaCustom}/${totalPaginas}`;
    pager.appendChild(info);
  }

  async function aplicarFiltroCustom(vm = acharVueFila(), force = false) {
    if (!vm || filtroSelecionado === 'TODAS') return;

    const minhaSeq = ++sequenciaAplicacao;
    const box = criarFiltro();
    atualizarBotoes();
    if (!box) return;

    const resumo = box.querySelector('.om30-resumo');
    if (resumo) resumo.textContent = 'Carregando fila completa...';

    try {
      const todos = await carregarFilaCompleta(vm, force);
      if (minhaSeq !== sequenciaAplicacao || filtroSelecionado === 'TODAS') return;

      const filtrados = filtrarItens(todos, filtroSelecionado);
      const totalPaginas = Math.max(1, Math.ceil(filtrados.length / ITENS_POR_PAGINA));
      paginaCustom = Math.max(1, Math.min(paginaCustom, totalPaginas));

      const inicio = (paginaCustom - 1) * ITENS_POR_PAGINA;
      const pagina = filtrados.slice(inicio, inicio + ITENS_POR_PAGINA);

      setItensVue(vm, pagina);
      renderizarPager(filtrados.length, totalPaginas, vm);
      setTimeout(() => ocultarIntrusosDoFiltro(vm), 0);
      setTimeout(() => ocultarIntrusosDoFiltro(vm), 120);

      if (resumo) {
        const nomeFiltro = FILTROS.find(f => f.key === filtroSelecionado)?.label || filtroSelecionado;
        resumo.textContent = `${nomeFiltro}: ${filtrados.length} na fila completa`;
      }

      setTimeout(() => processarLinhasRetorno(acharVueFila()), 50);
      setTimeout(() => processarLinhasRetorno(acharVueFila()), 350);

      log('Filtro aplicado', {
        filtro: filtroSelecionado,
        totalFila: todos.length,
        totalFiltrado: filtrados.length,
        pagina: paginaCustom,
        exibidos: pagina.length
      });
    } catch (e) {
      console.error('[OM30 Fila Médica v2.4.6] Erro ao montar fila filtrada:', e);
      if (resumo) resumo.textContent = `Erro ao carregar fila completa: ${e.message || e}`;
    }
  }

  // ---------------------------------------------------------------------------
  // Histórico médico anterior (fonte: HISTÓRICO DE ATENDIMENTOS)
  // ---------------------------------------------------------------------------

  function dataHoraParaMs(data, hora) {
    const d = clean(data);
    const h = clean(hora) || '00:00';

    let ano, mes, dia;
    let m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) [, ano, mes, dia] = m;

    if (!m) {
      m = d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      if (m) [, dia, mes, ano] = m;
    }

    if (!ano) return 0;
    const hm = h.match(/^(\d{1,2}):(\d{2})/);
    const horas = hm ? Number(hm[1]) : 0;
    const minutos = hm ? Number(hm[2]) : 0;
    return new Date(Number(ano), Number(mes) - 1, Number(dia), horas, minutos, 0, 0).getTime();
  }

  function timestampReferenciaFila(item) {
    const candidatos = [
      item?.data_senha_timestamp,
      item?.data_hora_chegada,
      item?.data_chegada,
      item?.created_at
    ];

    for (const bruto of candidatos) {
      if (bruto == null || bruto === '') continue;

      if (typeof bruto === 'number' && Number.isFinite(bruto)) {
        if (bruto > 1e12) return bruto;
        if (bruto > 1e9) return bruto * 1000;
      }

      const txt = clean(bruto);
      if (/^\d{13}$/.test(txt)) return Number(txt);
      if (/^\d{10}$/.test(txt)) return Number(txt) * 1000;

      let m = txt.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
      if (m) {
        return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] || 0), 0).getTime();
      }

      m = txt.match(/^(\d{2})\/(\d{2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
      if (m) {
        return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6] || 0), 0).getTime();
      }

      const parsed = Date.parse(txt);
      if (Number.isFinite(parsed)) return parsed;
    }

    return Date.now();
  }

  function dentroDaJanelaRetorno(timestampAtendimento, referenciaMs = Date.now()) {
    const ts = Number(timestampAtendimento) || 0;
    const ref = Number(referenciaMs) || Date.now();
    if (!(ts > 0) || !(ref > 0)) return false;
    const idade = ref - ts;
    return idade >= 0 && idade <= JANELA_RETORNO_MS;
  }

  function ehEspecialidadeMedica(valor) {
    const n = norm(valor);
    return /^225\d{3}/.test(n) || /\bMEDICO\b/.test(n);
  }

  function acharTabelaHistorico(root = document) {
    return [...root.querySelectorAll('table')].filter(table => {
      const hs = [...table.querySelectorAll('thead th')].map(th => norm(th.textContent));
      return hs.includes('PRONTUARIO') &&
             hs.includes('DATA') &&
             hs.includes('HORA') &&
             hs.includes('PROFISSIONAL') &&
             hs.includes('ESPECIALIDADE');
    });
  }

  function coletarHistoricoMedico(root = document) {
    const registros = [];
    const vistos = new Set();

    for (const table of acharTabelaHistorico(root)) {
      for (const tr of table.querySelectorAll('tbody tr')) {
        const cells = [...tr.cells].map(td => clean(td.textContent));
        if (cells.length < 5) continue;

        const prontuarioNumero = cells[0] || '';
        const dataAgendada = cells[1] || '';
        const horaAgendada = cells[2] || '';
        const profissional = cells[3] || '';
        const especialidade = cells[4] || '';
        if (!profissional || !ehEspecialidadeMedica(especialidade)) continue;

        const acaoModal = tr.querySelector('.load_modal_historicos_atendimentos[data-source], [data-source][data-nivel]');
        const acaoLink = tr.querySelector('a[title*="Detalhes"], a[href*="/prontuarios/"]');
        const acao = acaoModal || acaoLink;

        const atendimentoId = clean(acaoModal?.getAttribute('data-source'));
        const dataNivel = clean(acaoModal?.getAttribute('data-nivel'));
        const href = clean(acaoLink?.getAttribute('href') || acao?.getAttribute('href'));
        const mProntuario = href.match(/\/prontuarios\/(\d+)(?:\/detalhar)?(?:\?|$)/i);
        const prontuarioId = mProntuario?.[1] || '';

        const chave = [prontuarioNumero, dataAgendada, horaAgendada, profissional, especialidade].join('|');
        if (vistos.has(chave)) continue;
        vistos.add(chave);

        registros.push({
          prontuarioNumero,
          prontuarioId,
          atendimentoId: /^\d+$/.test(atendimentoId) ? atendimentoId : '',
          dataNivel,
          href,
          // IMPORTANTE: a tabela de Histórico usa a data do agendamento.
          // Ela serve para localizar o registro, mas NÃO deve ser exibida como data realizada.
          dataAgendada,
          horaAgendada,
          data: '',
          hora: '',
          profissional,
          especialidade,
          timestampAgendado: dataHoraParaMs(dataAgendada, horaAgendada),
          timestamp: 0
        });
      }
    }

    // Mantém a mesma ordem lógica do histórico para localizar o candidato mais recente,
    // mas a data exibida será enriquecida pela página real do prontuário.
    registros.sort((a, b) => b.timestampAgendado - a.timestampAgendado);
    return registros;
  }

  function linhasTextoDocumento(doc) {
    const clone = doc.body?.cloneNode(true);
    if (!clone) return [];
    clone.querySelectorAll('script, style, noscript, button, svg, .tooltip, .popover').forEach(el => el.remove());
    return (clone.innerText || clone.textContent || '')
      .split(/\r?\n/)
      .map(clean)
      .filter(Boolean);
  }

  function valorDepoisDoRotulo(linhas, rotulos, validador = null) {
    const alvos = new Set(rotulos.map(norm));
    for (let i = 0; i < linhas.length; i++) {
      if (!alvos.has(norm(linhas[i]))) continue;
      for (let j = i + 1; j < Math.min(linhas.length, i + 7); j++) {
        const valor = clean(linhas[j]);
        if (!valor || alvos.has(norm(valor))) continue;
        if (!validador || validador(valor)) return valor;
      }
    }
    return '';
  }

  function normalizarNomeUnidade(valor) {
    return norm(valor)
      .replace(/^UNIDADE(?: DE SAUDE)?\s*[:\-]?\s*/, '')
      .replace(/^ESTABELECIMENTO\s*[:\-]?\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function extrairUnidadesDocumento(doc) {
    const ids = new Set();
    const nomes = new Set();

    const adicionarId = valor => {
      const id = soDigitos(valor);
      if (id && /^\d+$/.test(id)) ids.add(id);
    };

    const adicionarNome = valor => {
      const txt = clean(valor);
      if (!txt) return;
      const n = norm(txt);
      if ([
        'UNIDADE', 'UNIDADE DE SAUDE', 'UNIDADE SAUDE',
        'ESTABELECIMENTO', 'UNIDADE DE ATENDIMENTO'
      ].includes(n)) return;
      const canon = normalizarNomeUnidade(txt);
      if (canon.length >= 3 && !/^\d+$/.test(canon)) nomes.add(canon);
    };

    // 1) Fonte mais confiável: campos cujo próprio id/name representa unidade.
    const camposUnidade = [...doc.querySelectorAll('input, select, [data-unidade-id], [data-unidade-saude-id]')]
      .filter(el => norm([
        el.id,
        el.name,
        el.getAttribute?.('data-unidade-id'),
        el.getAttribute?.('data-unidade-saude-id')
      ].filter(Boolean).join(' ')).includes('UNIDADE'));

    for (const el of camposUnidade) {
      adicionarId(el.value || el.getAttribute?.('value') || el.getAttribute?.('data-unidade-id') || el.getAttribute?.('data-unidade-saude-id'));
      if (el.tagName === 'SELECT') {
        const opt = el.selectedOptions?.[0] || el.querySelector('option[selected]');
        if (opt) adicionarNome(opt.textContent);
      }
    }

    // 2) Regex é apenas fallback. Se o HTML tiver MAIS DE UM ID diferente,
    // ele é ambíguo (pode conter templates/ações de outras unidades) e não é usado.
    if (!ids.size) {
      const html = doc.documentElement?.innerHTML || '';
      const regexId = /(?:unidade_saude_id|unidade_id)[^\d]{0,100}(\d{1,10})/gi;
      const encontrados = new Set();
      let m;
      while ((m = regexId.exec(html))) {
        const id = soDigitos(m[1]);
        if (id) encontrados.add(id);
      }
      if (encontrados.size === 1) adicionarId([...encontrados][0]);
    }

    // 3) Nome ao lado de rótulos de unidade/estabelecimento.
    const rotulos = new Set(['UNIDADE', 'UNIDADE DE SAUDE', 'UNIDADE SAUDE', 'ESTABELECIMENTO', 'UNIDADE DE ATENDIMENTO']);
    const elementos = [...doc.querySelectorAll('label, dt, th, strong, b, span, p, div')];
    for (const el of elementos) {
      const texto = clean(el.textContent);
      if (!rotulos.has(norm(texto)) || texto.length > 40) continue;

      const candidatos = [
        el.nextElementSibling,
        el.parentElement?.querySelector?.('.value, .valor, dd, td, span, strong'),
        el.parentElement?.nextElementSibling
      ].filter(Boolean);

      for (const cand of candidatos) {
        const valor = clean(cand.textContent);
        if (!valor || rotulos.has(norm(valor))) continue;
        adicionarNome(valor);
        break;
      }
    }

    // 4) Alguns prontuários mostram o nome como linha isolada: "UNIDADE TESTE GUARUJÁ".
    // Considera apenas elementos-folha para não capturar listas inteiras de unidades.
    for (const el of doc.querySelectorAll('h1,h2,h3,h4,h5,h6,strong,b,span,p,td,div')) {
      if (el.children.length) continue;
      const txt = clean(el.textContent);
      const n = norm(txt);
      if (txt.length > 120) continue;
      if (/^UNIDADE\s+/.test(n) && !rotulos.has(n)) adicionarNome(txt);
    }

    return { ids: [...ids], nomes: [...nomes] };
  }

  function unidadeIdentificada(unidade) {
    return !!(unidade && ((unidade.ids?.length || 0) || (unidade.nomes?.length || 0)));
  }

  function unidadesCompativeis(atual, anterior) {
    if (!unidadeIdentificada(atual) || !unidadeIdentificada(anterior)) return false;

    // O nome explícito da unidade é evidência forte. Comparamos ANTES dos IDs
    // porque páginas de prontuário podem carregar IDs auxiliares em templates/ações.
    const nomesAtual = new Set((atual.nomes || []).map(normalizarNomeUnidade).filter(Boolean));
    const nomesAnterior = new Set((anterior.nomes || []).map(normalizarNomeUnidade).filter(Boolean));
    for (const nome of nomesAtual) {
      if (nomesAnterior.has(nome)) return true;
    }

    const idsAtual = new Set((atual.ids || []).map(String));
    const idsAnterior = new Set((anterior.ids || []).map(String));
    for (const id of idsAtual) {
      if (idsAnterior.has(id)) return true;
    }

    // Se os dois lados têm nomes explícitos e eles não coincidem, é outra unidade.
    if (nomesAtual.size && nomesAnterior.size) return false;

    // Se os dois lados têm IDs explícitos e eles não coincidem, é outra unidade.
    if (idsAtual.size && idsAnterior.size) return false;

    // Um lado só tem nome e o outro só ID: não há evidência suficiente para afirmar
    // que é a mesma unidade. Melhor omitir do que mostrar prontuário de outra unidade.
    return false;
  }

  function descreverUnidade(unidade) {
    if (!unidadeIdentificada(unidade)) return 'não identificada';
    if (unidade.nomes?.length) return unidade.nomes.join(' / ');
    return `ID ${unidade.ids.join(', ')}`;
  }

  function extrairMetaProntuario(doc) {
    const linhas = linhasTextoDocumento(doc);
    const corte = linhas.findIndex(l => ['EVOLUCAO CLINICA', 'HISTORICO DE ATENDIMENTOS'].includes(norm(l)));
    const topo = corte > 0 ? linhas.slice(0, corte) : linhas.slice(0, 160);

    const data = valorDepoisDoRotulo(topo, ['Data'], v => /^(?:\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2})$/.test(v));
    const hora = valorDepoisDoRotulo(topo, ['Hora'], v => /^\d{1,2}:\d{2}(?::\d{2})?$/.test(v));
    const profissional = valorDepoisDoRotulo(topo, ['Médico', 'Medico', 'Profissional']);
    const especialidade = valorDepoisDoRotulo(topo, ['Especialidade']);
    const unidade = extrairUnidadesDocumento(doc);

    return {
      data,
      hora,
      profissional,
      especialidade,
      unidade,
      timestamp: dataHoraParaMs(data, hora)
    };
  }

  async function carregarProntuarioAnterior(registro) {
    const chave = registro?.prontuarioId || registro?.atendimentoId || registro?.prontuarioNumero;
    if (!chave) return null;
    if (cacheProntuarioAnterior.has(chave)) return cacheProntuarioAnterior.get(chave);

    const promessa = (async () => {
      const urls = [];
      if (registro.prontuarioId) urls.push(`/prontuarios/${encodeURIComponent(registro.prontuarioId)}`);
      if (registro.atendimentoId) {
        urls.push(`/ambulatorial/atendimentos/show_modal_historico_atendimento?atendimento_id=${encodeURIComponent(registro.atendimentoId)}`);
      }

      for (const url of urls) {
        try {
          const resp = await fetch(url, {
            credentials: 'same-origin',
            redirect: 'follow',
            cache: 'no-store'
          });
          if (!resp.ok) continue;
          const html = await resp.text();
          const doc = new DOMParser().parseFromString(html, 'text/html');
          return { url, doc, meta: extrairMetaProntuario(doc) };
        } catch (e) {
          warn('Falha ao abrir prontuário anterior:', e);
        }
      }
      return null;
    })();

    cacheProntuarioAnterior.set(chave, promessa);
    return promessa;
  }

  async function carregarUnidadeAtendimentoHistorico(registro) {
    const atendimentoId = clean(registro?.atendimentoId);
    const nivel = clean(registro?.dataNivel);
    if (!/^\d+$/.test(atendimentoId) || !/^[a-z0-9_-]+$/i.test(nivel)) {
      return { ids: [], nomes: [] };
    }

    const chave = `${nivel}|${atendimentoId}`;
    if (cacheUnidadeAtendimentoAnterior.has(chave)) {
      return cacheUnidadeAtendimentoAnterior.get(chave);
    }

    const promessa = (async () => {
      try {
        // É a mesma rota que o Saúde Simples usa ao abrir o atendimento completo
        // a partir do Histórico de Atendimentos. Nela o unidade_saude_id tende a
        // estar disponível mesmo quando /prontuarios/{id} mostra apenas o nome.
        const url = `/ambulatorial/${encodeURIComponent(nivel)}/atendimentos/${encodeURIComponent(atendimentoId)}`;
        const resp = await fetch(url, {
          credentials: 'same-origin',
          redirect: 'follow',
          cache: 'no-store'
        });
        if (!resp.ok) return { ids: [], nomes: [] };
        const html = await resp.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        return extrairUnidadesDocumento(doc);
      } catch (e) {
        warn('Falha ao identificar unidade do atendimento histórico:', e);
        return { ids: [], nomes: [] };
      }
    })();

    cacheUnidadeAtendimentoAnterior.set(chave, promessa);
    return promessa;
  }

  async function enriquecerRegistroAnterior(registro) {
    if (!registro) return null;
    const carregado = await carregarProntuarioAnterior(registro);
    const meta = carregado?.meta || {};

    const enriquecido = {
      ...registro,
      data: meta.data || '',
      hora: meta.hora || '',
      profissional: meta.profissional || registro.profissional,
      especialidade: meta.especialidade || registro.especialidade,
      unidade: meta.unidade || registro.unidade || { ids: [], nomes: [] },
      timestamp: meta.timestamp || 0,
      _docProntuario: carregado?.doc || null,
      _fonteProntuario: carregado?.url || ''
    };

    return enriquecido;
  }

  function dataCodificadaNoNumeroProntuario(numero, unidadeAtual) {
    const n = soDigitos(numero);
    if (!n) return null;

    // Nos prontuários da U/E observados, o número começa pelo ID da unidade
    // e logo em seguida traz a data YYMMDD. Ex.: 122260926... = unidade 122,
    // 26/09/2026. Usamos isso SOMENTE como índice rápido; a hora real continua
    // sendo confirmada na página do prontuário antes de aceitar o retorno.
    const ids = [...new Set((unidadeAtual?.ids || []).map(soDigitos).filter(Boolean))]
      .sort((a, b) => b.length - a.length);

    for (const id of ids) {
      if (!n.startsWith(id)) continue;
      const data6 = n.slice(id.length, id.length + 6);
      const m = data6.match(/^(\d{2})(\d{2})(\d{2})$/);
      if (!m) continue;

      const ano = 2000 + Number(m[1]);
      const mes = Number(m[2]);
      const dia = Number(m[3]);
      const dt = new Date(ano, mes - 1, dia, 12, 0, 0, 0);
      if (dt.getFullYear() !== ano || dt.getMonth() !== mes - 1 || dt.getDate() !== dia) continue;
      return { idUnidade: id, ano, mes, dia, timestampDia: dt.getTime() };
    }

    return null;
  }

  function candidatoRapidoMesmaUnidade36h(registro, unidadeAtual, referenciaMs) {
    const codificada = dataCodificadaNoNumeroProntuario(registro?.prontuarioNumero, unidadeAtual);
    if (!codificada) return false;

    const ref = new Date(Number(referenciaMs) || Date.now());
    const inicio = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() - 2, 0, 0, 0, 0).getTime();
    const fim = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), 23, 59, 59, 999).getTime();
    return codificada.timestampDia >= inicio && codificada.timestampDia <= fim;
  }

  async function buscarHistoricoAnteriorDoAtual(atendimentoStr, referenciaMs = Date.now()) {
    const refMs = Number(referenciaMs) || Date.now();
    const chaveCacheHistorico = `${atendimentoStr}|${Math.floor(refMs / 60000)}`;
    if (cacheHistoricoAnterior.has(chaveCacheHistorico)) {
      return cacheHistoricoAnterior.get(chaveCacheHistorico);
    }

    const atendimento = parseAtendimento(atendimentoStr);
    if (!atendimento) return null;

    const promessa = (async () => {
      try {
        const url = '/prontuarios/new' +
          '?prontuariavel_id=' + encodeURIComponent(atendimento.id) +
          '&prontuariavel_type=' + encodeURIComponent(atendimento.tipo);

        const resp = await fetch(url, {
          credentials: 'same-origin',
          redirect: 'follow',
          cache: 'no-store'
        });

        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const html = await resp.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');

        const unidadeAtual = extrairUnidadesDocumento(doc);
        if (!unidadeIdentificada(unidadeAtual)) {
          warn('Unidade atual não identificada; histórico anterior não será escolhido por aproximação.', atendimentoStr);
          return null;
        }

        const candidatos = coletarHistoricoMedico(doc);
        if (!candidatos.length) return null;

        // CAMINHO RÁPIDO:
        // primeiro reduz a lista pelo ID da unidade + data codificados no número
        // do prontuário. Assim uma ficha com dezenas de históricos não dispara
        // dezenas de GETs só para descobrir que estão fora das 36h.
        let candidatosRecentes = candidatos.filter(r => candidatoRapidoMesmaUnidade36h(r, unidadeAtual, refMs));

        // Se o ambiente não expuser ID da unidade/número no padrão observado,
        // usa um fallback curto. Não volta a varrer o histórico inteiro.
        if (!candidatosRecentes.length && !(unidadeAtual.ids?.length)) {
          candidatosRecentes = candidatos.slice(0, 8);
        }

        if (!candidatosRecentes.length) {
          log('Nenhum candidato da mesma unidade em datas compatíveis com 36h', atendimentoStr, descreverUnidade(unidadeAtual));
          return null;
        }

        // Normalmente serão 1-3 registros. Busca todos em paralelo e confirma
        // a DATA/HORA REAL do atendimento antes de aceitar.
        const resultados = await Promise.allSettled(candidatosRecentes.map(enriquecerRegistroAnterior));
        const compativeis = [];

        for (const resultado of resultados) {
          if (resultado.status !== 'fulfilled' || !resultado.value) continue;
          const registro = resultado.value;
          if (!(Number(registro.timestamp) > 0)) continue;
          if (!dentroDaJanelaRetorno(registro.timestamp, refMs)) continue;

          // O prefixo do número já comprovou o ID da mesma unidade. Se a página
          // também trouxer unidade explícita e ela conflitar, rejeita por segurança.
          const codificada = dataCodificadaNoNumeroProntuario(registro.prontuarioNumero, unidadeAtual);
          if (!codificada) continue;

          const unidadeAnterior = registro.unidade || { ids: [], nomes: [] };
          if (unidadeIdentificada(unidadeAnterior) && !unidadesCompativeis(unidadeAtual, unidadeAnterior)) {
            // Só faz UMA confirmação adicional quando existe conflito explícito.
            const unidadeDoAtendimento = await carregarUnidadeAtendimentoHistorico(registro);
            if (!unidadesCompativeis(unidadeAtual, unidadeDoAtendimento)) continue;
            registro.unidade = unidadeDoAtendimento;
          } else if (!unidadeIdentificada(unidadeAnterior)) {
            registro.unidade = { ids: [codificada.idUnidade], nomes: [] };
          }

          compativeis.push(registro);
        }

        compativeis.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
        const registro = compativeis[0] || null;

        if (registro) {
          registro.unidadeAtual = unidadeAtual;
          log('Último atendimento médico anterior NA MESMA UNIDADE / 36h', atendimentoStr, {
            unidadeAtual: descreverUnidade(unidadeAtual),
            prontuario: registro.prontuarioId || registro.prontuarioNumero,
            profissional: registro.profissional,
            realizadoEm: [registro.data, registro.hora].filter(Boolean).join(' ')
          });
        } else {
          log('Nenhum atendimento médico anterior na mesma unidade dentro de 36h', atendimentoStr, descreverUnidade(unidadeAtual));
        }

        return registro;
      } catch (e) {
        console.error('[OM30 Fila Médica v2.4.6] Histórico anterior:', atendimentoStr, e);
        return null;
      }
    })();

    cacheHistoricoAnterior.set(chaveCacheHistorico, promessa);
    return promessa;
  }

  function criarInfoProfissional(row) {
    const celula = row.cells?.[2];
    if (!celula) return null;

    let info = celula.querySelector('.om30-profissional-retorno');
    if (!info) {
      info = document.createElement('div');
      info.className = 'om30-profissional-retorno';
      celula.appendChild(info);
    }
    return info;
  }

  async function processarLinhaRetorno(row, vm) {
    const item = itemDaLinha(row, vm);
    if (!item || !itemEhRetorno(item) || !item.atendimento_str) return;

    const chave = chaveItem(item);
    if (row.dataset.om30RetornoProcessado === chave) return;
    row.dataset.om30RetornoProcessado = chave;

    // Exibe feedback imediato enquanto consulta o último atendimento válido.
    // Se não existir atendimento na mesma unidade dentro de 36h, a mensagem é removida.
    const infoConsulta = criarInfoProfissional(row);
    if (infoConsulta) {
      infoConsulta.style.color = '#6c757d';
      infoConsulta.textContent = 'Último atendimento nesta unidade: consultando...';
    }

    const referenciaMs = timestampReferenciaFila(item);
    const anterior = await buscarHistoricoAnteriorDoAtual(item.atendimento_str, referenciaMs);

    if (anterior?.profissional) {
      row.__om30AtendimentoAnterior = {
        prontuarioNumero: clean(anterior.prontuarioNumero),
        prontuarioId: clean(anterior.prontuarioId),
        atendimentoId: clean(anterior.atendimentoId),
        dataNivel: clean(anterior.dataNivel),
        href: clean(anterior.href),
        dataAgendada: clean(anterior.dataAgendada),
        horaAgendada: clean(anterior.horaAgendada),
        data: clean(anterior.data),
        hora: clean(anterior.hora),
        profissional: clean(anterior.profissional),
        especialidade: clean(anterior.especialidade),
        unidade: {
          ids: Array.isArray(anterior.unidade?.ids) ? anterior.unidade.ids.map(String) : [],
          nomes: Array.isArray(anterior.unidade?.nomes) ? anterior.unidade.nomes.map(String) : []
        },
        timestampAgendado: Number(anterior.timestampAgendado) || 0,
        timestamp: Number(anterior.timestamp) || 0
      };

      const info = criarInfoProfissional(row);
      if (!info) return;
      info.style.color = '#4f6657';
      const quandoReal = [anterior.data, anterior.hora].filter(Boolean).join(' ');
      info.textContent = `Último atendimento nesta unidade: ${anterior.profissional}${quandoReal ? ` · realizado em ${quandoReal}` : ''}`;
    } else {
      row.__om30AtendimentoAnterior = null;

      const info = criarInfoProfissional(row);
      if (!info) return;

      info.style.color = '#8a5555';
      info.textContent =
        'Nenhum profissional encontrado — atendimento há mais de 36h ou realizado manualmente.';
    }
  }

  async function processarLinhasRetorno(vm = acharVueFila()) {
    if (!vm) return;
    const rows = linhasFila();
    await Promise.allSettled(rows.map(row => processarLinhaRetorno(row, vm)));
  }

  function linhaPertenceAoFiltro(row, vm) {
    const item = itemDaLinha(row, vm);
    if (!item) return false;
    if (filtroSelecionado === 'RETORNO') return itemEhRetorno(item);
    if (['VERMELHO', 'AMARELO', 'VERDE', 'AZUL'].includes(filtroSelecionado)) {
      return riscoItem(item) === filtroSelecionado;
    }
    return true;
  }

  function ocultarIntrusosDoFiltro(vm = acharVueFila()) {
    if (!vm || filtroSelecionado === 'TODAS') {
      linhasFila().forEach(row => row.classList.remove(`${PREFIX}-intruso`));
      return;
    }

    for (const row of linhasFila()) {
      row.classList.toggle(`${PREFIX}-intruso`, !linhaPertenceAoFiltro(row, vm));
    }
  }

  function solicitarReaplicacaoFiltro(vm = acharVueFila(), delay = 20) {
    if (!vm || filtroSelecionado === 'TODAS') return;
    clearTimeout(timerGuardiaoFiltro);
    timerGuardiaoFiltro = setTimeout(() => aplicarFiltroCustom(vm, true), delay);
  }

  function instalarGuardiaoVue(vm) {
    if (!vm || vm.__om30GuardiaoFiltroInstalado) return;
    vm.__om30GuardiaoFiltroInstalado = true;

    if (typeof vm.fetchCollection === 'function') {
      const original = vm.fetchCollection;
      vm.fetchCollection = function (...args) {
        const self = this || vm;
        let retorno;
        try {
          retorno = original.apply(self, args);
        } finally {
          Promise.resolve(retorno).finally(() => {
            if (filtroSelecionado === 'TODAS' || sincronizandoFonteNativa) return;
            setTimeout(() => {
              ocultarIntrusosDoFiltro(self);
              solicitarReaplicacaoFiltro(self, 0);
            }, 0);
          });
        }
        return retorno;
      };
      log('Guardião instalado sobre fetchCollection da fila.');
    }
  }

  // ---------------------------------------------------------------------------
  // Contexto de clique em uma senha RT / retorno
  // ---------------------------------------------------------------------------

  function salvarContextoRetorno(item, atendimentoAnterior = null) {
    if (!item || !itemEhRetorno(item) || !item.atendimento_str) return;

    const contexto = {
      criadoEm: Date.now(),
      atendimentoStr: item.atendimento_str,
      senha: clean(item.senha),
      codigoCns: clean(item.codigo_cns),
      nomeMunicipe: clean(item.nome_municipe),
      origem: location.href,
      referenciaMs: timestampReferenciaFila(item),
      // Snapshot do EXATO prontuário anterior exibido na fila.
      // Só contém dados primitivos para poder ir ao sessionStorage.
      atendimentoAnterior: atendimentoAnterior ? {
        prontuarioNumero: clean(atendimentoAnterior.prontuarioNumero),
        prontuarioId: clean(atendimentoAnterior.prontuarioId),
        atendimentoId: clean(atendimentoAnterior.atendimentoId),
        dataNivel: clean(atendimentoAnterior.dataNivel),
        href: clean(atendimentoAnterior.href),
        dataAgendada: clean(atendimentoAnterior.dataAgendada),
        horaAgendada: clean(atendimentoAnterior.horaAgendada),
        data: clean(atendimentoAnterior.data),
        hora: clean(atendimentoAnterior.hora),
        profissional: clean(atendimentoAnterior.profissional),
        especialidade: clean(atendimentoAnterior.especialidade),
        unidade: {
          ids: Array.isArray(atendimentoAnterior.unidade?.ids) ? atendimentoAnterior.unidade.ids.map(String) : [],
          nomes: Array.isArray(atendimentoAnterior.unidade?.nomes) ? atendimentoAnterior.unidade.nomes.map(String) : []
        },
        timestampAgendado: Number(atendimentoAnterior.timestampAgendado) || 0,
        timestamp: Number(atendimentoAnterior.timestamp) || 0
      } : null
    };

    sessionStorage.setItem(SESSION_RETORNO, JSON.stringify(contexto));
    log('Contexto de retorno preparado:', contexto.senha, contexto.atendimentoStr);
  }

  function lerContextoRetorno() {
    let contexto;
    try {
      contexto = JSON.parse(sessionStorage.getItem(SESSION_RETORNO) || 'null');
    } catch (_) {
      return null;
    }

    if (!contexto?.atendimentoStr || !contexto?.criadoEm) return null;
    if (Date.now() - Number(contexto.criadoEm) > CONTEXTO_MAX_MS) {
      sessionStorage.removeItem(SESSION_RETORNO);
      return null;
    }

    return contexto;
  }

  function paginaCombinaComPaciente(contexto) {
    const body = clean(document.body?.innerText || document.body?.textContent);
    if (!body) return false;

    const cns = soDigitos(contexto.codigoCns);
    if (cns.length >= 10 && soDigitos(body).includes(cns)) return true;

    const nome = norm(contexto.nomeMunicipe);
    if (nome.length >= 5 && norm(body).includes(nome)) return true;

    return false;
  }

  function instalarCapturaCliqueRetorno() {
    if (document.__om30CapturaRtInstalada) return;
    document.__om30CapturaRtInstalada = true;

    document.addEventListener('click', event => {
      if (!ehPaginaFila()) return;

      const botaoAtender = event.target.closest?.('.botao-atender, [class*="botao-atender"]');
      if (!botaoAtender) return;

      const row = botaoAtender.closest('tr.collection-row');
      if (!row) return;

      const vm = acharVueFila();
      const item = itemDaLinha(row, vm);
      if (!itemEhRetorno(item)) return;

      salvarContextoRetorno(item, row.__om30AtendimentoAnterior || null);
    }, true);
  }

  // ---------------------------------------------------------------------------
  // Quadro somente leitura no atendimento de retorno
  // ---------------------------------------------------------------------------

  function visivel(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
  }

  function idAtendimentoDaPagina() {
    const candidatos = [
      document.querySelector('#prontuario_prontuariavel_id')?.value,
      document.querySelector('input[name="prontuario[prontuariavel_id]"]')?.value,
      document.querySelector('#resource_id')?.value,
      new URLSearchParams(location.search).get('prontuariavel_id')
    ].map(clean).filter(v => /^\d+$/.test(v));

    const rota = location.pathname.match(/\/atendimentos_pas\/(\d+)\/prontuario/i);
    if (rota?.[1]) candidatos.unshift(rota[1]);
    return candidatos[0] || '';
  }

  function paginaCombinaComContexto(contexto) {
    const parsed = parseAtendimento(contexto.atendimentoStr);
    const idPagina = idAtendimentoDaPagina();

    if (parsed?.id && idPagina) return parsed.id === idPagina;
    return paginaCombinaComPaciente(contexto);
  }

  function acharEvolucaoAtual() {
    const portlets = [...document.querySelectorAll('.portlet')]
      .filter(portlet => norm(portlet.querySelector('.portlet-header')?.textContent) === 'EVOLUCAO CLINICA');

    return portlets.find(visivel) || portlets[0] ||
      document.querySelector('textarea[id*="motivo_descricao"]')?.closest('.portlet, .content-box, .grid_16') || null;
  }

  const SECOES_CLINICAS = [
    { key: 'acolhimento', label: 'Acolhimento', aliases: ['ACOLHIMENTO'] },
    { key: 'motivo', label: 'Motivo do atendimento e descrição do exame clínico', aliases: ['MOTIVO DO ATENDIMENTO E DESCRICAO DO EXAME CLINICO', 'MOTIVO DE ATENDIMENTO', 'MOTIVO DO ATENDIMENTO'] },
    { key: 'diagnostico', label: 'Diagnóstico', aliases: ['DIAGNOSTICO'] },
    { key: 'cid', label: 'CID', aliases: ['CID', 'CIDS'] },
    { key: 'notificacao', label: 'Notificação compulsória', aliases: ['NOTIFICACAO COMPULSORIA'] },
    { key: 'procedimentos', label: 'Procedimentos', aliases: ['PROCEDIMENTOS/CIDS', 'PROCEDIMENTOS / CIDS', 'PROCEDIMENTOS'] },
    { key: 'exames', label: 'Exames', aliases: ['EXAMES'] },
    { key: 'medicamentos', label: 'Medicação', aliases: ['MEDICAMENTOS', 'MEDICACAO', 'MEDICAMENTO'] },
    { key: 'receituario', label: 'Receituário', aliases: ['RECEITUARIO'] },
    { key: 'conduta', label: 'Conduta', aliases: ['CONDUTA', 'CONDUTAS'] },
    { key: '_faturamento', label: 'Faturamento', aliases: ['FATURAMENTO', 'FATURAMENTO BPA', 'FATURAMENTO RAAS'] }
  ];

  const FRASES_VAZIAS = [
    'NAO FORAM SOLICITADOS EXAMES',
    'NAO FORAM SOLICITADOS PROCEDIMENTOS',
    'NAO FORAM PRESCRITOS MEDICAMENTOS',
    'NAO FORAM RECEITADOS MEDICAMENTOS',
    'NAO FORAM INSERIDAS CONDUTAS',
    'NAO FORAM INSERIDOS PROCEDIMENTOS',
    'NAO FORAM LANCADOS PROCEDIMENTOS',
    'NAO HA PROCEDIMENTO',
    'NAO HA PROCEDIMENTOS',
    'NAO EXISTEM FATURAMENTOS',
    'SEM INFORMACAO',
    'NAO PREENCHIDO'
  ];

  const ROTULOS_RUIDO = new Set([
    '—', '-', '|', 'EXIBE FA', 'AUTOMATICO', 'PROCEDIMENTO', 'QUANTIDADE', 'CID', 'CIDS',
    'SITUACAO', 'ACOES', 'CLASSIFICACAO', 'LOCAL', 'CODIGO', 'DESCRICAO', 'ENCAMINHAMENTO',
    'ENCAMINHAMENTOS', 'MEDICACAO', 'MEDICAMENTOS', 'MEDICAMENTO', 'VIA DE ADMINISTRACAO',
    'POSOLOGIA', 'OBSERVACAO', 'SEM PRIORIDADE', 'MAIS DETALHES', 'FECHAR', 'FATURAMENTO BPA',
    'FATURAMENTO RAAS', 'FATURAMENTO', 'CONTROLE DE SALAS'
  ]);

  const TODOS_TITULOS_CLINICOS = new Set(
    SECOES_CLINICAS.flatMap(s => s.aliases)
  );

  function linhaClinicaVazia(valor) {
    const n = norm(valor);
    if (!n || ROTULOS_RUIDO.has(n)) return true;
    if (/^\d+[.)]?$/.test(n)) return true;
    return FRASES_VAZIAS.some(frase => n.includes(frase));
  }

  function cloneClinico(doc) {
    const clone = doc.body?.cloneNode(true) || doc.documentElement?.cloneNode(true);
    if (!clone) return null;
    clone.querySelectorAll(
      'script,style,noscript,button,svg,.tooltip,.popover,.btn,nav,.pagination,[aria-hidden="true"]'
    ).forEach(el => el.remove());
    // Ações do prontuário não são informação clínica.
    clone.querySelectorAll('a').forEach(a => {
      const n = norm(a.textContent);
      if (/LAUDO|ATESTADO|DECLARACAO|ESPECIALIZACAO|INTERNACAO|TERAPIA|IMPRIMIR|ACESSAR|UPLOAD|EDITAR|NOVO/.test(n)) a.remove();
    });
    return clone;
  }

  function linhasDocumentoClinico(doc) {
    const clone = cloneClinico(doc);
    if (!clone) return [];

    // Consolida títulos semânticos em um único text node. Isso cobre templates em
    // que o texto do título vem quebrado em <strong>/<span> internos.
    const seletorTitulos = 'h1,h2,h3,h4,h5,h6,legend,dt,th,label,strong,b,.portlet-header,.panel-heading,.accordion-heading,.accordion-toggle';
    for (const el of clone.querySelectorAll(seletorTitulos)) {
      const txt = clean(el.textContent);
      if (!txt) continue;
      const n = norm(txt);
      if (TODOS_TITULOS_CLINICOS.has(n)) el.textContent = txt;
    }

    // NÃO usa innerText aqui: o HTML vem de DOMParser/fetch e não está renderizado.
    // Em documentos destacados, innerText pode achatar/remover quebras e foi a causa
    // de Motivo/Diagnóstico sumirem. Lemos os text nodes na ordem real do HTML.
    const linhas = [];
    const walker = doc.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const txt = clean(node.textContent);
      if (!txt) continue;
      linhas.push(txt);
    }
    return linhas;
  }

  function linhaBateAlias(valor, aliases) {
    const n = norm(valor);
    for (const alias of aliases) {
      if (n === alias) return { bate: true, resto: '' };
      if (n.startsWith(alias + ' ')) {
        return { bate: true, resto: clean(String(valor).slice(alias.length)) };
      }
    }
    return { bate: false, resto: '' };
  }

  function indicesMarcador(linhas, aliases) {
    const out = [];
    for (let i = 0; i < linhas.length; i++) {
      const m = linhaBateAlias(linhas[i], aliases);
      if (m.bate) out.push({ index: i, resto: m.resto });
    }
    return out;
  }

  function limparValoresSecao(valores, limite = 30) {
    const out = [];
    const vistos = new Set();
    for (const valor of valores) {
      const txt = clean(valor);
      const n = norm(txt);
      if (!txt || linhaClinicaVazia(txt) || TODOS_TITULOS_CLINICOS.has(n)) continue;
      if (/^(NOVO |EDITAR |IMPRIMIR |ACESSAR |UPLOAD |LAUDO APAC)/.test(n)) continue;
      if (vistos.has(n)) continue;
      vistos.add(n);
      out.push(txt);
      if (out.length >= limite) break;
    }
    return out;
  }

  function extrairEntreMarcadores(linhas, inicioAliases, fimAliases, limite = 30, maxSpan = 120) {
    const inicios = indicesMarcador(linhas, inicioAliases);
    const fins = indicesMarcador(linhas, fimAliases);
    let melhor = null;

    for (const ini of inicios) {
      const fim = fins.find(f => f.index > ini.index && f.index - ini.index <= maxSpan);
      if (!fim) continue;
      const crus = [];
      if (ini.resto) crus.push(ini.resto);
      crus.push(...linhas.slice(ini.index + 1, fim.index));
      const valores = limparValoresSecao(crus, limite);
      if (!valores.length) continue;
      const span = fim.index - ini.index;
      // Prefere o bloco preenchido mais curto: evita títulos duplicados de accordions/pais.
      if (!melhor || span < melhor.span || (span === melhor.span && valores.length > melhor.valores.length)) {
        melhor = { span, valores };
      }
    }
    return melhor?.valores || [];
  }

  function extrairNotificacao(linhas) {
    const valores = extrairEntreMarcadores(
      linhas,
      ['NOTIFICACAO COMPULSORIA'],
      ['PROCEDIMENTOS/CIDS', 'PROCEDIMENTOS / CIDS', 'PROCEDIMENTOS'],
      20,
      100
    );
    const uteis = [];
    for (const v of valores) {
      const n = norm(v);
      // Rótulo sem valor ou rótulo seguido somente de traço não conta como dado preenchido.
      if (/^(DOENCA\/AGRAVO|CONFIRMACAO|DATA DOS PRIMEIROS SINTOMAS)(\s*[:\-—]?\s*)?$/.test(n)) continue;
      if (/^(DOENCA\/AGRAVO|CONFIRMACAO|DATA DOS PRIMEIROS SINTOMAS)\s*[:\-—]\s*[\-—]?$/.test(n)) continue;
      if (/^(DOENCA\/AGRAVO|CONFIRMACAO|DATA DOS PRIMEIROS SINTOMAS)\s+[\-—]$/.test(n)) continue;
      uteis.push(v);
    }
    return limparValoresSecao(uteis, 20);
  }

  function detectarCabecalhoTabela(table) {
    const rows = [...table.querySelectorAll('tr')];
    if (!rows.length) return null;
    const palavras = new Set([
      'PROCEDIMENTO','QUANTIDADE','CID','SITUACAO','CODIGO','DESCRICAO','ENCAMINHAMENTO',
      'MEDICAMENTO','VIA DE ADMINISTRACAO','POSOLOGIA','OBSERVACAO'
    ]);
    let melhor = null;
    for (let r = 0; r < Math.min(rows.length, 4); r++) {
      const cells = [...rows[r].cells].map(c => clean(c.textContent));
      if (!cells.length) continue;
      const hits = cells.map(norm).filter(v => palavras.has(v)).length;
      if (!melhor || hits > melhor.hits) melhor = { rowIndex: r, headers: cells, hits };
    }
    return melhor && melhor.hits >= 2 ? melhor : null;
  }

  function dadosTabela(table, info) {
    const rows = [...table.querySelectorAll('tr')];
    return rows
      .filter((_, i) => i !== info.rowIndex)
      .map(tr => [...tr.cells].map(c => clean(c.textContent)))
      .filter(cells => cells.some(v => !linhaClinicaVazia(v)));
  }

  function indiceHeader(headers, aliases) {
    const hs = headers.map(norm);
    for (const alias of aliases) {
      const idx = hs.findIndex(h => h === alias || h.includes(alias));
      if (idx >= 0) return idx;
    }
    return -1;
  }

  function valorCell(cells, idx) {
    if (idx < 0 || idx >= cells.length) return '';
    const v = clean(cells[idx]);
    const n = norm(v);
    // Em tabelas, números são dados reais (Qtd. 1, código 0204030153 etc.).
    // Portanto NÃO usa linhaClinicaVazia(), que remove números isolados.
    if (!n || ['—', '-', '|'].includes(n)) return '';
    if (FRASES_VAZIAS.some(frase => n.includes(frase))) return '';
    return v;
  }

  function coletarTabelasEstruturadas(doc) {
    const out = { procedimentos: [], exames: [], medicamentos: [], cid: [] };
    const raiz = doc.body || doc.documentElement;
    if (!raiz) return out;

    for (const table of raiz.querySelectorAll('table')) {
      const info = detectarCabecalhoTabela(table);
      if (!info) {
        // Tabela simples de CID pode ter apenas EXIBE FA como cabeçalho.
        for (const tr of table.querySelectorAll('tr')) {
          for (const td of tr.cells) {
            const txt = clean(td.textContent);
            if (/^[A-Z]\d{3,4}\s*-\s*.+/i.test(txt)) out.cid.push(txt);
          }
        }
        continue;
      }

      const hs = info.headers.map(norm);
      const tem = x => hs.some(h => h === x || h.includes(x));
      const rows = dadosTabela(table, info);

      if (tem('PROCEDIMENTO') && tem('QUANTIDADE')) {
        const iProc = indiceHeader(info.headers, ['PROCEDIMENTO']);
        const iQtd = indiceHeader(info.headers, ['QUANTIDADE']);
        const iCid = indiceHeader(info.headers, ['CID']);
        const iSit = indiceHeader(info.headers, ['SITUACAO']);
        for (const cells of rows) {
          const procedimento = valorCell(cells, iProc >= 0 ? iProc : 0);
          if (!procedimento || norm(procedimento) === 'PROCEDIMENTO') continue;
          const qtd = valorCell(cells, iQtd);
          const cid = valorCell(cells, iCid);
          const sit = valorCell(cells, iSit);
          out.procedimentos.push({
            titulo: procedimento,
            codigo: '',
            detalhes: [qtd ? `Qtd. ${qtd}` : '', cid ? `CID: ${cid}` : '', sit].filter(Boolean)
          });
        }
        continue;
      }

      if (tem('CODIGO') && tem('DESCRICAO') && tem('ENCAMINHAMENTO')) {
        const iCodigo = indiceHeader(info.headers, ['CODIGO']);
        const iDesc = indiceHeader(info.headers, ['DESCRICAO']);
        const iEnc = indiceHeader(info.headers, ['ENCAMINHAMENTO']);
        const iSit = indiceHeader(info.headers, ['SITUACAO']);
        for (const cells of rows) {
          const codigo = valorCell(cells, iCodigo);
          const descricao = valorCell(cells, iDesc);
          const enc = valorCell(cells, iEnc);
          const sit = valorCell(cells, iSit);
          if (!codigo && !descricao) continue;
          out.exames.push({
            titulo: descricao || codigo,
            codigo: descricao && codigo ? codigo : '',
            detalhes: [enc, sit].filter(Boolean)
          });
        }
        continue;
      }

      if (tem('MEDICAMENTO') && tem('VIA DE ADMINISTRACAO') && tem('POSOLOGIA')) {
        const iMed = indiceHeader(info.headers, ['MEDICAMENTO']);
        const iVia = indiceHeader(info.headers, ['VIA DE ADMINISTRACAO']);
        const iPos = indiceHeader(info.headers, ['POSOLOGIA']);
        const iObs = indiceHeader(info.headers, ['OBSERVACAO']);
        const iSit = indiceHeader(info.headers, ['SITUACAO']);
        for (const cells of rows) {
          const med = valorCell(cells, iMed);
          if (!med || norm(med) === 'MEDICAMENTO') continue;
          const via = valorCell(cells, iVia);
          const pos = valorCell(cells, iPos);
          const obs = valorCell(cells, iObs);
          const sit = valorCell(cells, iSit);
          out.medicamentos.push({
            titulo: med,
            codigo: '',
            detalhes: [
              via ? `Via: ${via}` : '',
              pos ? `Posologia: ${pos}` : '',
              obs ? `Obs.: ${obs}` : '',
              sit
            ].filter(Boolean)
          });
        }
      }
    }

    return out;
  }


  const CAMPOS_ACOLHIMENTO = [
    { label: 'PA', aliases: ['PA (MMHG)', 'PRESSAO ARTERIAL', 'AFERICAO DE PRESSAO ARTERIAL'] },
    { label: 'Temperatura', aliases: ['TEMP. (OC)', 'TEMP. (°C)', 'TEMPERATURA', 'TEMPERATURA (OC)', 'TEMPERATURA (°C)'] },
    { label: 'FC', aliases: ['FC (BPM)', 'FREQUENCIA CARDIACA'] },
    { label: 'FR', aliases: ['FR (RPM)', 'FR (FRM)', 'FR (IRPM)', 'FREQUENCIA RESPIRATORIA'] },
    { label: 'Glicemia', aliases: ['GLI (MG/DL)', 'GLICEMIA CAPILAR', 'GLICEMIA'] },
    { label: 'Sat. O₂', aliases: ['SAT 02 (%)', 'SAT O2 (%)', 'SAT. O2 (%)', 'SATURACAO O2', 'SATURACAO DE OXIGENIO'] },
    { label: 'Peso', aliases: ['PESO'] },
    { label: 'Altura', aliases: ['ALTURA'] },
    { label: 'Dor', aliases: ['AVALIACAO DA DOR', 'ESCALA DE DOR', 'DOR'] },
    { label: 'Classificação', aliases: ['CLASSIFICACAO DE RISCO', 'GRAU DE RISCO'] },
    { label: 'Alergias', aliases: ['ALERGIAS', 'ALERGIA'] },
    { label: 'Medicação em uso', aliases: ['MEDICACAO EM USO'] },
    { label: 'Descritivo', aliases: ['DESCRITIVO DO ATENDIMENTO', 'DESCRICAO DO ATENDIMENTO'] }
  ];

  const CAMPOS_ACOLHIMENTO_BOOLEANOS = [
    { label: 'DM', aliases: ['DM', 'DMS', 'DIABETES', 'DIABETES MELLITUS'] },
    { label: 'HAS', aliases: ['HAS', 'HIPERTENSAO', 'HIPERTENSAO ARTERIAL'] },
    { label: 'ICO', aliases: ['ICO'] },
    { label: 'AVE', aliases: ['AVE'] },
    { label: 'DPOC', aliases: ['DPOC'] },
    { label: 'Tabagista', aliases: ['TABAGISTA', 'TABAGISMO'] }
  ];

  const ROTULOS_ACOLHIMENTO = new Set([
    'AFERICAO', 'SIGLA', 'ANTECEDENTES', 'FACE DA DOR', 'CHORO', 'PALIDEZ',
    'SUDORESE', 'AGITACAO', 'OUTROS', 'ATENDIMENTO',
    ...CAMPOS_ACOLHIMENTO.flatMap(c => c.aliases),
    ...CAMPOS_ACOLHIMENTO_BOOLEANOS.flatMap(c => c.aliases)
  ]);

  function normalizarValorAcolhimento(valor) {
    const txt = clean(valor);
    const n = norm(txt);
    if (!txt || ['—', '-', '|'].includes(n)) return '';
    if (FRASES_VAZIAS.some(frase => n.includes(frase))) return '';
    return txt;
  }

  const SELETOR_TITULO_CLINICO_DOM = [
    'h1','h2','h3','h4','h5','h6','legend','dt',
    '.portlet-header','.panel-heading','.accordion-heading','.accordion-toggle',
    '[role="heading"]','strong','b','th','label'
  ].join(',');

  function textoProprioClinico(el) {
    if (!el) return '';
    return clean([...el.childNodes]
      .filter(node => node.nodeType === Node.TEXT_NODE)
      .map(node => node.textContent)
      .join(' '));
  }

  function scoreTituloClinico(el, aliases) {
    if (!el) return -Infinity;
    const proprio = norm(textoProprioClinico(el));
    const completo = norm(clean(el.textContent));
    const bateProprio = aliases.includes(proprio);
    const bateCompleto = aliases.includes(completo);
    if (!bateProprio && !bateCompleto) return -Infinity;

    let score = 0;
    if (bateProprio) score += 8;
    if (/^H[1-6]$/.test(el.tagName) || ['LEGEND', 'DT'].includes(el.tagName)) score += 8;
    if (/header|heading|title|titulo/i.test(String(el.className || ''))) score += 6;
    if (['STRONG', 'B'].includes(el.tagName)) score += 3;
    if (['TH', 'LABEL'].includes(el.tagName)) score -= 2;
    if (el.children.length === 0) score += 2;
    if (completo.length <= 80) score += 1;
    return score;
  }

  function titulosClinicosDom(doc, aliases) {
    return [...doc.querySelectorAll(SELETOR_TITULO_CLINICO_DOM)]
      .map(el => ({ el, score: scoreTituloClinico(el, aliases) }))
      .filter(x => Number.isFinite(x.score));
  }

  function vemDepoisDom(a, b) {
    return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  function distanciaDom(inicio, fim) {
    if (!inicio || !fim) return Number.MAX_SAFE_INTEGER;
    let n = 0;
    const walker = inicio.ownerDocument.createTreeWalker(
      inicio.ownerDocument.documentElement,
      NodeFilter.SHOW_ELEMENT
    );
    let viuInicio = false;
    let node;
    while ((node = walker.nextNode())) {
      if (node === inicio) {
        viuInicio = true;
        continue;
      }
      if (!viuInicio) continue;
      n++;
      if (node === fim) return n;
      if (n > 5000) break;
    }
    return Number.MAX_SAFE_INTEGER;
  }

  function valorControleClinico(el) {
    if (!el) return '';
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const tipo = String(el.type || '').toLowerCase();
      if (['hidden', 'submit', 'button', 'reset', 'file', 'image'].includes(tipo)) return '';
      if (['checkbox', 'radio'].includes(tipo)) {
        if (!el.checked) return '';
        const v = clean(el.value);
        return !v || ['1', 'true', 'on'].includes(v.toLowerCase()) ? 'Sim' : v;
      }
      return clean(el.value || el.getAttribute('value'));
    }
    if (tag === 'TEXTAREA') return clean(el.value || el.textContent);
    if (tag === 'SELECT') {
      const opt = el.options?.[el.selectedIndex];
      return clean(opt?.textContent || el.value);
    }
    return '';
  }

  function prepararFragmentoClinico(fragmento) {
    const doc = fragmento.ownerDocument || document;
    const wrap = doc.createElement('div');
    wrap.appendChild(fragmento.cloneNode(true));
    wrap.querySelectorAll('script,style,noscript,button,svg,.tooltip,.popover,.btn,nav,.pagination,[aria-hidden="true"]').forEach(el => el.remove());

    // O histórico pode trazer sinais/descrições em inputs, selects e textareas.
    // Text-node-only ignora esses valores; convertemos controles preenchidos em texto.
    for (const el of [...wrap.querySelectorAll('input,textarea,select')]) {
      const valor = valorControleClinico(el);
      const span = doc.createElement('span');
      span.textContent = valor;
      el.replaceWith(span);
    }
    return wrap;
  }

  function linhasDoFragmentoClinico(fragmento) {
    if (!fragmento) return [];
    const wrap = prepararFragmentoClinico(fragmento);
    const linhas = [];
    const walker = wrap.ownerDocument.createTreeWalker(wrap, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const txt = clean(node.textContent);
      if (txt) linhas.push(txt);
    }
    return linhas;
  }

  function candidatosFragmentoEntreTitulos(doc, inicioAliases, fimAliases, maxDist = 2500) {
    const inicios = titulosClinicosDom(doc, inicioAliases);
    const fins = titulosClinicosDom(doc, fimAliases);
    const candidatos = [];

    for (const ini of inicios) {
      const depois = fins
        .filter(f => vemDepoisDom(ini.el, f.el))
        .map(f => ({ ...f, dist: distanciaDom(ini.el, f.el) }))
        .filter(f => f.dist <= maxDist)
        .sort((a, b) => a.dist - b.dist || b.score - a.score);
      const fim = depois[0];
      if (!fim) continue;

      try {
        const range = doc.createRange();
        range.setStartAfter(ini.el);
        range.setEndBefore(fim.el);
        const fragmento = range.cloneContents();
        const linhas = linhasDoFragmentoClinico(fragmento);
        const uteis = limparValoresSecao(linhas, 80);
        candidatos.push({ fragmento, linhas: uteis, dist: fim.dist, score: ini.score + fim.score });
      } catch (_) {}
    }

    return candidatos.sort((a, b) => {
      const aPreenchido = a.linhas.length ? 1 : 0;
      const bPreenchido = b.linhas.length ? 1 : 0;
      if (aPreenchido !== bPreenchido) return bPreenchido - aPreenchido;
      if (a.dist !== b.dist) return a.dist - b.dist;
      if (a.score !== b.score) return b.score - a.score;
      return a.linhas.length - b.linhas.length;
    });
  }

  function extrairTextoSecaoDom(doc, inicioAliases, fimAliases, limite = 8) {
    const candidatos = candidatosFragmentoEntreTitulos(doc, inicioAliases, fimAliases);
    for (const c of candidatos) {
      const valores = limparValoresSecao(c.linhas, limite)
        .filter(v => !TODOS_TITULOS_CLINICOS.has(norm(v)));
      if (valores.length) return valores;
    }
    return [];
  }

  function rotuloAmigavelAcolhimento(rotulo) {
    const n = norm(rotulo).replace(/\s*[:：]\s*$/, '');
    if (!n) return '';
    for (const campo of CAMPOS_ACOLHIMENTO) {
      if (campo.aliases.some(a => n === a || n.startsWith(a + ' '))) return campo.label;
    }
    for (const campo of CAMPOS_ACOLHIMENTO_BOOLEANOS) {
      if (campo.aliases.some(a => n === a || n.startsWith(a + ' '))) return campo.label;
    }
    if (['AFERICAO', 'SIGLA', 'ANTECEDENTES', 'ATENDIMENTO'].includes(n)) return '';
    if (TODOS_TITULOS_CLINICOS.has(n) || ROTULOS_RUIDO.has(n)) return '';
    const txt = clean(rotulo).replace(/\s*[:：]\s*$/, '');
    if (txt.length < 2 || txt.length > 70) return '';
    // Não transforma valores em rótulos no fallback sequencial (ex.: 120/80 -> 38,5).
    if (/^\d+(?:[.,]\d+)?(?:\s*[xX\/-]\s*\d+(?:[.,]\d+)?)?(?:\s*%|\s*°?[CF])?$/.test(txt)) return '';
    if (/^(SIM|NAO|NÃO|POSITIVO|NEGATIVO|PRESENTE|AUSENTE)$/i.test(txt)) return '';
    if (txt.split(/\s+/).length > 7) return '';
    return txt;
  }

  function valorUtilAcolhimento(valor) {
    const v = normalizarValorAcolhimento(valor);
    const n = norm(v);
    if (!v) return '';
    if (['NAO', 'NÃO', 'FALSE', '0'].includes(n)) return '';
    if (TODOS_TITULOS_CLINICOS.has(n) || ROTULOS_ACOLHIMENTO.has(n)) return '';
    return v;
  }

  function extrairParesAcolhimentoFragmento(fragmento) {
    if (!fragmento) return [];
    const doc = fragmento.ownerDocument || document;
    const wrap = doc.createElement('div');
    wrap.appendChild(fragmento.cloneNode(true));
    wrap.querySelectorAll('script,style,noscript,button,svg,.tooltip,.popover,.btn,nav,.pagination,[aria-hidden="true"]').forEach(el => el.remove());
    const encontrados = [];
    const vistos = new Set();

    const adicionar = (rotuloRaw, valorRaw) => {
      const rotulo = rotuloAmigavelAcolhimento(rotuloRaw);
      const valor = valorUtilAcolhimento(valorRaw);
      if (!rotulo || !valor) return;
      if (norm(rotulo) === norm(valor)) return;
      const chave = norm(`${rotulo}:${valor}`);
      if (vistos.has(chave)) return;
      vistos.add(chave);
      encontrados.push(`${rotulo}: ${valor}`);
    };

    // label -> controle/valor associado.
    for (const label of wrap.querySelectorAll('label')) {
      const rotulo = clean(label.textContent);
      const alvoId = label.getAttribute('for');
      let controle = null;
      if (alvoId) controle = [...wrap.querySelectorAll('input,textarea,select')].find(el => el.id === alvoId) || null;
      controle ||= label.querySelector('input,textarea,select');
      if (!controle) {
        const container = label.closest('li,.input,.field,.form-group,td,div') || label.parentElement;
        controle = container?.querySelector('input,textarea,select') || null;
      }
      if (controle) adicionar(rotulo, valorControleClinico(controle));
    }

    // Tabelas de sinais vitais / classificação: suporta pares TH/TD e células alternadas.
    for (const tr of wrap.querySelectorAll('tr')) {
      const cells = [...tr.cells];
      if (cells.length < 2) continue;
      for (let i = 0; i + 1 < cells.length; i += 2) {
        adicionar(cells[i].textContent, cells[i + 1].textContent);
      }
    }

    // <dt>Rótulo</dt><dd>Valor</dd>
    for (const dt of wrap.querySelectorAll('dt')) {
      const dd = dt.nextElementSibling;
      if (dd?.tagName === 'DD') adicionar(dt.textContent, dd.textContent);
    }

    // Estrutura comum do prontuário: <li><strong>Rótulo</strong></li><li>Valor</li>
    for (const forte of wrap.querySelectorAll('strong,b')) {
      const rotulo = clean(forte.textContent);
      const pai = forte.closest('li,div,td,p') || forte.parentElement;
      if (!pai) continue;
      const copia = pai.cloneNode(true);
      copia.querySelectorAll('strong,b,label').forEach(el => el.remove());
      let valor = clean(copia.textContent);
      if (!valor && pai.nextElementSibling) valor = clean(pai.nextElementSibling.textContent);
      adicionar(rotulo, valor);
    }

    // Fallback por sequência de texto, mas somente dentro do bloco Acolhimento.
    const linhas = linhasDoFragmentoClinico(fragmento).map(clean).filter(Boolean);
    const aliasesConhecidos = [
      ...CAMPOS_ACOLHIMENTO.flatMap(c => c.aliases),
      ...CAMPOS_ACOLHIMENTO_BOOLEANOS.flatMap(c => c.aliases)
    ];
    for (let i = 0; i < linhas.length; i++) {
      const nLinha = norm(linhas[i]);
      if (!aliasesConhecidos.some(alias => nLinha === alias || nLinha.startsWith(alias + ' '))) continue;
      const rotulo = rotuloAmigavelAcolhimento(linhas[i]);
      if (!rotulo) continue;
      for (let j = i + 1; j < Math.min(linhas.length, i + 4); j++) {
        const nCand = norm(linhas[j]);
        if (['NAO', 'NÃO', 'FALSE', '0'].includes(nCand)) break;
        if (aliasesConhecidos.some(alias => nCand === alias || nCand.startsWith(alias + ' '))) break;
        const candidato = valorUtilAcolhimento(linhas[j]);
        if (!candidato) continue;
        adicionar(rotulo, candidato);
        break;
      }
    }

    return encontrados.slice(0, 24);
  }

  function acharPortletClinicoReal(doc, titulo) {
    const alvo = norm(titulo);
    for (const header of doc.querySelectorAll('.portlet-header')) {
      const proprio = norm(textoProprioClinico(header));
      const completo = norm(clean(header.textContent));
      if (proprio !== alvo && completo !== alvo) continue;
      const portlet = header.closest('.portlet');
      if (portlet) return portlet;
    }
    return null;
  }

  function extrairEvolucaoClinicaReal(doc) {
    const resultado = { motivo: [], diagnostico: [] };
    const portlet = acharPortletClinicoReal(doc, 'EVOLUCAO CLINICA');
    const raiz = portlet || doc;

    for (const table of raiz.querySelectorAll('table')) {
      const headers = [...table.querySelectorAll('thead th')].map(th => clean(th.textContent));
      if (headers.length < 2) continue;
      const hn = headers.map(norm);
      const iMotivo = hn.findIndex(h => [
        'MOTIVO DE ATENDIMENTO',
        'MOTIVO DO ATENDIMENTO',
        'MOTIVO DO ATENDIMENTO E DESCRICAO DO EXAME CLINICO'
      ].includes(h));
      const iDiagnostico = hn.findIndex(h => h === 'DIAGNOSTICO');
      if (iMotivo < 0 || iDiagnostico < 0) continue;

      for (const tr of table.querySelectorAll('tbody tr')) {
        const cells = [...tr.cells].map(td => clean(td.textContent));
        const motivo = valorCell(cells, iMotivo);
        const diagnostico = valorCell(cells, iDiagnostico);
        if (motivo) resultado.motivo.push(motivo);
        if (diagnostico) resultado.diagnostico.push(diagnostico);
        if (motivo || diagnostico) break;
      }

      if (resultado.motivo.length || resultado.diagnostico.length) break;
    }

    resultado.motivo = dedupeStrings(resultado.motivo);
    resultado.diagnostico = dedupeStrings(resultado.diagnostico);
    return resultado;
  }

  function extrairAcolhimento(doc) {
    const portlet = acharPortletClinicoReal(doc, 'ACOLHIMENTO');
    if (!portlet) return [];

    const conteudo = portlet.querySelector('.portlet-content') || portlet;
    const encontrados = [];
    const vistos = new Set();

    const adicionar = (rotuloRaw, valorRaw) => {
      const rotulo = rotuloAmigavelAcolhimento(rotuloRaw);
      const valor = valorUtilAcolhimento(valorRaw);
      if (!rotulo || !valor) return;
      if (norm(rotulo) === norm(valor)) return;
      const chave = norm(`${rotulo}:${valor}`);
      if (vistos.has(chave)) return;
      vistos.add(chave);
      encontrados.push(`${rotulo}: ${valor}`);
    };

    // Estrutura REAL observada em /prontuarios/{id}:
    // Aferição | Sigla | Procedimento. O valor está na 1ª coluna e o rótulo na 2ª.
    for (const table of conteudo.querySelectorAll('table')) {
      const headers = [...table.querySelectorAll('thead th')].map(th => norm(th.textContent));
      const iAfericao = headers.findIndex(h => h === 'AFERICAO');
      const iSigla = headers.findIndex(h => h === 'SIGLA');
      const iProcedimento = headers.findIndex(h => h === 'PROCEDIMENTO');
      if (iAfericao < 0 || iSigla < 0) continue;

      for (const tr of table.querySelectorAll('tbody tr')) {
        const cells = [...tr.cells].map(td => clean(td.textContent));
        const valor = valorCell(cells, iAfericao);
        if (!valor) continue;
        const sigla = valorCell(cells, iSigla);
        const procedimento = valorCell(cells, iProcedimento);
        adicionar(sigla || procedimento, valor);
      }
    }

    // Estrutura REAL observada no restante do Acolhimento:
    // <div class="grid_*"><strong>Alergias</strong><li>TESTE</li></div>
    // Também cobre Antecedentes, avaliação de dor, Medicação em uso e Descritivo.
    for (const forte of conteudo.querySelectorAll('strong,b')) {
      const rotulo = clean(forte.textContent);
      if (!rotulo) continue;

      let valor = '';
      const pai = forte.parentElement;
      if (pai?.tagName === 'LI') {
        valor = clean(pai.nextElementSibling?.textContent);
      }

      if (!valor) {
        const caixa = forte.closest('div,td,p,li');
        if (caixa) {
          const candidatos = [...caixa.querySelectorAll('li')]
            .filter(li => !li.contains(forte))
            .map(li => clean(li.textContent))
            .filter(Boolean);
          valor = candidatos[0] || '';
        }
      }

      if (!valor) {
        const caixa = forte.closest('div,td,p,li');
        if (caixa) {
          const clone = caixa.cloneNode(true);
          clone.querySelectorAll('strong,b,label,h1,h2,h3,h4,h5,h6').forEach(el => el.remove());
          valor = clean(clone.textContent);
        }
      }

      adicionar(rotulo, valor);
    }

    // Caso algum template do acolhimento venha com controles em vez de texto estático.
    for (const label of conteudo.querySelectorAll('label')) {
      const rotulo = clean(label.textContent);
      const alvoId = label.getAttribute('for');
      let controle = alvoId ? [...conteudo.querySelectorAll('input,textarea,select')].find(el => el.id === alvoId) : null;
      controle ||= label.querySelector('input,textarea,select');
      if (!controle) {
        const caixa = label.closest('.input,.field,.form-group,li,td,div');
        controle = caixa?.querySelector('input,textarea,select') || null;
      }
      if (controle) adicionar(rotulo, valorControleClinico(controle));
    }

    return encontrados.slice(0, 24);
  }


  function dedupeStrings(valores) {
    const out = [];
    const vistos = new Set();
    for (const v of valores || []) {
      const txt = clean(v);
      const n = norm(txt);
      if (!txt || linhaClinicaVazia(txt) || vistos.has(n)) continue;
      vistos.add(n);
      out.push(txt);
    }
    return out;
  }

  function dedupeItens(itens) {
    const out = [];
    const vistos = new Set();
    for (const item of itens || []) {
      if (!item) continue;
      const detalhes = dedupeStrings(item.detalhes || []);
      const chave = norm([item.titulo, item.codigo, ...detalhes].join('|'));
      if (!chave || vistos.has(chave)) continue;
      vistos.add(chave);
      out.push({ titulo: clean(item.titulo), codigo: clean(item.codigo), detalhes });
    }
    return out;
  }

  function extrairSecoesClinicas(doc) {
    const linhas = linhasDocumentoClinico(doc);
    const tabelas = coletarTabelasEstruturadas(doc);
    const secoes = [];

    const acolhimento = extrairAcolhimento(doc, linhas);
    if (acolhimento.length) secoes.push({ key: 'acolhimento', label: 'Acolhimento', linhas: acolhimento, itens: [] });

    // Na ficha REAL, Motivo e Diagnóstico são duas COLUNAS da mesma tabela dentro de Evolução Clínica.
    // Ler "entre títulos" mistura as duas informações; por isso a tabela é a fonte primária.
    const evolucaoReal = extrairEvolucaoClinicaReal(doc);

    const motivo = evolucaoReal.motivo.length ? evolucaoReal.motivo : extrairTextoSecaoDom(
      doc,
      ['MOTIVO DO ATENDIMENTO E DESCRICAO DO EXAME CLINICO', 'MOTIVO DE ATENDIMENTO', 'MOTIVO DO ATENDIMENTO'],
      ['DIAGNOSTICO'],
      8
    );
    if (motivo.length) secoes.push({ key: 'motivo', label: 'Motivo do atendimento e descrição do exame clínico', linhas: motivo, itens: [] });

    const diagnostico = evolucaoReal.diagnostico.length ? evolucaoReal.diagnostico : extrairTextoSecaoDom(doc, ['DIAGNOSTICO'], ['CID', 'CIDS'], 8);
    if (diagnostico.length) secoes.push({ key: 'diagnostico', label: 'Diagnóstico', linhas: diagnostico, itens: [] });

    const cidLinhas = extrairEntreMarcadores(
      linhas,
      ['CID', 'CIDS'],
      ['NOTIFICACAO COMPULSORIA', 'PROCEDIMENTOS/CIDS', 'PROCEDIMENTOS / CIDS', 'PROCEDIMENTOS'],
      20,
      120
    ).filter(v => /^[A-Z]\d{3,4}(?:\s*-\s*.+)?$/i.test(clean(v)));
    const cids = dedupeStrings([...(tabelas.cid || []), ...cidLinhas]);
    if (cids.length) secoes.push({ key: 'cid', label: 'CID', linhas: cids, itens: [] });

    const notif = extrairNotificacao(linhas);
    if (notif.length) secoes.push({ key: 'notificacao', label: 'Notificação compulsória', linhas: notif, itens: [] });

    const procedimentos = dedupeItens(tabelas.procedimentos);
    if (procedimentos.length) secoes.push({ key: 'procedimentos', label: 'Procedimentos', linhas: [], itens: procedimentos });

    const exames = dedupeItens(tabelas.exames);
    if (exames.length) secoes.push({ key: 'exames', label: 'Exames', linhas: [], itens: exames });

    const medicamentos = dedupeItens(tabelas.medicamentos);
    if (medicamentos.length) secoes.push({ key: 'medicamentos', label: 'Medicação', linhas: [], itens: medicamentos });

    const receituario = extrairEntreMarcadores(linhas, ['RECEITUARIO'], ['CONDUTA', 'CONDUTAS'], 30, 120);
    if (receituario.length) secoes.push({ key: 'receituario', label: 'Receituário', linhas: receituario, itens: [] });

    const conduta = extrairEntreMarcadores(
      linhas,
      ['CONDUTA', 'CONDUTAS'],
      ['FATURAMENTO', 'FATURAMENTO BPA', 'FATURAMENTO RAAS'],
      30,
      160
    );
    if (conduta.length) secoes.push({ key: 'conduta', label: 'Conduta', linhas: conduta, itens: [] });

    return secoes;
  }

  function mesclarSecoesClinicas(principal, fallback) {
    const p = new Map((principal || []).map(s => [s.key, s]));
    const f = new Map((fallback || []).map(s => [s.key, s]));
    const estruturadas = new Set(['procedimentos', 'exames', 'medicamentos']);
    const saida = [];

    for (const def of SECOES_CLINICAS) {
      if (def.key.startsWith('_')) continue;
      const a = p.get(def.key);
      const b = f.get(def.key);

      if (estruturadas.has(def.key)) {
        const itens = dedupeItens([...(a?.itens || []), ...(b?.itens || [])]);
        if (itens.length) saida.push({ key: def.key, label: def.label, linhas: [], itens });
        continue;
      }

      // Para texto clínico, a fonte principal vence; fallback só preenche ausência real.
      const linhas = dedupeStrings(a?.linhas?.length ? a.linhas : (b?.linhas || []));
      if (linhas.length) saida.push({ key: def.key, label: def.label, linhas, itens: [] });
    }
    return saida;
  }

  async function buscarDetalhesRegistro(registro) {
    const chave = registro?.atendimentoId || registro?.prontuarioId || registro?.prontuarioNumero;
    if (!chave) return { secoes: [], fonte: '' };
    if (cacheDetalhesAnterior.has(chave)) return cacheDetalhesAnterior.get(chave);

    const promessa = (async () => {
      let secoesProntuario = [];
      let secoesModal = [];

      // 1) Ficha completa, quando existe ID interno do prontuário.
      let docProntuario = registro?._docProntuario || null;
      if (!docProntuario && registro?.prontuarioId) {
        try {
          const resp = await fetch(`/prontuarios/${encodeURIComponent(registro.prontuarioId)}`, {
            credentials: 'same-origin', redirect: 'follow', cache: 'no-store'
          });
          if (resp.ok) {
            const html = await resp.text();
            docProntuario = new DOMParser().parseFromString(html, 'text/html');
          }
        } catch (e) {
          warn('Falha ao abrir ficha completa do prontuário anterior:', e);
        }
      }
      if (docProntuario) secoesProntuario = extrairSecoesClinicas(docProntuario);

      // 2) Lupa do Histórico de Atendimentos. Sempre consulta também, porque ela pode
      //    ter linhas/tabelas que a ficha completa não expôs no HTML inicial.
      if (registro?.atendimentoId) {
        try {
          const urlModal = `/ambulatorial/atendimentos/show_modal_historico_atendimento?atendimento_id=${encodeURIComponent(registro.atendimentoId)}`;
          const resp = await fetch(urlModal, { credentials: 'same-origin', redirect: 'follow', cache: 'no-store' });
          if (resp.ok) {
            const html = await resp.text();
            const docModal = new DOMParser().parseFromString(html, 'text/html');
            secoesModal = extrairSecoesClinicas(docModal);
          }
        } catch (e) {
          warn('Falha ao abrir a lupa do histórico anterior:', e);
        }
      }

      const secoes = mesclarSecoesClinicas(secoesProntuario, secoesModal);
      return {
        secoes,
        fonte: secoesProntuario.length ? 'Prontuário' : (secoesModal.length ? 'Histórico de Atendimentos' : '')
      };
    })();

    cacheDetalhesAnterior.set(chave, promessa);
    return promessa;
  }

  function criarCardRetorno(registro, detalhes) {
    const host = document.createElement('div');
    host.id = `${PREFIX}-retorno-host`;

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all:initial; display:block; width:100%; margin:8px 0 10px; font-family:Arial,Helvetica,sans-serif; }
      * { box-sizing:border-box; }

      .card {
        border:1px solid #d9d4e0;
        border-left:4px solid #6f42c1;
        border-radius:8px;
        background:#fff;
        box-shadow:0 1px 5px rgba(0,0,0,.05);
        overflow:hidden;
        color:#26212b;
      }

      .topo {
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:8px;
        padding:7px 10px;
        background:#f5f1fa;
        border-bottom:1px solid #e5deec;
      }
      .titulo { font-size:13px; font-weight:800; color:#4f2b70; letter-spacing:.1px; }
      .leitura {
        flex:none;
        font-size:8px;
        font-weight:800;
        color:#6f42c1;
        border:1px solid #c5b3d5;
        border-radius:10px;
        padding:2px 6px;
        background:#fff;
      }

      .meta {
        display:grid;
        grid-template-columns:minmax(190px,1.45fr) minmax(145px,.75fr) minmax(145px,.8fr);
        gap:5px 10px;
        padding:6px 10px;
        border-bottom:1px solid #eee;
        background:#fff;
      }
      .meta-item { min-width:0; }
      .meta-label {
        display:block;
        margin-bottom:1px;
        font-size:8.5px;
        font-weight:800;
        text-transform:uppercase;
        letter-spacing:.3px;
        color:#817788;
      }
      .meta-value {
        display:block;
        overflow-wrap:anywhere;
        font-size:11.5px;
        line-height:1.25;
        font-weight:700;
        color:#352c3c;
      }

      .conteudo {
        padding:8px 10px 10px;
        background:#fcfbfd;
      }

      .topo-clinico {
        display:grid;
        grid-template-columns:minmax(0,1fr) minmax(0,1fr);
        gap:7px;
      }
      .topo-clinico + .corpo-clinico { margin-top:7px; }

      .corpo-clinico {
        display:grid;
        grid-template-columns:minmax(0,.88fr) minmax(0,1.12fr);
        align-items:start;
        gap:7px;
      }
      .corpo-clinico.uma-coluna { grid-template-columns:1fr; }

      .coluna {
        display:flex;
        flex-direction:column;
        gap:7px;
        min-width:0;
      }

      .secao {
        min-width:0;
        padding:7px 8px;
        border:1px solid #e7e2ea;
        border-radius:6px;
        background:#fff;
      }
      .secao-acolhimento,
      .secao-motivo,
      .secao-notificacao { grid-column:1 / -1; }

      .secao-acolhimento .valor {
        display:flex;
        flex-wrap:wrap;
        gap:4px 5px;
      }
      .secao-acolhimento .linha {
        padding:2px 6px;
        border:1px solid #eee9f1;
        border-radius:4px;
        background:#f8f7f9;
        font-size:10.5px;
      }
      .secao-acolhimento .linha + .linha {
        border-top:1px solid #eee9f1;
        margin-top:0;
        padding-top:2px;
      }

      .rotulo {
        margin-bottom:4px;
        font-size:9.5px;
        font-weight:800;
        text-transform:uppercase;
        letter-spacing:.3px;
        color:#6f42c1;
      }
      .valor {
        font-size:11.5px;
        line-height:1.32;
        color:#242126;
        user-select:text;
        overflow-wrap:anywhere;
      }
      .linha { padding:1px 0; }
      .linha + .linha {
        border-top:1px dashed #eee;
        margin-top:2px;
        padding-top:3px;
      }

      .item {
        display:grid;
        grid-template-columns:minmax(0,1fr) auto;
        column-gap:7px;
        row-gap:3px;
        padding:5px 6px;
        border:1px solid #eee9f1;
        border-radius:5px;
        background:#fff;
      }
      .item + .item { margin-top:5px; }

      .item-titulo {
        min-width:0;
        font-size:11px;
        font-weight:700;
        color:#242126;
        line-height:1.28;
        overflow-wrap:anywhere;
      }
      .item-codigo {
        grid-column:2;
        grid-row:1;
        align-self:start;
        display:inline-block;
        margin:0;
        padding:2px 5px;
        border-radius:4px;
        background:#f3f0f5;
        font-size:9px;
        line-height:1.2;
        font-weight:700;
        color:#5f5665;
        white-space:nowrap;
      }
      .item-detalhes {
        grid-column:1 / -1;
        display:flex;
        flex-wrap:wrap;
        gap:3px 5px;
        margin-top:1px;
        font-size:9.5px;
        color:#625969;
      }
      .item-detalhe {
        display:inline-block;
        padding:2px 5px;
        border-radius:4px;
        background:#f8f7f9;
        border:1px solid #eee;
        white-space:normal;
      }

      .vazio { padding:9px 10px; font-size:11px; color:#766d7b; font-style:italic; }

      @media (max-width:900px) {
        .meta { grid-template-columns:1fr; }
        .topo-clinico,
        .corpo-clinico { grid-template-columns:1fr; }
        .secao-acolhimento,
        .secao-motivo,
        .secao-notificacao { grid-column:1; }
      }
    `;

    const card = document.createElement('section');
    card.className = 'card';

    const topo = document.createElement('div');
    topo.className = 'topo';
    const titulo = document.createElement('div');
    titulo.className = 'titulo';
    titulo.textContent = 'RETORNO - ATENDIMENTO ANTERIOR';
    const leitura = document.createElement('span');
    leitura.className = 'leitura';
    leitura.textContent = 'SOMENTE LEITURA';
    topo.append(titulo, leitura);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const quando = [registro.data, registro.hora].filter(Boolean).join(' ');
    for (const [rotuloTxt, valorTxt] of [
      ['Profissional', registro.profissional],
      ['Realizado em', quando],
      ['Especialidade', registro.especialidade]
    ]) {
      if (!clean(valorTxt)) continue;
      const item = document.createElement('div');
      item.className = 'meta-item';
      const label = document.createElement('span');
      label.className = 'meta-label';
      label.textContent = rotuloTxt + ':';
      const value = document.createElement('span');
      value.className = 'meta-value';
      value.textContent = valorTxt;
      item.append(label, value);
      meta.appendChild(item);
    }
    card.append(topo, meta);

    const secoes = Array.isArray(detalhes?.secoes) ? detalhes.secoes : [];
    if (!secoes.length) {
      const vazio = document.createElement('div');
      vazio.className = 'vazio';
      vazio.textContent = 'Nenhuma informação clínica preenchida foi localizada no atendimento anterior.';
      card.appendChild(vazio);
      shadow.append(style, card);
      return host;
    }

    const conteudo = document.createElement('div');
    conteudo.className = 'conteudo';

    const criarBlocoSecao = secao => {
      const bloco = document.createElement('div');
      bloco.className = 'secao';
      if (secao?.key) bloco.classList.add(`secao-${secao.key}`);

      const rotulo = document.createElement('div');
      rotulo.className = 'rotulo';
      rotulo.textContent = secao.label;

      const valor = document.createElement('div');
      valor.className = 'valor';

      if (Array.isArray(secao.itens) && secao.itens.length) {
        for (const itemInfo of secao.itens) {
          const item = document.createElement('div');
          item.className = 'item';

          const itTitulo = document.createElement('div');
          itTitulo.className = 'item-titulo';
          itTitulo.textContent = itemInfo.titulo || itemInfo.codigo || '';
          item.appendChild(itTitulo);

          if (itemInfo.codigo && itemInfo.codigo !== itemInfo.titulo) {
            const cod = document.createElement('div');
            cod.className = 'item-codigo';
            cod.textContent = itemInfo.codigo;
            item.appendChild(cod);
          }

          if (Array.isArray(itemInfo.detalhes) && itemInfo.detalhes.length) {
            const dets = document.createElement('div');
            dets.className = 'item-detalhes';

            for (const detalhe of itemInfo.detalhes) {
              if (!clean(detalhe)) continue;
              const d = document.createElement('span');
              d.className = 'item-detalhe';
              d.textContent = detalhe;
              dets.appendChild(d);
            }

            if (dets.childNodes.length) item.appendChild(dets);
          }

          valor.appendChild(item);
        }
      } else {
        for (const linha of secao.linhas || []) {
          const div = document.createElement('div');
          div.className = 'linha';
          div.textContent = linha;
          valor.appendChild(div);
        }
      }

      bloco.append(rotulo, valor);
      return bloco;
    };

    const porChave = new Map(secoes.map(secao => [secao.key, secao]));

    // Parte clínica principal fica curta no topo.
    const topoClinico = document.createElement('div');
    topoClinico.className = 'topo-clinico';

    for (const key of ['acolhimento', 'motivo', 'diagnostico', 'cid', 'notificacao']) {
      const secao = porChave.get(key);
      if (secao) topoClinico.appendChild(criarBlocoSecao(secao));
    }

    if (topoClinico.childNodes.length) conteudo.appendChild(topoClinico);

    // Parte operacional usa duas colunas independentes:
    // esquerda = procedimentos/medicação/conduta; direita = exames.
    // Assim a altura dos exames não empurra a medicação para baixo.
    const corpoClinico = document.createElement('div');
    corpoClinico.className = 'corpo-clinico';

    const esquerda = document.createElement('div');
    esquerda.className = 'coluna coluna-esquerda';

    const direita = document.createElement('div');
    direita.className = 'coluna coluna-direita';

    for (const key of ['procedimentos', 'medicamentos', 'receituario', 'conduta']) {
      const secao = porChave.get(key);
      if (secao) esquerda.appendChild(criarBlocoSecao(secao));
    }

    const exames = porChave.get('exames');
    if (exames) direita.appendChild(criarBlocoSecao(exames));

    // Qualquer seção futura/desconhecida não some: vai para a coluna esquerda.
    const conhecidas = new Set([
      'acolhimento', 'motivo', 'diagnostico', 'cid', 'notificacao',
      'procedimentos', 'medicamentos', 'receituario', 'conduta', 'exames'
    ]);

    for (const secao of secoes) {
      if (!conhecidas.has(secao.key)) esquerda.appendChild(criarBlocoSecao(secao));
    }

    const temEsquerda = esquerda.childNodes.length > 0;
    const temDireita = direita.childNodes.length > 0;

    if (temEsquerda || temDireita) {
      if (!(temEsquerda && temDireita)) corpoClinico.classList.add('uma-coluna');
      if (temEsquerda) corpoClinico.appendChild(esquerda);
      if (temDireita) corpoClinico.appendChild(direita);
      conteudo.appendChild(corpoClinico);
    }

    card.appendChild(conteudo);
    shadow.append(style, card);
    return host;
  }

  async function tentarInserirAtendimentoAnterior() {
    if (ehPaginaFila()) return false;
    if (document.getElementById(`${PREFIX}-retorno-host`)) return true;

    const contexto = lerContextoRetorno();
    if (!contexto || !norm(contexto.senha).startsWith('RT')) return false;

    // TRAVA DE ESCOPO: este recurso existe SOMENTE na Urgência e Emergência.
    // Mesmo que reste contexto RT no sessionStorage, não injeta nada em APS,
    // ambulatório, terapia, recepção, agenda ou qualquer outro módulo.
    if (!ehPaginaAtendimentoUrgenciaEmergencia(contexto)) return false;
    if (!paginaCombinaComContexto(contexto)) return false;

    const evolucaoAtual = acharEvolucaoAtual();
    if (!evolucaoAtual) return false;

    // REGRA DE CONSISTÊNCIA:
    // 1) Se a fila já exibiu qual era o último atendimento, usa EXATAMENTE aquele
    //    prontuário salvo no clique do RT.
    // 2) Se o usuário clicou antes de a consulta da fila terminar, consulta pela
    //    mesma função usada na fila.
    // 3) NÃO escolhe mais o primeiro registro da tabela visível desta página,
    //    pois isso foi a causa de a fila mostrar o atendimento novo e o quadro
    //    carregar um prontuário antigo.
    let anterior = null;

    if (contexto.atendimentoAnterior && (
      contexto.atendimentoAnterior.prontuarioId ||
      contexto.atendimentoAnterior.atendimentoId ||
      contexto.atendimentoAnterior.prontuarioNumero
    )) {
      anterior = await enriquecerRegistroAnterior(contexto.atendimentoAnterior);
    }

    if (!anterior) {
      anterior = await buscarHistoricoAnteriorDoAtual(contexto.atendimentoStr, contexto.referenciaMs || Date.now());
    }

    if (!anterior) return false;

    // Se a tabela de Histórico de Atendimentos já estiver no DOM desta tela,
    // liga o prontuário escolhido na fila ao data-source EXATO da lupa.
    // Assim o resumo usa a mesma fonte que o médico abre manualmente.
    try {
      const registrosTela = coletarHistoricoMedico(document);
      const correspondente = registrosTela.find(r =>
        (anterior.prontuarioNumero && r.prontuarioNumero === anterior.prontuarioNumero) ||
        (anterior.prontuarioId && r.prontuarioId === anterior.prontuarioId)
      );
      if (correspondente?.atendimentoId) {
        anterior = { ...anterior, atendimentoId: correspondente.atendimentoId, dataNivel: correspondente.dataNivel || anterior.dataNivel };
      }
    } catch (e) {
      warn('Não foi possível vincular a lupa do histórico ao prontuário anterior:', e);
    }

    const detalhes = await buscarDetalhesRegistro(anterior);
    if (document.getElementById(`${PREFIX}-retorno-host`)) return true;

    const alvo = evolucaoAtual.closest('.column, .grid_16, .content-box') || evolucaoAtual;
    if (!alvo.parentNode) return false;

    const card = criarCardRetorno(anterior, detalhes);
    alvo.parentNode.insertBefore(card, alvo);

    log('RETORNO - ATENDIMENTO ANTERIOR inserido.', {
      profissional: anterior.profissional,
      data: anterior.data,
      hora: anterior.hora,
      secoes: detalhes?.secoes?.map(s => s.key) || []
    });

    return true;
  }

  function iniciarPaginaAtendimentoRetorno() {
    const tentativas = [250, 700, 1400, 2600, 4500, 7500];
    tentativas.forEach(ms => setTimeout(() => tentarInserirAtendimentoAnterior(), ms));

    let execucoes = 0;
    const obs = new MutationObserver(() => {
      if (++execucoes > 100 || document.getElementById(`${PREFIX}-retorno-host`)) {
        obs.disconnect();
        return;
      }
      clearTimeout(obs.__om30Timer);
      obs.__om30Timer = setTimeout(() => tentarInserirAtendimentoAnterior(), 160);
    });

    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 20000);
  }

  // ---------------------------------------------------------------------------
  // Observação / atualização automática da fila
  // ---------------------------------------------------------------------------

  function observarFila() {
    observerFila?.disconnect();

    observerFila = new MutationObserver(() => {
      const vm = acharVueFila();
      if (!vm) return;

      // Primeiro esconde imediatamente qualquer linha que o refresh nativo tenha
      // recolocado fora do filtro selecionado. Depois recompõe a paginação global.
      ocultarIntrusosDoFiltro(vm);

      clearTimeout(timerObserver);
      timerObserver = setTimeout(async () => {
        await processarLinhasRetorno(vm);

        if (filtroSelecionado !== 'TODAS' && !aplicandoItensVue) {
          const atual = assinaturaItens(vm.$data.items);
          if (!assinaturaCustom || atual !== assinaturaCustom) {
            solicitarReaplicacaoFiltro(vm, 0);
          }
        }
      }, 60);
    });

    observerFila.observe(document.querySelector('#classificacao') || document.body, {
      childList: true,
      subtree: true
    });
  }

  function iniciarGuardiaoLocal() {
    clearInterval(intervaloGuardiaoFiltro);
    intervaloGuardiaoFiltro = setInterval(() => {
      if (!ehPaginaFila() || filtroSelecionado === 'TODAS') return;
      const vm = acharVueFila();
      if (!vm) return;
      ocultarIntrusosDoFiltro(vm);
      const atual = assinaturaItens(vm.$data.items);
      if (!assinaturaCustom || atual !== assinaturaCustom) solicitarReaplicacaoFiltro(vm, 0);
    }, 1000);
  }

  function iniciarAtualizacaoPeriodica() {
    clearInterval(intervaloAtualizacao);
    intervaloAtualizacao = setInterval(() => {
      if (!ehPaginaFila()) return;
      const vm = acharVueFila();
      if (!vm) return;

      if (filtroSelecionado === 'TODAS') {
        processarLinhasRetorno(vm);
      } else {
        solicitarReaplicacaoFiltro(vm, 0);
      }
    }, 20000);
  }

  async function reativarFiltroPersistido() {
    if (!ehPaginaFila()) return false;
    if (reativacaoFiltroEmCurso) return reativacaoFiltroEmCurso;

    const promessa = (async () => {
      // Relê o storage porque a página pode ter voltado pelo cache do navegador.
      const salvo = localStorage.getItem(STORAGE_FILTRO) || 'TODAS';
      filtroSelecionado = FILTROS_VALIDOS.has(salvo) ? salvo : 'TODAS';
      atualizarBotoes();

      const vm = acharVueFila();
      if (!vm) return false;
      instalarGuardiaoVue(vm);

      if (filtroSelecionado === 'TODAS') {
        esconderPager();
        return true;
      }

      paginaCustom = 1;
      ocultarIntrusosDoFiltro(vm);

      // Equivale ao que antes o usuário precisava fazer manualmente em
      // "Todas -> Retorno": primeiro deixa a fila nativa atualizar seu contexto
      // (ocupação/local/URL) e só depois aplica o filtro salvo.
      await sincronizarFonteNativaFila(vm);
      await aplicarFiltroCustom(vm, true);
      ocultarIntrusosDoFiltro(vm);
      return true;
    })();

    reativacaoFiltroEmCurso = promessa;
    try {
      return await promessa;
    } finally {
      if (reativacaoFiltroEmCurso === promessa) reativacaoFiltroEmCurso = null;
    }
  }

  async function iniciarFila() {
    injetarCSS();
    instalarCapturaCliqueRetorno();

    const iniciar = async () => {
      const box = criarFiltro();
      const vm = acharVueFila();
      if (!box || !vm) return false;

      observarFila();
      iniciarGuardiaoLocal();
      iniciarAtualizacaoPeriodica();

      if (filtroSelecionado === 'TODAS') {
        instalarGuardiaoVue(vm);
        esconderPager();
        const resumo = box.querySelector('.om30-resumo');
        if (resumo) resumo.textContent = 'Exibindo paginação normal da fila';
        processarLinhasRetorno(vm);
      } else {
        // IMPORTANTE: ao voltar de um atendimento, o filtro salvo já aparece
        // selecionado antes de o Vue terminar a primeira busca. Sincroniza a
        // fonte nativa primeiro para não montar "Retorno: 0" com URL genérica.
        await reativarFiltroPersistido();
      }

      return true;
    };

    for (const ms of [100, 500, 1200, 2500, 5000]) {
      setTimeout(iniciar, ms);
    }

    // Se a fila voltar pelo BFCache (voltar/redirect do atendimento), o JS pode
    // não reiniciar. pageshow revalida a fila e reaplica o filtro automaticamente.
    window.addEventListener('pageshow', () => {
      setTimeout(() => reativarFiltroPersistido(), 120);
    });
  }

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------

  if (ehPaginaFila()) {
    // Fila exclusiva da Urgência e Emergência.
    iniciarFila();
  } else {
    const contexto = lerContextoRetorno();
    if (ehPaginaAtendimentoUrgenciaEmergencia(contexto)) {
      iniciarPaginaAtendimentoRetorno();
    }
  }

  // Fora da Urgência e Emergência o script não injeta CSS, filtro, observer
  // nem quadro clínico; permanece totalmente inativo.
  log('v2.4.6 carregado. Escopo: somente Urgência e Emergência. Filtro inicial:', filtroSelecionado);
})();