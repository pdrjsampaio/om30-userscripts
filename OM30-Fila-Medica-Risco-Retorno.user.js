// ==UserScript==
// @name         OM30 - Fila Médica | Risco + Retorno
// @namespace    https://om30.com.br/
// @version      2.11.5
// @description  Fila médica contínua no padrão Controle de Salas: coleção nativa completa, filtros estáveis, tempo de espera, ações e retorno médico RT de 36h + profissional do Retorno nativo.
// @author       Pedro Sampaio - Samp
// @updateURL    https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Fila-Medica-Risco-Retorno.user.js
// @downloadURL  https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Fila-Medica-Risco-Retorno.user.js
// @match        https://guaruja.saudesimples.net/prontuarios*
// @match        https://guarujahomolog.saudesimples.net/prontuarios*
// @match        https://guaruja.saudesimples.net/atendimentos/prontuario*
// @match        https://guarujahomolog.saudesimples.net/atendimentos/prontuario*
// @match        https://guaruja.saudesimples.net/atendimentos_pas/*/prontuario*
// @match        https://guarujahomolog.saudesimples.net/atendimentos_pas/*/prontuario*
// @match        *://*.saudesimples.net/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  // v2.10.5:
  // - /prontuarios e /prontuarios/urgencia_emergencia são tratados como fila médica.
  // v2.11.5:
  // - Corrige definitivamente a sobreposição do menu (*) com a coluna sticky Ação das outras linhas.
  // - Enquanto o menu está aberto, somente a célula Ação da linha atual fica acima do dropdown.
  //
  // v2.11.4:
  // - Restaura o texto completo da opção: "Desvincular senha de outro profissional".
  // - Mantém a correção de z-index/largura do dropdown.
  //
  // v2.11.3:
  // - Corrige o menu (*) da fila médica sendo cortado pela coluna sticky da linha seguinte.
  // - Enquanto o dropdown está aberto, a linha/célula atual sobe de z-index.
  // - Rótulo manual encurtado para "Desvincular senha".
  //
  // v2.11.2:
  // - Fila médica: adiciona no menu (*) a opção "Desvincular senha de outro profissional".
  // - Só executa após confirmação do Senha Simples de que a senha está presa (422 ja_chamada).
  // - Mantém a mesma senha e não chama/inicia atendimento automaticamente.
  //
  // v2.11.1:
  // - Mantém a funcionalidade de Ausentes embutida somente em /prontuarios.
  // - Remove deste script toda captura/salvamento da classificação e toda CLOUD OM30 2.
  // - O Acolhimento + classificação CLOUD continuam exclusivamente no OM30-Ausentes-Acolhimento.user.js.
  //
  // v2.11.0:
  // - Unifica o módulo de Ausentes na fila médica.
  //
  // v2.10.8:
  // - Pesquisa passa a ser 100% local sobre a medFonte completa.
  // - Durante digitação/limpeza, respostas nativas não podem substituir a fonte-mãe.
  // - URLs usadas para recarregar a fila descartam somente parâmetros de busca textual.
  //
  // v2.10.7:
  // - Corrige a detecção do campo de pesquisa nativo que fica fora de #classificacao.
  // - Listener delegado acompanha recriações do input pelo Vue.
  //
  // v2.10.6:
  // - Corrige a pesquisa da fila médica: nome, nome social, senha e CNS passam a
  //   filtrar a fonte completa mantida pelo script, sem o refresh restaurar todos.
  // - Nenhuma integração Cloud/Classificação foi adicionada aqui.
  //
  // - Senha RT = retorno PA/36h (regra independente).
  // - prontuario_com_retorno = tag Retorno nativa (regra independente).
  // - Profissional do Retorno v1.0.3 incorporado, incluindo 3º fallback:
  //   bloco legado "Médico NOME" quando não houver BPA nem data-profissional-*.


  if (window.__OM30_FILA_MEDICA_RISCO_RETORNO_V2115__) return;
  window.__OM30_FILA_MEDICA_RISCO_RETORNO_V2115__ = true;

  const PREFIX = 'om30-fila-risco-retorno';
  const STORAGE_FILTRO = `${PREFIX}:filtro`;
  const SESSION_RETORNO = `${PREFIX}:contexto-retorno`;
  const BODY_CUSTOM = `${PREFIX}-custom-ativo`;
  const BODY_ATUALIZANDO = `${PREFIX}-atualizando`;
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
  const cacheProfissionalRetornoNativo = new Map();
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

  function horarioCurtoAgora() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function log(...args) {
    console.log('[OM30 Fila Médica v2.10.5 RASCUNHO]', ...args);
  }

  function warn(...args) {
    console.warn('[OM30 Fila Médica v2.10.5 RASCUNHO]', ...args);
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

  // IMPORTANTE: igual ao Controle de Salas estável, a coleção que realmente
  // desenha as linhas é o BTable. O collection-with-search é só o componente pai.
  function acharTabelaVueFila() {
    const tabelaDom = acharTabelaFila();
    const candidatos = [...document.querySelectorAll('#classificacao *')]
      .map(el => el.__vue__)
      .filter(Boolean);

    let tabela = candidatos.find(vm =>
      vm?.$options?.name === 'BTable' &&
      Array.isArray(vm?.items) &&
      (!tabelaDom || vm.$el === tabelaDom || vm.$el?.contains?.(tabelaDom) || tabelaDom.contains?.(vm.$el))
    );

    if (!tabela) {
      tabela = candidatos.find(vm =>
        vm?.$options?.name === 'BTable' &&
        Array.isArray(vm?.items) &&
        (vm.fields || []).some?.(f => ['senha', 'grau_risco', 'nome_grau_risco'].includes(String(f?.key || '').toLowerCase()))
      );
    }

    return tabela || null;
  }

  function getColecaoFila(tabela = acharTabelaVueFila()) {
    let vm = tabela;
    const vistos = new Set();
    for (let i = 0; vm && i < 12 && !vistos.has(vm); i++, vm = vm.$parent) {
      vistos.add(vm);
      if (norm(vm?.$options?.name) === 'COLLECTION-WITH-SEARCH-ATENDIMENTO') return vm;
    }
    return acharVueFila();
  }

  function linhasFila() {
    const tabela = acharTabelaFila();
    return tabela ? [...tabela.querySelectorAll('tbody tr.collection-row')] : [];
  }

  function itensDaTabela(vmPai = null) {
    const tabela = acharTabelaVueFila();
    if (tabela && Array.isArray(tabela.items)) return tabela.items;
    if (vmPai?.$data && Array.isArray(vmPai.$data.items)) return vmPai.$data.items;
    return [];
  }

  function itemDaLinha(row, vm) {
    if (!row) return null;
    const itens = itensDaTabela(vm);
    if (!itens.length) return null;

    const senha = clean(row.cells?.[6]?.innerText || row.cells?.[6]?.textContent);
    const cns = clean(row.cells?.[1]?.innerText || row.cells?.[1]?.textContent);
    const nome = clean(
      row.cells?.[2]?.querySelector('span:not(.badge)')?.innerText ||
      row.cells?.[2]?.innerText ||
      row.cells?.[2]?.textContent
    );

    // A senha é a chave visual mais forte da fila. Se ela está presente, NÃO
    // fazemos fallback para CNS/nome quando não houver correspondência. Isso evita
    // que uma <tr> reaproveitada pelo Vue durante a reordenação herde dados de outro
    // atendimento (era a causa provável do aviso de 36h aparecer em linha aleatória).
    if (senha) {
      return itens.find(item => item && norm(item.senha) === norm(senha)) || null;
    }

    if (cns) {
      const porCns = itens.filter(item => item && clean(item.codigo_cns) === cns);
      if (porCns.length === 1) return porCns[0];
      if (porCns.length > 1 && nome) {
        return porCns.find(item => norm(item.nome_municipe) === norm(nome)) || null;
      }
    }

    if (nome) {
      const porNome = itens.filter(item => item && norm(item.nome_municipe) === norm(nome));
      if (porNome.length === 1) return porNome[0];
    }

    return null;
  }

  function assinaturaVisualItens(itens) {
    return (Array.isArray(itens) ? itens : []).map(item => [
      chaveItem(item),
      riscoItem(item) || '',
      norm(item?.status || item?.nome_status || item?.status_nome || ''),
      clean(item?.senha),
      norm(item?.nome_municipe),
      clean(item?.data_senha_timestamp || item?.data_senha_formatada || '')
    ].join('~')).join('||');
  }

  function ocultarTabelaParaTroca() {}
  function revelarTabelaAposVue() { document.body.classList.remove(BODY_ATUALIZANDO); }

  function liberarLoadingColecao(colecao) {
    if (!colecao) return;
    try { colecao.preparingLoading = false; } catch (_) {}
    try { colecao.isLoading = false; } catch (_) {}
    try { colecao.errorRequest = {}; } catch (_) {}
  }

  function estabilizarUmaPagina(tabela, total) {
    document.body.classList.add(BODY_CUSTOM);
    if (!tabela) return;

    const colecao = getColecaoFila(tabela);

    // O diagnóstico no console confirmou o fluxo real desta tela:
    // collection-with-search pode carregar todos os registros, mas o BTable ainda
    // corta visualmente em 10 enquanto perPage=10. O ponto decisivo é zerar o
    // perPage DO BTABLE (BootstrapVue usa 0 = sem paginação interna).
    let mudouPerPageTabela = false;
    try {
      if (Number(tabela.perPage) !== 0) {
        if (tabela._props) tabela._props.perPage = 0;
        else tabela.perPage = 0;
        mudouPerPageTabela = true;
      }
    } catch (_) {}
    try {
      if (Number(tabela.currentPage) !== 1) {
        if (tabela._props) tabela._props.currentPage = 1;
        else tabela.currentPage = 1;
      }
    } catch (_) {}

    // Mantém o pai preparado para buscar a fila completa caso algum carregamento
    // nativo seja permitido. 100 já foi validado no console e devolveu todos os 35.
    if (colecao) {
      try { colecao.customPerPage = 100; } catch (_) {}
      try { if (colecao.$data && 'customPerPage' in colecao.$data) colecao.$data.customPerPage = 100; } catch (_) {}
      try { colecao.currentPage = 1; } catch (_) {}
      try { if (colecao.$data && 'currentPage' in colecao.$data) colecao.$data.currentPage = 1; } catch (_) {}
      try { colecao.totalRows = total; } catch (_) {}
      try { if (colecao.$data && 'totalRows' in colecao.$data) colecao.$data.totalRows = total; } catch (_) {}
      liberarLoadingColecao(colecao);
    }

    // Só força uma renderização quando mudamos perPage de 10 para 0. Depois disso,
    // as alterações de items continuam reativas por splice e não precisam redraw.
    if (mudouPerPageTabela) {
      try { tabela.$forceUpdate?.(); } catch (_) {}
    }
  }

  function sincronizarObjetosSemReordenar(tabela, novos) {
    if (!tabela || !Array.isArray(tabela.items) || !Array.isArray(novos)) return false;
    const porChave = new Map(novos.map(item => [chaveItem(item), item]));
    let mudou = false;

    for (const atual of tabela.items) {
      const origem = porChave.get(chaveItem(atual));
      if (!origem || !atual || typeof atual !== 'object') continue;
      for (const [k, v] of Object.entries(origem)) {
        if (atual[k] === v) continue;
        try {
          if (typeof tabela.$set === 'function') tabela.$set(atual, k, v);
          else atual[k] = v;
          mudou = true;
        } catch (_) {}
      }
    }
    return mudou;
  }

  function setItensVue(vmPai, itens) {
    const tabela = acharTabelaVueFila();
    if (!tabela || !Array.isArray(tabela.items)) {
      warn('BTable da fila não localizado; não vou alterar a coleção pai para evitar voltar ao limite de 10.');
      return false;
    }

    const novos = [...itens];
    estabilizarUmaPagina(tabela, novos.length);

    const atuais = tabela.items;
    const chavesAtuais = atuais.map(chaveItem);
    const chavesNovas = novos.map(chaveItem);
    const mesmaOrdem = chavesAtuais.length === chavesNovas.length &&
      chavesAtuais.every((chave, i) => chave === chavesNovas[i]);

    const assinaturaNova = assinaturaVisualItens(novos);
    const assinaturaAtual = assinaturaVisualItens(atuais);
    assinaturaCustom = assinaturaItens(novos);

    if (mesmaOrdem && assinaturaAtual === assinaturaNova) {
      liberarLoadingColecao(getColecaoFila(tabela));
      return false;
    }

    aplicandoItensVue = true;
    try {
      if (mesmaOrdem) {
        sincronizarObjetosSemReordenar(tabela, novos);
      } else {
        // Mesmo padrão do Controle de Salas: muta diretamente o array observado
        // pelo BTable e NÃO usa $forceUpdate(), evitando reconstruir a tabela inteira.
        tabela.items.splice(0, tabela.items.length, ...novos);
      }

      liberarLoadingColecao(getColecaoFila(tabela));
      if (typeof tabela.$nextTick === 'function') {
        tabela.$nextTick(() => {
          atualizarTemposEsperaNaTela(getColecaoFila(tabela));
          melhorarAcoesFila();
        });
      }
      return true;
    } finally {
      Promise.resolve().then(() => { aplicandoItensVue = false; });
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

  function parametroEhPesquisaFila(nome) {
    const n = String(nome || '').trim().toLowerCase();
    if (!n) return false;
    if (['q','query','search','search_term','term','keyword','keywords','busca','pesquisa'].includes(n)) return true;
    return /(?:^|[\[\]_.-])(search|query|term|keyword|busca|pesquisa)(?:$|[\[\]_.-])/.test(n);
  }

  function urlTemPesquisaFila(url) {
    try {
      for (const [k, v] of url.searchParams.entries()) {
        if (parametroEhPesquisaFila(k) && clean(v)) return true;
      }
    } catch (_) {}
    return false;
  }

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
      // Uma URL produzida pela caixa de pesquisa nunca deve virar a fonte-base.
      if (urlTemPesquisaFila(url)) pontos -= 50;
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

    // A caixa de pesquisa é tratada localmente pela OM30. Se a última requisição
    // nativa tiver levado "robson", "CN0062" etc., removemos SOMENTE esse parâmetro
    // textual para não transformar um resultado parcial na nova fonte completa.
    for (const k of [...url.searchParams.keys()]) {
      if (parametroEhPesquisaFila(k)) url.searchParams.delete(k);
    }
    return url;
  }

  async function buscarPaginaFila(urlBase, pagina) {
    const url = new URL(urlBase.href);
    url.searchParams.set('page', String(pagina));
    // Primeiro pede um lote grande. Se o backend limitar internamente, o laço
    // de carregarFilaCompleta continua em page=2,3... sem prender a tela em 10.
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

        // Se ele realmente aceitou per_page=100, lote menor que 100 encerra.
        // Se devolveu 10, NÃO encerra: há instalações que limitam a 10 e paginam normalmente.
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

  function ordenarFilaMedica(itens) {
    const peso = { VERMELHO: 0, AMARELO: 1, VERDE: 2, AZUL: 3 };
    return [...(Array.isArray(itens) ? itens : [])].sort((a, b) => {
      const pa = peso[riscoItem(a)] ?? 9;
      const pb = peso[riscoItem(b)] ?? 9;
      if (pa !== pb) return pa - pb;
      return timestampReferenciaFila(a) - timestampReferenciaFila(b);
    });
  }

  function tempoEsperaMs(item, agora = Date.now()) {
    const inicio = timestampReferenciaFila(item);
    if (!(Number(inicio) > 0)) return 0;
    return Math.max(0, Number(agora) - Number(inicio));
  }

  function formatarTempoEspera(ms) {
    const totalMin = Math.max(0, Math.floor(Number(ms || 0) / 60000));
    if (totalMin < 60) return `${totalMin} min`;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m ? `${h}h ${m}min` : `${h}h`;
  }

  function mediaEspera(itens, filtroRisco = null, agora = Date.now()) {
    const lista = (Array.isArray(itens) ? itens : []).filter(item => {
      if (filtroRisco && riscoItem(item) !== filtroRisco) return false;
      return tempoEsperaMs(item, agora) >= 0;
    });
    if (!lista.length) return 0;
    const soma = lista.reduce((acc, item) => acc + tempoEsperaMs(item, agora), 0);
    return soma / lista.length;
  }

  function atualizarTemposEsperaNaTela(vm = acharVueFila()) {
    if (!vm) return;
    const agora = Date.now();

    const tabela = acharTabelaFila();
    const thChegada = tabela?.querySelector('thead th:nth-child(1)');
    if (thChegada && !thChegada.dataset.om30TituloEspera) {
      thChegada.dataset.om30TituloEspera = '1';
      thChegada.innerHTML = 'Data/Hora da<br>chegada <span class="om30-th-espera">+ espera</span>';
    }

    for (const row of linhasFila()) {
      const item = itemDaLinha(row, vm);
      if (!item) continue;

      // A espera pertence à chegada. Não polui mais a coluna de risco.
      const celula = row.cells?.[0];
      if (!celula) continue;

      let badge = celula.querySelector('.om30-tempo-espera');
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'om30-tempo-espera';
        celula.appendChild(badge);
      }

      badge.innerHTML = `<span class="om30-espera-relogio" aria-hidden="true">🕒</span><span class="om30-espera-label">Espera</span><strong>${formatarTempoEspera(tempoEsperaMs(item, agora))}</strong>`;
    }
  }

  function contarFila(itens) {
    const contagem = {
      TODAS: 0,
      VERMELHO: 0,
      AMARELO: 0,
      VERDE: 0,
      AZUL: 0,
      RETORNO: 0
    };
    for (const item of Array.isArray(itens) ? itens : []) {
      contagem.TODAS++;
      const risco = riscoItem(item);
      if (contagem[risco] != null) contagem[risco]++;
      if (itemEhRetorno(item)) contagem.RETORNO++;
    }
    return contagem;
  }

  function atualizarResumoFila(itens) {
    const box = document.getElementById(`${PREFIX}-box`);
    if (!box) return;

    const c = contarFila(itens);
    const agora = Date.now();
    const dados = {
      TODAS:    { qtd: c.TODAS,    media: mediaEspera(itens, null, agora) },
      VERMELHO: { qtd: c.VERMELHO, media: mediaEspera(itens, 'VERMELHO', agora) },
      AMARELO:  { qtd: c.AMARELO,  media: mediaEspera(itens, 'AMARELO', agora) },
      VERDE:    { qtd: c.VERDE,    media: mediaEspera(itens, 'VERDE', agora) },
      AZUL:     { qtd: c.AZUL,     media: mediaEspera(itens, 'AZUL', agora) },
      RETORNO:  { qtd: c.RETORNO,  media: null }
    };

    box.querySelectorAll('.om30-resumo-card[data-filtro]').forEach(card => {
      const key = card.dataset.filtro;
      const info = dados[key];
      if (!info) return;

      const qtd = card.querySelector('.om30-card-qtd');
      const media = card.querySelector('.om30-card-media');
      if (qtd) qtd.textContent = String(info.qtd ?? 0);

      if (media) {
        if (key === 'RETORNO') {
          media.textContent = `${info.qtd === 1 ? 'retorno' : 'retornos'} na fila`;
        } else if ((info.qtd ?? 0) > 0) {
          media.innerHTML = `Tempo Médio <strong>${formatarTempoEspera(info.media)}</strong>`;
        } else {
          media.textContent = 'Sem pacientes';
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Interface da fila - rascunho 2.5.0 (padrão Controle de Salas)
  // ---------------------------------------------------------------------------

  function injetarCSS() {
    if (document.getElementById(`${PREFIX}-css`)) return;

    const style = document.createElement('style');
    style.id = `${PREFIX}-css`;
    style.textContent = `
      #${PREFIX}-box {
        box-sizing:border-box;
        width:100%;
        margin:8px 0 12px;
        padding:12px 14px 14px;
        background:#fff;
        border:1px solid #e2e5e8;
        border-radius:10px;
        box-shadow:0 2px 8px rgba(25,35,45,.055);
        font-family:Arial,Helvetica,sans-serif;
      }

      #${PREFIX}-box .om30-resumo-cabecalho {
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:12px;
        margin-bottom:8px;
      }
      #${PREFIX}-box .om30-titulo-bloco {
        display:flex;
        flex-direction:column;
        gap:1px;
        min-width:0;
      }
      #${PREFIX}-box .om30-titulo {
        font-size:12px;
        line-height:1.2;
        font-weight:800;
        color:#3c4650;
      }
      #${PREFIX}-box .om30-subtitulo {
        font-size:9.5px;
        line-height:1.2;
        color:#8a929a;
      }
      #${PREFIX}-box .om30-status-fila {
        flex:none;
        font-size:9.5px;
        font-weight:700;
        color:#7c858d;
      }

      #${PREFIX}-box .om30-resumo {
        display:grid;
        grid-template-columns:repeat(6,minmax(118px,1fr));
        gap:8px;
        width:100%;
      }
      #${PREFIX}-box .om30-resumo-card {
        --om30-cor:#6c757d;
        appearance:none;
        position:relative;
        display:grid;
        grid-template-columns:auto 1fr;
        grid-template-rows:auto auto;
        column-gap:7px;
        row-gap:1px;
        min-width:0;
        min-height:58px;
        padding:9px 10px 9px 11px;
        border:1px solid #e1e5e8;
        border-left:4px solid var(--om30-cor);
        border-radius:9px;
        background:#fff;
        color:#3d464f;
        text-align:left;
        cursor:pointer;
        transition:border-color .12s ease, background .12s ease, box-shadow .12s ease, transform .12s ease;
      }
      #${PREFIX}-box .om30-resumo-card:hover {
        background:#fafbfc;
        border-color:#d3d9de;
        transform:translateY(-1px);
      }
      #${PREFIX}-box .om30-resumo-card.ativo {
        background:color-mix(in srgb, var(--om30-cor) 8%, white);
        border-color:color-mix(in srgb, var(--om30-cor) 55%, #d9dde1);
        box-shadow:0 0 0 1px color-mix(in srgb, var(--om30-cor) 18%, transparent);
      }
      #${PREFIX}-box .om30-card-indicador {
        grid-row:1 / 3;
        align-self:center;
        width:9px;
        height:9px;
        border-radius:50%;
        background:var(--om30-cor);
        box-shadow:0 0 0 3px color-mix(in srgb, var(--om30-cor) 12%, transparent);
      }
      #${PREFIX}-box .om30-card-linha {
        display:flex;
        align-items:baseline;
        justify-content:space-between;
        gap:6px;
        min-width:0;
      }
      #${PREFIX}-box .om30-card-label {
        overflow:hidden;
        text-overflow:ellipsis;
        white-space:nowrap;
        font-size:10.5px;
        font-weight:800;
        text-transform:uppercase;
        letter-spacing:.2px;
        color:#68717a;
      }
      #${PREFIX}-box .om30-card-qtd {
        flex:none;
        font-size:20px;
        line-height:1;
        font-weight:800;
        color:#2f3740;
      }
      #${PREFIX}-box .om30-card-media {
        grid-column:2;
        min-width:0;
        font-size:10px;
        color:#7e8790;
        white-space:nowrap;
      }
      #${PREFIX}-box .om30-card-media strong { color:#5a626a; }
      #${PREFIX}-box .om30-card-total { --om30-cor:#6c757d; background:#fafbfc; }

      .om30-th-espera {
        display:inline-block;
        margin-left:2px;
        font-size:8px;
        font-weight:600;
        color:#929aa1;
        text-transform:none;
      }
      .om30-tempo-espera {
        display:inline-flex;
        align-items:center;
        gap:4px;
        margin-top:4px;
        padding:2px 6px;
        border-radius:10px;
        background:#f2f4f6;
        font-size:9px;
        line-height:1.2;
        color:#69737d;
        white-space:nowrap;
      }
      .om30-tempo-espera .om30-espera-relogio { font-size:11px; line-height:1; }
      .om30-tempo-espera .om30-espera-label { font-weight:700; }
      .om30-tempo-espera strong { font-size:9.5px; font-weight:800; color:#343d46; }

      #classificacao tbody tr.collection-row td:first-child {
        white-space:nowrap;
      }

      /* Ações da fila: largura é definida apenas no bloco moderno abaixo.
         Regra antiga de 250px removida para não empurrar as demais colunas. */
      #classificacao td.om30-acoes-celula {
        white-space:nowrap;
        display:flex !important;
        align-items:center !important;
        justify-content:flex-end !important;
        gap:5px !important;
      }
      #classificacao td.om30-acoes-celula .om30-acao-chamar,
      #classificacao td.om30-acoes-celula .om30-acao-confirmar {
        box-sizing:border-box !important;
        display:inline-flex !important;
        align-items:center !important;
        justify-content:center !important;
        gap:5px !important;
        min-height:30px !important;
        margin:0 !important;
        padding:5px 9px !important;
        border-radius:6px !important;
        box-shadow:none !important;
        font-size:10.5px !important;
        font-weight:700 !important;
        line-height:1 !important;
        text-decoration:none !important;
        vertical-align:middle !important;
        cursor:pointer !important;
      }
      #classificacao td.om30-acoes-celula .om30-acao-chamar {
        min-width:76px !important;
        background:#fff !important;
        border:1px solid #17a2b8 !important;
        color:#117a8b !important;
      }
      #classificacao td.om30-acoes-celula .om30-acao-chamar:hover {
        background:#def3f7 !important;
        border-color:#42aec0 !important;
      }
      #classificacao td.om30-acoes-celula .om30-acao-confirmar {
        min-width:135px !important;
        background:#28a745 !important;
        border:1px solid #28a745 !important;
        color:#fff !important;
      }
      #classificacao td.om30-acoes-celula .om30-acao-confirmar:hover {
        background:#218838 !important;
        border-color:#1e7e34 !important;
      }
      #classificacao td.om30-acoes-celula .om30-acao-chamar .om30-acao-label::before { content:'📣 '; }
      #classificacao td.om30-acoes-celula .om30-acao-confirmar .om30-acao-label::before { content:'✓ '; }
      #classificacao td.om30-acoes-celula .om30-acao-label {
        pointer-events:none;
        white-space:nowrap;
        display:inline !important;
      }
      #classificacao td.om30-acoes-celula .dropdown-toggle,
      #classificacao td.om30-acoes-celula .om30-acao-engrenagem {
        flex:0 0 auto !important;
      }

      /* A paginação nativa deixa de existir visualmente: fila contínua. */
      #classificacao .pagination { display:none !important; }


      tr.${PREFIX}-intruso { display:none !important; }

      .om30-retorno-rt36, .om30-profissional-retorno-nativo {
        margin-top:3px; font-size:11px; font-weight:700;
      }
      .om30-retorno-rt36 { color:#4f6657; }
      .om30-profissional-retorno-nativo { color:#355c7d; }

      #${PREFIX}-evolucao-anterior {
        box-sizing:border-box; width:100%; margin:12px 0 16px; border:2px solid #6f42c1;
        border-radius:8px; background:#fbf9ff; box-shadow:0 2px 7px rgba(0,0,0,.06);
        overflow:hidden; font-family:Arial,Helvetica,sans-serif;
      }
      #${PREFIX}-evolucao-anterior .om30-card-topo {
        display:flex; align-items:center; justify-content:space-between; gap:10px;
        padding:10px 12px; background:#6f42c1; color:#fff; font-weight:800;
      }
      #${PREFIX}-evolucao-anterior .om30-somente-leitura {
        padding:3px 8px; border:1px solid rgba(255,255,255,.65); border-radius:12px;
        font-size:10px; white-space:nowrap;
      }
      #${PREFIX}-evolucao-anterior .om30-card-meta {
        padding:9px 12px; border-bottom:1px solid #ded5ee; font-size:12px; color:#443652;
      }
      #${PREFIX}-evolucao-anterior .om30-card-texto {
        padding:12px; white-space:pre-wrap; line-height:1.45; color:#2f2933;
        font-size:13px; user-select:text;
      }
      #${PREFIX}-evolucao-anterior .om30-card-erro { color:#8a5555; font-style:italic; }
      #${PREFIX}-retorno-host { display:block; width:100%; margin:12px 0 16px; }

      @media (max-width:1366px) {
        #${MED_BAR_ID} { gap:5px; padding:6px; }
        #${MED_BAR_ID} .om30m-filtro { min-width:112px; padding-left:6px; padding-right:6px; }
      }
      @media (max-width:1180px) {
        #${MED_BAR_ID} .om30m-filtro { min-width:102px; }
      }
      @media (max-width:1100px) {
        #${PREFIX}-box .om30-resumo { grid-template-columns:repeat(3,minmax(115px,1fr)); }
      }
      @media (max-width:760px) {
        #${PREFIX}-box .om30-resumo { grid-template-columns:repeat(2,minmax(115px,1fr)); }
        #${PREFIX}-box .om30-subtitulo { display:none; }
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

    const tabela = acharTabelaFila();
    if (!tabela) return null;
    // Insere imediatamente acima do componente responsivo da tabela. Evita subir
    // para containers grandes (grid_16/ui-widget) e mantém o resumo junto da fila.
    const alvoInsercao = tabela.closest('.table-responsive') || tabela;

    box = document.createElement('div');
    box.id = `${PREFIX}-box`;

    const cabecalho = document.createElement('div');
    cabecalho.className = 'om30-resumo-cabecalho';

    const blocoTitulo = document.createElement('div');
    blocoTitulo.className = 'om30-titulo-bloco';

    const titulo = document.createElement('span');
    titulo.className = 'om30-titulo';
    titulo.textContent = 'Resumo da fila';

    const subtitulo = document.createElement('span');
    subtitulo.className = 'om30-subtitulo';
    subtitulo.textContent = 'Clique em uma classificação para filtrar';

    blocoTitulo.append(titulo, subtitulo);

    const status = document.createElement('span');
    status.className = 'om30-status-fila';
    status.textContent = 'Lendo fila...';

    cabecalho.append(blocoTitulo, status);
    box.appendChild(cabecalho);

    const resumo = document.createElement('div');
    resumo.className = 'om30-resumo';

    for (const filtro of FILTROS) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `om30-resumo-card${filtro.key === 'TODAS' ? ' om30-card-total' : ''}`;
      card.dataset.filtro = filtro.key;
      card.style.setProperty('--om30-cor', filtro.cor);
      card.innerHTML = `
        <span class="om30-card-indicador" aria-hidden="true"></span>
        <span class="om30-card-linha">
          <span class="om30-card-label">${filtro.key === 'TODAS' ? 'Total' : filtro.label}</span>
          <strong class="om30-card-qtd">0</strong>
        </span>
        <span class="om30-card-media">Calculando...</span>
      `;

      card.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        if (filtroSelecionado === filtro.key) return;
        filtroSelecionado = filtro.key;
        localStorage.setItem(STORAGE_FILTRO, filtroSelecionado);
        atualizarBotoes();
        const vm = acharVueFila();
        if (vm) await aplicarFiltroCustom(vm, false);
      });

      resumo.appendChild(card);
    }

    box.appendChild(resumo);

    // Fica imediatamente acima da tabela, no mesmo ponto visual do Controle de Salas.
    alvoInsercao.parentNode?.insertBefore(box, alvoInsercao);

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

  async function aplicarFiltroCustom(vm = acharVueFila(), force = false) {
    if (!vm) return;

    const minhaSeq = ++sequenciaAplicacao;
    const box = criarFiltro();
    atualizarBotoes();
    if (!box) return;

    try {
      const todos = await carregarFilaCompleta(vm, force);
      if (minhaSeq !== sequenciaAplicacao) return;

      atualizarResumoFila(todos);
      const status = box.querySelector('.om30-status-fila');
      if (status) status.textContent = `🕒 ${horarioCurtoAgora()}`;
      const filtrados = ordenarFilaMedica(filtrarItens(todos, filtroSelecionado));
      document.body.classList.add(BODY_CUSTOM);
      setItensVue(vm, filtrados);

      setTimeout(() => {
        const vmAtual = acharVueFila();
        atualizarTemposEsperaNaTela(vmAtual);
        melhorarAcoesFila();
        processarLinhasRetorno(vmAtual);
      }, 40);

      log('Fila contínua aplicada', {
        filtro: filtroSelecionado,
        totalFila: todos.length,
        exibidos: filtrados.length,
        assinatura: assinaturaItens(filtrados)
      });
    } catch (e) {
      console.error('[OM30 Fila Médica v2.10.5 RASCUNHO] Erro ao montar fila:', e);
      const status = box.querySelector('.om30-status-fila');
      if (status) status.textContent = `Erro ao carregar fila: ${e.message || e}`;
      document.body.classList.remove(BODY_ATUALIZANDO);
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
        console.error('[OM30 Fila Médica v2.10.5 RASCUNHO] Histórico anterior:', atendimentoStr, e);
        return null;
      }
    })();

    cacheHistoricoAnterior.set(chaveCacheHistorico, promessa);
    return promessa;
  }

  function criarInfoProfissional(row) {
    const celula = row.cells?.[2];
    if (!celula) return null;

    let info = celula.querySelector('.om30-retorno-rt36');
    if (!info) {
      info = document.createElement('div');
      info.className = 'om30-retorno-rt36';
      celula.appendChild(info);
    }
    return info;
  }

  function limparInfoRetornoRT(row) {
    row?.cells?.[2]?.querySelectorAll?.('.om30-retorno-rt36').forEach(el => el.remove());
    if (row?.dataset) delete row.dataset.om30RetornoProcessado;
    if (row) row.__om30AtendimentoAnterior = null;
  }

  async function processarLinhaRetorno(row, vm) {
    // Trava DUPLA: a própria linha visual precisa exibir uma senha RT e o item
    // associado precisa ser a MESMA senha RT. Assim uma <tr> reaproveitada pelo Vue
    // nunca mantém o aviso de 36h depois que passou a representar outro paciente.
    const senhaVisual = clean(row?.cells?.[6]?.innerText || row?.cells?.[6]?.textContent);
    if (!norm(senhaVisual).startsWith('RT')) {
      limparInfoRetornoRT(row);
      return;
    }

    const item = itemDaLinha(row, vm);
    if (!item || !itemEhRetorno(item) || norm(item.senha) !== norm(senhaVisual) || !item.atendimento_str) {
      limparInfoRetornoRT(row);
      return;
    }

    const chave = chaveItem(item);
    // O Vue pode redesenhar o conteúdo da linha durante o refresh automático sem
    // substituir o <tr>. Nesse caso o dataset permanece, mas o texto OM30 some.
    // Só considera processado quando o bloco visual ainda existe na célula.
    const infoExistente = row.cells?.[2]?.querySelector?.('.om30-retorno-rt36');
    if (row.dataset.om30RetornoProcessado === chave && infoExistente?.textContent?.trim()) return;
    row.dataset.om30RetornoProcessado = chave;

    // Exibe feedback imediato enquanto consulta o último atendimento válido.
    // Se não houver atendimento médico válido dentro de 36h, mantém um aviso visível
    // indicando os dois cenários operacionais esperados: atendimento antigo ou manual.
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

  function itemEhRetornoNativo(item) {
    const v = item?.prontuario_com_retorno;
    return v === true || String(v).toLowerCase() === 'true' || String(v) === '1';
  }

  function criarInfoProfissionalRetornoNativo(row) {
    const celula = row?.cells?.[2];
    if (!celula) return null;
    let info = celula.querySelector('.om30-profissional-retorno-nativo');
    if (!info) {
      info = document.createElement('div');
      info.className = 'om30-profissional-retorno-nativo';
      celula.appendChild(info);
    }
    return info;
  }

  function limparInfoProfissionalRetornoNativo(row) {
    row?.cells?.[2]?.querySelectorAll?.('.om30-profissional-retorno-nativo').forEach(el => el.remove());
    if (row?.dataset) delete row.dataset.om30ProfissionalRetornoNativo;
  }

  function extrairProfissionalRetornoNativo(doc) {
    // 1) Faturamento BPA: formato usado pelo Profissional do Retorno v1.0.3.
    const candidatos = [];
    for (const table of doc.querySelectorAll('table')) {
      const headers = [...table.querySelectorAll('th')].map(th => norm(th.textContent));
      const ip = headers.findIndex(h => h.includes('PROFISSIONAL/ESPECIALIDADE'));
      if (ip === -1) continue;
      const iproc = headers.findIndex(h => h.includes('PROCEDIMENTO'));
      for (const tr of table.querySelectorAll('tbody tr')) {
        const cells = [...tr.cells];
        const profissional = clean(cells[ip]?.textContent);
        if (!profissional || !/\bM[EÉ]DIC[OA]\b/i.test(profissional)) continue;
        const procedimento = iproc >= 0 ? clean(cells[iproc]?.textContent) : '';
        const nome = clean(profissional.replace(/\s+-\s+M[eé]dic[oa].*$/i, ''));
        if (nome) candidatos.push({ nome, principal:/\b0301060096\b/.test(procedimento) });
      }
    }
    if (candidatos.length) return (candidatos.find(x => x.principal) || candidatos[0]).nome;

    // 2) data-profissional-*.
    for (const el of doc.querySelectorAll('[data-profissional-nome]')) {
      const nomeRaw = textoHtml(el.getAttribute('data-profissional-nome'));
      const cboRaw = textoHtml(el.getAttribute('data-profissional-cbo'));
      if (!/\bM[EÉ]DIC[OA]\b/i.test(cboRaw)) continue;
      const nome = clean(nomeRaw.replace(/^PROFISSIONAL\s*:\s*/i, ''));
      if (nome) return nome;
    }

    // 3) Layout legado confirmado no diagnóstico:
    //    <div class="grid_8">Médico PEDRO JUSTINO SAMPAIO ANDRADE</div>
    //
    // Fazemos em camadas porque algumas telas colocam "Médico" em <strong>/<label>
    // e o nome no mesmo <li>/<div>, enquanto outras entregam tudo como texto direto.
    const limparNomeMedicoLegado = valor => {
      let nome = clean(valor)
        .replace(/^M[EÉ]DICO\s*:?\s*/i, '')
        .replace(/\s+ESPECIALIDADE\s+.*$/i, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

      // Não aceita o próprio rótulo/especialidade como se fosse nome.
      if (!nome || /^M[EÉ]DICO$/i.test(nome) || /^M[EÉ]DICO\s+CL[IÍ]NICO$/i.test(nome)) return '';
      if (/^(ESPECIALIDADE|CID|MEDICA[CÇ][AÃ]O|PROCEDIMENTO)/i.test(nome)) return '';
      return nome.length <= 180 ? nome : '';
    };

    // 3A) Rótulo estrutural <strong>Médico</strong> / <label>Médico</label>.
    for (const rotulo of doc.querySelectorAll('strong, label, b')) {
      if (norm(rotulo.textContent).replace(/:$/, '') !== 'MEDICO') continue;

      const pai = rotulo.closest('li, .grid_8, div, td');
      if (!pai) continue;

      const clone = pai.cloneNode(true);
      for (const r of clone.querySelectorAll('strong, label, b')) {
        if (norm(r.textContent).replace(/:$/, '') === 'MEDICO') r.remove();
      }

      const nome = limparNomeMedicoLegado(clone.textContent);
      if (nome) {
        console.log('[OM30 Retorno] Médico localizado pelo layout legado/rotulo:', nome);
        return nome;
      }
    }

    // 3B) Bloco cujo texto começa exatamente por "Médico".
    for (const el of doc.querySelectorAll('.grid_8, li, div, td')) {
      const txt = clean(el.textContent);
      if (!/^M[EÉ]DICO\b/i.test(txt)) continue;

      const nome = limparNomeMedicoLegado(txt);
      if (nome) {
        console.log('[OM30 Retorno] Médico localizado pelo layout legado/bloco:', nome);
        return nome;
      }
    }

    // 3C) Último fallback por linhas, sem depender da classe.
    const textoPagina = String(doc.body?.innerText || doc.body?.textContent || '');
    for (const linhaRaw of textoPagina.split(/[\r\n]+/)) {
      const linha = clean(linhaRaw);
      if (!/^M[EÉ]DICO\b/i.test(linha)) continue;

      const nome = limparNomeMedicoLegado(linha);
      if (nome) {
        console.log('[OM30 Retorno] Médico localizado pelo layout legado/texto:', nome);
        return nome;
      }
    }

    // 3D) Fallback exato do layout que apareceu no diagnóstico do TESTE OMTRINTA:
    // "Médico PEDRO JUSTINO SAMPAIO ANDRADE Especialidade Médico clínico"
    // DOMParser pode perder as quebras de linha; por isso procuramos no texto colapsado.
    const textoColapsado = clean(doc.body?.textContent || '');
    const padroesLegados = [
      /(?:^|\s)M[EÉ]DICO\s*:?\s+(.+?)\s+ESPECIALIDADE\s+M[EÉ]DICO\b/i,
      /(?:^|\s)M[EÉ]DICO\s*:?\s+([A-ZÀ-ÖØ-Ý][A-ZÀ-ÖØ-Ý'´`.-]*(?:\s+[A-ZÀ-ÖØ-Ý][A-ZÀ-ÖØ-Ý'´`.-]*){1,10})(?=\s+(?:CID|MEDICA[CÇ][AÃ]O|PROCEDIMENTO|CONDUTA|$))/i
    ];

    for (const rx of padroesLegados) {
      const m = textoColapsado.match(rx);
      const nome = limparNomeMedicoLegado(m?.[1] || '');
      if (nome) {
        console.log('[OM30 Retorno] Médico localizado pelo layout legado/diagnóstico:', nome);
        return nome;
      }
    }

    return '';
  }

  async function buscarProfissionalRetornoNativo(atendimentoStr) {
    if (cacheProfissionalRetornoNativo.has(atendimentoStr)) return cacheProfissionalRetornoNativo.get(atendimentoStr);
    const atendimento = parseAtendimento(atendimentoStr);
    if (!atendimento) return '';

    const promessa = (async () => {
      const url = '/prontuarios/new?prontuariavel_id=' + encodeURIComponent(atendimento.id) +
                  '&prontuariavel_type=' + encodeURIComponent(atendimento.tipo);
      try {
        const resp = await fetch(url, { credentials:'same-origin', redirect:'follow' });
        if (!resp.ok) return '';
        const html = await resp.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        return extrairProfissionalRetornoNativo(doc);
      } catch (e) {
        warn('Profissional do Retorno nativo:', atendimentoStr, e);
        return '';
      }
    })();

    cacheProfissionalRetornoNativo.set(atendimentoStr, promessa);
    return promessa;
  }

  async function processarLinhaProfissionalRetornoNativo(row, vm) {
    const item = itemDaLinha(row, vm);
    if (!item || !itemEhRetornoNativo(item) || !item.atendimento_str) {
      limparInfoProfissionalRetornoNativo(row);
      return;
    }

    const chave = chaveItem(item);
    const existente = row?.cells?.[2]?.querySelector?.('.om30-profissional-retorno-nativo');
    if (row.dataset.om30ProfissionalRetornoNativo === chave && existente?.textContent?.trim()) return;
    row.dataset.om30ProfissionalRetornoNativo = chave;

    const info = criarInfoProfissionalRetornoNativo(row);
    if (!info) return;
    info.style.color = '#6c757d';
    info.textContent = '1º atendimento: consultando...';

    const nome = await buscarProfissionalRetornoNativo(item.atendimento_str);
    // Confere novamente a linha depois do await: ela pode ter sido reaproveitada/reordenada.
    const atual = itemDaLinha(row, vm);
    if (!atual || chaveItem(atual) !== chave || !itemEhRetornoNativo(atual)) {
      limparInfoProfissionalRetornoNativo(row);
      return;
    }

    const alvo = criarInfoProfissionalRetornoNativo(row);
    if (!alvo) return;
    if (nome) {
      alvo.style.color = '#355c7d';
      alvo.textContent = `1º atendimento: ${nome}`;
    } else {
      alvo.style.color = '#8a5555';
      alvo.textContent = 'Profissional não localizado';
    }
  }

  async function processarProfissionaisRetornoNativo(vm = acharVueFila()) {
    if (!vm) return;
    await Promise.allSettled(linhasFila().map(row => processarLinhaProfissionalRetornoNativo(row, vm)));
  }


  function textoAcao(el) {
    if (!el) return '';
    return norm([
      el.getAttribute?.('title'),
      el.getAttribute?.('aria-label'),
      el.getAttribute?.('data-original-title'),
      el.value,
      el.textContent,
      el.className
    ].filter(Boolean).join(' '));
  }

  function garantirLabelAcao(el, label) {
    if (!el || !label) return;

    // Inputs não aceitam filhos. Neles, só ajusta o value.
    if (el.tagName === 'INPUT') {
      if (/^(ATENDER|CHAMAR|CHAMAR PACIENTE|CONFIRMAR)$/i.test(clean(el.value))) {
        el.value = label;
      }
      return;
    }

    const atual = clean(el.textContent);
    if (norm(atual).includes(norm(label))) return;

    // Troca apenas textos operacionais conhecidos, preservando ícones e listeners.
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let no;
    while ((no = walker.nextNode())) {
      const txt = clean(no.nodeValue);
      if (!txt) continue;
      if (/^(ATENDER|CONFIRMAR|CONFIRMAR ATENDIMENTO|CHAMAR|CHAMAR PACIENTE)$/i.test(txt)) {
        no.nodeValue = ` ${label} `;
        return;
      }
    }

    // Botões puramente por ícone recebem um rótulo visual sem alterar o clique.
    const span = document.createElement('span');
    span.className = 'om30-acao-label';
    span.textContent = label;
    el.appendChild(span);
  }

  function melhorarAcoesFila() {
    for (const row of linhasFila()) {
      const celula = row.cells?.[8];
      if (!celula) continue;
      celula.classList.add('om30-acoes-celula');

      const controles = [...celula.querySelectorAll(
        'a, button, input[type="button"], input[type="submit"], [role="button"]'
      )].filter(el => !el.closest('.dropdown-menu') || el.matches('.dropdown-toggle'));

      for (const el of controles) {
        // Evita classificar duas vezes o mesmo controle.
        el.classList.remove('om30-acao-chamar', 'om30-acao-confirmar', 'om30-acao-engrenagem');

        const txt = textoAcao(el);
        const html = norm(el.innerHTML || '');
        const classe = norm(el.className || '');
        const vueNome = norm(
          el.__vue__?.$options?.name ||
          el.parentElement?.__vue__?.$options?.name ||
          el.closest('[data-v-app]')?.__vue__?.$options?.name ||
          ''
        );

        const ehEngrenagem =
          /CONFIG|OPCOES|ACOES|ENGRENAGEM/.test(txt) ||
          /FA-COG|FA-GEAR|ICON-COG|GLYPHICON-COG/.test(html) ||
          /DROPDOWN-TOGGLE/.test(classe);

        const ehConfirmar =
          /BOTAO-INICIAR-ATENDIMENTO/.test(vueNome) ||
          /BOTAO-ATENDER/.test(classe) ||
          /CONFIRMAR ATENDIMENTO/.test(txt) ||
          /\\bATENDER\\b/.test(txt);

        const ehChamar =
          !ehConfirmar && (
            /BOTAO-CHAMAR-PACIENTE/.test(vueNome) ||
            /CHAMAR/.test(txt) ||
            /CHAMAR/.test(classe)
          );

        if (!(ehEngrenagem || ehConfirmar || ehChamar)) continue;

        if (ehEngrenagem) {
          // Mantém exatamente o visual nativo azul da engrenagem.
          el.classList.add('om30-acao-engrenagem');
          el.dataset.om30Acao = 'engrenagem';
          el.setAttribute('title', 'Mais opções');
          el.setAttribute('aria-label', 'Mais opções');
          continue;
        }

        if (ehConfirmar) {
          el.classList.add('om30-acao-confirmar');
          el.dataset.om30Acao = 'confirmar';
          el.setAttribute('title', 'Atender');
          garantirLabelAcao(el, 'Atender');
          continue;
        }

        if (ehChamar) {
          el.classList.add('om30-acao-chamar');
          el.dataset.om30Acao = 'chamar';
          el.setAttribute('title', 'Chamar paciente');
          garantirLabelAcao(el, 'Chamar');
        }
      }
    }
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
    if (!vm) return;
    clearTimeout(timerGuardiaoFiltro);
    timerGuardiaoFiltro = setTimeout(() => aplicarFiltroCustom(vm, true), delay);
  }

  function instalarGuardiaoVue(vm) {
    if (!vm || vm.__om30GuardiaoFiltroInstalado) return;
    vm.__om30GuardiaoFiltroInstalado = true;

    // Padrão do Controle de Salas: o OM30 assume a coleção depois da carga inicial.
    // O fetch nativo não pode recolocar só 10 itens entre duas leituras do monitor.
    const tabela = acharTabelaVueFila();
    if (tabela) estabilizarUmaPagina(tabela, tabela.items?.length || 0);

    // O pai fica em 100 apenas como proteção. O filtro/ordenação operacional usa
    // nossa leitura silenciosa e injeta o resultado diretamente no BTable.
    try { vm.customPerPage = 100; } catch (_) {}
    try { if (vm.$data && 'customPerPage' in vm.$data) vm.$data.customPerPage = 100; } catch (_) {}

    if (typeof vm.fetchCollection === 'function' && !vm.fetchCollection.__om30FilaEstavel) {
      const original = vm.fetchCollection;
      function fetchEstavel(...args) {
        // Antes de termos uma URL válida, deixa a carga nativa acontecer.
        if (!filaCache.url && !descobrirUrlFila(this || vm)) return original.apply(this, args);
        return Promise.resolve(null);
      }
      fetchEstavel.__om30FilaEstavel = true;
      fetchEstavel.__om30Original = original;
      vm.fetchCollection = fetchEstavel;
    }

    // Esconde a paginação nativa; a fila passa a ser uma coleção contínua.
    document.body.classList.add(BODY_CUSTOM);
    log('Motor estável da fila instalado: sem MutationObserver e sem refresh nativo de 10 itens.');
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
  // FILA VISUAL OM30 - SOBRE A FILA NATIVA
  // ---------------------------------------------------------------------------
  // O Saúde Simples continua sendo o motor real: ele busca os dados e mantém os
  // componentes de Chamar / Confirmar / menu. A OM30 apenas deixa a tabela nativa
  // escondida depois da primeira carga e mostra uma fila própria, estável, por cima.

  const VISUAL_ID = `${PREFIX}-visual`;
  const BODY_VISUAL = `${PREFIX}-visual-ativo`;
  const BODY_PREPARANDO = `${PREFIX}-visual-preparando`;
  let visualItens = [];
  let visualAssinaturaFonte = '';
  let visualAssinaturaRender = '';
  let visualAtualizando = false;
  let visualIntervalo = null;
  let visualFonteInicializada = false;
  let visualEnriquecendoRetorno = false;

  function injetarCSSFilaVisual() {
    if (document.getElementById(`${VISUAL_ID}-css`)) return;
    const style = document.createElement('style');
    style.id = `${VISUAL_ID}-css`;
    style.textContent = `
      body.${BODY_PREPARANDO} #classificacao .table-responsive { visibility:hidden !important; }
      body.${BODY_VISUAL} #classificacao .table-responsive { display:none !important; }
      body.${BODY_VISUAL} #classificacao .pagination { display:none !important; }

      #${VISUAL_ID} {
        width:100%;
        box-sizing:border-box;
        margin:10px 0 16px;
        font-family:Arial,Helvetica,sans-serif;
      }
      #${VISUAL_ID} .om30v-resumo {
        display:grid;
        grid-template-columns:repeat(6,minmax(120px,1fr));
        gap:7px;
        margin:0 0 10px;
      }
      #${VISUAL_ID} .om30v-card {
        --c:#6c757d;
        display:grid;
        grid-template-columns:8px 1fr auto;
        grid-template-rows:auto auto;
        column-gap:8px;
        row-gap:2px;
        align-items:center;
        min-width:0;
        min-height:54px;
        padding:8px 10px;
        border:1px solid #dde2e6;
        border-left:4px solid var(--c);
        border-radius:8px;
        background:#fff;
        color:#303840;
        text-align:left;
        cursor:pointer;
        box-shadow:0 1px 2px rgba(0,0,0,.03);
      }
      #${VISUAL_ID} .om30v-card:hover { background:#fafbfc; border-color:#cfd6dc; }
      #${VISUAL_ID} .om30v-card.ativo {
        background:#f7f9fa;
        box-shadow:0 0 0 2px rgba(0,0,0,.035);
      }
      #${VISUAL_ID} .om30v-dot {
        grid-row:1/3;
        width:8px;height:8px;border-radius:50%;background:var(--c);
      }
      #${VISUAL_ID} .om30v-label {
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
        font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.25px;color:#727b83;
      }
      #${VISUAL_ID} .om30v-qtd { font-size:20px;line-height:1;font-weight:800;color:#2d343a; }
      #${VISUAL_ID} .om30v-media { grid-column:2/4;font-size:10px;color:#7c858d;white-space:nowrap; }
      #${VISUAL_ID} .om30v-media strong { color:#4b555d; }

      #${VISUAL_ID} .om30v-tabela-wrap {
        overflow-x:auto;
        border:1px solid #dde2e6;
        border-radius:8px;
        background:#fff;
        box-shadow:0 2px 6px rgba(0,0,0,.035);
      }
      #${VISUAL_ID} table { width:100%;border-collapse:collapse;table-layout:auto;background:#fff; }
      #${VISUAL_ID} thead th {
        padding:9px 8px;
        border-bottom:2px solid #e1e5e8;
        background:#f7f8f9;
        color:#596168;
        font-size:10px;
        font-weight:800;
        text-transform:uppercase;
        text-align:center;
        vertical-align:middle;
        white-space:nowrap;
      }
      #${VISUAL_ID} tbody td {
        padding:8px 7px;
        border-bottom:1px solid #e9ecef;
        color:#343a40;
        font-size:11px;
        line-height:1.3;
        vertical-align:middle;
        text-align:center;
      }
      #${VISUAL_ID} tbody tr:last-child td { border-bottom:0; }
      #${VISUAL_ID} tbody tr:hover td { background:#fbfcfd; }
      #${VISUAL_ID} .om30v-nome { text-align:left; min-width:190px; }
      #${VISUAL_ID} .om30v-chegada { min-width:116px; white-space:nowrap; }
      #${VISUAL_ID} .om30v-espera {
        display:inline-flex;align-items:center;gap:4px;
        margin-top:4px;padding:2px 7px;border-radius:11px;background:#f0f2f4;
        color:#69727a;font-size:9px;font-weight:600;
      }
      #${VISUAL_ID} .om30v-espera strong { color:#343b42;font-size:9.5px; }
      #${VISUAL_ID} .om30v-acoes { min-width:252px;white-space:nowrap; }
      #${VISUAL_ID} .om30v-btn {
        display:inline-flex;align-items:center;justify-content:center;
        min-height:29px;margin:1px 2px;padding:5px 9px;border-radius:6px;
        font-size:10px;font-weight:800;line-height:1;cursor:pointer;vertical-align:middle;
      }
      #${VISUAL_ID} .om30v-chamar { background:#edf8fa;border:1px solid #70c6d2;color:#187989; }
      #${VISUAL_ID} .om30v-confirmar { background:#edf7f0;border:1px solid #6eb88a;color:#257244; }
      #${VISUAL_ID} .om30v-gear { width:30px;padding:0;background:#0d6efd;border:1px solid #0d6efd;color:#fff;font-size:15px; }
      #${VISUAL_ID} .om30v-btn:disabled { opacity:.42;cursor:not-allowed;filter:grayscale(.2); }
      .om30v-menu-flutuante {
        position:fixed;z-index:2147483000;min-width:190px;padding:5px;
        border:1px solid #d8dde2;border-radius:7px;background:#fff;
        box-shadow:0 8px 24px rgba(0,0,0,.16);font-family:Arial,Helvetica,sans-serif;
      }
      .om30v-menu-flutuante button {
        display:block;width:100%;padding:7px 9px;border:0;border-radius:5px;
        background:#fff;color:#343a40;text-align:left;font-size:11px;cursor:pointer;
      }
      .om30v-menu-flutuante button:hover { background:#f3f6f8; }
      #${VISUAL_ID} .om30-retorno-rt36, #${VISUAL_ID} .om30-profissional-retorno-nativo { margin-top:3px;font-size:10px;font-weight:700; }
      #${VISUAL_ID} .om30v-vazio { padding:24px;text-align:center;color:#7b838a;font-size:12px; }

      @media (max-width:1200px) {
        #${VISUAL_ID} .om30v-resumo { grid-template-columns:repeat(3,minmax(150px,1fr)); }
      }
      @media (max-width:760px) {
        #${VISUAL_ID} .om30v-resumo { grid-template-columns:repeat(2,minmax(135px,1fr)); }
      }
    `;
    document.head.appendChild(style);
  }

  function encontrarAcaoNativa(row, tipo) {
    if (!row) return null;
    const todos = [...row.querySelectorAll('a,button,[role="button"]')];

    if (tipo === 'confirmar') {
      return todos.find(el => el.matches?.('.botao-atender,[class*="botao-atender"]')) ||
             todos.find(el => norm(el.innerText || el.textContent || el.title).includes('ATENDER')) || null;
    }

    if (tipo === 'engrenagem') {
      return todos.find(el => el.matches?.('.dropdown-toggle,[data-toggle="dropdown"]')) ||
             todos.find(el => el.querySelector?.('.fa-cog,.fa-gear,[class*="cog"],[class*="gear"]')) || null;
    }

    // Chamar: prioriza o Vue do botão, depois títulos/textos.
    for (const el of todos) {
      let vm = el.__vue__;
      if (norm(vm?.$options?.name) === 'BOTAO-CHAMAR-PACIENTE') return el;
      const txt = norm([el.innerText, el.textContent, el.title, el.getAttribute?.('aria-label'), el.getAttribute?.('data-original-title')].filter(Boolean).join(' '));
      if (txt.includes('CHAMAR')) return el;
    }
    return null;
  }

  function linhasNativasPorChave(vm = acharVueFila()) {
    const mapa = new Map();
    for (const row of linhasFila()) {
      const item = itemDaLinha(row, vm);
      const chave = chaveItem(item);
      if (chave) mapa.set(chave, { row, item });
    }
    return mapa;
  }

  async function prepararFonteVisual({ recarregar = true } = {}) {
    const vm = acharVueFila();
    if (!vm) return null;

    try {
      // A carga NATIVA só é usada na primeira sincronização. Foi validado no
      // console que customPerPage=100 faz o Saúde Simples devolver a fila inteira.
      vm.customPerPage = 100;
      vm.currentPage = 1;
      if (vm.$data) {
        if ('customPerPage' in vm.$data) vm.$data.customPerPage = 100;
        if ('currentPage' in vm.$data) vm.$data.currentPage = 1;
      }

      if (recarregar && !visualFonteInicializada && typeof vm.fetchCollection === 'function') {
        // Se algum rascunho anterior deixou um wrapper, usa o original quando existir.
        const fetchFn = vm.fetchCollection.__om30Original || vm.fetchCollection;
        await Promise.resolve(fetchFn.call(vm));
      }

      await new Promise(resolve => vm.$nextTick ? vm.$nextTick(resolve) : setTimeout(resolve, 0));

      const tabela = acharTabelaVueFila();
      if (!tabela) return null;

      estabilizarUmaPagina(tabela, Number(vm.totalRows || vm.$data?.totalRows || tabela.items?.length || 0));
      await new Promise(resolve => tabela.$nextTick ? tabela.$nextTick(resolve) : setTimeout(resolve, 0));
      await esperar(20);

      visualFonteInicializada = true;
      return { vm, tabela };
    } catch (e) {
      warn('Falha ao preparar fonte da fila visual:', e);
      return null;
    }
  }

  async function sincronizarFonteVisualSilenciosa() {
    const fonte = await prepararFonteVisual({ recarregar: !visualFonteInicializada });
    if (!fonte) return null;

    const { vm, tabela } = fonte;

    // Depois da primeira carga NUNCA chama fetchCollection em loop.
    // Lê o mesmo /prontuarios.json diretamente; isso não ativa loading nem
    // paginação do Vue e, portanto, não faz a tela piscar.
    if (visualFonteInicializada && visualAssinaturaFonte) {
      let novos = null;
      try {
        filaCache = { at: 0, url: filaCache.url || '', itens: filaCache.itens || [] };
        novos = await carregarFilaCompleta(vm, true);
      } catch (e) {
        warn('Leitura silenciosa da fila falhou; mantendo snapshot atual:', e);
      }

      if (Array.isArray(novos)) {
        const assinaturaNova = assinaturaVisualItens(novos);
        const assinaturaTabela = assinaturaVisualItens(tabela.items || []);

        if (assinaturaNova !== assinaturaTabela) {
          setItensVue(vm, novos);
          await new Promise(resolve => tabela.$nextTick ? tabela.$nextTick(resolve) : setTimeout(resolve, 0));
          await esperar(20);
        }
      }
    }

    estabilizarUmaPagina(tabela, tabela.items?.length || 0);
    return { vm, tabela };
  }

  function criarFilaVisual() {
    let host = document.getElementById(VISUAL_ID);
    if (host) return host;

    const tabelaNativa = acharTabelaFila();
    if (!tabelaNativa) return null;
    const wrapperNativo = tabelaNativa.closest('.table-responsive') || tabelaNativa;
    host = document.createElement('section');
    host.id = VISUAL_ID;
    host.innerHTML = `
      <div class="om30v-resumo"></div>
      <div class="om30v-tabela-wrap">
        <table>
          <thead><tr>
            <th>Data/Hora da<br>chegada</th>
            <th>CNS</th>
            <th>Nome / Nome Social</th>
            <th>Nome da Mãe</th>
            <th>Data de Nascimento</th>
            <th>Idade</th>
            <th>Senha</th>
            <th>Risco / Vulnerabilidade</th>
            <th>Ação</th>
          </tr></thead>
          <tbody></tbody>
        </table>
      </div>
    `;

    wrapperNativo.parentNode?.insertBefore(host, wrapperNativo);

    const resumo = host.querySelector('.om30v-resumo');
    for (const filtro of FILTROS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'om30v-card';
      btn.dataset.filtro = filtro.key;
      btn.style.setProperty('--c', filtro.cor);
      btn.innerHTML = `
        <span class="om30v-dot"></span>
        <span class="om30v-label">${filtro.key === 'TODAS' ? 'Total' : filtro.label}</span>
        <strong class="om30v-qtd">0</strong>
        <span class="om30v-media">Calculando...</span>
      `;
      btn.addEventListener('click', () => {
        filtroSelecionado = filtro.key;
        localStorage.setItem(STORAGE_FILTRO, filtroSelecionado);
        visualAssinaturaRender = '';
        renderizarFilaVisual(true);
      });
      resumo.appendChild(btn);
    }

    return host;
  }

  function atualizarResumoVisual() {
    const host = document.getElementById(VISUAL_ID);
    if (!host) return;
    const contagem = contarFila(visualItens);
    const agora = Date.now();

    const medias = {
      TODAS: mediaEspera(visualItens, null, agora),
      VERMELHO: mediaEspera(visualItens, 'VERMELHO', agora),
      AMARELO: mediaEspera(visualItens, 'AMARELO', agora),
      VERDE: mediaEspera(visualItens, 'VERDE', agora),
      AZUL: mediaEspera(visualItens, 'AZUL', agora)
    };

    host.querySelectorAll('.om30v-card').forEach(card => {
      const key = card.dataset.filtro;
      card.classList.toggle('ativo', key === filtroSelecionado);
      const qtd = card.querySelector('.om30v-qtd');
      const media = card.querySelector('.om30v-media');
      const numero = contagem[key] || 0;
      if (qtd) qtd.textContent = String(numero);
      if (!media) return;
      if (key === 'RETORNO') media.textContent = `${numero} ${numero === 1 ? 'retorno' : 'retornos'}`;
      else if (numero) media.innerHTML = `Tempo Médio <strong>${formatarTempoEspera(medias[key] || 0)}</strong>`;
      else media.textContent = 'Sem pacientes';
    });
  }

  function atualizarEsperasVisual() {
    atualizarResumoVisual();
    const host = document.getElementById(VISUAL_ID);
    if (!host) return;
    const porChave = new Map(visualItens.map(item => [chaveItem(item), item]));
    host.querySelectorAll('tbody tr[data-chave]').forEach(tr => {
      const item = porChave.get(tr.dataset.chave);
      const forte = tr.querySelector('.om30v-espera strong');
      if (item && forte) forte.textContent = formatarTempoEspera(tempoEsperaMs(item));
    });
  }

  function copiarCelulaVisual(origem, classe = '') {
    const td = document.createElement('td');
    if (classe) td.className = classe;
    if (origem) td.innerHTML = origem.innerHTML;
    return td;
  }

  function estadoAcaoNativa(row, tipo) {
    const el = encontrarAcaoNativa(row, tipo);
    if (!el) return { existe:false, disabled:true };
    const vm = el.__vue__;
    const disabled = Boolean(
      el.disabled ||
      el.classList?.contains('disabled') ||
      el.getAttribute?.('aria-disabled') === 'true' ||
      vm?.botaoBloqueado === true
    );
    return { existe:true, disabled };
  }

  function fecharMenuVisual() {
    document.querySelectorAll('.om30v-menu-flutuante').forEach(x => x.remove());
  }

  function abrirMenuVisual(chave, botaoVisual) {
    fecharMenuVisual();
    const vm = acharVueFila();
    const alvo = linhasNativasPorChave(vm).get(chave);
    if (!alvo?.row) return;

    const celula = alvo.row.cells?.[8] || alvo.row;
    const menuNativo = celula.querySelector('.dropdown-menu');
    const opcoes = menuNativo
      ? [...menuNativo.querySelectorAll('a,button')].filter(el => !el.disabled && !el.classList.contains('disabled'))
      : [];

    if (!opcoes.length) {
      const toggle = encontrarAcaoNativa(alvo.row, 'engrenagem');
      toggle?.click?.();
      return;
    }

    const menu = document.createElement('div');
    menu.className = 'om30v-menu-flutuante';
    for (const original of opcoes) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = clean(original.innerText || original.textContent || original.title || 'Opção');
      b.addEventListener('click', () => {
        fecharMenuVisual();
        original.click();
      });
      menu.appendChild(b);
    }

    document.body.appendChild(menu);
    const r = botaoVisual.getBoundingClientRect();
    const w = Math.max(190, menu.getBoundingClientRect().width || 190);
    let left = Math.min(window.innerWidth - w - 8, Math.max(8, r.right - w));
    let top = Math.min(window.innerHeight - 20, r.bottom + 4);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    setTimeout(() => {
      const fechar = ev => {
        if (!menu.contains(ev.target) && ev.target !== botaoVisual) {
          fecharMenuVisual();
          document.removeEventListener('mousedown', fechar, true);
        }
      };
      document.addEventListener('mousedown', fechar, true);
    }, 0);
  }

  function acionarNativo(chave, tipo) {
    const vm = acharVueFila();
    const mapa = linhasNativasPorChave(vm);
    const alvo = mapa.get(chave);
    if (!alvo) return;

    const { row, item } = alvo;
    if (tipo === 'confirmar' && itemEhRetorno(item)) {
      salvarContextoRetorno(item, row.__om30AtendimentoAnterior || null);
    }

    const el = encontrarAcaoNativa(row, tipo);
    if (el) {
      el.click();
      return;
    }

    if (tipo === 'chamar') {
      const comps = [...row.querySelectorAll('*')].map(x => x.__vue__).filter(Boolean);
      const btn = comps.find(x => norm(x?.$options?.name) === 'BOTAO-CHAMAR-PACIENTE');
      if (typeof btn?.chamarSenhaManualmente === 'function') btn.chamarSenhaManualmente();
    }
  }

  function renderizarFilaVisual(forcar = false) {
    const host = criarFilaVisual();
    if (!host) return false;

    atualizarResumoVisual();
    const tbody = host.querySelector('tbody');
    const mapaNativo = linhasNativasPorChave();
    const exibidos = ordenarFilaMedica(filtrarItens(visualItens, filtroSelecionado));

    const assinatura = [filtroSelecionado, ...exibidos.map(item => {
      const ref = mapaNativo.get(chaveItem(item));
      const row = ref?.row;
      const confirmar = estadoAcaoNativa(row, 'confirmar');
      const chamar = estadoAcaoNativa(row, 'chamar');
      return [chaveItem(item), riscoItem(item), clean(item?.status || item?.nome_status), confirmar.disabled, chamar.disabled].join('~');
    })].join('||');

    if (!forcar && assinatura === visualAssinaturaRender) {
      atualizarEsperasVisual();
      return true;
    }
    visualAssinaturaRender = assinatura;
    tbody.replaceChildren();

    for (const item of exibidos) {
      const chave = chaveItem(item);
      const ref = mapaNativo.get(chave);
      const rowNativa = ref?.row;
      if (!rowNativa) continue;

      const tr = document.createElement('tr');
      tr.dataset.chave = chave;

      const chegada = copiarCelulaVisual(rowNativa.cells?.[0], 'om30v-chegada');
      chegada.querySelectorAll('.om30-tempo-espera').forEach(x => x.remove());
      const espera = document.createElement('div');
      espera.className = 'om30v-espera';
      espera.innerHTML = `<span>Espera</span><strong>${formatarTempoEspera(tempoEsperaMs(item))}</strong>`;
      chegada.appendChild(espera);
      tr.appendChild(chegada);

      tr.appendChild(copiarCelulaVisual(rowNativa.cells?.[1]));
      tr.appendChild(copiarCelulaVisual(rowNativa.cells?.[2], 'om30v-nome'));
      tr.appendChild(copiarCelulaVisual(rowNativa.cells?.[3]));
      tr.appendChild(copiarCelulaVisual(rowNativa.cells?.[4]));
      tr.appendChild(copiarCelulaVisual(rowNativa.cells?.[5]));
      tr.appendChild(copiarCelulaVisual(rowNativa.cells?.[6]));
      tr.appendChild(copiarCelulaVisual(rowNativa.cells?.[7]));

      const acoes = document.createElement('td');
      acoes.className = 'om30v-acoes';

      const chamarEstado = estadoAcaoNativa(rowNativa, 'chamar');
      const confirmarEstado = estadoAcaoNativa(rowNativa, 'confirmar');
      const engrenagemEstado = estadoAcaoNativa(rowNativa, 'engrenagem');

      const chamar = document.createElement('button');
      chamar.type = 'button';
      chamar.className = 'om30v-btn om30v-chamar';
      chamar.textContent = 'Chamar';
      chamar.disabled = !chamarEstado.existe || chamarEstado.disabled;
      chamar.addEventListener('click', () => acionarNativo(chave, 'chamar'));

      const confirmar = document.createElement('button');
      confirmar.type = 'button';
      confirmar.className = 'om30v-btn om30v-confirmar';
      confirmar.textContent = 'Atender';
      confirmar.disabled = !confirmarEstado.existe || confirmarEstado.disabled;
      confirmar.addEventListener('click', () => acionarNativo(chave, 'confirmar'));

      const gear = document.createElement('button');
      gear.type = 'button';
      gear.className = 'om30v-btn om30v-gear';
      gear.innerHTML = '&#9881;';
      gear.title = 'Opções';
      gear.disabled = !engrenagemEstado.existe || engrenagemEstado.disabled;
      gear.addEventListener('click', () => abrirMenuVisual(chave, gear));

      acoes.append(chamar, confirmar, gear);
      tr.appendChild(acoes);
      tbody.appendChild(tr);
    }

    if (!tbody.children.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 9;
      td.className = 'om30v-vazio';
      td.textContent = 'Nenhum paciente neste filtro.';
      tr.appendChild(td);
      tbody.appendChild(tr);
    }

    return true;
  }

  async function atualizarFilaVisual({ inicial = false } = {}) {
    if (visualAtualizando || !ehPaginaFila()) return false;
    visualAtualizando = true;
    try {
      const fonte = await sincronizarFonteVisualSilenciosa();
      if (!fonte) return false;

      const { vm, tabela } = fonte;
      const itens = Array.isArray(tabela.items) ? [...tabela.items] : [...(vm.$data?.items || [])];
      if (!itens.length && Number(vm.totalRows || vm.$data?.totalRows || 0) > 0) return false;

      const assinaturaFonte = assinaturaVisualItens(itens);
      visualItens = itens;

      if (inicial || assinaturaFonte !== visualAssinaturaFonte) {
        visualAssinaturaFonte = assinaturaFonte;
        visualAssinaturaRender = '';
        renderizarFilaVisual(true);

        // O enriquecimento RT não bloqueia mais a primeira pintura da fila.
        // Faz em segundo plano e redesenha uma única vez quando terminar.
        if (!visualEnriquecendoRetorno) {
          visualEnriquecendoRetorno = true;
          Promise.resolve(processarLinhasRetorno(vm)).then(() => {
            visualAssinaturaRender = '';
            renderizarFilaVisual(true);
          }).catch(() => {}).finally(() => {
            visualEnriquecendoRetorno = false;
          });
        }
      } else {
        // Sem mudança real: não recria nenhuma linha; só atualiza relógios/médias.
        atualizarEsperasVisual();
      }

      document.body.classList.add(BODY_VISUAL);
      document.body.classList.remove(BODY_PREPARANDO);
      return true;
    } catch (e) {
      warn('Atualização da fila visual falhou:', e);
      return false;
    } finally {
      visualAtualizando = false;
    }
  }

  async function iniciarFilaVisualOM30() {
    injetarCSS();
    injetarCSSFilaVisual();
    instalarCapturaCliqueRetorno();
    instalarProtecaoDropdownUltimaLinha();
    document.body.classList.add(BODY_PREPARANDO);

    const limite = Date.now() + 3500;
    let pronta = false;
    while (Date.now() < limite && !pronta) {
      const vm = acharVueFila();
      const tabela = acharTabelaFila();
      if (vm && tabela) pronta = await atualizarFilaVisual({ inicial:true });
      if (!pronta) await esperar(40);
    }

    if (!pronta) {
      document.body.classList.remove(BODY_PREPARANDO);
      warn('Fila visual OM30 não ficou pronta em 3,5s; mantendo fila nativa visível.');
      return;
    }

    clearInterval(visualIntervalo);
    // Monitor silencioso: consulta JSON diretamente. Não chama fetchCollection.
    visualIntervalo = setInterval(() => atualizarFilaVisual().catch(() => {}), 1500);

    // Espera/médias mudam mesmo quando nenhum paciente entra ou sai.
    setInterval(() => atualizarEsperasVisual(), 30000);

    window.addEventListener('pageshow', () => {
      setTimeout(() => atualizarFilaVisual({ inicial:true }), 80);
    });
  }

  // ---------------------------------------------------------------------------
  // Observação / atualização automática da fila
  // ---------------------------------------------------------------------------

  function observarFila() {
    // v2.5.5: propositalmente vazio.
    // O Controle de Salas ficou estável justamente quando o MutationObserver deixou
    // de dirigir a fila. O observer reagia ao próprio redraw e causava o pisca-pisca.
  }

  function iniciarGuardiaoLocal() {
    // Sem guardião que reaplica a coleção em intervalo curto.
    clearInterval(intervaloGuardiaoFiltro);
    intervaloGuardiaoFiltro = null;
  }

  function iniciarAtualizacaoPeriodica() {
    clearInterval(intervaloAtualizacao);
    intervaloAtualizacao = setInterval(async () => {
      if (!ehPaginaFila() || aplicandoItensVue || sincronizandoFonteNativa) return;
      const vm = acharVueFila();
      if (!vm) return;

      // Leitura silenciosa. setItensVue só redesenha se membros/ordem/dados mudaram.
      filaCache = { at: 0, url: filaCache.url || '', itens: filaCache.itens || [] };
      await aplicarFiltroCustom(vm, true);
    }, 1500);
  }

  async function reativarFiltroPersistido() {
    if (!ehPaginaFila()) return false;
    if (reativacaoFiltroEmCurso) return reativacaoFiltroEmCurso;

    const promessa = (async () => {
      const salvo = localStorage.getItem(STORAGE_FILTRO) || 'TODAS';
      filtroSelecionado = FILTROS_VALIDOS.has(salvo) ? salvo : 'TODAS';
      atualizarBotoes();

      const vm = acharVueFila();
      if (!vm) return false;
      instalarGuardiaoVue(vm);

      ocultarTabelaParaTroca();
      await sincronizarFonteNativaFila(vm);
      await aplicarFiltroCustom(vm, true);
      revelarTabelaAposVue(vm);
      return true;
    })();

    reativacaoFiltroEmCurso = promessa;
    try {
      return await promessa;
    } finally {
      if (reativacaoFiltroEmCurso === promessa) reativacaoFiltroEmCurso = null;
    }
  }

  // ---------------------------------------------------------------------------
  // FILA MÉDICA ESTÁVEL - ARQUITETURA DO CONTROLE DE SALAS 1.12
  // ---------------------------------------------------------------------------
  // Diferente dos rascunhos 2.6.x, NÃO existe tabela clonada. A própria coleção
  // nativa recebe a lista completa/filtrada e continua dona dos componentes de
  // Chamar, Atender e engrenagem.

  const MED_BAR_ID = `${PREFIX}-controle-barra`;
  const MED_BODY_PREP = `${PREFIX}-controle-preparando`;
  const MED_PER_PAGE = 5000;
  const MED_MONITOR_MS = 1500;
  let medFonte = [];
  let medAssinaturaFonte = '';
  let medAssinaturaAplicada = '';
  let medAtualizando = false;
  let medIntervalo = null;
  let medOriginalFetch = null;
  let medVm = null;
  let medWatchStop = null;
  let medPesquisaTermo = '';
  let medPesquisaInput = null;
  let medPesquisaUltimaInteracao = 0;
  let medPesquisaGeracao = 0;

  function injetarCSSControleMedico() {
    if (document.getElementById(`${MED_BAR_ID}-css`)) return;
    const st = document.createElement('style');
    st.id = `${MED_BAR_ID}-css`;
    st.textContent = `
      body.${MED_BODY_PREP} #classificacao .collection-with-search-atendimento tbody {
        visibility:hidden !important;
      }
      #${MED_BAR_ID} {
        display:flex;flex-wrap:wrap;gap:7px;align-items:stretch;
        margin:6px 0 8px;padding:7px 8px;border:1px solid #d9dfe4;border-radius:7px;
        background:#f8fafb;font-family:Arial,Helvetica,sans-serif;box-shadow:0 1px 3px rgba(0,0,0,.035);
      }
      #${MED_BAR_ID} .om30m-filtro {
        --c:#6c757d;display:grid;grid-template-columns:7px auto auto;grid-template-rows:auto auto;
        column-gap:7px;align-items:center;min-width:128px;min-height:43px;padding:5px 8px;
        border:1px solid #d6dce1;border-left:4px solid var(--c);border-radius:6px;background:#fff;
        color:#35404a;cursor:pointer;text-align:left;line-height:1.1;
      }
      #${MED_BAR_ID} .om30m-filtro:hover { background:#f7f9fb; }
      #${MED_BAR_ID} .om30m-filtro.ativo { box-shadow:0 0 0 2px color-mix(in srgb,var(--c) 20%,transparent);background:#f7f9fb; }
      #${MED_BAR_ID} .om30m-dot { grid-row:1/3;width:7px;height:7px;border-radius:50%;background:var(--c); }
      #${MED_BAR_ID} .om30m-label { font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.25px;color:#68737c; }
      #${MED_BAR_ID} .om30m-qtd { justify-self:end;font-size:16px;font-weight:800;color:#252d34; }
      #${MED_BAR_ID} .om30m-media { grid-column:2/4;font-size:9px;color:#7b858e;white-space:nowrap; }
      #${MED_BAR_ID} .om30m-media strong { color:#46515a; }
      #${MED_BAR_ID} .om30m-atualizado { margin-left:auto;align-self:center;display:inline-flex;align-items:center;gap:8px;min-width:108px;padding:7px 12px;border:1px solid #d8dfe5;border-radius:8px;background:#fff;box-shadow:0 1px 2px rgba(15,23,42,.04);white-space:nowrap; }
      #${MED_BAR_ID} .om30m-atualizado-label { font-size:11px;font-weight:700;color:#7a8590;letter-spacing:.3px;text-transform:uppercase; }
      #${MED_BAR_ID} .om30m-atualizado-hora { font-size:18px;font-weight:800;color:#3f4a54;line-height:1;letter-spacing:.4px;font-variant-numeric:tabular-nums; }
      #classificacao .collection-with-search-atendimento ul.pagination { display:none !important; }
      #classificacao .collection-with-search-atendimento tbody tr > td:first-child { position:relative !important; padding-left:14px !important; }
      #classificacao .collection-with-search-atendimento tbody tr.om30-risco-VERMELHO > td:first-child::before,
      #classificacao .collection-with-search-atendimento tbody tr.om30-risco-AMARELO > td:first-child::before,
      #classificacao .collection-with-search-atendimento tbody tr.om30-risco-VERDE > td:first-child::before,
      #classificacao .collection-with-search-atendimento tbody tr.om30-risco-AZUL > td:first-child::before {
        content:''; position:absolute; left:2px; top:4px; bottom:4px; width:4px; border-radius:4px;
      }
      #classificacao .collection-with-search-atendimento tbody tr.om30-risco-VERMELHO > td:first-child::before { background:#dc3545; }
      #classificacao .collection-with-search-atendimento tbody tr.om30-risco-AMARELO > td:first-child::before { background:#f9b000; }
      #classificacao .collection-with-search-atendimento tbody tr.om30-risco-VERDE > td:first-child::before { background:#198754; }
      #classificacao .collection-with-search-atendimento tbody tr.om30-risco-AZUL > td:first-child::before { background:#0d6efd; }
      #classificacao .collection-with-search-atendimento .om30-med-espera {
        display:inline-flex;align-items:center;gap:4px;margin-top:4px;padding:2px 7px;border-radius:10px;
        background:#eef1f3;color:#68727b;font-size:9px;line-height:1.25;white-space:nowrap;
      }
      #classificacao .collection-with-search-atendimento .om30-med-espera strong { color:#303941;font-size:9.5px; }
      #classificacao .collection-with-search-atendimento .om30-med-espera .om30-med-clock { font-size:11px;line-height:1; }
      #classificacao .collection-with-search-atendimento td:nth-child(9) { min-width:148px; vertical-align:middle; }
      /* v2.7.8: estilos aplicados DIRETAMENTE às classes nativas do Saúde Simples. */
      #classificacao .om30-med-acoes-proprias,
      #classificacao .om30-med-native-label { display:none !important; }
      #classificacao .om30-med-native-hide { display:initial !important; }
      #classificacao .collection-with-search-atendimento td:nth-child(9) .row {
        display:grid !important;
        grid-template-columns:minmax(0,1fr) 34px !important;
        grid-template-rows:30px 30px !important;
        column-gap:4px !important;
        row-gap:4px !important;
        align-items:stretch !important;
        justify-items:stretch !important;
        margin:0 !important;
        width:100% !important;
        min-width:0 !important;
      }
      #classificacao .collection-with-search-atendimento td:nth-child(9) .row::before,
      #classificacao .collection-with-search-atendimento td:nth-child(9) .row::after { display:none !important; }
      /* O relógio da ação some: espera já aparece em Data/Hora da chegada. */
      #classificacao .collection-with-search-atendimento td:nth-child(9) .botao-tempo-chegada { display:none !important; }
      #classificacao .collection-with-search-atendimento .om30-med-native-call,
      #classificacao .collection-with-search-atendimento .om30-med-native-confirm {
        display:inline-flex !important;align-items:center !important;justify-content:center !important;
        width:100% !important;min-width:0 !important;max-width:none !important;
        height:30px !important;min-height:30px !important;
        padding:0 5px 0 25px !important;border:1px solid #b9c2cc !important;border-radius:5px !important;
        background-color:#fff !important;background-position:5px center !important;background-size:17px !important;
        background-repeat:no-repeat !important;color:#24313f !important;font-size:10px !important;font-weight:700 !important;
        text-decoration:none !important;white-space:nowrap !important;overflow:hidden !important;
        text-overflow:ellipsis !important;filter:none !important;box-shadow:none !important;
      }
      #classificacao .collection-with-search-atendimento .om30-med-native-call {
        grid-column:1 !important;grid-row:1 !important;
      }
      #classificacao .collection-with-search-atendimento .om30-med-native-call::after { content:'Chamar'; }
      #classificacao .collection-with-search-atendimento .om30-med-native-confirm {
        grid-column:1 !important;grid-row:2 !important;
      }
      #classificacao .collection-with-search-atendimento .om30-med-native-confirm::after { content:'Atender'; }
      /* Antes da chamada continua visível, porém cinza. */
      #classificacao .collection-with-search-atendimento .om30-med-native-confirm.om30-med-desabilitado,
      #classificacao .collection-with-search-atendimento .om30-med-native-confirm.disabled,
      #classificacao .collection-with-search-atendimento .om30-med-native-confirm[disabled],
      #classificacao .collection-with-search-atendimento .om30-med-native-confirm[aria-disabled="true"] {
        opacity:1 !important;background-color:#f0f1f2 !important;border-color:#c8cdd2 !important;
        color:#8a9299 !important;filter:grayscale(.35) !important;cursor:not-allowed !important;
      }
      /* Depois de chamar: Confirmar fica verde. */
      #classificacao .collection-with-search-atendimento .om30-med-native-confirm:not(.om30-med-desabilitado):not(.disabled):not([disabled]):not([aria-disabled="true"]) {
        background-color:#edf8f1 !important;border-color:#68ae80 !important;color:#24643b !important;
      }
      #classificacao .collection-with-search-atendimento .om30-med-native-call:not(.disabled):hover { background-color:#eaf4f8 !important; }
      #classificacao .collection-with-search-atendimento .om30-med-native-confirm:not(.om30-med-desabilitado):not(.disabled):not([disabled]):hover { background-color:#e0f2e6 !important; }
      /* Engrenagem permanece azul, porém centralizada visualmente dentro do botão. */
      #classificacao .collection-with-search-atendimento .om30-med-native-gear {
        position:relative !important;
        display:flex !important;align-items:center !important;justify-content:center !important;
        grid-column:2 !important;grid-row:1 / 3 !important;
        width:34px !important;min-width:34px !important;max-width:34px !important;
        height:64px !important;min-height:64px !important;
        align-self:stretch !important;
        margin:0 !important;padding:0 !important;
        border-radius:5px !important;
      }
      #classificacao .collection-with-search-atendimento .om30-med-native-gear .zmdi {
        position:absolute !important;left:50% !important;top:50% !important;
        transform:translate(-50%,-50%) !important;
        font-size:20px !important;line-height:1 !important;
        margin:0 !important;padding:0 !important;
      }
      /* Remove a setinha do dropdown para a engrenagem ficar REALMENTE no centro
         do botão azul. O botão inteiro continua abrindo o mesmo menu nativo. */
      #classificacao .collection-with-search-atendimento .om30-med-native-gear.dropdown-toggle::after {
        display:none !important;
      }
      #classificacao .collection-with-search-atendimento .om30-med-oculto { display:none !important; }
      #classificacao .collection-with-search-atendimento .om30-med-chamar,
      #classificacao .collection-with-search-atendimento .om30-med-confirmar {
        display:inline-flex !important;align-items:center;justify-content:center;gap:4px;width:auto !important;max-width:none !important;
        min-height:30px;padding:0 9px 0 28px !important;border-radius:5px;background-position:7px center !important;
        background-size:17px !important;font-size:11px;font-weight:700;text-decoration:none !important;white-space:nowrap;filter:none !important;
      }
      #classificacao .collection-with-search-atendimento .om30-med-chamar {
        border:1px solid #6fbfca !important;background-color:#eef9fa !important;color:#18717e !important;
      }
      #classificacao .collection-with-search-atendimento .om30-med-chamar::after { content:'Chamar'; }
      #classificacao .collection-with-search-atendimento .om30-med-confirmar {
        border:1px solid #76b990 !important;background-color:#eef8f1 !important;color:#276e43 !important;
      }
      #classificacao .collection-with-search-atendimento .om30-med-confirmar::after { content:'Atender'; }
      #classificacao .collection-with-search-atendimento .om30-med-chamar:hover,
      #classificacao .collection-with-search-atendimento .om30-med-confirmar:hover { filter:none !important;brightness:1 !important; }
      #classificacao .collection-with-search-atendimento .om30-med-chamar.disabled,
      #classificacao .collection-with-search-atendimento .om30-med-confirmar.disabled,
      #classificacao .collection-with-search-atendimento .om30-med-chamar[disabled],
      #classificacao .collection-with-search-atendimento .om30-med-confirmar[disabled] { opacity:.45 !important; }
      @media (max-width:1100px) {
        #${MED_BAR_ID} .om30m-filtro { min-width:112px; }
      }
    `;
    document.head.appendChild(st);

    // v2.7.7 — override final usando as classes NATIVAS reais do Saúde Simples.
    // Não depende de o userscript conseguir adicionar classes auxiliares.
    const native = document.createElement('style');
    native.id = 'om30-med-acoes-nativas-diretas-v277';
    native.textContent = `
      #classificacao .collection-with-search-atendimento td:last-child > .row {
        display:flex !important;
        flex-wrap:nowrap !important;
        align-items:center !important;
        justify-content:flex-end !important;
        gap:5px !important;
        margin:0 !important;
        width:100% !important;
      }
      #classificacao .collection-with-search-atendimento td:last-child > .row::before,
      #classificacao .collection-with-search-atendimento td:last-child > .row::after { display:none !important; }

      /* O relógio nativo da coluna Ação fica oculto; espera já aparece na chegada. */
      #classificacao .collection-with-search-atendimento td:last-child .botao-tempo-chegada {
        display:none !important;
      }

      /* CHAMAR — usa o bonequinho/background NATIVO e só transforma o próprio botão em compacto com texto. */
      #classificacao .collection-with-search-atendimento td:last-child .botao-chamar {
        display:inline-flex !important;
        align-items:center !important;
        justify-content:center !important;
        flex:none !important;
        width:auto !important;
        min-width:78px !important;
        max-width:none !important;
        height:30px !important;
        min-height:30px !important;
        padding:0 8px 0 28px !important;
        border:1px solid #76b9c6 !important;
        border-radius:5px !important;
        background-color:#eef9fa !important;
        background-position:7px center !important;
        background-size:17px auto !important;
        background-repeat:no-repeat !important;
        color:#176b77 !important;
        font:700 11px/1.1 inherit !important;
        text-decoration:none !important;
        white-space:nowrap !important;
        box-shadow:none !important;
        filter:none !important;
        overflow:visible !important;
        text-indent:0 !important;
      }
      #classificacao .collection-with-search-atendimento td:last-child .botao-chamar::after {
        content:'Chamar' !important;
        display:inline !important;
        margin:0 !important;
      }
      #classificacao .collection-with-search-atendimento td:last-child .botao-chamar:hover {
        background-color:#e2f4f6 !important;
      }

      /* CONFIRMAR — usa o bonequinho NATIVO. Sempre visível; cinza enquanto o próprio sistema bloqueia. */
      #classificacao .collection-with-search-atendimento td:last-child .botao-atender {
        display:inline-flex !important;
        align-items:center !important;
        justify-content:center !important;
        flex:none !important;
        width:auto !important;
        min-width:138px !important;
        max-width:none !important;
        height:30px !important;
        min-height:30px !important;
        padding:0 8px 0 28px !important;
        border:1px solid #c5cbd1 !important;
        border-radius:5px !important;
        background-color:#f1f2f3 !important;
        background-position:7px center !important;
        background-size:17px auto !important;
        background-repeat:no-repeat !important;
        color:#8a9299 !important;
        font:700 11px/1.1 inherit !important;
        text-decoration:none !important;
        white-space:nowrap !important;
        box-shadow:none !important;
        filter:grayscale(.35) !important;
        opacity:1 !important;
        overflow:visible !important;
        text-indent:0 !important;
      }
      #classificacao .collection-with-search-atendimento td:last-child .botao-atender::before {
        content:none !important;
        display:none !important;
      }
      #classificacao .collection-with-search-atendimento td:last-child .botao-atender::after {
        content:'Atender' !important;
        display:inline !important;
        margin:0 !important;
      }

      /* Quando o componente NATIVO deixa de estar bloqueado, fica verde. */
      #classificacao .collection-with-search-atendimento td:last-child .botao-atender:not(.disabled):not([disabled]):not([aria-disabled="true"]) {
        background-color:#edf8f1 !important;
        border-color:#68ae80 !important;
        color:#24643b !important;
        filter:none !important;
        cursor:pointer !important;
      }
      #classificacao .collection-with-search-atendimento td:last-child .botao-atender:not(.disabled):not([disabled]):not([aria-disabled="true"]):hover {
        background-color:#e0f2e6 !important;
      }

      /* Se o bloqueio for só estado Vue/classe auxiliar, mantém cinza. */
      #classificacao .collection-with-search-atendimento td:last-child .botao-atender.om30-med-desabilitado {
        background-color:#f1f2f3 !important;
        border-color:#c5cbd1 !important;
        color:#8a9299 !important;
        filter:grayscale(.35) !important;
        cursor:not-allowed !important;
      }

      /* Engrenagem/dropdown: não redesenha, só preserva o tamanho nativo compacto. */
      #classificacao .collection-with-search-atendimento td:last-child .dropdown-toggle {
        flex:none !important;
      }
    `;
    document.head.appendChild(native);

    // v2.8.1 — coluna Ação mapeada pelo DOM real da fila médica.
    // Layout: Chamar em cima, Atender embaixo e engrenagem ao lado dos dois.
    // A cor acompanha SOMENTE a classificação de risco, nunca o botão Chamar.
    const mapped = document.createElement('style');
    mapped.id = 'om30-med-acoes-mapeadas-v285';
    mapped.textContent = `
      /* Risco / Vulnerabilidade: mantém a largura NATIVA; só colore o texto. */
      #classificacao tr.om30-risco-VERMELHO > td:nth-child(8),
      #classificacao tr.om30-risco-VERMELHO > td:nth-child(8) * { color:#dc3545 !important; font-weight:800 !important; background:transparent !important; }
      #classificacao tr.om30-risco-AMARELO > td:nth-child(8),
      #classificacao tr.om30-risco-AMARELO > td:nth-child(8) * { color:#d39e00 !important; font-weight:800 !important; background:transparent !important; }
      #classificacao tr.om30-risco-VERDE > td:nth-child(8),
      #classificacao tr.om30-risco-VERDE > td:nth-child(8) * { color:#198754 !important; font-weight:800 !important; background:transparent !important; }
      #classificacao tr.om30-risco-AZUL > td:nth-child(8),
      #classificacao tr.om30-risco-AZUL > td:nth-child(8) * { color:#0d6efd !important; font-weight:800 !important; background:transparent !important; }

      /* Coluna Ação sem invadir Risco. */
      #classificacao th:nth-child(9), #classificacao td:nth-child(9),
      #classificacao td[aria-colindex="9"] {
        min-width:148px !important; width:148px !important; max-width:148px !important;
        box-sizing:border-box !important; vertical-align:middle !important; white-space:nowrap !important;
        overflow:visible !important; padding-left:1px !important; padding-right:1px !important;
      }
      #classificacao td[aria-colindex="9"] > .row {
        display:grid !important;
        grid-template-columns:112px 30px !important;
        grid-template-rows:30px 30px !important;
        column-gap:4px !important; row-gap:3px !important;
        align-items:stretch !important; justify-content:start !important;
        margin:0 !important; padding:0 !important; width:179px !important; min-width:179px !important; max-width:179px !important;
      }
      #classificacao td[aria-colindex="9"] > .row > .botao-tempo-chegada { display:none !important; }

      /* Botões NATIVOS: só organizamos o tamanho; imagem nativa permanece. */
      #classificacao td[aria-colindex="9"] > .row > a.botao-chamar,
      #classificacao td[aria-colindex="9"] > .row > a.botao-atender {
        display:flex !important; align-items:center !important; justify-content:flex-start !important;
        width:100% !important; min-width:0 !important; max-width:none !important; height:30px !important; min-height:30px !important;
        margin:0 !important; padding:0 5px 0 25px !important;
        border:1px solid #b9c2cc !important; border-radius:5px !important;
        background-repeat:no-repeat !important; background-position:5px center !important; background-size:16px auto !important;
        font-family:inherit !important; font-size:10px !important; line-height:1 !important; font-weight:700 !important;
        text-decoration:none !important; white-space:nowrap !important; box-shadow:none !important; text-indent:0 !important;
        box-sizing:border-box !important; overflow:hidden !important;
      }
      /* O texto é CSS no próprio controle nativo. Assim não some quando o Vue
         redesenha somente os componentes de ação durante uma atualização. */
      #classificacao td[aria-colindex="9"] > .row > a.botao-chamar::after {
        content:'Chamar' !important; display:inline !important; margin:0 !important; color:inherit !important;
      }
      #classificacao td[aria-colindex="9"] > .row > a.botao-atender::after {
        content:'Atender' !important; display:inline !important; margin:0 !important; color:inherit !important;
      }
      #classificacao td[aria-colindex="9"] > .row > a.botao-atender::before { content:none !important; display:none !important; }

      /* Chamar: neutro, como estava bom antes. */
      #classificacao td[aria-colindex="9"] > .row > a.botao-chamar {
        grid-column:1 !important; grid-row:1 !important;
        background-color:#fff !important; border-color:#7fb8cb !important; color:#176b77 !important; cursor:pointer !important;
      }
      #classificacao td[aria-colindex="9"] > .row > a.botao-chamar:hover { background-color:#eef9fa !important; }

      /* Confirmar: sempre visível. Cinza antes da chamada, verde quando o próprio sistema habilitar. */
      #classificacao td[aria-colindex="9"] > .row > a.botao-atender {
        grid-column:1 !important; grid-row:2 !important;
        background-color:#f0f1f2 !important; border-color:#c8cdd2 !important; color:#8a9299 !important;
        filter:grayscale(.35) !important; cursor:not-allowed !important; opacity:1 !important;
      }
      #classificacao td[aria-colindex="9"] > .row > a.botao-atender:not(.disabled):not([disabled]):not([aria-disabled="true"]):not(.om30-med-desabilitado) {
        background-color:#edf8f1 !important; border-color:#68ae80 !important; color:#24643b !important;
        filter:none !important; cursor:pointer !important;
      }
      #classificacao td[aria-colindex="9"] > .row > a.botao-atender:not(.disabled):not([disabled]):not([aria-disabled="true"]):not(.om30-med-desabilitado):hover {
        background-color:#e0f2e6 !important;
      }
      #classificacao td[aria-colindex="9"] > .row > a.botao-atender.disabled,
      #classificacao td[aria-colindex="9"] > .row > a.botao-atender[disabled],
      #classificacao td[aria-colindex="9"] > .row > a.botao-atender[aria-disabled="true"],
      #classificacao td[aria-colindex="9"] > .row > a.botao-atender.om30-med-desabilitado {
        background-color:#f0f1f2 !important; border-color:#c8cdd2 !important; color:#8a9299 !important;
        filter:grayscale(.35) !important; cursor:not-allowed !important; opacity:1 !important;
      }
      #classificacao td[aria-colindex="9"] .om30-med-texto-acao { display:none !important; }

      /* Engrenagem nativa ao lado, ocupando visualmente a altura dos dois botões. */
      #classificacao td[aria-colindex="9"] > .row > .dropdown-opcoes-atendimento {
        grid-column:2 !important; grid-row:1 / span 2 !important;
        align-self:stretch !important; display:flex !important; margin:0 !important; width:30px !important;
      }
      #classificacao td[aria-colindex="9"] > .row > .dropdown-opcoes-atendimento > button.dropdown-toggle {
        width:30px !important; min-width:30px !important; height:63px !important; min-height:63px !important; padding:0 !important;
        display:flex !important; align-items:center !important; justify-content:center !important; border-radius:5px !important;
      }
      /* v2.10.5: geometria final da Ação, baseada no DOM real medido no console. */
      #classificacao td[aria-colindex="9"] {
        display:table-cell !important;
        width:148px !important;
        min-width:148px !important;
        max-width:148px !important;
        padding-left:1px !important;
        padding-right:1px !important;
        overflow:visible !important;
      }
      #classificacao td[aria-colindex="9"] > .row.mx-auto {
        display:grid !important;
        grid-template-columns:112px 30px !important;
        grid-template-rows:30px 30px !important;
        column-gap:4px !important;
        row-gap:3px !important;
        width:146px !important;
        min-width:146px !important;
        max-width:146px !important;
        margin:0 !important;
        padding:0 !important;
        justify-content:start !important;
        align-items:stretch !important;
      }
      #classificacao td[aria-colindex="9"] > .row.mx-auto > a.botao-chamar {
        grid-column:1 !important;
        grid-row:1 !important;
        width:112px !important;
        min-width:112px !important;
        max-width:112px !important;
      }
      #classificacao td[aria-colindex="9"] > .row.mx-auto > a.botao-atender {
        grid-column:1 !important;
        grid-row:2 !important;
        width:112px !important;
        min-width:112px !important;
        max-width:112px !important;
      }
      #classificacao td[aria-colindex="9"] > .row.mx-auto > .dropdown-opcoes-atendimento {
        grid-column:2 !important;
        grid-row:1 / span 2 !important;
        width:30px !important;
        min-width:30px !important;
        max-width:30px !important;
        height:63px !important;
        margin:0 !important;
        padding:0 !important;
        display:flex !important;
        align-items:stretch !important;
      }
      #classificacao td[aria-colindex="9"] > .row.mx-auto > .dropdown-opcoes-atendimento > button.dropdown-toggle {
        position:relative !important;
        width:30px !important;
        min-width:30px !important;
        max-width:30px !important;
        height:63px !important;
        min-height:63px !important;
        max-height:63px !important;
        margin:0 !important;
        padding:0 !important;
        display:flex !important;
        align-items:center !important;
        justify-content:center !important;
      }
      #classificacao td[aria-colindex="9"] > .row.mx-auto > .dropdown-opcoes-atendimento > button.dropdown-toggle > .zmdi {
        position:absolute !important;
        left:50% !important;
        top:50% !important;
        transform:translate(-50%,-50%) !important;
        margin:0 !important;
        padding:0 !important;
        font-size:20px !important;
        line-height:1 !important;
      }
      #classificacao td[aria-colindex="9"] > .row.mx-auto > .dropdown-opcoes-atendimento > button.dropdown-toggle::after {
        display:none !important;
        content:none !important;
      }

      /* v2.10.5 — Ação fixa à direita.
         A tabela continua com rolagem horizontal nativa, mas Chamar/Confirmar/Engrenagem
         ficam sempre visíveis mesmo quando a profissional aumenta o zoom do navegador. */
      #classificacao table.b-table thead th:nth-child(9),
      #classificacao table.b-table tbody td:nth-child(9),
      #classificacao table.b-table td[aria-colindex="9"] {
        position:sticky !important;
        right:0 !important;
        z-index:6 !important;
        background:#fff !important;
        box-shadow:none !important;
      }

      #classificacao table.b-table thead th:nth-child(9) {
        z-index:9 !important;
        background:#fff !important;
      }

      #classificacao table.b-table tbody tr:nth-of-type(odd) td:nth-child(9) {
        background:#f9f9f9 !important;
      }

      #classificacao table.b-table tbody tr:hover td:nth-child(9) {
        background:#f5f5f5 !important;
      }

      /* Menu da engrenagem: abre limpo, acima da coluna sticky e sem "sombra branca". */
      #classificacao .table-responsive,
      #classificacao table,
      #classificacao tbody,
      #classificacao tr,
      #classificacao td[aria-colindex="9"] {
        overflow:visible !important;
      }

      #classificacao td[aria-colindex="9"] .dropdown-menu {
        z-index:3000 !important;
        min-width:220px !important;
        max-width:280px !important;
        border:1px solid #d9e0e7 !important;
        border-radius:6px !important;
        box-shadow:0 8px 22px rgba(15,23,42,.14) !important;
        background:#fff !important;
        overflow:visible !important;
      }
      #classificacao td[aria-colindex="9"] .dropdown-menu .dropdown-item {
        box-sizing:border-box !important;
        width:100% !important;
      }
      #classificacao td[aria-colindex="9"] .dropdown-menu .om30-med-desvincular-outro-profissional {
        white-space:nowrap !important;
      }

      /* A coluna Ação é sticky. Sem elevar a linha atual, a célula sticky da linha
         seguinte pinta por cima do dropdown quando ele ocupa mais de uma linha. */
      #classificacao tr.om30-menu-aberto {
        position:relative !important;
        z-index:99990 !important;
      }
      #classificacao tr.om30-menu-aberto > td:nth-child(9),
      #classificacao tr.om30-menu-aberto > td[aria-colindex="9"] {
        z-index:99999 !important;
      }

      /*
       * Chrome pinta células position:sticky de linhas posteriores sobre o dropdown,
       * mesmo quando o filho da linha atual tem z-index alto. Enquanto houver menu
       * aberto, retiramos temporariamente o stacking sticky SOMENTE das outras linhas.
       */
      #classificacao.om30-menu-acoes-aberto table.b-table tbody tr:not(.om30-menu-aberto) > td:nth-child(9),
      #classificacao.om30-menu-acoes-aberto table.b-table tbody tr:not(.om30-menu-aberto) > td[aria-colindex="9"] {
        position:relative !important;
        right:auto !important;
        z-index:0 !important;
      }
      #classificacao.om30-menu-acoes-aberto table.b-table tbody tr.om30-menu-aberto > td:nth-child(9),
      #classificacao.om30-menu-acoes-aberto table.b-table tbody tr.om30-menu-aberto > td[aria-colindex="9"] {
        position:sticky !important;
        right:0 !important;
        z-index:2147483000 !important;
        overflow:visible !important;
      }
      #classificacao.om30-menu-acoes-aberto tr.om30-menu-aberto .dropdown-menu.show {
        z-index:2147483001 !important;
      }

      /* Padrão: menu abre para a esquerda da engrenagem, alinhado no topo do bloco. */
      #classificacao td[aria-colindex="9"] > .row.mx-auto > .dropdown-opcoes-atendimento .dropdown-menu.show {
        left:auto !important;
        right:calc(100% + 6px) !important;
        top:0 !important;
        bottom:auto !important;
        margin:0 !important;
        transform:none !important;
      }

      /* Encosta o conjunto no limite direito real da coluna, sem sobra branca. */
      #classificacao th:nth-child(9) { width:181px !important; min-width:181px !important; max-width:181px !important; padding-left:2px !important; padding-right:2px !important; box-sizing:border-box !important; }
      /* A responsividade/rolagem horizontal é controlada pelo .table-responsive nativo. */
      #classificacao { overflow-x:visible !important; overflow-y:visible !important; }
      #classificacao.om30-dropdown-ultima-aberto { padding-bottom:180px !important; }

      /* Só na última linha: em vez de abrir para o lado e ficar estranho/cortado,
         o menu abre para baixo, alinhado pela direita da engrenagem. */
      #classificacao .collection-with-search-atendimento tr.om30-ultima-linha .dropdown-menu.show {
        top:100% !important;
        bottom:auto !important;
        left:auto !important;
        right:0 !important;
        margin-top:4px !important;
        transform:none !important;
        z-index:99999 !important;
      }
    `;
    document.head.appendChild(mapped);
  }


  let timerZoomResponsivoMedico = null;

  function garantirCSSResponsivoFilaMedica() {
    let st = document.getElementById('om30-fila-medica-responsivo-v294');
    if (!st) {
      st = document.createElement('style');
      st.id = 'om30-fila-medica-responsivo-v294';
      document.head.appendChild(st);
    }

    st.textContent = `
      /* v2.10.5 — NÃO mexe nas larguras nativas de Data, CNS, Nome, Mãe,
         Nascimento, Idade, Senha ou Risco.
         O BTable/Saúde Simples continua distribuindo essas 8 colunas como sempre. */
      #classificacao .table-responsive {
        display:block !important;
        width:100% !important;
        max-width:100% !important;
        overflow-x:auto !important;
        overflow-y:visible !important;
        -webkit-overflow-scrolling:touch;
      }

      #classificacao .table-responsive > table,
      #classificacao table.b-table {
        width:100% !important;
        max-width:none !important;
        table-layout:auto !important;
      }

      /* Não redefine width/min-width/max-width das colunas 1 a 8.
         Isso é proposital: no diagnóstico nativo, CNS recebe ~186px e Nome ~240px.
         Foram justamente essas medidas que a v2.9.5 estava destruindo. */
      #classificacao table.b-table th:nth-child(-n+8),
      #classificacao table.b-table td:nth-child(-n+8) {
        box-sizing:border-box !important;
      }
      /* Nome e Mãe continuam podendo quebrar normalmente. */
      #classificacao table.b-table th:nth-child(3),
      #classificacao table.b-table td:nth-child(3),
      #classificacao table.b-table th:nth-child(4),
      #classificacao table.b-table td:nth-child(4) {
        white-space:normal !important;
        overflow-wrap:anywhere !important;
      }

      /* Só a Ação é maior que no sistema nativo, porque adicionamos os rótulos
         Chamar / Confirmar. Se faltar espaço, a barra horizontal NATIVA aparece. */
      #classificacao table.b-table th:nth-child(9),
      #classificacao table.b-table td:nth-child(9),
      #classificacao table.b-table td[aria-colindex="9"] {
        width:148px !important;
        min-width:148px !important;
        max-width:148px !important;
        white-space:nowrap !important;
        overflow:visible !important;
        padding-left:1px !important;
        padding-right:1px !important;
      }

      /* Em tela menor não rouba largura das primeiras colunas.
         A tabela simplesmente passa a ter scroll horizontal, igual ao nativo. */
      @media (max-width:1366px) {
        #classificacao table.b-table th:nth-child(9),
        #classificacao table.b-table td:nth-child(9),
        #classificacao table.b-table td[aria-colindex="9"] {
          width:181px !important;
          min-width:181px !important;
          max-width:181px !important;
        }
      }
    `;
  }

  function ajustarZoomResponsivoFilaMedica() {
    garantirCSSResponsivoFilaMedica();

    const raiz = document.querySelector('#classificacao');
    const tabela = raiz?.querySelector('table.b-table, table');
    const responsivo = tabela?.closest('.table-responsive');

    if (!raiz || !tabela || !responsivo) return;

    // Limpa resíduos das versões com zoom/largura compensada.
    for (const el of [raiz, responsivo, tabela, tabela.closest('.collection-with-search-atendimento')].filter(Boolean)) {
      el.style.removeProperty('zoom');
      el.style.removeProperty('transform');
      el.style.removeProperty('transform-origin');
    }

    tabela.style.removeProperty('width');
    tabela.style.removeProperty('min-width');
    tabela.style.removeProperty('max-width');
    tabela.style.tableLayout = 'auto';

    responsivo.style.overflowX = 'auto';
    responsivo.style.overflowY = 'visible';
    responsivo.style.width = '100%';
    responsivo.style.maxWidth = '100%';

    const excesso = Math.max(0, responsivo.scrollWidth - responsivo.clientWidth);
    responsivo.dataset.om30OverflowPx = String(Math.round(excesso));
  }

  function solicitarAjusteZoomResponsivoFilaMedica(delay = 30) {
    clearTimeout(timerZoomResponsivoMedico);
    timerZoomResponsivoMedico = setTimeout(ajustarZoomResponsivoFilaMedica, delay);
  }

  if (!window.__OM30_FILA_MEDICA_ZOOM_RESPONSIVO__) {
    window.__OM30_FILA_MEDICA_ZOOM_RESPONSIVO__ = true;
    window.addEventListener('resize', () => solicitarAjusteZoomResponsivoFilaMedica(80), { passive:true });
  }

  function campoPesquisaMedica(vm = medVm) {
    const classificacao = document.querySelector('#classificacao');
    const inputs = [...document.querySelectorAll('input')]
      .filter(el => !el.disabled && !el.readOnly)
      .filter(el => ['text','search',''].includes(String(el.type || '').toLowerCase()))
      .filter(el => !el.closest('td[aria-colindex="9"], .dropdown-menu, table'))
      .filter(el => {
        const r = el.getBoundingClientRect?.();
        return !r || (r.width >= 120 && r.height > 0);
      });

    const rectClassificacao = classificacao?.getBoundingClientRect?.() || null;

    const pontuar = el => {
      const meta = norm([
        el.placeholder, el.name, el.id, el.className,
        el.getAttribute('aria-label'), el.getAttribute('data-original-title')
      ].filter(Boolean).join(' '));

      let p = 0;
      if (/PESQUIS|BUSC|SEARCH/.test(meta)) p += 60;
      if (/NOME|SENHA|PACIENTE|MUNICIPE|CNS/.test(meta)) p += 25;
      if (String(el.type || '').toLowerCase() === 'search') p += 15;
      if (clean(el.value)) p += 8;

      const r = el.getBoundingClientRect?.();
      if (r && rectClassificacao) {
        const distancia = rectClassificacao.top - r.bottom;
        // O campo nativo da fila fica imediatamente acima de #classificacao.
        if (distancia >= -40 && distancia <= 450) p += 45;
        if (r.width >= 300) p += 8;
      }

      const bloco = el.closest('form,.card,.panel,.box,.form-group,.row,div');
      const contexto = norm(bloco?.innerText || bloco?.textContent || '');
      if (/LIMPAR/.test(contexto)) p += 25;
      if (/ADICIONAR FILTRO/.test(contexto)) p += 25;

      return p;
    };

    const ordenados = inputs
      .map(el => ({ el, p:pontuar(el) }))
      .sort((a,b) => b.p - a.p);

    return ordenados[0]?.p > 0 ? ordenados[0].el : null;
  }

  function lerPesquisaMedica(vm = medVm) {
    const input = campoPesquisaMedica(vm);
    if (input) medPesquisaInput = input;
    const valor = clean(input?.value ?? medPesquisaTermo);
    medPesquisaTermo = valor;
    return valor;
  }

  function itemCombinaPesquisaMedica(item, termo = medPesquisaTermo) {
    const q = norm(termo);
    if (!q) return true;
    const texto = norm([
      item?.nome_municipe,
      item?.nome_social,
      item?.senha,
      item?.codigo_cns
    ].filter(Boolean).join(' '));
    return texto.includes(q);
  }

  function filtrarItensMedicos(itens, filtro = filtroSelecionado, termo = medPesquisaTermo) {
    return filtrarItens(itens, filtro).filter(item => itemCombinaPesquisaMedica(item, termo));
  }

  function instalarPesquisaMedica(vm = medVm) {
    const input = campoPesquisaMedica(vm);
    if (input) {
      medPesquisaInput = input;
      medPesquisaTermo = clean(input.value);
      input.dataset.om30PesquisaMedica = '1';
    }

    // Delegado no document porque o Saúde Simples pode recriar o campo de pesquisa.
    // Assim não perdemos o filtro quando o input é substituído pelo Vue.
    if (document.documentElement.dataset.om30PesquisaMedicaDelegada !== '1') {
      document.documentElement.dataset.om30PesquisaMedicaDelegada = '1';

      const reaplicar = ev => {
        const alvo = ev?.target;
        if (!(alvo instanceof HTMLInputElement)) return;
        const campoAtual = campoPesquisaMedica(medVm);
        if (!campoAtual || alvo !== campoAtual) return;

        medPesquisaInput = campoAtual;
        medPesquisaTermo = clean(campoAtual.value);
        medPesquisaUltimaInteracao = Date.now();
        medPesquisaGeracao++;
        medAssinaturaAplicada = '';

        // Pesquisa/limpeza é local. Não espera nova consulta do Saúde Simples.
        Promise.resolve().then(() => aplicarMedFonte(medVm, true));
      };

      document.addEventListener('input', reaplicar, true);
      document.addEventListener('search', reaplicar, true);
      document.addEventListener('change', reaplicar, true);
    }

    return !!input;
  }

  function assinaturaMedFonte(lista) {
    return (Array.isArray(lista) ? lista : []).map(it => [
      chaveItem(it), riscoItem(it), clean(it?.status || it?.nome_status), clean(it?.senha),
      clean(it?.data_senha_timestamp || it?.data_senha_formatada || it?.data_hora)
    ].join('~')).join('||');
  }

  function assinaturaMedAplicada(lista) {
    return [filtroSelecionado, norm(medPesquisaTermo), ...(Array.isArray(lista) ? lista : []).map(it => [
      chaveItem(it), riscoItem(it), clean(it?.status || it?.nome_status), clean(it?.senha)
    ].join('~'))].join('||');
  }

  function montarBarraControleMedico(vm) {
    if (!vm?.$el?.parentNode) return null;
    let bar = document.getElementById(MED_BAR_ID);
    if (!bar) {
      bar = document.createElement('div');
      bar.id = MED_BAR_ID;
      for (const filtro of FILTROS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'om30m-filtro';
        b.dataset.filtro = filtro.key;
        b.style.setProperty('--c', filtro.cor);
        b.innerHTML = `<span class="om30m-dot"></span><span class="om30m-label"></span><span class="om30m-qtd">0</span><span class="om30m-media"></span>`;
        b.addEventListener('click', ev => {
          ev.preventDefault(); ev.stopPropagation();
          filtroSelecionado = filtro.key;
          localStorage.setItem(STORAGE_FILTRO, filtroSelecionado);
          medAssinaturaAplicada = '';
          aplicarMedFonte(vm, true);
        });
        bar.appendChild(b);
      }
      const at = document.createElement('span');
      at.className = 'om30m-atualizado';
      at.textContent = `🕒 ${horarioCurtoAgora()}`;
      bar.appendChild(at);
    }
    if (bar.nextSibling !== vm.$el) vm.$el.parentNode.insertBefore(bar, vm.$el);
    atualizarBarraControleMedico();
    solicitarAjusteZoomResponsivoFilaMedica(40);
    return bar;
  }

  function atualizarBarraControleMedico() {
    const bar = document.getElementById(MED_BAR_ID);
    if (!bar) return;
    const agora = Date.now();
    const contagem = {
      TODAS: medFonte.length,
      VERMELHO: medFonte.filter(x => riscoItem(x) === 'VERMELHO').length,
      AMARELO: medFonte.filter(x => riscoItem(x) === 'AMARELO').length,
      VERDE: medFonte.filter(x => riscoItem(x) === 'VERDE').length,
      AZUL: medFonte.filter(x => riscoItem(x) === 'AZUL').length,
      RETORNO: medFonte.filter(itemEhRetorno).length,
    };
    const medias = {
      TODAS: mediaEspera(medFonte, null, agora),
      VERMELHO: mediaEspera(medFonte, 'VERMELHO', agora),
      AMARELO: mediaEspera(medFonte, 'AMARELO', agora),
      VERDE: mediaEspera(medFonte, 'VERDE', agora),
      AZUL: mediaEspera(medFonte, 'AZUL', agora),
    };
    for (const f of FILTROS) {
      const b = bar.querySelector(`[data-filtro="${f.key}"]`);
      if (!b) continue;
      b.classList.toggle('ativo', f.key === filtroSelecionado);
      b.querySelector('.om30m-label').textContent = f.key === 'TODAS' ? 'Total' : f.label;
      b.querySelector('.om30m-qtd').textContent = String(contagem[f.key] || 0);
      const m = b.querySelector('.om30m-media');
      if (f.key === 'RETORNO') m.textContent = `${contagem.RETORNO || 0} retorno${contagem.RETORNO === 1 ? '' : 's'}`;
      else {
        const valor = medias[f.key];
        m.innerHTML = valor >= 0 ? `Tempo Médio <strong>${formatarTempoEspera(valor)}</strong>` : 'Sem pacientes';
      }
    }
    const at = bar.querySelector('.om30m-atualizado');
    if (at) at.innerHTML = `<span class="om30m-atualizado-label">Horário</span><span class="om30m-atualizado-hora">${horarioCurtoAgora()}</span>`;
  }

  function itemDaLinhaMed(row, vm) {
    return itemDaLinha(row, vm);
  }

  function encontrarAcaoNativa(acoes, tipo) {
    if (!acoes) return null;
    const todos = [...acoes.querySelectorAll('*')].filter(el => !el.closest('.om30-med-acoes-proprias'));
    const clicaveis = todos.filter(el => el.matches?.('a,button,[role="button"],[data-toggle="dropdown"]'));

    const dados = el => {
      let vm = el.__vue__ || null;
      if (!vm) {
        const host = [el, ...el.querySelectorAll('*')].find(x => x.__vue__);
        vm = host?.__vue__ || null;
      }
      const nomeVm = norm(vm?.$options?.name);
      const txt = norm([
        el.innerText, el.textContent, el.title,
        el.getAttribute?.('aria-label'), el.getAttribute?.('data-original-title'),
        el.className
      ].filter(Boolean).join(' '));
      return { el, vm, nomeVm, txt };
    };

    const lista = clicaveis.map(dados);
    if (tipo === 'chamar') {
      return lista.find(x => x.nomeVm === 'BOTAO-CHAMAR-PACIENTE' || /CHAMAR/.test(x.txt))?.el || null;
    }
    if (tipo === 'confirmar') {
      return lista.find(x => x.nomeVm === 'BOTAO-INICIAR-ATENDIMENTO' || /CONFIRMAR ATENDIMENTO|ATENDER|INICIAR ATENDIMENTO/.test(x.txt))?.el || null;
    }
    if (tipo === 'gear') {
      return lista.find(x => /DROPDOWN-TOGGLE/.test(x.txt) || x.el.matches?.('.dropdown-toggle,[data-toggle="dropdown"]') || x.el.querySelector?.('.fa-cog,.fa-gear,[class*="cog"],[class*="gear"]'))?.el || null;
    }
    return null;
  }

  function clicarAcaoNativa(el) {
    if (!el) return false;
    try {
      el.dispatchEvent(new MouseEvent('click', { bubbles:true, cancelable:true, view:window }));
      return true;
    } catch (_) {
      try { el.click(); return true; } catch (_) { return false; }
    }
  }

  function garantirRotuloNativo(acoes, alvo, tipo, texto, desabilitado = false) {
    if (!acoes || !alvo) return null;
    const seletor = `.om30-med-native-label[data-om30-for="${tipo}"]`;
    let label = acoes.querySelector(seletor);
    if (!label) {
      label = document.createElement('span');
      label.className = `om30-med-native-label om30-med-native-label-${tipo}`;
      label.dataset.om30For = tipo;
      label.textContent = texto;
      // Fica imediatamente ao lado do bonequinho nativo, sem mover o componente Vue.
      alvo.insertAdjacentElement('afterend', label);
      label.addEventListener('click', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        if (label.classList.contains('om30-med-desabilitado')) return;
        clicarAcaoNativa(alvo);
      });
    } else if (label.previousElementSibling !== alvo) {
      alvo.insertAdjacentElement('afterend', label);
    }
    label.textContent = texto;
    label.classList.toggle('om30-med-desabilitado', !!desabilitado);
    label.setAttribute('aria-disabled', desabilitado ? 'true' : 'false');
    return label;
  }

  function limparRotulosNativosOrfaos(acoes, manter = []) {
    if (!acoes) return;
    for (const label of acoes.querySelectorAll('.om30-med-native-label')) {
      if (!manter.includes(label)) label.remove();
    }
  }

  function decorarLinhaMedica(row, item) {
    if (!row || !item) return;
    for (const r of ['VERMELHO','AMARELO','VERDE','AZUL']) row.classList.remove(`om30-risco-${r}`);
    const risco = riscoItem(item);
    if (risco) row.classList.add(`om30-risco-${risco}`);

    const chegada = row.cells?.[0];
    if (chegada) {
      let espera = chegada.querySelector('.om30-med-espera');
      if (!espera) {
        espera = document.createElement('div');
        espera.className = 'om30-med-espera';
        chegada.appendChild(espera);
      }
      espera.innerHTML = `<span class="om30-med-clock">🕒</span><span>Espera</span> <strong>${formatarTempoEspera(tempoEsperaMs(item))}</strong>`;
    }

    // Ações: decoramos os controles NATIVOS do Saúde Simples.
    // Não criamos botões paralelos e não escondemos bonequinhos/engrenagem.
    const acoes = row.cells?.[row.cells.length - 1];
    if (!acoes) return;

    // Remove a UI artificial de versões anteriores, se existir.
    acoes.querySelectorAll('.om30-med-acoes-proprias').forEach(el => el.remove());
    acoes.querySelectorAll('.om30-med-native-hide').forEach(el => el.classList.remove('om30-med-native-hide'));

    const chamarNativo = encontrarAcaoNativa(acoes, 'chamar');
    const confirmarNativo = encontrarAcaoNativa(acoes, 'confirmar');
    const gearNativo = encontrarAcaoNativa(acoes, 'gear');

    // Remove rótulos externos deixados pela 2.7.5: agora o texto nasce no próprio botão (::after),
    // exatamente como no Controle de Salas.
    limparRotulosNativosOrfaos(acoes, []);

    if (chamarNativo) {
      chamarNativo.classList.add('om30-med-native-call');
      chamarNativo.classList.remove('om30-med-native-confirm', 'om30-med-native-gear');
      chamarNativo.setAttribute('title', 'Chamar paciente');
      chamarNativo.querySelectorAll(':scope > .om30-med-texto-acao').forEach(el => el.remove());
    }

    if (confirmarNativo) {
      confirmarNativo.classList.add('om30-med-native-confirm');
      confirmarNativo.classList.remove('om30-med-native-call', 'om30-med-native-gear');
      confirmarNativo.setAttribute('title', 'Atender');
      confirmarNativo.querySelectorAll(':scope > .om30-med-texto-acao').forEach(el => el.remove());

      // Sempre visível: cinza antes da chamada; verde assim que o próprio componente nativo habilitar.
      const vmConfirmar = confirmarNativo.__vue__ ||
        [...confirmarNativo.querySelectorAll('*')].find(x => x.__vue__)?.__vue__ || null;
      const desabilitado = Boolean(
        confirmarNativo.disabled ||
        confirmarNativo.getAttribute('aria-disabled') === 'true' ||
        confirmarNativo.classList.contains('disabled') ||
        vmConfirmar?.botaoBloqueado === true
      );
      confirmarNativo.classList.toggle('om30-med-desabilitado', desabilitado);
    }

    if (gearNativo) {
      gearNativo.classList.add('om30-med-native-gear');
      gearNativo.classList.remove('om30-med-native-call', 'om30-med-native-confirm');
      gearNativo.setAttribute('title', 'Mais opções');
    }
  }

  function decorarLinhasMedicas(vm = medVm || acharVueFila()) {
    if (!vm) return;
    for (const row of linhasFila()) {
      const item = itemDaLinhaMed(row, vm);
      if (item) decorarLinhaMedica(row, item);
    }
  }

  function atualizarEsperasMedicas() {
    const vm = medVm || acharVueFila();
    if (!vm) return;
    for (const row of linhasFila()) {
      const item = itemDaLinhaMed(row, vm);
      const forte = row.querySelector('.om30-med-espera strong');
      if (item && forte) forte.textContent = formatarTempoEspera(tempoEsperaMs(item));
    }
    atualizarBarraControleMedico();
  }

  function prepararColecaoMedica(vm) {
    medVm = vm;
    vm.customPerPage = MED_PER_PAGE;
    vm.currentPage = 1;
    if (vm.$data) {
      if ('customPerPage' in vm.$data) vm.$data.customPerPage = MED_PER_PAGE;
      if ('currentPage' in vm.$data) vm.$data.currentPage = 1;
    }
    montarBarraControleMedico(vm);
    instalarPesquisaMedica(vm);
  }

  function atualizarObjetoMedico(destino, origem) {
    if (!destino || !origem || destino === origem) return destino;
    // Mantém a MESMA referência Vue da linha. Só altera propriedades cujo valor mudou.
    // Isso evita destruir/recriar o componente da linha e, consequentemente, o pisca-pisca.
    for (const [k, v] of Object.entries(origem)) {
      if (destino[k] !== v) {
        try { destino[k] = v; } catch (_) {}
      }
    }
    return destino;
  }

  function reconciliarItensMedicos(vm, desejados) {
    const atual = vm?.$data?.items;
    if (!Array.isArray(atual) || !Array.isArray(desejados)) return { mudou:false, estrutural:false };

    let mudou = false;
    let estrutural = false;
    const desejadas = new Set(desejados.map(chaveItem));

    // 1) Remove somente quem realmente saiu da visão atual.
    for (let i = atual.length - 1; i >= 0; i--) {
      if (!desejadas.has(chaveItem(atual[i]))) {
        atual.splice(i, 1);
        mudou = estrutural = true;
      }
    }

    // 2) Insere/move apenas a linha necessária e preserva as referências já existentes.
    for (let alvo = 0; alvo < desejados.length; alvo++) {
      const novo = desejados[alvo];
      const chave = chaveItem(novo);
      if (chaveItem(atual[alvo]) === chave) {
        atualizarObjetoMedico(atual[alvo], novo);
        continue;
      }

      const existente = atual.findIndex((it, idx) => idx > alvo && chaveItem(it) === chave);
      if (existente >= 0) {
        const [mesmoObjeto] = atual.splice(existente, 1);
        atualizarObjetoMedico(mesmoObjeto, novo);
        atual.splice(alvo, 0, mesmoObjeto);
      } else {
        atual.splice(alvo, 0, novo);
      }
      mudou = estrutural = true;
    }

    // Proteção para qualquer sobra eventual.
    if (atual.length > desejados.length) {
      atual.splice(desejados.length, atual.length - desejados.length);
      mudou = estrutural = true;
    }

    return { mudou, estrutural };
  }

  function aplicarMedFonte(vm = medVm, forcar = false) {
    if (!vm || !Array.isArray(vm.$data?.items)) return false;
    prepararColecaoMedica(vm);
    const termoPesquisa = lerPesquisaMedica(vm);
    const lista = ordenarFilaMedica(filtrarItensMedicos(medFonte, filtroSelecionado, termoPesquisa));
    const assinatura = assinaturaMedAplicada(lista);
    const atual = assinaturaItens(vm.$data.items || []);
    const esperado = assinaturaItens(lista);

    // Sem mudança estrutural: NÃO toca no array Vue. Só atualiza relógios/barra e garante o RT.
    if (!forcar && assinatura === medAssinaturaAplicada && atual === esperado) {
      atualizarEsperasMedicas();
      processarLinhasRetorno(vm).catch?.(() => {});
      processarProfissionaisRetornoNativo(vm).catch?.(() => {});
      return true;
    }

    medAssinaturaAplicada = assinatura;
    aplicandoItensVue = true;
    let resultado = { mudou:false, estrutural:false };
    try {
      vm.customPerPage = MED_PER_PAGE;
      vm.currentPage = 1;
      resultado = reconciliarItensMedicos(vm, lista);
      vm.totalRows = lista.length;
      // IMPORTANTE: não emitimos definedItems aqui. Esse evento fazia o BTable reconstruir
      // todas as linhas mesmo quando só uma pessoa entrava/saía da fila.
      try { vm.isLoading = false; } catch (_) {}
      if (vm.errorRequest == null) { try { vm.errorRequest = {}; } catch (_) {} }
    } finally {
      Promise.resolve().then(() => { aplicandoItensVue = false; });
    }

    const apos = () => {
      decorarLinhasMedicas(vm);
      processarLinhasRetorno(vm).catch?.(() => {});
      processarProfissionaisRetornoNativo(vm).catch?.(() => {});
      atualizarBarraControleMedico();
      solicitarAjusteZoomResponsivoFilaMedica(40);
      document.body.classList.remove(MED_BODY_PREP);
    };
    if (typeof vm.$nextTick === 'function') vm.$nextTick(() => requestAnimationFrame(apos));
    else requestAnimationFrame(apos);
    return true;
  }

  async function lerFonteMedicaSilenciosa(vm) {
    filaCache = { at: 0, url: filaCache.url || '', itens: filaCache.itens || [] };
    return carregarFilaCompleta(vm, true);
  }

  async function atualizarControleMedico({ inicial = false, forcar = false } = {}) {
    if (medAtualizando || !ehPaginaFila()) return false;
    medAtualizando = true;
    try {
      const vm = medVm || acharVueFila();
      if (!vm) return false;
      prepararColecaoMedica(vm);

      const geracaoInicio = medPesquisaGeracao;
      const termoInicio = lerPesquisaMedica(vm);
      const pesquisaRecente = Date.now() - medPesquisaUltimaInteracao < 1500;

      // Enquanto há pesquisa — e por um curto período após LIMPAR — a fonte completa
      // já está em medFonte. Não fazemos fetchCollection nem trocamos a fonte-mãe.
      if (!inicial && medFonte.length && (termoInicio || pesquisaRecente)) {
        medAssinaturaAplicada = '';
        aplicarMedFonte(vm, true);
        return true;
      }

      let todos;
      if (inicial) {
        // Mesma ideia do Controle de Salas: primeira carga usa o carregador nativo,
        // mas já com perPage alto para nascer com a lista inteira.
        vm.customPerPage = 100;
        vm.currentPage = 1;
        if (vm.$data) {
          if ('customPerPage' in vm.$data) vm.$data.customPerPage = 100;
          if ('currentPage' in vm.$data) vm.$data.currentPage = 1;
        }
        if (medOriginalFetch) await Promise.resolve(medOriginalFetch.call(vm));
        await new Promise(resolve => vm.$nextTick ? vm.$nextTick(resolve) : setTimeout(resolve, 0));
        todos = Array.isArray(vm.$data.items) ? [...vm.$data.items] : [];
        // Se por qualquer motivo o nativo ainda vier incompleto, nossa leitura direta completa.
        const total = Number(vm.totalRows || vm.$data?.totalRows || 0);
        if (total > todos.length) todos = await lerFonteMedicaSilenciosa(vm);
      } else {
        todos = await lerFonteMedicaSilenciosa(vm);
      }

      if (!Array.isArray(todos)) return false;

      // Se o usuário pesquisou/limpou enquanto a leitura estava em voo, esta resposta
      // ficou obsoleta. Preserva a medFonte completa e só reaplica a visão atual.
      if (geracaoInicio !== medPesquisaGeracao) {
        medAssinaturaAplicada = '';
        aplicarMedFonte(vm, true);
        return true;
      }

      const ass = assinaturaMedFonte(todos);
      if (forcar || ass !== medAssinaturaFonte || !medFonte.length) {
        medFonte = todos;
        medAssinaturaFonte = ass;
        medAssinaturaAplicada = '';
        aplicarMedFonte(vm, true);
      } else {
        // Mesmo backend: se algum refresh nativo tentou recolocar 10 registros,
        // restaura imediatamente a nossa visão sem refazer a consulta.
        const lista = ordenarFilaMedica(filtrarItensMedicos(medFonte, filtroSelecionado, lerPesquisaMedica(vm)));
        if (assinaturaItens(vm.$data.items || []) !== assinaturaItens(lista)) aplicarMedFonte(vm, true);
        else {
          // Nada mudou: não toca no DOM nem nos componentes da tabela.
          // Isso é o que elimina o pisca na atualização automática. O relógio tem seu
          // próprio ciclo de 30 s e o texto RT permanece porque a linha não é recriada.
          atualizarBarraControleMedico();
        }
      }
      return true;
    } catch (e) {
      warn('Fila médica estável:', e);
      return false;
    } finally {
      medAtualizando = false;
      try { (medVm || acharVueFila()).isLoading = false; } catch (_) {}
      document.body.classList.remove(MED_BODY_PREP);
    }
  }

  function interceptarFetchMedico(vm) {
    if (!vm || vm.fetchCollection?.__om30MedStable) return;
    medOriginalFetch = vm.fetchCollection?.__om30Original || vm.fetchCollection;
    if (typeof medOriginalFetch !== 'function') return;
    const wrapper = function () {
      const self = this;
      const jaTemItens = Array.isArray(self?.$data?.items) && self.$data.items.length > 0;
      // Mesmo princípio do Controle de Salas: atualização automática acontece por baixo.
      // O spinner só pode aparecer na primeira carga; com a fila visível ele causava o pisca.
      if (!jaTemItens) { try { self.isLoading = true; } catch (_) {} }
      return Promise.resolve(atualizarControleMedico({ forcar:false }))
        .finally(() => {
          try { self.isLoading = false; } catch (_) {}
          if (self.errorRequest == null) { try { self.errorRequest = {}; } catch (_) {} }
          document.body.classList.remove(MED_BODY_PREP);
        });
    };
    wrapper.__om30MedStable = true;
    wrapper.__om30Original = medOriginalFetch;
    vm.fetchCollection = wrapper;
  }

  function interceptarAtualizadoresFilaMedica(vm) {
    // O Saúde Simples também possui atualizarListagemFila nos componentes-pai.
    // Se deixarmos esses métodos nativos rodarem, eles recriam a tabela antes mesmo
    // de fetchCollection e causam o pisca. Redirecionamos a atualização automática
    // e o clique de atualizar para a nossa carga silenciosa, como no Controle de Salas.
    let atual = vm;
    for (let i = 0; atual && i < 10; i++, atual = atual.$parent) {
      if (typeof atual.atualizarListagemFila !== 'function' || atual.atualizarListagemFila.__om30MedStable) continue;
      const original = atual.atualizarListagemFila;
      const wrapper = function () {
        return atualizarControleMedico({ forcar:false });
      };
      wrapper.__om30MedStable = true;
      wrapper.__om30Original = original;
      try { atual.atualizarListagemFila = wrapper.bind(atual); } catch (_) {}
    }
  }

  function instalarSentinelaMedica(vm) {
    if (typeof medWatchStop === 'function') { try { medWatchStop(); } catch (_) {} }
    medWatchStop = null;
    if (typeof vm?.$watch !== 'function') return;
    try {
      medWatchStop = vm.$watch(
        () => assinaturaItens(vm.$data?.items || []),
        () => {
          if (aplicandoItensVue || !medFonte.length) return;
          const lista = ordenarFilaMedica(filtrarItensMedicos(medFonte, filtroSelecionado, lerPesquisaMedica(vm)));
          if (assinaturaItens(vm.$data?.items || []) !== assinaturaItens(lista)) {
            Promise.resolve().then(() => aplicarMedFonte(vm, false));
          }
        }
      );
    } catch (_) { medWatchStop = null; }
  }

  function instalarProtecaoDropdownUltimaLinha() {
    if (document.documentElement.dataset.om30DropdownUltimaLinha === '1') return;
    document.documentElement.dataset.om30DropdownUltimaLinha = '1';

    const marcarUltima = () => {
      const rows = linhasFila().filter(r => getComputedStyle(r).display !== 'none');
      rows.forEach(r => r.classList.remove('om30-ultima-linha'));
      rows.at(-1)?.classList.add('om30-ultima-linha');
    };

    document.addEventListener('pointerdown', ev => {
      const botao = ev.target?.closest?.('#classificacao tr.collection-row .dropdown-opcoes-atendimento > button.dropdown-toggle');
      if (!botao) return;
      marcarUltima();

      const row = botao.closest('tr.collection-row');
      document.querySelectorAll('#classificacao tr.om30-menu-aberto').forEach(r => {
        if (r !== row) r.classList.remove('om30-menu-aberto');
      });
      row?.classList.add('om30-menu-aberto');

      const ultima = row?.classList.contains('om30-ultima-linha');
      const raiz = document.querySelector('#classificacao');
      if (raiz) {
        raiz.classList.add('om30-menu-acoes-aberto');
        raiz.classList.toggle('om30-dropdown-ultima-aberto', !!ultima);
      }
    }, true);

    document.addEventListener('click', ev => {
      if (ev.target?.closest?.('#classificacao .dropdown-opcoes-atendimento')) return;
      const raiz = document.querySelector('#classificacao');
      raiz?.classList.remove('om30-dropdown-ultima-aberto', 'om30-menu-acoes-aberto');
      document.querySelectorAll('#classificacao tr.om30-menu-aberto').forEach(r => r.classList.remove('om30-menu-aberto'));
    }, true);

    // Bootstrap/Vue remove .show ao fechar; limpa o espaço logo depois.
    const obs = new MutationObserver(() => {
      const raiz = document.querySelector('#classificacao');
      if (!raiz?.classList.contains('om30-dropdown-ultima-aberto')) return;
      const aberta = raiz.querySelector('tr.om30-ultima-linha .dropdown-menu.show');
      if (!aberta) raiz.classList.remove('om30-dropdown-ultima-aberto');

      for (const row of raiz.querySelectorAll('tr.om30-menu-aberto')) {
        if (!row.querySelector('.dropdown-menu.show')) row.classList.remove('om30-menu-aberto');
      }
      if (!raiz.querySelector('tr.om30-menu-aberto .dropdown-menu.show')) {
        raiz.classList.remove('om30-menu-acoes-aberto');
      }
    });
    obs.observe(document.documentElement, { subtree:true, attributes:true, attributeFilter:['class'] });
    marcarUltima();
  }

  async function iniciarFilaControleMedico() {
    injetarCSS();
    injetarCSSControleMedico();
    instalarCapturaCliqueRetorno();
    // Remove restos da fila clonada dos rascunhos 2.6.x, se o Tampermonkey foi
    // atualizado sem fechar a aba.
    document.getElementById(VISUAL_ID)?.remove();
    document.body.classList.remove(BODY_VISUAL, BODY_PREPARANDO);
    document.body.classList.add(MED_BODY_PREP);

    const salvo = localStorage.getItem(STORAGE_FILTRO) || 'TODAS';
    filtroSelecionado = FILTROS_VALIDOS.has(salvo) ? salvo : 'TODAS';

    const limite = Date.now() + 3500;
    let vm = null;
    while (Date.now() < limite && !vm) {
      vm = acharVueFila();
      if (!vm) await esperar(40);
    }
    if (!vm) {
      document.body.classList.remove(MED_BODY_PREP);
      warn('Componente da fila médica não apareceu em 3,5s.');
      return false;
    }

    medVm = vm;
    medOriginalFetch = vm.fetchCollection?.__om30Original || vm.fetchCollection;
    const ok = await atualizarControleMedico({ inicial:true, forcar:true });
    solicitarAjusteZoomResponsivoFilaMedica(80);
    if (!ok) {
      document.body.classList.remove(MED_BODY_PREP);
      return false;
    }

    interceptarFetchMedico(vm);
    interceptarAtualizadoresFilaMedica(vm);
    instalarSentinelaMedica(vm);
    prepararColecaoMedica(vm);
    document.body.classList.remove(MED_BODY_PREP);

    clearInterval(medIntervalo);
    medIntervalo = null;
    // Não criamos um segundo polling de 1,5 s. O Saúde Simples já atualiza a fila;
    // o fetchCollection nativo passa pelo wrapper silencioso acima. Dois ciclos em
    // paralelo eram a principal fonte de redraw/pisca.
    setInterval(atualizarEsperasMedicas, 30000);

    window.addEventListener('pageshow', () => {
      setTimeout(() => atualizarControleMedico({ forcar:true }).catch(() => {}), 80);
    });
    return true;
  }

  async function iniciarFila() {
    return iniciarFilaControleMedico();
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
  log('v2.11.5 carregado. Fila/Risco/Retorno + Ausentes + desvincular senha na fila médica, sem Cloud de classificação. Filtro inicial:', filtroSelecionado);
})();

// ===== OM30 AUSENTES EMBUTIDO — origem: OM30-Ausentes-Acolhimento v2.0.6 =====
if (/^\/prontuarios(?:\/|$)/i.test(location.pathname)) {
(() => {
  'use strict';
 
  // Módulo Ausentes embutido para /prontuarios.
  // A captura/salvamento da classificação e a CLOUD OM30 2 ficam exclusivamente
  // no OM30-Ausentes-Acolhimento.user.js separado.
  //
  // v2.0.3:
  // - Mensagem ao devolver: deixa claro que é a MESMA senha do munícipe (não precisa informar
  //   número novo), só avisar que voltou para a fila.
  //
  // v2.0.2:
  // - Senha da ficha aparece igual às outras (sem etiqueta "ficha" nem borda tracejada).
  //
  // v2.0.1:
  // - Senha da ficha: passando o mouse mostra por que o Senha Simples não deu o número.
  //
  // v2.0.0:
  // - FICHA FUNCIONANDO: a leitura pulava o conteúdo da página porque confundia o dicionário
  //   dele com o da imagem anterior (PDF iText). Agora lê "SENHA:PD0038 08/10/2026 15:14:19".
  //
  // v1.9.9:
  // - Senha EM = Emergência sempre (venha do Senha Simples ou da ficha), com ou sem profissional.
  // - Ficha: quando não acha a senha, o motivo aparece ao passar o mouse e o texto lido vai
  //   para o console ([OM30 Ausentes] ficha sem senha), para ajustar a leitura.
  //
  // v1.9.8:
  // - CORREÇÃO (regressão da 1.9.0): voltou a consulta pelo guichê de quem está com a senha.
  //   Era isso que trazia o número da maioria quando o Senha Simples responde "em atendimento
  //   por FULANO no guichê X". Vale para a fila médica, emergência, acolhimento e a volta pelo
  //   acolhimento.
  // - "sem nº": passando o mouse mostra o motivo (o que o Senha Simples e a ficha responderam).
  //
  // v1.9.7:
  // - Senha vinda da ficha aparece marcada com "ficha" (só para visualizar; a devolução continua
  //   pelo Senha Simples). Medidor de tempo escondido na versão normal.
  //
  // v1.9.6:
  // - Não fica mais preso em "Conectando ao Senha Simples": a cada 5 s testa se o Senha Simples
  //   já responde e, respondendo, volta a buscar os números (antes esperava um token novo que
  //   podia nunca chegar, e aí ficava sem número para sempre).
  // - Console: OM30AusentesDebug(id) mostra fila por fila o que o Senha Simples respondeu.
  //
  // v1.9.5:
  // - Ficha (PDF iText/Jasper): lê também texto em hexadecimal, aceita a senha longe do rótulo
  //   (único código tipo AA0000 da ficha) e, se não achar, tenta de novo em 10 min (não 12 h).
  //
  // v1.9.4:
  // - CORREÇÃO: no 401 o script apagava o login (token) que a própria tela usa. Agora nunca
  //   mexe no token da tela nem recarrega o login do Senha Simples.
  //
  // v1.9.3:
  // - Clicar no tempo da barra copia o resultado (modo, tempos e quantos com número).
  //
  // v1.9.2:
  // - MODO_NUMERO (AMBOS / SENHA / FICHA) e medição de tempo na barra, para comparar.
  //
  // v1.9.1:
  // - Ausentes da fila médica voltaram a ter número: se a senha está com o profissional
  //   (Senha Simples esconde o número), pega o número na fila do acolhimento, onde a mesma
  //   senha já foi concluída. Só depois tenta a ficha.
  // - Console: OM30AusentesFicha(id) mostra o que o script leu na ficha (para conferir).
  //
  // v1.9.0:
  // - Origem pela coluna PROFISSIONAL da lista de ausentes da fila médica (mesma lista, mesmo
  //   atendimento): sem profissional = ausentado no ACOLHIMENTO; com profissional = ausentado
  //   na FILA MÉDICA (EM... = Emergência). É instantâneo e não depende do Senha Simples.
  //   No acolhimento a coluna vem da lista da fila médica, lida junto com a lista.
  // - O Senha Simples agora só completa a senha / quem chamou (1 consulta por paciente, só na
  //   fila certa). Com 401 a lista continua separada normalmente.
  //
  // v1.8.5:
  // - "sem nº" acabou: quando o Senha Simples não mostra o número (senha com outro profissional),
  //   o script lê a SENHA impressa na ficha do atendimento (PDF da ficha, lido por trás, sem
  //   abrir nada na tela). O número fica guardado, então cada ficha é lida uma vez só.
  //
  // v1.8.4:
  // - Emergência separada da fila médica: card/filtro próprio "Emergência" (fila EMERGÊNCIA
  //   do Senha Simples ou senha começando com EM). Na tela da fila médica pode ser removida
  //   (devolve para a emergência); no acolhimento fica bloqueada.
  //
  // v1.8.3:
  // - Ausente novo aparece sozinho em até ~30 s: a cada 30 s lê só a página 1 da lista (os mais
  //   recentes vêm primeiro) e consulta no Senha Simples só quem é novo. A conferência completa
  //   de hoje (quem saiu da lista em outro computador) roda a cada 5 min e no Atualizar.
  //
  // v1.8.2:
  // - Lista: as páginas dos ausentes são buscadas 6 de uma vez (cada página do sistema leva ~2,5 s).
  // - HTTP 401: não sobrescreve mais o token que a própria tela está usando; ao dar 401, recarrega
  //   o login do Senha Simples da tela (iframe) e espera o token novo, sem ficar repetindo consultas.
  // - Mais consultas simultâneas ao Senha Simples (8).
  //
  // v1.8.1:
  // - Bem mais rápido: para cada ausente consulta primeiro a fila médica; só se não decidir
  //   consulta o acolhimento, e só no fim as outras filas (antes eram TODAS as filas, sempre).
  //   4 consultas ao mesmo tempo. O resultado fica guardado 30 min (vale entre recargas e
  //   entre as telas), então a segunda abertura é quase imediata.
  // - Emergência/urgência contam como fila médica. Fila reconhecida também pelo nome.
  // - O histórico completo da senha é buscado só ao abrir os detalhes.
  //
  // v1.8.0:
  // - Funciona também na aba AUSENTES da fila médica (/prontuarios e /prontuarios/urgencia_emergencia).
  //   Lá só remove quem foi ausentado na fila médica (devolvendo a mesma senha para a fila médica);
  //   quem foi ausentado no acolhimento fica só para consulta, com o botão bloqueado.
  //
  // v1.7.2:
  // - HTTP 401 do Senha Simples (token vencido / login ainda não terminou): não mostra erro.
  //   Espera o token novo que a própria tela recebe do Senha Simples e verifica sozinho.
  //   Se o Senha Simples não estiver logado no navegador, avisa o que fazer.
  //
  // v1.7.1:
  // - Muito mais rápido: a lista de ausentes do sistema tem o histórico inteiro (dezenas de páginas).
  //   Agora carrega só as páginas de HOJE (várias ao mesmo tempo, mostrando conforme chegam).
  //   As páginas antigas só são buscadas quando "Somente hoje" é desmarcado.
  // - Usa a paginação certa da aba (#paginacaoAusentes, parâmetro page_ausentes).
  //
  // v1.7.0:
  // - Lista completa numa página só: busca todas as páginas dos ausentes (sem o limite de 10)
  //   e esconde a paginação. A cada revisita, entra quem foi ausentado e sai quem foi removido,
  //   sem recarregar a tela.
  //
  // v1.6.3:
  // - Não precisa clicar em Atualizar: se nada for encontrado, refaz sozinho do zero;
  //   revisita a lista a cada 90 s e quando a aba volta ao foco. "Não encontrada" não fica em cache.
  //
  // v1.6.2:
  // - Senha Simples logado em outra unidade: consulta direto as filas de acolhimento e médica
  //   desta unidade (antes tudo virava "sem senha") e avisa na barra.
  // - Remoção só liberada para ausentes confirmados no ACOLHIMENTO; o resto fica bloqueado.
  //
  // v1.6.0:
  // - Visual: colunas "Senha" e "Ausente em" na lista de ausentes; janelas e avisos novos
  //   (confirmação, sucesso, erro, bloqueio) no padrão OM30; detalhe da senha redesenhado.
  //
  // v1.5.0:
  // - Senha presa: ao clicar em Chamar e o Senha Simples responder "já chamada / em atendimento
  //   por FULANO", solta a senha (retornar + desvincular) e chama por este guichê.
  //   Vale no acolhimento e na tela do médico.
  // - Devolver da ausência já solta a senha (desvincular), para qualquer guichê chamar.
  //
  // v1.4.2:
  // - 422 "em atendimento no guichê X": consulta de novo pelo guichê X (às vezes vem a senha completa).
  // - "seu usuário" do Senha Simples não vira mais "você" (era texto genérico).
  // - Quando a senha foi concluída sem ser chamada, mostra quem concluiu.
  //
  // v1.4.1:
  // - Consulta com até 3 tentativas e 2 pacientes por vez (o Senha Simples recusava rajadas);
  //   se ainda falhar, o código do erro aparece na etiqueta.
  // - Etiqueta reorganizada: senha em destaque + "Ausente: Emergência"; nomes de setor curtos;
  //   "Chamado por Bianca Jeniffer no Emergência".
  //
  // v1.4.0:
  // - Botão "Senha" em cada ausente: mostra a senha, em qual fila foi ausentado, a hora em que a
  //   senha foi concluída (= ausência) e o histórico por fila (gerada, chamada, concluída, por quem).
  //
  // v1.3.1:
  // - Ausentes da fila médica / emergência / outros: botão de remover BLOQUEADO no acolhimento
  //   (cinza, sem opção de forçar). Os grupos continuam visíveis para consulta.
  //
  // v1.3.0:
  // - Mostra quem chamou a senha por último na fila de origem ("chamado por FULANO · GUICHÊ").
  // - Remover ausência de quem foi ausentado NO ACOLHIMENTO: remove a ausência e devolve a
  //   mesma senha para a fila do acolhimento (retornar_para_atendimento), mostrando o número.
  //   Se a senha não voltar, avisa claramente.
  //
  // v1.2.1:
  // - Salas não ausentam: quem passou por medicação/exames/raio-x/procedimento conta como FILA MÉDICA.
  //
  // v1.2.0:
  // - Consulta a senha em TODAS as filas do Senha Simples da unidade.
  // - 422 "já chamada" conta como senha existente naquela fila (antes virava "Erro").
  // - Origem = fila mais adiantada no fluxo onde a senha existe
  //   (recepção < acolhimento < médico/emergência/pediatria), desempate por created_at.
  //   Salas (medicação, exames, raio-x, procedimento) NÃO ausentam: quem passou por sala
  //   volta para a fila médica e conta como FILA MÉDICA.
  //   Senha parada (nunca chamada nem concluída) só conta se não houver outra.
  // - "Outros setores" mostra o nome da fila (ex.: EMERGÊNCIA, MEDICAÇÃO).
  //
  // v1.1.1:
  // - Leitura das filas em sequência + nova tentativa; o aviso mostra o erro real.
  //
  // v1.1.0:
  // - Locais das filas descobertos pela parametrização DA UNIDADE LOGADA
  //   (/filas/parametrizacoes/{acolhimento|atendimento} -> categoria -> locais_atendimento).
  //   Não depende mais do guichê salvo no computador (que podia ser de outra unidade).
  //
  // v1.0.0:
  // - Origem da ausência pela senha do Senha Simples (recuperar_senha_saude_atendimento):
  //     senha na fila médica          -> FILA MÉDICA
  //     senha só na fila acolhimento  -> ACOLHIMENTO
  //     senha nas duas                -> vale a mais recente (created_at)
  //     nenhuma das duas              -> OUTROS (encaminhado p/ outro setor / sem senha)
  // - Remover pelo acolhimento um ausente da FILA MÉDICA pede confirmação
  //   (removendo pela tela errada o paciente some das duas filas).

  if (window.__OM30_AUSENTES_ACOLHIMENTO_V203__) return;
  window.__OM30_AUSENTES_ACOLHIMENTO_V203__ = true;

  // De onde vem o NÚMERO da senha (a origem é sempre pelo profissional):
  //   'AMBOS' = Senha Simples e, se ele esconder, a ficha | 'SENHA' = só Senha Simples | 'FICHA' = só a ficha
  const MODO_NUMERO = 'AMBOS';
  let T0 = performance.now();
  const VERSAO = (typeof GM_info !== 'undefined' && GM_info?.script?.version) || '2.0.3';
  const PREFIX = 'om30-ausentes-acolhimento';
  // Tela atual: acolhimento ou fila médica (prontuarios e urgencia_emergencia são a mesma fila).
  const TELA = location.pathname.startsWith('/prontuarios') ? 'MEDICO' : 'ACOLHIMENTO';
  const STORAGE_FILTRO = TELA === 'MEDICO' ? `${PREFIX}:filtro-medico` : `${PREFIX}:filtro`;
  const STORAGE_HOJE = `${PREFIX}:somente-hoje`;
  const SESSION_LOCAIS = `${PREFIX}:locais-unidade-v17`;
  const SESSION_CACHE = `${PREFIX}:origem-v22:`;   // guardado no localStorage
  const BAR_ID = `${PREFIX}-barra`;
  const MODAL_ID = `${PREFIX}-modal`;
  const STYLE_ID = `${PREFIX}-css-v161`;
  const CACHE_LOCAIS_MS = 30 * 60 * 1000;
  const CACHE_ORIGEM_MS = 30 * 60 * 1000;
  const REVERIFICAR_MS = 30 * 1000;            // leitura leve (página 1)
  const CONFERENCIA_COMPLETA_MS = 5 * 60 * 1000;  // relê todas as páginas de hoje
  const CONCORRENCIA = 6;
  // /ausentes/{id} no acolhimento, /atendimento_ausentes/{id} na fila médica
  const SEL_REMOVER = 'a[href*="ausentes/"][data-method="delete"]';

  const FILTROS = [
    { key: 'TODOS',       label: 'Todos',       sub: 'ausentes',              cor: '#6c757d' },
    { key: 'ACOLHIMENTO', label: 'Acolhimento', sub: 'pode devolver aqui',    cor: '#198754' },
    { key: 'MEDICO',      label: 'Fila médica', sub: 'só consulta aqui',      cor: '#6f42c1' },
    { key: 'EMERGENCIA',  label: 'Emergência',  sub: '',                      cor: '#dc3545' },
    { key: 'OUTROS',      label: 'Outros setores', sub: 'emergência · só consulta', cor: '#f9b000' }
  ];
  const FILTROS_VALIDOS = new Set(FILTROS.map(f => f.key));

  const ROTULO_ORIGEM = {
    ACOLHIMENTO: 'Acolhimento',
    MEDICO: 'Fila médica',
    EMERGENCIA: 'Emergência',
    OUTROS: 'Outro setor',
    SEM_SENHA: 'Sem senha no Senha Simples',
    ERRO: 'Erro ao consultar',
    INDEFINIDO: 'Fila não encontrada'
  };

  // ---------------------------------------------------------------------------
  // Utilidades
  // ---------------------------------------------------------------------------

  const clean = valor => String(valor ?? '').replace(/\s+/g, ' ').trim();
  const norm = valor => clean(valor).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  const semEspaco = valor => norm(valor).replace(/\s/g, '');
  const esc = v => String(v ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
  const hora = iso => {
    const d = iso ? new Date(iso) : null;
    return d && !isNaN(d) ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
  };
  const horarioCurtoAgora = () => new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  function lerJSON(chave, store = localStorage) {
    try { return JSON.parse(store.getItem(chave) || 'null') || {}; } catch { return {}; }
  }

  function gravar(chave, valor, store = localStorage) {
    try { store.setItem(chave, typeof valor === 'string' ? valor : JSON.stringify(valor)); } catch {}
  }

  function esperar(condicao, ms = 30000) {
    return new Promise((resolve, reject) => {
      const inicio = Date.now();
      (function loop() {
        try { if (condicao()) return resolve(); } catch {}
        if (Date.now() - inicio > ms) return reject(new Error('timeout'));
        setTimeout(loop, 300);
      })();
    });
  }

  async function emParalelo(itens, limite, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: limite }, async () => {
      while (i < itens.length) { const k = i++; await fn(itens[k]); }
    }));
  }

  // ---------------------------------------------------------------------------
  // Senha Simples (somente leitura)
  // ---------------------------------------------------------------------------

  const fnRecuperar = () =>
    (typeof senhaSimplesGetSenhaAtendimento === 'function') ? senhaSimplesGetSenhaAtendimento : null;
  const proxySenha = () =>
    (typeof senhaSimplesProxy !== 'undefined') ? senhaSimplesProxy : null;
  const senhaSimplesPronto = () =>
    !!fnRecuperar() && !!sessionStorage.getItem('senhaSimplesToken');

  // Sempre usa o token mais novo que a tela recebeu do Senha Simples.
  function garantirTokenSenha() {
    const proxy = proxySenha();
    const token = sessionStorage.getItem('senhaSimplesToken');
    if (!proxy || !token) return;
    const h = proxy.defaults.headers || {};
    // Se a tela já tem um token no proxy, é ele que vale (pode ser mais novo que o guardado).
    if (!h.Authorization && !(h.common && h.common.Authorization)) {
      proxy.defaults.headers = { ...h, Authorization: `Bearer ${token}` };
    }
  }

  // ---- Token do Senha Simples ----
  // A tela recebe o token por mensagem do Senha Simples (iframe) a cada carga. O token que já
  // estava guardado pode estar vencido (HTTP 401) até essa mensagem chegar.
  let tokenRecebidoEm = 0;
  let erroLoginSenha = '';
  let aguardandoToken = false;
  let aoChegarToken = null;
  window.addEventListener('message', ev => {
    const a = ev.data;
    if (!a || a.source !== 'om30-senha-simples') return;
    if (!/^https:\/\/senha[a-z]*\.saudesimples\.net$/.test(ev.origin)) return;
    if (a.token) {
      erroLoginSenha = '';
      tokenRecebidoEm = Date.now();
      setTimeout(() => {
        if (aoChegarToken) aoChegarToken();
      }, 300);
    } else if (a.error) {
      erroLoginSenha = clean(a.error);
      if (aoChegarToken) aoChegarToken();
    }
  });

  const eh401 = e => e?.response?.status === 401 || /HTTP 401/.test(String(e));

  // Recarrega o iframe de login do Senha Simples que a própria tela usa: ele manda um token novo.
  let renovadoEm = 0;
  function renovarTokenSenha() {
    if (Date.now() - renovadoEm < 60000) return false;
    renovadoEm = Date.now();
    const frames = [...document.querySelectorAll('iframe')].filter(f => /senha[a-z]*\.saudesimples\.net/i.test(f.src || ''));
    frames.forEach(f => { try { const src = f.src; f.src = 'about:blank'; setTimeout(() => { f.src = src; }, 50); } catch {} });
    console.info(`[OM30 Ausentes] 401 do Senha Simples: login da tela recarregado (${frames.length} iframe).`);
    return frames.length > 0;
  }

  // Quando der 401: avisa sem cara de erro e refaz sozinho assim que o token mudar.
  function esperarTokenNovo(refazer) {
    if (aguardandoToken) return;
    aguardandoToken = true;

    const antigo = sessionStorage.getItem('senhaSimplesToken');
    const inicio = Date.now();
    const pronto = () => {
      clearInterval(timer);
      aguardandoToken = false;
      aoChegarToken = null;
      definirAviso('');
      refazer();
    };
    aoChegarToken = () => {
      if (erroLoginSenha) {
        definirAviso(`Senha Simples não está logado neste navegador (${erroLoginSenha}). Faça login em senhaguaruja.saudesimples.net e recarregue esta página.`);
      } else pronto();
    };
    definirAviso('Conectando ao Senha Simples… a lista será verificada sozinha.');
    let testando = false, ultimoTeste = Date.now();
    const timer = setInterval(async () => {
      const t = sessionStorage.getItem('senhaSimplesToken');
      if (t && t !== antigo) return pronto();
      // O 401 pode ter sido passageiro: testa se o Senha Simples já responde.
      if (!testando && Date.now() - ultimoTeste >= 5000) {
        testando = true; ultimoTeste = Date.now();
        try { garantirTokenSenha(); await senhaSimplesGetSenhaCategorias(); testando = false; return pronto(); }
        catch { testando = false; }
      }
      if (Date.now() - inicio > 20000 && !erroLoginSenha) {
        definirAviso('O Senha Simples não respondeu o login nesta tela. Abra senhaguaruja.saudesimples.net neste navegador, faça login e recarregue esta página.');
      }
    }, 1500);
  }

  // ---------------------------------------------------------------------------
  // Filas da unidade logada (parametrização + categorias do Senha Simples)
  // ---------------------------------------------------------------------------

  async function lerParametrizacao(tipo) {
    if (typeof saudeSimplesProxy !== 'undefined') {
      return (await saudeSimplesProxy.get(`/filas/parametrizacoes/${tipo}`)).data;
    }
    const r = await fetch(`/filas/parametrizacoes/${tipo}`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async function comRetentativa(fn, vezes = 2) {
    let ultimo;
    for (let i = 0; i < vezes; i++) {
      try { return await fn(); } catch (e) { ultimo = e; await new Promise(r => setTimeout(r, 600)); }
    }
    throw ultimo;
  }

  const descricaoErro = e => e?.response?.status ? `HTTP ${e.response.status}` : String(e?.message || e);

  // Ordem do fluxo do PA. Na dúvida entre duas filas onde a senha existe,
  // a mais adiantada no fluxo é onde o paciente estava quando foi ausentado.
  function classificarFila(cat, nome, acolhCat, medCat) {
    const n = norm(nome);
    const igual = (a, b) => a != null && b != null && String(a) === String(b);
    if (igual(cat, acolhCat)) return { grupo: 'ACOLHIMENTO', ordem: 1 };
    if (igual(cat, medCat)) return { grupo: 'MEDICO', ordem: 2 };
    if (/EMERGENC|URGENC/.test(n)) return { grupo: 'EMERGENCIA', ordem: 2 };
    if (/ACOLHIMENTO|CLASSIFICACAO DE RISCO|TRIAGEM/.test(n)) return { grupo: 'ACOLHIMENTO', ordem: 1 };
    if (/ATENDIMENTO MEDICO|CLINICO|CONSULTORIO/.test(n)) return { grupo: 'MEDICO', ordem: 2 };
    if (/RECEP/.test(n)) return { grupo: 'RECEPCAO', ordem: 0 };
    // Salas (controle de salas) não ausentam: o paciente volta para a fila médica e é o médico que ausenta.
    if (/MEDICACAO|EXAME|RADIO|RAIO|PROCEDIMENTO|GESSO|IMOBILIZ/.test(n)) return { grupo: 'SALA', ordem: -1 };
    return { grupo: 'OUTROS', ordem: 2 }; // pediatria, emergência e demais filas de atendimento
  }

  const tituloCaso = v => clean(v).toLowerCase()
    .replace(/(^|\s)(\S)/g, (m, e, c) => e + c.toUpperCase())
    .replace(/\s(De|Da|Do|Das|Dos|E)(?=\s)/g, m => m.toLowerCase());

  // "EMERGÊNCIA MATHEUS SANTAMARIA" -> "Emergência"; "MEDICAÇÃO (MATHEUS SANTAMARIA)" -> "Medicação"
  const SETORES = [
    [/EMERGENCIA/, 'Emergência'], [/PEDIATR/, 'Pediatria'], [/MEDICACAO/, 'Medicação'],
    [/EXAME/, 'Exames'], [/RADIOGRAF|RAIO/, 'Raio-X'], [/SUTURA|CURATIVO/, 'Sutura/Curativo'],
    [/PROCEDIMENTO/, 'Procedimento'], [/RECEP/, 'Recepção'], [/ACOLHIMENTO/, 'Acolhimento'],
    [/ATENDIMENTO MEDICO/, 'Fila médica'], [/DENTISTA|ODONTO/, 'Dentista']
  ];
  const nomeCurto = nome => {
    const n = norm(nome);
    const achado = SETORES.find(([rx]) => rx.test(n));
    return achado ? achado[1] : (tituloCaso(String(nome || '').replace(/\(.*?\)/g, '')) || 'Outro setor');
  };
  const guicheCurto = g => {
    if (!g) return '';
    const n = norm(g);
    const achado = SETORES.find(([rx]) => rx.test(n));
    return /\d/.test(g) || !achado ? tituloCaso(g) : achado[1];
  };
  // "BIANCA JENIFFER VIEIRA MARQUES" -> "Bianca Jeniffer"
  const pessoaCurta = nome => {
    if (!nome || nome === 'você') return nome || '';
    const p = tituloCaso(nome).split(' ');
    return p.slice(0, /^(de|da|do|das|dos|e)$/i.test(p[1] || '') ? 3 : 2).join(' ');
  };

  async function filasDaUnidade(forcar = false) {
    const cache = lerJSON(SESSION_LOCAIS, sessionStorage);
    if (!forcar && cache.t && Date.now() - cache.t < CACHE_LOCAIS_MS && cache.filas?.length) return cache;

    const erros = {};
    // Em sequência (não em paralelo): o proxy do Saúde Simples pode descartar chamadas simultâneas.
    const acolhCat = await comRetentativa(() => lerParametrizacao('acolhimento'))
      .then(p => p?.senha_simples_categoria?.id || null).catch(e => { erros.acolhimento = descricaoErro(e); return null; });
    const medCat = await comRetentativa(() => lerParametrizacao('atendimento'))
      .then(p => p?.senha_simples_categoria?.id || null).catch(e => { erros.atendimento = descricaoErro(e); return null; });

    let categorias = [];
    try {
      const { data } = await comRetentativa(() => senhaSimplesGetSenhaCategorias());
      categorias = Array.isArray(data) ? data : (Object.values(data || {}).find(Array.isArray) || []);
    } catch (e) { erros.categorias = descricaoErro(e); }

    const filas = [];
    for (const c of categorias) {
      let locais = c.locais_atendimento;
      if (!locais) {
        try { locais = (await proxySenha().get(`categorias/${c.id}`)).data?.locais_atendimento; } catch {}
      }
      const local = (locais || []).map(l => l.id).find(Boolean);
      if (!local) continue;
      const guiches = (locais || []).filter(l => l.id).map(l => ({ id: l.id, nome: norm(l.nome) }));
      filas.push({ cat: c.id, nome: c.nome, local, guiches, ...classificarFila(c.id, c.nome, acolhCat, medCat) });
    }

    // Se o Senha Simples estiver logado em OUTRA unidade, a lista de categorias não traz as
    // filas desta unidade. Garante pelo menos acolhimento e fila médica buscando direto.
    let unidadeDiferente = false;
    for (const cat of [acolhCat, medCat]) {
      if (!cat || filas.some(f => f.cat === cat)) continue;
      unidadeDiferente = true;
      try {
        const c = (await proxySenha().get(`categorias/${cat}`)).data;
        const locais = (c?.locais_atendimento || []).filter(l => l.id);
        if (locais.length) {
          filas.push({ cat, nome: c.nome, local: locais[0].id,
                       guiches: locais.map(l => ({ id: l.id, nome: norm(l.nome) })),
                       ...classificarFila(cat, c.nome, acolhCat, medCat) });
        }
      } catch (e) { erros.categorias = descricaoErro(e); }
    }

    const r = { acolhCat, medCat, filas, erros, unidadeDiferente, t: Date.now() };
    console.info('[OM30 Ausentes] Filas do Senha Simples:', filas.map(f => `${f.nome} → ${f.grupo}`).join(' | '));
    if (filas.length && acolhCat && medCat) gravar(SESSION_LOCAIS, r, sessionStorage);
    return r;
  }

  // 200 = senha existe (com datas); 422 ja_chamada = existe e já foi chamada; 404 = não existe.
  async function consultarSenha(local, atendimentoId, tipo) {
    let r;
    for (let i = 0; i < 3; i++) {
      r = await consultarSenhaUmaVez(local, atendimentoId, tipo);
      if (!r?.erro || r.auth) return r;
      await new Promise(ok => setTimeout(ok, 700 * (i + 1)));
    }
    return r;
  }

  // No máximo 8 consultas ao Senha Simples ao mesmo tempo.
  const LIMITE_SIMULTANEAS = 8;
  let emVoo = 0;
  const filaEspera = [];
  async function comLimite(fn) {
    if (emVoo >= LIMITE_SIMULTANEAS) await new Promise(ok => filaEspera.push(ok));
    emVoo++;
    try { return await fn(); } finally { emVoo--; filaEspera.shift()?.(); }
  }

  function consultarSenhaUmaVez(local, atendimentoId, tipo) {
    return comLimite(() => consultarSenhaUmaVezSemLimite(local, atendimentoId, tipo));
  }

  async function consultarSenhaUmaVezSemLimite(local, atendimentoId, tipo) {
    try {
      const { data: s } = await fnRecuperar()({
        localAtendimentoAtualId: local,
        params: { atendimento_id: atendimentoId, atendimento_type: tipo }
      });
      return {
        existe: true, senha: s.senha, created_at: s.created_at, chamado_em: s.chamado_em, confirmado_em: s.confirmado_em,
        chamadoPor: (s.chamado_em || s.confirmado_em) ? clean(s.usuario?.nome) || null : null,
        guiche: (s.chamado_em || s.confirmado_em) ? clean(s.local_atendimento?.nome) || null : null
      };
    } catch (e) {
      const st = e?.response?.status;
      if (st === 404) return null;
      if (st === 422 && e.response?.data?.ja_chamada) {
        // "Senha já se encontra em atendimento por FULANO no guichê X"
        const m = String(e.response.data.error || '').match(/por\s+(.+?)\s+no\s+guich[eê]\s+(.+)$/i);
        const quem = m ? clean(m[1]) : null;
        return {
          existe: true, chamada: true,
          // "seu usuário" é texto genérico do Senha Simples, não quer dizer que foi este login.
          chamadoPor: quem && /seu usu[aá]rio/i.test(quem) ? null : quem,
          guiche: m ? clean(m[2]) : null
        };
      }
      return { erro: st || 'falha', auth: st === 401 };
    }
  }

  // Guarda de origens: apaga as vencidas uma vez por carga.
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(`${PREFIX}:origem-`)) continue;
      const v = lerJSON(k);
      if (!k.startsWith(SESSION_CACHE) || !v.t || Date.now() - v.t > CACHE_ORIGEM_MS) localStorage.removeItem(k);
    }
  } catch {}

  const usada = a => !!(a.chamada || a.chamado_em || a.confirmado_em);

  // Consulta por etapas, parando assim que der para decidir:
  //   1) fila médica / emergência / outras de atendimento  -> se a senha foi usada lá, é de lá
  //   2) acolhimento                                       -> se foi usada lá, é do acolhimento
  //   3) recepção e salas (só se ainda não decidiu)
  // completo=true consulta todas (para o histórico nos detalhes).
  async function origemDoAusente(atendimentoId, tipo, unidade, { completo = false } = {}) {
    const chave = SESSION_CACHE + atendimentoId;
    const cache = lerJSON(chave);
    if (!completo && cache.t && Date.now() - cache.t < CACHE_ORIGEM_MS) return cache;

    const achados = [];
    const errosHttp = [];
    // Outras filas de atendimento (pediatria etc.) vêm antes do acolhimento: quem foi do
    // acolhimento para lá e foi ausentado lá não pode ser tratado como ausente do acolhimento.
    const etapas = [
      unidade.filas.filter(f => f.grupo === 'MEDICO' || f.grupo === 'EMERGENCIA'),
      unidade.filas.filter(f => f.grupo === 'OUTROS'),
      unidade.filas.filter(f => f.grupo === 'ACOLHIMENTO'),
      unidade.filas.filter(f => f.grupo === 'RECEPCAO' || f.grupo === 'SALA')
    ];
    const decidido = () => achados.some(a => a.grupo !== 'SALA' && a.grupo !== 'RECEPCAO' && usada(a));
    let parcial = false;
    for (let e = 0; e < etapas.length; e++) {
      if (!completo && decidido()) { parcial = true; break; }
      await consultarFilas(etapas[e]);
    }
    // Decidiu sem número (senha com outro profissional): tenta pegar o número no acolhimento.
    // Se ainda não tiver o número, tenta nas filas que faltaram (acolhimento primeiro).
    if (parcial && !achados.some(a => a.senha)) {
      const naoConsultada = f => !achados.some(a => a.cat === f.cat);
      const acolh = etapas[2].filter(naoConsultada);
      if (acolh.length) await consultarFilas(acolh);
    }

    // As filas de uma etapa são consultadas ao mesmo tempo (o limite geral segura o excesso).
    async function consultarFilas(filas) {
    await Promise.all(filas.map(async f => {
      let r = await consultarSenha(f.local, atendimentoId, tipo);
      // 422 diz em qual guichê a senha está; consultando por esse guichê, às vezes vem completa.
      if (r?.chamada && r.guiche) {
        const g = (f.guiches || []).find(x => x.nome === norm(r.guiche));
        if (g && g.id !== f.local) {
          const r2 = await consultarSenha(g.id, atendimentoId, tipo);
          if (r2?.existe && !r2.chamada) {
            r = { ...r2, chamadoPor: r2.chamadoPor || r.chamadoPor,
                  guiche: r2.guiche || r.guiche, jaChamadaEm: r.guiche };
          }
        }
      }
      if (!r) return;
      if (r.erro) { errosHttp.push(r.erro); return; }
      achados.push({ ...f, ...r });
    }));
    }

    // Senha parada (nunca chamada nem concluída) é fila que ele ainda não usou;
    // só vale se não houver outra. Recepção só vale se não houver mais nada.
    // Salas não ausentam: se a senha passou por uma sala, o paciente voltou para a fila médica.
    // Senha de sala parada (nunca chamada nem concluída) não conta como passagem pela sala.
    const passouPorSala = achados.some(a => a.grupo === 'SALA' && (a.chamada || a.chamado_em || a.confirmado_em));
    const filasQueAusentam = achados.filter(a => a.grupo !== 'SALA');
    const usadas = filasQueAusentam.filter(a => !(a.created_at && !a.chamado_em && !a.confirmado_em));
    let candidatas = usadas.length ? usadas : filasQueAusentam;
    const semRecepcao = candidatas.filter(a => a.grupo !== 'RECEPCAO');
    if (semRecepcao.length) candidatas = semRecepcao;

    candidatas.sort((a, b) =>
      (b.ordem - a.ordem) || ((Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0)));
    const escolhida = candidatas[0];

    const senha = achados.find(a => a.senha)?.senha || null;
    const historico = [...achados]
      .sort((a, b) => (a.ordem - b.ordem) || ((Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0)))
      .map(a => ({
        fila: nomeCurto(a.nome), grupo: a.grupo, senha: a.senha || null,
        gerada: a.created_at || null, chamada: a.chamado_em || null, concluida: a.confirmado_em || null,
        jaChamada: !!a.chamada, por: a.chamadoPor || null, guiche: a.guiche || null
      }));
    let r;
    if (passouPorSala && !['OUTROS', 'EMERGENCIA'].includes(escolhida?.grupo)) {
      // Voltou da sala para a fila médica: foi lá que o médico ausentou.
      const med = achados.find(a => a.grupo === 'MEDICO');
      r = { origem: 'MEDICO', setor: null, senha, cat: unidade.medCat,
            chamadoPor: med?.chamadoPor || null, guiche: med?.guiche || null,
            acao: (med?.chamada || med?.chamado_em) ? 'Chamado' : 'Concluída' };
    } else if (!escolhida) r = { origem: errosHttp.length ? 'ERRO' : 'SEM_SENHA', setor: null, senha: null, cat: null,
             erroHttp: [...new Set(errosHttp)].join(', ') };
    else r = {
      origem: escolhida.grupo === 'RECEPCAO' ? 'OUTROS' : escolhida.grupo,
      setor: nomeCurto(escolhida.nome),
      senha,
      cat: escolhida.cat,
      chamadoPor: escolhida.chamadoPor || null,
      guiche: escolhida.guiche || null,
      acao: (escolhida.chamada || escolhida.chamado_em) ? 'Chamado' : 'Concluída'
    };
    // Senha EM é da emergência.
    if (r.origem === 'MEDICO' && /^EM/i.test(r.senha || '')) {
      const em = achados.find(a => a.grupo === 'EMERGENCIA');
      r.origem = 'EMERGENCIA';
      r.setor = 'Emergência';
      if (em) r.cat = em.cat;
    }
    r.historico = historico;
    r.parcial = parcial;
    r.t = Date.now();
    // Só guarda resultado confirmado; "não encontrada" e erro são consultados de novo na próxima vez.
    if (r.origem !== 'ERRO' && r.origem !== 'SEM_SENHA') gravar(chave, r);
    return r;
  }

  // ---------------------------------------------------------------------------
  // Origem rápida: o grupo vem do profissional; o Senha Simples só completa senha/quem chamou.
  // ---------------------------------------------------------------------------
  // Consulta uma fila; se a senha estiver com alguém ("em atendimento por X no guichê Y"),
  // consulta de novo pelo guichê Y, que costuma devolver a senha completa.
  async function consultarComGuiche(f, atendimentoId, tipo) {
    let r = await consultarSenha(f.local, atendimentoId, tipo);
    if (r?.chamada && r.guiche) {
      const g = (f.guiches || []).find(x => x.nome === norm(r.guiche));
      if (g && g.id !== f.local) {
        const r2 = await consultarSenha(g.id, atendimentoId, tipo);
        if (r2?.existe && !r2.chamada) {
          r = { ...r2, chamadoPor: r2.chamadoPor || r.chamadoPor, guiche: r2.guiche || r.guiche, jaChamadaEm: r.guiche };
        }
      }
    }
    return r;
  }

  async function origemRapida(atendimentoId, tipo, unidade, grupo, prof, comSenhaSimples) {
    const chave = SESSION_CACHE + atendimentoId;
    const cache = lerJSON(chave);
    if (cache.t && cache.base === grupo && Date.now() - cache.t < CACHE_ORIGEM_MS) return cache;

    const achados = [];
    const errosHttp = [];
    if (comSenhaSimples) {
      const filas = unidade.filas.filter(f => grupo === 'MEDICO'
        ? (f.grupo === 'MEDICO' || f.grupo === 'EMERGENCIA') : f.grupo === 'ACOLHIMENTO');
      await Promise.all(filas.map(async f => {
        const x = await consultarComGuiche(f, atendimentoId, tipo);
        if (!x) return;
        if (x.erro) { errosHttp.push(x.erro); return; }
        achados.push({ ...f, ...x });
      }));
    }
    // Sem número na fila médica (senha com o profissional): a mesma senha passou pelo
    // acolhimento e lá já está concluída, então o Senha Simples mostra o número.
    // Ainda sem número: procura a mesma senha nas outras filas (acolhimento, salas de
    // medicação/exames, recepção...). Onde ela já foi concluída, o Senha Simples mostra o número.
    let numeroExtra = null;
    if (comSenhaSimples && !achados.some(a => a.senha)) {
      const jaVistas = new Set(achados.map(a => a.cat));
      const resto = unidade.filas.filter(f => !jaVistas.has(f.cat) &&
        !(grupo === 'MEDICO' ? (f.grupo === 'MEDICO' || f.grupo === 'EMERGENCIA') : f.grupo === 'ACOLHIMENTO'));
      resto.sort((a, b) => (a.grupo === 'ACOLHIMENTO' ? 0 : a.grupo === 'SALA' ? 1 : 2) - (b.grupo === 'ACOLHIMENTO' ? 0 : b.grupo === 'SALA' ? 1 : 2));
      const res = await Promise.all(resto.map(f => consultarComGuiche(f, atendimentoId, tipo).catch(() => null)));
      numeroExtra = res.find(x => x?.senha)?.senha || null;
    }
    achados.sort((a, b) => Number(usada(b)) - Number(usada(a)) || ((Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0)));
    const ach = achados[0];
    const senha = achados.find(a => a.senha)?.senha || numeroExtra || null;
    let origem = grupo;
    if (grupo === 'MEDICO' && (/^EM/i.test(senha || '') || (ach && ach.grupo === 'EMERGENCIA'))) origem = 'EMERGENCIA';
    const r = {
      origem, base: grupo,
      setor: origem === 'EMERGENCIA' ? 'Emergência' : (ach ? nomeCurto(ach.nome) : null),
      senha,
      cat: ach?.cat || (grupo === 'ACOLHIMENTO' ? unidade.acolhCat : unidade.medCat) || null,
      chamadoPor: ach?.chamadoPor || (grupo === 'MEDICO' ? prof : null) || null,
      guiche: ach?.guiche || null,
      acao: ach ? ((ach.chamada || ach.chamado_em) ? 'Chamado' : 'Concluída') : (prof ? 'Profissional' : 'Chamado'),
      historico: achados.map(a => ({
        fila: nomeCurto(a.nome), grupo: a.grupo, senha: a.senha || null,
        gerada: a.created_at || null, chamada: a.chamado_em || null, concluida: a.confirmado_em || null,
        jaChamada: !!a.chamada, por: a.chamadoPor || null, guiche: a.guiche || null
      })),
      parcial: true,
      erroHttp: [...new Set(errosHttp)].join(', '),
      motivoSemNumero: senha ? '' : !comSenhaSimples ? 'Senha Simples não consultado (conectando)'
        : errosHttp.length ? `Senha Simples deu erro ${[...new Set(errosHttp)].join(', ')}`
          : achados.length ? `Senha Simples não mostra o número (com ${achados.find(a => a.chamadoPor)?.chamadoPor || 'outro profissional'})`
            : 'Senha Simples não achou a senha nas filas',
      t: Date.now()
    };
    if (comSenhaSimples && !errosHttp.length) gravar(chave, r);
    return r;
  }

  // ---------------------------------------------------------------------------
  // Senha pela ficha do atendimento (PDF "SENHA: PF0087 11/10/2026 15:17:30")
  // ---------------------------------------------------------------------------

  const CHAVE_FICHA = `${PREFIX}:ficha-v4:`;
  const FICHA_MS = 12 * 60 * 60 * 1000;

  // Junta o texto das strings do PDF: (texto) Tj, [(te) -20 (xto)] TJ.
  function textoDoConteudoPdf(c) {
    const partes = [];
    const re = /\((?:[^()\\]|\\[\s\S])*\)|(?<!<)<[0-9A-Fa-f\s]+>(?!>)|\]\s*TJ|Tj|T\*|'|"|Td|TD|Tm|ET/g;
    let m, linha = '';
    while ((m = re.exec(c))) {
      const t = m[0];
      if (t[0] === '<') {
        const hex = t.slice(1, -1).replace(/\s/g, '');
        for (let k = 0; k + 1 < hex.length; k += 2) linha += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16));
      } else if (t[0] === '(') {
        linha += t.slice(1, -1)
          .replace(/\\([0-7]{1,3})/g, (x, o) => String.fromCharCode(parseInt(o, 8)))
          .replace(/\\([nrtbf])/g, ' ')
          .replace(/\\([\s\S])/g, '$1');
      } else if (t === 'Td' || t === 'TD' || t === 'T*' || t === 'Tm' || t === 'ET') {
        if (linha) { partes.push(linha); linha = ''; }
      }
    }
    if (linha) partes.push(linha);
    return partes.join('\n');
  }

  // Descompacta aproveitando o que der, mesmo com lixo no fim do stream.
  async function inflar(bytes) {
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
    const dec = new TextDecoder('latin1');
    let out = '';
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; out += dec.decode(value, { stream: true }); }
    } catch {}
    return out;
  }

  function ascii85(bytes) {
    const txt = new TextDecoder('latin1').decode(bytes).replace(/\s/g, '').replace(/^<~/, '').replace(/~>.*$/, '');
    const out = [];
    let grupo = [];
    for (const ch of txt) {
      if (ch === 'z' && !grupo.length) { out.push(0, 0, 0, 0); continue; }
      grupo.push(ch.charCodeAt(0) - 33);
      if (grupo.length === 5) {
        let v = 0; for (const d of grupo) v = v * 85 + d;
        out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
        grupo = [];
      }
    }
    if (grupo.length) {
      const n = grupo.length;
      while (grupo.length < 5) grupo.push(84);
      let v = 0; for (const d of grupo) v = v * 85 + d;
      out.push(...[(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].slice(0, n - 1));
    }
    return new Uint8Array(out);
  }

  async function lerTextoPdf(url) {
    const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    const bin = new TextDecoder('latin1').decode(buf);
    const textos = [];
    let i = 0, n = 0;
    while ((i = bin.indexOf('stream', i)) >= 0 && n < 400) {
      let ini = i + 6;
      if (bin[ini] === '\r') ini++;
      if (bin[ini] === '\n') ini++;
      const fim = bin.indexOf('endstream', ini);
      if (fim < 0) break;
      // Dicionário do PRÓPRIO objeto (do "N 0 obj" até "stream"), não os 300 caracteres anteriores,
      // que podiam pegar o "/Subtype/Image" da imagem de antes e pular o conteúdo da página.
      const objIni = bin.lastIndexOf('obj', i);
      const dic = bin.slice(objIni >= 0 && i - objIni < 4000 ? objIni : Math.max(0, i - 300), i);
      if (!/\/Subtype\s*\/Image|\/FontFile/.test(dic)) {
        let c = '';
        try {
          let bytes = buf.slice(ini, fim);
          if (/ASCII85Decode/.test(dic)) bytes = ascii85(bytes);
          c = /FlateDecode/.test(dic) ? await inflar(bytes) : new TextDecoder('latin1').decode(bytes);
        } catch {}
        if (c) textos.push(textoDoConteudoPdf(c), c);
      }
      i = fim + 9; n++;
    }
    return textos.join('\n');
  }

  let ultimoTextoFicha = '';
  let fichaLogada = 0;
  async function senhaPelaFicha(id, tipo) {
    if (tipo !== 'AtendimentoPa') return null;
    const cache = lerJSON(CHAVE_FICHA + id);
    if (cache.t && Date.now() - cache.t < FICHA_MS) return cache.senha || null;
    const texto = await lerTextoPdf(`/atendimentos_pas/${id}.pdf`);
    ultimoTextoFicha = texto;
    const m = texto.match(/SENHA\s*:?\s*([A-Z]{2}\s?\d{3,4})\b/);
    let senha = m ? m[1].replace(/\s/g, '').toUpperCase() : null;
    if (!senha) {
      // Jasper desenha rótulo e valor separados: vale o único código tipo AA0000 da ficha.
      const codigos = [...new Set(texto.match(/\b[A-Z]{2}\d{4}\b/g) || [])];
      if (codigos.length === 1) senha = codigos[0];
    }
    // Sem senha: guarda só 10 min, para tentar de novo.
    gravar(CHAVE_FICHA + id, { senha, t: senha ? Date.now() : Date.now() - FICHA_MS + 10 * 60 * 1000 });
    return senha;
  }

  window.OM30AusentesDebug = async id => {
    const u = unidadeAtual || await filasDaUnidade(true);
    const out = { aguardandoToken, acolhCat: u.acolhCat, medCat: u.medCat, erros: u.erros, prof: mapaProf.get(String(id)) || null, filas: [] };
    for (const f of u.filas || []) {
      const r = await consultarSenhaUmaVezSemLimite(f.local, String(id), 'AtendimentoPa');
      out.filas.push({ fila: f.nome, grupo: f.grupo, resposta: r ? (r.erro ? `erro ${r.erro}` : (r.senha || (r.chamada ? `com ${r.chamadoPor || '?'}` : 'existe sem nº'))) : 'não existe' });
    }
    console.log(JSON.stringify(out, null, 2));
  };

  window.OM30AusentesFicha = async id => {
    const t = await lerTextoPdf(`/atendimentos_pas/${id}.pdf`);
    const i = t.search(/SENHA/i);
    console.log(JSON.stringify({ tamanho: t.length, codigos: [...new Set(t.match(/\b[A-Z]{2}\d{4}\b/g) || [])],
                  trecho: i >= 0 ? t.slice(Math.max(0, i - 120), i + 200) : t.slice(0, 600) }, null, 2));
  };

  // Fila de leitura das fichas (3 por vez), só para quem ficou sem número.
  const filaFicha = [];
  let fichasLendo = 0;
  function pedirSenhaFicha(tr) {
    const inf = infoLinha(tr);
    if (!inf?.id || tr.dataset.om30FichaPedida === inf.id) return;
    tr.dataset.om30FichaPedida = inf.id;
    filaFicha.push(tr);
    rodarFilaFicha();
  }
  function rodarFilaFicha() {
    while (fichasLendo < 3 && filaFicha.length) {
      const tr = filaFicha.shift();
      fichasLendo++;
      (async () => {
        try {
          const inf = infoLinha(tr);
          const senha = await senhaPelaFicha(inf.id, inf.tipo);
          const r = detalhes.get(inf.id);
          if (!senha) {
            tr.dataset.om30FichaFalhou = '1';
            const t = ultimoTextoFicha || '';
            tr.dataset.om30FichaMotivo = inf.tipo !== 'AtendimentoPa' ? `Ficha: tipo ${inf.tipo} sem ficha PA.`
              : t.length < 20 ? 'Ficha: não consegui ler o texto do PDF.' : 'Ficha: lida, mas não achei o código da senha.';
            if (fichaLogada < 3 && inf.tipo === 'AtendimentoPa') {
              fichaLogada++;
              const i = t.search(/SENHA/i);
              console.info('[OM30 Ausentes] ficha sem senha', inf.id, JSON.stringify(i >= 0 ? t.slice(Math.max(0, i - 150), i + 250) : t.slice(0, 600)));
            }
            const b = tr.querySelector('.om30a-senha-btn.sem-numero');
            if (b) { b.textContent = 'sem nº'; b.title = `${b.title.split(' · Ficha')[0]} · ${tr.dataset.om30FichaMotivo}`; }
          }
          if (senha && r && !r.senha && tr.isConnected) {
            r.senha = senha;
            r.senhaDaFicha = true;
            marcarLinha(tr, r);
            aplicarFiltros();
          }
        } catch (e) {
          console.warn('[OM30 Ausentes] ficha:', e);
          tr.dataset.om30FichaFalhou = '1';
          tr.dataset.om30FichaMotivo = `Ficha: não abriu (${e?.message || e}).`;
          const b = tr.querySelector('.om30a-senha-btn.sem-numero');
          if (b) { b.textContent = 'sem nº'; b.title = `${b.title.split(' · Ficha')[0]} · ${tr.dataset.om30FichaMotivo}`; }
        } finally {
          fichasLendo--;
          rodarFilaFicha();
          verificarConclusao();
        }
      })();
    }
  }

  // ---------------------------------------------------------------------------
  // Senha presa em outro profissional
  //   Ao clicar em Chamar, se o Senha Simples responder "senha já chamada / em atendimento
  //   por FULANO", solta a senha (retornar -> desvincular) e chama de novo por este guichê.
  // ---------------------------------------------------------------------------

  async function desvincularSenha(s, localPadrao) {
    const local = s.local_atendimento?.id || localPadrao;
    if (!s?.id || !s?.tipo_atendimento?.id || !local) throw new Error('senha sem id/tipo/guichê');
    return (await senhaSimplesPutFilas(`${local}/${s.tipo_atendimento.id}/${s.id}/desvincular`)).data;
  }

  async function instalarLiberacaoSenhaPresa() {
    try { await esperar(() => typeof senhaSimplesChamarSenhaAtendimento === 'function'); } catch { return; }
    const original = window.senhaSimplesChamarSenhaAtendimento;
    if (!original || original.__om30Liberacao) return;
    const tipoTela = location.pathname.startsWith('/prontuarios') ? 'atendimento' : 'acolhimento';

    const embrulho = async function (args) {
      try {
        return await original(args);
      } catch (e) {
        const dados = e?.response?.data || {};
        if (!(e?.response?.status === 422 && dados.ja_chamada)) throw e;
        try {
          const param = await lerParametrizacao(tipoTela);
          const cat = param?.senha_simples_categoria?.id;
          if (!cat) throw e;
          const { data: s } = await senhaSimplesPutFilas(`${cat}/retornar_para_atendimento`, {
            atendimento_id: args?.params?.atendimento_id,
            atendimento_type: args?.params?.atendimento_type,
            categoria_id: cat
          });
          await desvincularSenha(s, args?.localAtendimentoAtualId);
          const resultado = await original(args);
          const m = String(dados.error || '').match(/por\s+(.+?)\s+no\s+guich[eê]\s+(.+)$/i) || [];
          const de = m[1] && !/seu usu[aá]rio/i.test(m[1]) ? pessoaCurta(m[1]) : null;
          toast({
            tipo: 'sucesso',
            titulo: `Senha ${s.senha || ''} liberada e chamada`,
            texto: `Estava presa${de ? ` com ${de}` : ''}${m[2] ? ` (${guicheCurto(clean(m[2]))})` : ''}. Agora está vinculada a este guichê.`
          });
          return resultado;
        } catch (falha) {
          console.warn('[OM30] Não foi possível liberar a senha presa:', falha);
          throw e; // mostra o aviso original do sistema
        }
      }
    };
    embrulho.__om30Liberacao = true;
    window.senhaSimplesChamarSenhaAtendimento = embrulho;
  }


  instalarLiberacaoSenhaPresa();

  // ---------------------------------------------------------------------------
  // Fila médica — opção manual no menu (*) para desvincular senha presa
  // ---------------------------------------------------------------------------

  const OM30_MED_DESVINCULAR_CLASS = 'om30-med-desvincular-outro-profissional';
  let om30MedDesvincularObserver = null;

  function acharCollectionFilaMedicaManual() {
    const candidatos = [...document.querySelectorAll('#classificacao *')]
      .map(el => el.__vue__)
      .filter(Boolean);

    return candidatos.find(vm =>
      norm(vm?.$options?.name) === 'COLLECTION-WITH-SEARCH-ATENDIMENTO' &&
      Array.isArray(vm?.$data?.items)
    ) || null;
  }

  function itensFilaMedicaManual() {
    const vm = acharCollectionFilaMedicaManual();
    if (Array.isArray(vm?.$data?.items)) return vm.$data.items;
    if (Array.isArray(vm?.items)) return vm.items;
    return [];
  }

  function itemFilaMedicaDaLinhaManual(tr) {
    if (!tr) return null;
    const itens = itensFilaMedicaManual();
    if (!itens.length) return null;

    const senha = clean(tr.cells?.[6]?.innerText || tr.cells?.[6]?.textContent);
    const cns = clean(tr.cells?.[1]?.innerText || tr.cells?.[1]?.textContent);
    const nome = clean(
      tr.cells?.[2]?.querySelector('span:not(.badge)')?.innerText ||
      tr.cells?.[2]?.innerText ||
      tr.cells?.[2]?.textContent
    );

    // Senha é a chave visual mais forte.
    if (senha && senha !== '—') {
      const achou = itens.find(item => norm(item?.senha) === norm(senha));
      if (achou) return achou;
    }

    if (cns && cns !== '—') {
      const porCns = itens.filter(item => clean(item?.codigo_cns) === cns);
      if (porCns.length === 1) return porCns[0];
      if (porCns.length > 1 && nome) {
        const achou = porCns.find(item => norm(item?.nome_municipe) === norm(nome));
        if (achou) return achou;
      }
    }

    if (nome) {
      const porNome = itens.filter(item => norm(item?.nome_municipe) === norm(nome));
      if (porNome.length === 1) return porNome[0];
    }

    return null;
  }

  function atendimentoFilaMedicaManual(item) {
    if (!item || typeof item !== 'object') return null;

    let id =
      item.atendimento_id ??
      item.saude_atendimento_id ??
      item.atendimento?.id ??
      item.saude_atendimento?.id ??
      null;

    let tipo = clean(
      item.atendimento_type ??
      item.saude_atendimento_type ??
      item.atendimento?.type ??
      item.atendimento?.tipo ??
      item.saude_atendimento?.type ??
      ''
    );

    const str = clean(item.atendimento_str || item.saude_atendimento_str || '');
    const m = str.match(/^([^#]+)#(\d+)$/);
    if (m) {
      if (id == null) id = m[2];
      if (!tipo) tipo = m[1];
    }

    if (id == null || !tipo) return null;
    return { id: String(id), tipo };
  }

  function localAtualFilaMedicaManual() {
    const vm = acharCollectionFilaMedicaManual();
    let atual = vm;
    const vistos = new Set();

    for (let i = 0; atual && i < 12 && !vistos.has(atual); i++, atual = atual.$parent) {
      vistos.add(atual);

      const direto = clean(atual?.localAtendimentoId);
      if (direto) return direto;

      try {
        const tipo = clean(atual?.tipoParametrizacao || atual?.$props?.tipoParametrizacao || 'atendimento');
        const mapa = atual?.$store?.getters?.localAtendimentoAtual || {};
        const local = mapa?.[tipo] || mapa?.atendimento || null;
        if (local?.id) return clean(local.id);
      } catch {}
    }

    return '';
  }

  async function retornarEDesvincularFilaMedica(atendimento, localPadrao) {
    const param = await lerParametrizacao('atendimento');
    const cat = param?.senha_simples_categoria?.id;
    if (!cat) throw new Error('categoria da fila médica não encontrada');

    const { data: senha } = await senhaSimplesPutFilas(cat + '/retornar_para_atendimento', {
      atendimento_id: Number(atendimento.id),
      atendimento_type: atendimento.tipo,
      categoria_id: cat
    });

    if (!senha?.id) throw new Error('Senha Simples não devolveu a senha do atendimento');
    const liberada = await desvincularSenha(senha, localPadrao || null);
    return liberada || senha;
  }

  async function acaoDesvincularFilaMedica(tr) {
    if (!location.pathname.startsWith('/prontuarios')) return;

    if (!senhaSimplesPronto()) {
      toast({
        tipo: 'aviso',
        titulo: 'Aguarde o Senha Simples',
        texto: 'Ainda não foi possível consultar a senha. Tente novamente em alguns segundos.'
      });
      return;
    }

    const item = itemFilaMedicaDaLinhaManual(tr);
    const atendimento = atendimentoFilaMedicaManual(item);
    const nome = clean(item?.nome_municipe || tr?.cells?.[2]?.innerText || 'Paciente');
    const senhaVisual = clean(item?.senha || tr?.cells?.[6]?.innerText || '');

    if (!atendimento) {
      await dialogo({
        tipo: 'erro',
        titulo: 'Não consegui identificar o atendimento',
        subtitulo: nome,
        texto: ['Nada foi alterado.', 'Atualize a fila e tente novamente.'],
        botoes: [{ rotulo: 'Fechar', valor: true, primario: true }]
      });
      return;
    }

    const localAtual = localAtualFilaMedicaManual();
    if (!localAtual) {
      toast({
        tipo: 'aviso',
        titulo: 'Guichê não identificado',
        texto: 'Selecione novamente o guichê da fila médica e tente de novo.'
      });
      return;
    }

    let estado;
    try {
      estado = await consultarSenha(localAtual, atendimento.id, atendimento.tipo);
    } catch (e) {
      estado = { erro: descricaoErro(e) };
    }

    if (estado?.auth || estado?.erro) {
      await dialogo({
        tipo: 'erro',
        titulo: 'Não foi possível conferir a senha',
        subtitulo: nome,
        texto: ['Nada foi alterado.', 'Detalhe: ' + (estado?.erro || 'falha no Senha Simples')],
        botoes: [{ rotulo: 'Fechar', valor: true, primario: true }]
      });
      return;
    }

    // Só executa quando o recuperar_senha_saude_atendimento respondeu 422 ja_chamada.
    if (!estado?.chamada) {
      await dialogo({
        tipo: 'info',
        titulo: 'Senha não está presa em outro profissional',
        subtitulo: nome,
        senha: estado?.senha || senhaVisual || '',
        senhaRotulo: 'Senha',
        texto: ['Nenhuma alteração foi feita. O Senha Simples não confirmou vínculo com outro profissional/guichê.'],
        botoes: [{ rotulo: 'Fechar', valor: true, primario: true }]
      });
      return;
    }

    const profissional = estado.chamadoPor ? pessoaCurta(estado.chamadoPor) : '';
    const guiche = estado.guiche ? guicheCurto(estado.guiche) : '';
    const onde = [profissional, guiche].filter(Boolean).join(' · ');

    const ok = await dialogo({
      tipo: 'pergunta',
      titulo: 'Desvincular senha de outro profissional?',
      subtitulo: nome,
      senha: senhaVisual || '',
      senhaRotulo: 'Senha atual',
      texto: [
        onde
          ? 'A senha está vinculada a ' + onde + '.'
          : 'O Senha Simples confirmou que esta senha está vinculada a outro profissional/guichê.',
        'Ao continuar, ela será liberada desse profissional e ficará disponível para nova chamada.',
        'A mesma senha será mantida. Nenhum atendimento será iniciado automaticamente.'
      ],
      botoes: [
        { rotulo: 'Cancelar', valor: false },
        { rotulo: 'Desvincular senha', valor: true, primario: true }
      ]
    });
    if (!ok) return;

    try {
      const liberada = await retornarEDesvincularFilaMedica(atendimento, localAtual);

      await dialogo({
        tipo: 'sucesso',
        titulo: 'Senha desvinculada',
        subtitulo: nome,
        senha: liberada?.senha || senhaVisual || '',
        senhaRotulo: 'Mesma senha do munícipe',
        texto: ['A senha foi liberada do outro profissional/guichê e já pode ser chamada novamente.'],
        botoes: [{ rotulo: 'Fechar', valor: true, primario: true }]
      });

      // fetchCollection está envolvido pela fila estável; portanto atualiza por baixo,
      // sem o pisca-pisca da listagem nativa.
      try {
        const vm = acharCollectionFilaMedicaManual();
        await Promise.resolve(vm?.fetchCollection?.());
      } catch {}
    } catch (e) {
      await dialogo({
        tipo: 'erro',
        titulo: 'Não foi possível desvincular a senha',
        subtitulo: nome,
        texto: ['Nada mais será feito automaticamente.', 'Detalhe: ' + descricaoErro(e)],
        botoes: [{ rotulo: 'Fechar', valor: true, primario: true }]
      });
    }
  }

  function menuAcoesFilaMedicaManual(tr) {
    if (!tr?.cells?.length) return null;
    const ultima = tr.cells[tr.cells.length - 1];
    return ultima.querySelector('.dropdown-opcoes-atendimento .dropdown-menu, .dropdown-menu');
  }

  function instalarOpcaoDesvincularFilaMedica(tr) {
    if (!tr || !location.pathname.startsWith('/prontuarios')) return false;
    const menu = menuAcoesFilaMedicaManual(tr);
    if (!menu) return false;

    if (menu.querySelector('.' + OM30_MED_DESVINCULAR_CLASS)) return true;

    const divisor = document.createElement('div');
    divisor.className = 'dropdown-divider om30-med-desvincular-divider';

    const opcao = document.createElement('a');
    opcao.href = 'javascript:void(0)';
    opcao.className = 'dropdown-item ' + OM30_MED_DESVINCULAR_CLASS;
    opcao.setAttribute('role', 'menuitem');
    opcao.textContent = 'Desvincular senha de outro profissional';
    opcao.title = 'Libera a mesma senha se ela estiver presa em outro profissional/guichê';

    opcao.addEventListener('click', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      acaoDesvincularFilaMedica(tr).catch(e => {
        console.warn('[OM30] Desvincular senha na fila médica:', e);
      });
    });

    menu.appendChild(divisor);
    menu.appendChild(opcao);
    return true;
  }

  function instalarMenusDesvincularFilaMedica() {
    if (!location.pathname.startsWith('/prontuarios')) return;

    const aplicar = () => {
      document.querySelectorAll('#classificacao tbody tr.collection-row').forEach(instalarOpcaoDesvincularFilaMedica);
    };

    aplicar();

    if (om30MedDesvincularObserver) return;
    let timer = null;
    om30MedDesvincularObserver = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(aplicar, 80);
    });
    om30MedDesvincularObserver.observe(document.querySelector('#classificacao') || document.body, {
      childList: true,
      subtree: true
    });
  }

  instalarMenusDesvincularFilaMedica();

  // ---------------------------------------------------------------------------
  // Tabela nativa de ausentes
  // ---------------------------------------------------------------------------

  function acharTabelaAusentes(raiz = document) {
    return [...raiz.querySelectorAll('table')].find(t => {
      if (t.querySelector(SEL_REMOVER)) return true;
      const ths = [...t.querySelectorAll('th')].map(th => norm(th.textContent));
      return ths.includes('DATA DO ATENDIMENTO') && ths.includes('TELEFONE');
    });
  }

  function infoLinha(tr) {
    const a = tr.querySelector(SEL_REMOVER);
    if (!a) return null;
    const u = new URL(a.href, location.origin);
    return {
      id: u.pathname.match(/(\d+)$/)?.[1],
      tipo: u.searchParams.get('type') || 'AtendimentoPa'
    };
  }

  function linhaEhDeHoje(tr) {
    const m = (tr.cells[0]?.textContent || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (!m) return true;
    const d = new Date();
    return +m[1] === d.getDate() && +m[2] === d.getMonth() + 1 && +m[3] === d.getFullYear();
  }

  // ---------------------------------------------------------------------------
  // Lista completa (sem paginação)
  //   Lê a página 1, 2, 3... da própria lista de ausentes até não vir ninguém novo,
  //   junta tudo na tabela da tela e esconde a paginação nativa.
  // ---------------------------------------------------------------------------

  const MAX_PAGINAS = 50;
  const SEL_PAGINACAO = '.pagination, ul.pagination, nav.pagination, .pagy-nav, .pagy, [class*="paginat"]';
  let fonteLista = null;      // { url: URL, param: 'page' }
  let sincronizando = null;

  // Paginação que pertence à tabela de ausentes (sobe até a aba, sem invadir outras abas).
  function paginacaoDa(tabela) {
    let el = tabela;
    for (let i = 0; i < 10 && el?.parentElement; i++) {
      el = el.parentElement;
      const pags = [...el.querySelectorAll(SEL_PAGINACAO)]
        .filter(p => !p.contains(tabela) && !p.closest('table'))
        .filter(p => !(p.parentElement && p.parentElement.closest(SEL_PAGINACAO)));
      if (pags.length) {
        const nativa = pags.find(p => p.id === 'paginacaoAusentes');
        return nativa ? [nativa] : pags;
      }
      if (el.matches('.tab-pane, [role="tabpanel"], body')) break;
    }
    return [];
  }

  function fonteDaPaginacao(pags, base) {
    for (const p of pags) {
      for (const a of p.querySelectorAll('a[href]')) {
        const h = a.getAttribute('href') || '';
        if (!h || h.startsWith('#') || /^javascript:/i.test(h)) continue;
        let u;
        try { u = new URL(h, base); } catch { continue; }
        for (const [k, v] of u.searchParams) {
          if (/page/i.test(k) && !/per_?page/i.test(k) && /^\d+$/.test(v)) return { url: u, param: k };
        }
      }
    }
    return null;
  }

  function urlDaPagina(fonte, n) {
    const u = new URL(fonte.url.href);
    u.searchParams.set(fonte.param, String(n));
    u.hash = '';
    return u.href;
  }

  async function lerPaginaLista(url) {
    const r = await fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'text/html,application/xhtml+xml' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
    const t = acharTabelaAusentes(doc);
    return { doc, t, linhas: t ? [...(t.tBodies[0]?.rows || [])].filter(tr => infoLinha(tr)?.id) : [] };
  }

  // Candidatas a "endereço da lista", na ordem: link da paginação, a carga da aba
  // (se a aba vier por ajax) e a própria URL da tela.
  function candidatasFonte(tabela) {
    const lista = [];
    const nativa = document.getElementById('paginacaoAusentes');
    const daNativa = nativa && fonteDaPaginacao([nativa], location.href);
    if (daNativa) lista.push(daNativa);
    const daPag = fonteDaPaginacao(paginacaoDa(tabela), location.href);
    if (daPag) lista.push(daPag);
    try {
      for (const e of performance.getEntriesByType('resource')) {
        if (!/ausent/i.test(e.name) || /\/ausentes\/\d+|paciente_ausente|reverter_situacao/i.test(e.name)) continue;
        if (!['xmlhttprequest', 'fetch'].includes(e.initiatorType)) continue;
        const u = new URL(e.name);
        const k = [...u.searchParams.keys()].find(x => /page/i.test(x) && !/per_?page/i.test(x)) || 'page';
        lista.push({ url: u, param: k });
      }
    } catch {}
    lista.push({ url: new URL(location.href), param: 'page' });
    return lista;
  }

  // Maior número de página que aparece nos links da paginação.
  function ultimaPagina(raiz, param) {
    let max = 0;
    for (const a of raiz.querySelectorAll(`a[href*="${param}="]`)) {
      try {
        const v = +new URL(a.getAttribute('href'), location.origin).searchParams.get(param);
        if (v > max) max = v;
      } catch {}
    }
    return max;
  }

  function idNum(tr) { return +(infoLinha(tr)?.id || 0); }

  function esconderPaginacao(tabela) {
    document.getElementById('paginacaoAusentes')?.classList.add('om30a-pag-oculta');
    for (const p of paginacaoDa(tabela)) p.classList.add('om30a-pag-oculta');
  }

  let todasCarregadas = false;

  // Junta na tabela da tela as linhas buscadas: acrescenta quem falta e (se pedido)
  // tira quem saiu. Ordena do mais recente para o mais antigo, como a lista nativa.
  function mesclarLinhas(tabela, mapa, remover) {
    const tbody = tabela.tBodies[0];
    const atuais = new Map();
    for (const tr of [...tbody.rows]) {
      const id = infoLinha(tr)?.id;
      if (id) atuais.set(id, tr);
    }
    let novos = 0, saiu = 0;
    if (remover) {
      for (const [id, tr] of atuais) {
        if (mapa.has(id) || !remover(tr)) continue;
        tr.remove(); atuais.delete(id); detalhes.delete(id); saiu++;
      }
    }
    for (const [id, trRemota] of mapa) {
      if (!trRemota || atuais.has(id)) continue;
      const tr = document.importNode(trRemota, true);
      if (tabela.querySelector('.om30a-th')) prepararLinha(tr);
      atuais.set(id, tr);
      novos++;
    }
    if (novos || saiu) {
      const ordem = [...atuais.values()].sort((x, y) => idNum(y) - idNum(x));
      for (const tr of ordem) tbody.appendChild(tr);
    }
    for (const tr of [...tbody.rows]) {
      if (!infoLinha(tr) && tr.cells.length === 1) tr.style.display = atuais.size ? 'none' : '';
    }
    return { novos, saiu };
  }

  // Busca a lista no sistema.
  //   completa=false: só as páginas de hoje (a lista vem do mais recente para o mais antigo,
  //                   então para na primeira página que já tem gente de outro dia).
  //   completa=true : todas as páginas, 4 por vez, mostrando conforme chegam.
  //   inicial=true  : a página 1 é a própria tela, não precisa buscar de novo.
  // Leitura leve: só a página 1 (e as seguintes enquanto vierem só pessoas novas).
  // ---- Profissional de cada ausente (coluna "Profissional" da lista da fila médica) ----
  const mapaProf = new Map();   // id -> { prof, esp }
  function registrarProfissionais(t) {
    const cab = t.tHead?.rows[0] || t.rows[0];
    if (!cab) return 0;
    const ths = [...cab.cells].map(c => norm(c.textContent));
    const ip = ths.indexOf('PROFISSIONAL');
    if (ip < 0) return 0;
    const ie = ths.indexOf('ESPECIALIDADE');
    let n = 0;
    for (const tr of t.tBodies[0]?.rows || []) {
      const inf = infoLinha(tr);
      if (!inf?.id) continue;
      const prof = clean(tr.cells[ip]?.textContent).replace(/^[—–-]+$/, '');
      mapaProf.set(inf.id, { prof, esp: ie >= 0 ? clean(tr.cells[ie]?.textContent) : '' });
      n++;
    }
    return n;
  }
  const fonteProf = { url: new URL('/prontuarios', location.origin), param: 'page_ausentes' };
  function lerProfPagina(n) {
    if (TELA !== 'ACOLHIMENTO') return Promise.resolve();
    return comRetentativa(() => lerPaginaLista(urlDaPagina(fonteProf, n)), 2)
      .then(pg => { if (pg.t) registrarProfissionais(pg.t); })
      .catch(() => {});
  }

  async function buscarNovos(tabela) {
    if (sincronizando) return { novos: 0 };
    const fonte = fonteLista || candidatasFonte(tabela)[0];
    if (!fonte) return { novos: 0 };
    fonteLista = fonte;
    const conhecidos = new Set([...tabela.tBodies[0].rows].map(tr => infoLinha(tr)?.id).filter(Boolean));
    const mapa = new Map();
    const prof1 = lerProfPagina(1);
    for (let n = 1; n <= 5; n++) {
      let pg;
      try { pg = await lerPaginaLista(urlDaPagina(fonte, n)); } catch { break; }
      if (!pg.t || !pg.linhas.length) break;
      let algumConhecido = false;
      for (const tr of pg.linhas) {
        const id = infoLinha(tr).id;
        if (conhecidos.has(id)) algumConhecido = true; else mapa.set(id, tr);
      }
      if (algumConhecido) break;
    }
    await prof1;
    if (!mapa.size) return { novos: 0 };
    const r = mesclarLinhas(tabela, mapa, null);
    if (TELA === 'MEDICO') registrarProfissionais(tabela);
    if (r.novos) console.info(`[OM30 Ausentes] ${r.novos} ausente(s) novo(s).`);
    return r;
  }

  async function sincronizarLista(tabela, { completa = false, inicial = false } = {}) {
    if (sincronizando) return sincronizando;
    sincronizando = (async () => {
      esconderPaginacao(tabela);
      const fonte = fonteLista || candidatasFonte(tabela)[0];
      if (!fonte) return { ok: false };
      fonteLista = fonte;

      const mapa = new Map();
      let maxPag = Math.max(ultimaPagina(document, fonte.param), 1);
      let n = 1, fim = false, falhou = false, totalNovos = 0;
      const profs = [];
      if (inicial) profs.push(lerProfPagina(1));

      if (inicial) {
        const vivas = [...tabela.tBodies[0].rows].filter(tr => infoLinha(tr)?.id);
        vivas.forEach(tr => mapa.set(infoLinha(tr).id, null));
        n = 2;
        const ultima = vivas[vivas.length - 1];
        if (!vivas.length || (!completa && ultima && !linhaEhDeHoje(ultima))) fim = true;
      }

      const LOTE = 6;
      while (!fim && n <= Math.min(maxPag, MAX_PAGINAS)) {
        const nums = [];
        while (nums.length < LOTE && n <= Math.min(maxPag, MAX_PAGINAS)) nums.push(n++);
        nums.forEach(k => profs.push(lerProfPagina(k)));
        const pgs = await Promise.all(nums.map(k =>
          comRetentativa(() => lerPaginaLista(urlDaPagina(fonte, k)), 2).catch(() => null)));
        for (const pg of pgs) {
          if (!pg || !pg.t) { falhou = !pg; fim = true; break; }
          maxPag = Math.max(maxPag, ultimaPagina(pg.doc, fonte.param));
          let novos = 0;
          for (const tr of pg.linhas) {
            const id = infoLinha(tr).id;
            if (!mapa.has(id)) { mapa.set(id, tr); novos++; }
          }
          if (!novos) { fim = true; break; }
          const ultima = pg.linhas[pg.linhas.length - 1];
          if (!completa && ultima && !linhaEhDeHoje(ultima)) { fim = true; break; }
        }
        // mostra o que já chegou
        totalNovos += mesclarLinhas(tabela, mapa, null).novos;
        if (completa) definirStatus(`Carregando ausentes… ${Math.min(n - 1, maxPag)}/${maxPag}`);
        aplicarFiltros();
      }

      await Promise.all(profs);
      if (TELA === 'MEDICO') registrarProfissionais(tabela);

      // Tira quem não está mais na lista (ausência removida em outro computador),
      // só dentro do trecho que foi lido e só se a leitura deu certo.
      let saiu = 0;
      if (!falhou) {
        saiu = mesclarLinhas(tabela, mapa, completa ? () => true : tr => linhaEhDeHoje(tr)).saiu;
        if (completa) todasCarregadas = true;
      }
      if (totalNovos || saiu) console.info(`[OM30 Ausentes] Lista: +${totalNovos} / -${saiu} (páginas lidas até ${Math.min(n - 1, maxPag)} de ${maxPag}).`);
      return { ok: !falhou, novos: totalNovos, saiu };
    })();
    try { return await sincronizando; } finally { sincronizando = null; }
  }

  // ---------------------------------------------------------------------------
  // Estado
  // ---------------------------------------------------------------------------

  let filtroSelecionado = localStorage.getItem(STORAGE_FILTRO) || TELA;
  if (!FILTROS_VALIDOS.has(filtroSelecionado)) filtroSelecionado = TELA;
  let somenteHoje = localStorage.getItem(STORAGE_HOJE) !== '0';
  let busca = '';
  let tabelaRef = null;
  let verificando = false;
  const detalhes = new Map();

  // ---------------------------------------------------------------------------
  // Visual (mesmo padrão da Fila Médica / Controle de Salas)
  // ---------------------------------------------------------------------------

  function garantirCSS() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = `
      :root {
        --om30a-azul:#123f68; --om30a-verde:#198754; --om30a-roxo:#6f42c1; --om30a-ambar:#e0a000;
        --om30a-vermelho:#c0392b; --om30a-texto:#263942; --om30a-suave:#6b7a85; --om30a-borda:#dde3e8;
      }

      /* ---------- barra de filtros ---------- */
      #${BAR_ID} {
        display:flex;flex-wrap:wrap;gap:7px;align-items:stretch;
        margin:6px 0 8px;padding:7px 8px;border:1px solid #d9dfe4;border-radius:7px;
        background:#f8fafb;font-family:Arial,Helvetica,sans-serif;box-shadow:0 1px 3px rgba(0,0,0,.035);
      }
      #${BAR_ID} .om30a-filtro {
        --c:#6c757d;display:grid;grid-template-columns:7px 1fr auto;
        column-gap:8px;align-items:center;min-width:132px;min-height:43px;padding:5px 10px;
        border:1px solid #d6dce1;border-left:4px solid var(--c);border-radius:6px;background:#fff;
        color:#35404a;cursor:pointer;text-align:left;line-height:1.1;
      }
      #${BAR_ID} .om30a-filtro:hover { background:#f7f9fb; }
      #${BAR_ID} .om30a-filtro.ativo { box-shadow:0 0 0 2px color-mix(in srgb,var(--c) 20%,transparent);background:#f7f9fb; }
      #${BAR_ID} .om30a-dot { width:7px;height:7px;border-radius:50%;background:var(--c); }
      #${BAR_ID} .om30a-label { font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.25px;color:#68737c; }
      #${BAR_ID} .om30a-qtd { justify-self:end;font-size:18px;font-weight:800;color:#252d34; }
      #${BAR_ID} .om30a-sub { grid-column:2/4;font-size:9px;color:#7b858e;white-space:nowrap; }
      #${BAR_ID} .om30a-ferramentas {
        display:flex;align-items:center;gap:8px;padding:5px 8px;
        border:1px solid #d6dce1;border-radius:6px;background:#fff;
      }
      #${BAR_ID} .om30a-busca {
        width:230px;max-width:100%;border:1px solid #d6dce1;border-radius:999px;
        padding:6px 11px;font-size:11px;color:#35404a;outline:none;background:#f8fafb;
      }
      #${BAR_ID} .om30a-busca:focus { background:#fff;border-color:#b9c2cc;box-shadow:0 0 0 3px rgba(18,63,104,.07); }
      #${BAR_ID} .om30a-hoje { display:flex;align-items:center;gap:5px;margin:0;font-size:10px;font-weight:700;color:#68737c;cursor:pointer;white-space:nowrap; }
      #${BAR_ID} .om30a-atualizar {
        border:1px solid #b9c2cc;border-radius:5px;background:#fff;color:#24313f;
        font-size:10px;font-weight:700;padding:5px 9px;cursor:pointer;white-space:nowrap;
      }
      #${BAR_ID} .om30a-atualizar:hover { background:#eaf4f8; }
      #${BAR_ID} .om30a-atualizado {
        margin-left:auto;align-self:center;display:inline-flex;align-items:center;gap:8px;min-width:108px;
        padding:7px 12px;border:1px solid #d8dfe5;border-radius:8px;background:#fff;
        box-shadow:0 1px 2px rgba(15,23,42,.04);white-space:nowrap;
      }
      #${BAR_ID} .om30a-atualizado-label { font-size:11px;font-weight:700;color:#7a8590;letter-spacing:.3px;text-transform:uppercase; }
      #${BAR_ID} .om30a-atualizado-hora { font-size:18px;font-weight:800;color:#3f4a54;line-height:1;letter-spacing:.4px;font-variant-numeric:tabular-nums; }
      #${BAR_ID} .om30a-aviso {
        flex-basis:100%;display:flex;gap:8px;align-items:flex-start;padding:7px 10px;border-radius:6px;
        border:1px solid #f1d39a;border-left:4px solid var(--om30a-ambar);background:#fffaf0;
        font-size:11px;color:#6b4e00;line-height:1.35;
      }
      #${BAR_ID} .om30a-aviso:empty { display:none; }
      #${BAR_ID} .om30a-vazio {
        flex-basis:100%;padding:10px;text-align:center;font-size:11px;color:#7b858e;
        border:1px dashed #d6dce1;border-radius:6px;background:#fff;
      }
      #${BAR_ID} .om30a-vazio[hidden] { display:none; }

      /* ---------- colunas Senha e Ausente em ---------- */
      th.om30a-th { white-space:nowrap; }
      .om30a-pag-oculta { display:none !important; }
      #${BAR_ID} .om30a-tempo { font:600 11px Arial,Helvetica,sans-serif;color:#4a5560;white-space:nowrap;
        border:1px solid #d6dde3;background:#fff;border-radius:6px;padding:5px 8px;cursor:pointer; }
      #${BAR_ID} .om30a-tempo:empty { display:none; }
      ${MODO_NUMERO === 'AMBOS' ? `#${BAR_ID} .om30a-tempo { display:none !important; }` : ''}
      #${BAR_ID} .om30a-tempo:hover { background:#f2f5f7; }
      td.om30a-td-senha { white-space:nowrap;vertical-align:middle !important; }
      td.om30a-td-origem { vertical-align:middle !important;min-width:170px; }
      .om30a-senha-btn.da-ficha { border-style:dashed !important; }
      .om30a-tag-ficha { margin-left:6px;padding:1px 5px;border-radius:4px;background:#eef1f3;color:#6b7680;
        font:700 9px Arial,Helvetica,sans-serif;letter-spacing:.3px;text-transform:uppercase;vertical-align:middle; }
      .om30a-senha-btn {
        display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:6px;
        border:1px solid #c9d1d8;background:#fff;cursor:pointer;
        font:800 12px Consolas,'Courier New',monospace;letter-spacing:.6px;color:#1f2d37;
      }
      .om30a-senha-btn:hover { border-color:var(--om30a-azul);background:#f2f7fb; }
      .om30a-senha-btn .om30a-lupa { font:700 10px Arial,sans-serif;color:#8a98a3; }
      .om30a-senha-btn.sem-numero { font:700 10px Arial,Helvetica,sans-serif;letter-spacing:0;color:#8a96a0;border-style:dashed; }
      .om30a-senha-btn.carregando { color:#a0aab2;border-style:dashed;cursor:default; }
      .om30a-origem {
        display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;
        font:700 10.5px Arial,Helvetica,sans-serif;white-space:nowrap;background:#eef1f3;color:#5c6770;
      }
      .om30a-origem::before { content:'';width:7px;height:7px;border-radius:50%;background:currentColor;opacity:.85; }
      .om30a-origem[data-o="ACOLHIMENTO"] { background:#e8f5ee;color:#1d6b40; }
      .om30a-origem[data-o="MEDICO"] { background:#f0e9fb;color:#5a3399; }
      .om30a-origem[data-o="EMERGENCIA"] { background:#fde8ea;color:#b02a37; }
      .om30a-origem[data-o="OUTROS"], .om30a-origem[data-o="SEM_SENHA"] { background:#fff3d6;color:#8a5a00; }
      .om30a-origem[data-o="ERRO"], .om30a-origem[data-o="INDEFINIDO"] { background:#fde8e6;color:#a8332a; }
      .om30a-origem[data-o="PENDENTE"] { background:#f1f3f5;color:#9aa4ac; }
      .om30a-origem-hora { font-weight:600;opacity:.75; }
      .om30a-quem { margin-top:4px;font:11px Arial,Helvetica,sans-serif;color:#7b858e;line-height:1.3; }
      .om30a-quem b { color:#4a5560;font-weight:700; }
      a.om30a-bloqueado { opacity:.28 !important;filter:grayscale(1) !important;cursor:not-allowed !important; }
      tr.om30a-linha > td:first-child { position:relative !important;padding-left:14px !important; }
      tr.om30a-linha > td:first-child::before {
        content:'';position:absolute;left:2px;top:4px;bottom:4px;width:4px;border-radius:4px;background:transparent;
      }
      tr.om30a-linha[data-om30-origem="ACOLHIMENTO"] > td:first-child::before { background:var(--om30a-verde); }
      tr.om30a-linha[data-om30-origem="MEDICO"] > td:first-child::before { background:var(--om30a-roxo); }
      tr.om30a-linha[data-om30-origem="EMERGENCIA"] > td:first-child::before { background:#dc3545; }
      tr.om30a-linha[data-om30-origem="OUTROS"] > td:first-child::before { background:var(--om30a-ambar); }

      /* ---------- janelas ---------- */
      #${MODAL_ID} {
        position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;
        background:rgba(15,23,42,.42);font-family:Arial,Helvetica,sans-serif;animation:om30aFade .12s ease-out;
      }
      #${MODAL_ID} .om30a-caixa {
        --c:var(--om30a-azul);position:relative;width:min(440px,calc(100vw - 32px));max-height:calc(100vh - 40px);overflow:auto;
        background:#fff;border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.28);border-top:5px solid var(--c);
        padding:22px 24px 18px;color:var(--om30a-texto);animation:om30aSobe .14s ease-out;
      }
      #${MODAL_ID} .om30a-caixa.largo { width:min(760px,calc(100vw - 32px)); }
      #${MODAL_ID} .om30a-caixa[data-tipo="sucesso"] { --c:var(--om30a-verde); }
      #${MODAL_ID} .om30a-caixa[data-tipo="erro"] { --c:var(--om30a-vermelho); }
      #${MODAL_ID} .om30a-caixa[data-tipo="aviso"] { --c:var(--om30a-ambar); }
      #${MODAL_ID} .om30a-topo { display:flex;align-items:center;gap:12px;margin-bottom:10px; }
      #${MODAL_ID} .om30a-icone {
        flex:none;width:38px;height:38px;border-radius:50%;display:grid;place-items:center;
        background:color-mix(in srgb,var(--c) 14%,#fff);color:var(--c);font-size:19px;font-weight:900;
      }
      #${MODAL_ID} .om30a-titulo { font-size:15px;font-weight:800;line-height:1.25; }
      #${MODAL_ID} .om30a-subtitulo { font-size:11px;color:var(--om30a-suave);margin-top:2px; }
      #${MODAL_ID} .om30a-senha-box {
        margin:12px 0;padding:12px;border-radius:10px;text-align:center;
        background:color-mix(in srgb,var(--c) 7%,#fff);border:1px solid color-mix(in srgb,var(--c) 30%,#fff);
      }
      #${MODAL_ID} .om30a-senha-rot { font-size:10px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:var(--om30a-suave); }
      #${MODAL_ID} .om30a-senha-num {
        margin-top:2px;font:900 40px Consolas,'Courier New',monospace;letter-spacing:3px;color:var(--c);
      }
      #${MODAL_ID} .om30a-senha-num.pequena { font:800 16px Arial,Helvetica,sans-serif;letter-spacing:0; }
      #${MODAL_ID} .om30a-texto { font-size:12.5px;line-height:1.5;color:#4b5963; }
      #${MODAL_ID} .om30a-texto p { margin:0 0 6px; }
      #${MODAL_ID} .om30a-acoes { display:flex;justify-content:flex-end;gap:8px;margin-top:16px; }
      #${MODAL_ID} .om30a-btn {
        border:1px solid #c5ced5;border-radius:7px;background:#fff;color:#2b3a44;
        font:700 12px Arial,Helvetica,sans-serif;padding:9px 16px;cursor:pointer;
      }
      #${MODAL_ID} .om30a-btn:hover { background:#f3f6f8; }
      #${MODAL_ID} .om30a-btn.primario { border-color:var(--c);background:var(--c);color:#fff; }
      #${MODAL_ID} .om30a-btn.primario:hover { filter:brightness(.94); }
      #${MODAL_ID} .om30a-resumo { display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 10px; }
      #${MODAL_ID} .om30a-hist { width:100%;border-collapse:separate;border-spacing:0;font-size:11.5px;text-align:left;border:1px solid var(--om30a-borda);border-radius:8px;overflow:hidden; }
      #${MODAL_ID} .om30a-hist th { background:#f5f7f9;color:#6b7680;font-size:10px;text-transform:uppercase;letter-spacing:.3px;padding:7px 8px;border-bottom:1px solid var(--om30a-borda); }
      #${MODAL_ID} .om30a-hist td { padding:7px 8px;border-bottom:1px solid #eef1f3;color:#35404a; }
      #${MODAL_ID} .om30a-hist tr:last-child td { border-bottom:0; }
      #${MODAL_ID} .om30a-hist tr.aqui td { background:#fff8e6; }
      #${MODAL_ID} .om30a-hist .marca { display:inline-block;margin-left:6px;padding:1px 6px;border-radius:999px;background:#ffe4a3;color:#7a5200;font-size:9.5px;font-weight:800; }
      #${MODAL_ID} .om30a-hist .mono { font-family:Consolas,'Courier New',monospace;font-weight:800; }
      #${MODAL_ID} .om30a-hist .vazio { color:#b0b8bf; }
      #${MODAL_ID} .om30a-nota { margin-top:8px;font-size:10.5px;color:#8a949c;line-height:1.4; }

      /* ---------- avisos rápidos ---------- */
      #om30a-toasts { position:fixed;top:16px;right:16px;z-index:2147483001;display:flex;flex-direction:column;gap:8px;font-family:Arial,Helvetica,sans-serif; }
      .om30a-toast {
        --c:var(--om30a-azul);display:flex;gap:10px;align-items:flex-start;width:min(360px,calc(100vw - 32px));
        padding:11px 12px;border-radius:10px;background:#fff;border:1px solid var(--om30a-borda);border-left:5px solid var(--c);
        box-shadow:0 10px 28px rgba(15,23,42,.18);animation:om30aEntra .16s ease-out;
      }
      .om30a-toast[data-tipo="sucesso"] { --c:var(--om30a-verde); }
      .om30a-toast[data-tipo="erro"] { --c:var(--om30a-vermelho); }
      .om30a-toast[data-tipo="aviso"] { --c:var(--om30a-ambar); }
      .om30a-toast .ico { flex:none;width:24px;height:24px;border-radius:50%;display:grid;place-items:center;background:color-mix(in srgb,var(--c) 14%,#fff);color:var(--c);font-weight:900;font-size:13px; }
      .om30a-toast .tt { font-size:12.5px;font-weight:800;color:var(--om30a-texto); }
      .om30a-toast .tx { margin-top:2px;font-size:11.5px;color:#5b6670;line-height:1.4; }
      .om30a-toast .x { margin-left:auto;border:0;background:transparent;color:#9aa4ac;font-size:16px;line-height:1;cursor:pointer;padding:0 2px; }

      @keyframes om30aFade { from { opacity:0 } to { opacity:1 } }
      @keyframes om30aSobe { from { transform:translateY(8px);opacity:.6 } to { transform:none;opacity:1 } }
      @keyframes om30aEntra { from { transform:translateX(12px);opacity:0 } to { transform:none;opacity:1 } }

      @media (max-width:1100px) {
        #${BAR_ID} .om30a-filtro { min-width:112px; }
        #${BAR_ID} .om30a-busca { width:180px; }
      }
    `;
    document.head.appendChild(st);
  }

  const ICONES = { sucesso: '✓', erro: '✕', aviso: '!', info: 'i', pergunta: '?' };

  // Janela padrão OM30. botoes: [{ rotulo, valor, primario }]. Resolve com o valor do botão.
  function dialogo({ tipo = 'info', titulo, subtitulo, senha, senhaRotulo = 'Senha', senhaPequena = false,
                     texto, html, botoes = [{ rotulo: 'OK', valor: true, primario: true }], largo = false }) {
    garantirCSS();
    return new Promise(resolve => {
      document.getElementById(MODAL_ID)?.remove();
      const m = document.createElement('div');
      m.id = MODAL_ID;
      const caixa = document.createElement('div');
      caixa.className = 'om30a-caixa' + (largo ? ' largo' : '');
      caixa.dataset.tipo = tipo;
      caixa.innerHTML = `
        <div class="om30a-topo">
          <div class="om30a-icone">${ICONES[tipo] || 'i'}</div>
          <div><div class="om30a-titulo"></div>${subtitulo ? '<div class="om30a-subtitulo"></div>' : ''}</div>
        </div>
        ${senha ? `<div class="om30a-senha-box"><div class="om30a-senha-rot"></div><div class="om30a-senha-num${senhaPequena ? ' pequena' : ''}"></div></div>` : ''}
        ${texto ? '<div class="om30a-texto"></div>' : ''}
        ${html ? `<div class="om30a-html">${html}</div>` : ''}
        <div class="om30a-acoes"></div>`;
      caixa.querySelector('.om30a-titulo').textContent = titulo || '';
      if (subtitulo) caixa.querySelector('.om30a-subtitulo').textContent = subtitulo;
      if (senha) {
        caixa.querySelector('.om30a-senha-rot').textContent = senhaRotulo;
        caixa.querySelector('.om30a-senha-num').textContent = senha;
      }
      if (texto) {
        const alvo = caixa.querySelector('.om30a-texto');
        for (const par of [].concat(texto)) { const p = document.createElement('p'); p.textContent = par; alvo.appendChild(p); }
      }

      const fechar = valor => { document.removeEventListener('keydown', teclas, true); m.remove(); resolve(valor); };
      const temCancelar = botoes.some(b => b.valor === false || b.valor === null);
      const teclas = ev => {
        if (ev.key === 'Escape') { ev.preventDefault(); fechar(temCancelar ? false : (botoes[0]?.valor ?? true)); }
      };
      const acoes = caixa.querySelector('.om30a-acoes');
      let principal = null;
      for (const b of botoes) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'om30a-btn' + (b.primario ? ' primario' : '');
        el.textContent = b.rotulo;
        el.addEventListener('click', () => fechar(b.valor));
        acoes.appendChild(el);
        if (b.primario) principal = el;
      }
      m.addEventListener('click', ev => { if (ev.target === m && temCancelar) fechar(false); });
      document.addEventListener('keydown', teclas, true);
      m.appendChild(caixa);
      document.body.appendChild(m);
      (principal || acoes.lastChild)?.focus();
    });
  }

  function toast({ tipo = 'info', titulo, texto, ms = 7000 }) {
    garantirCSS();
    let pilha = document.getElementById('om30a-toasts');
    if (!pilha) { pilha = document.createElement('div'); pilha.id = 'om30a-toasts'; document.body.appendChild(pilha); }
    const t = document.createElement('div');
    t.className = 'om30a-toast';
    t.dataset.tipo = tipo;
    t.innerHTML = `<div class="ico">${ICONES[tipo] || 'i'}</div><div><div class="tt"></div><div class="tx"></div></div><button type="button" class="x" title="Fechar">×</button>`;
    t.querySelector('.tt').textContent = titulo || '';
    t.querySelector('.tx').textContent = texto || '';
    if (!texto) t.querySelector('.tx').remove();
    t.querySelector('.x').addEventListener('click', () => t.remove());
    pilha.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  // ---------------------------------------------------------------------------
  // Barra de filtros
  // ---------------------------------------------------------------------------

  function montarBarra(tabela) {
    garantirCSS();
    let bar = document.getElementById(BAR_ID);
    if (bar) return bar;

    bar = document.createElement('div');
    bar.id = BAR_ID;

    for (const filtro of FILTROS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'om30a-filtro';
      b.dataset.filtro = filtro.key;
      b.style.setProperty('--c', filtro.cor);
      b.innerHTML = `<span class="om30a-dot"></span><span class="om30a-label">${filtro.label}</span><span class="om30a-qtd">0</span>`;
      b.addEventListener('click', ev => {
        ev.preventDefault(); ev.stopPropagation();
        filtroSelecionado = filtro.key;
        gravar(STORAGE_FILTRO, filtroSelecionado);
        aplicarFiltros();
      });
      bar.appendChild(b);
    }

    const ferramentas = document.createElement('div');
    ferramentas.className = 'om30a-ferramentas';
    ferramentas.innerHTML = `
      <input type="search" class="om30a-busca" placeholder="Buscar nome ou senha (ex: CN0003)">
      <label class="om30a-hoje"><input type="checkbox"${somenteHoje ? ' checked' : ''}> Somente hoje</label>
      <button type="button" class="om30a-atualizar" title="Consulta de novo o Senha Simples">↻ Atualizar</button>
      <button type="button" class="om30a-tempo" title="Tempo de carga (clique para copiar)"></button>
    `;
    bar.appendChild(ferramentas);
    ferramentas.querySelector('.om30a-tempo').addEventListener('click', async ev => {
      const t = ev.currentTarget.dataset.copiar;
      if (!t) return;
      try { await navigator.clipboard.writeText(t); }
      catch {
        const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta);
        ta.select(); try { document.execCommand('copy'); } catch {} ta.remove();
      }
      toast({ tipo: 'sucesso', titulo: 'Tempo copiado', texto: 'Cole aqui no chat para comparar.' });
    });

    const at = document.createElement('span');
    at.className = 'om30a-atualizado';
    bar.appendChild(at);

    const aviso = document.createElement('div');
    aviso.className = 'om30a-aviso';
    bar.appendChild(aviso);

    const vazio = document.createElement('div');
    vazio.className = 'om30a-vazio';
    vazio.hidden = true;
    vazio.textContent = 'Nenhum ausente neste grupo com os filtros atuais.';
    bar.appendChild(vazio);

    const inputBusca = ferramentas.querySelector('.om30a-busca');
    inputBusca.addEventListener('input', () => { busca = inputBusca.value; aplicarFiltros(); });
    inputBusca.addEventListener('keydown', ev => { if (ev.key === 'Enter') ev.preventDefault(); });

    ferramentas.querySelector('input[type=checkbox]').addEventListener('change', ev => {
      somenteHoje = ev.target.checked;
      gravar(STORAGE_HOJE, somenteHoje ? '1' : '0');
      aplicarFiltros();
      if (!somenteHoje && tabelaRef) {
        (async () => {
          if (!todasCarregadas) {
            definirStatus('Carregando ausentes antigos…');
            try { await sincronizarLista(tabelaRef, { completa: true }); } catch {}
            aplicarFiltros();
          }
          classificarTodos(false);
        })();
      }
    });

    ferramentas.querySelector('.om30a-atualizar').addEventListener('click', async () => {
      if (verificando || !tabelaRef) return;
      definirStatus('Carregando ausentes…');
      T0 = performance.now(); tLista = 0; tFim = 0; classificou = false;
      const el = document.querySelector(`#${BAR_ID} .om30a-tempo`); if (el) el.textContent = '';
      try { await sincronizarLista(tabelaRef, { completa: !somenteHoje }); } catch {}
      marcarTempoLista();
      aplicarFiltros();
      classificarTodos(true);
    });

    tabela.parentElement.insertBefore(bar, tabela);
    definirStatus('');
    return bar;
  }

  function definirStatus(texto) {
    const el = document.querySelector(`#${BAR_ID} .om30a-atualizado`);
    if (!el) return;
    el.innerHTML = texto
      ? `<span class="om30a-atualizado-label">${esc(texto)}</span>`
      : `<span class="om30a-atualizado-label">Horário</span><span class="om30a-atualizado-hora">${horarioCurtoAgora()}</span>`;
  }

  function definirAviso(texto) {
    const el = document.querySelector(`#${BAR_ID} .om30a-aviso`);
    if (el) el.innerHTML = texto ? `<b>⚠</b><span>${esc(texto)}</span>` : '';
  }

  // ---------------------------------------------------------------------------
  // Colunas "Senha" e "Ausente em" na tabela nativa
  // ---------------------------------------------------------------------------

  const COL_SENHA = 2;   // logo depois de "Nome"
  const COL_ORIGEM = 3;

  function prepararColunas(tabela) {
    const cab = tabela.tHead?.rows[0] || tabela.rows[0];
    if (cab && !cab.querySelector('.om30a-th')) {
      const ref = cab.cells[COL_SENHA] || null;
      for (const nome of ['Senha', 'Ausente em']) {
        const th = document.createElement('th');
        th.className = 'om30a-th';
        th.textContent = nome;
        cab.insertBefore(th, ref);
      }
    }
    for (const tr of tabela.tBodies[0]?.rows || []) prepararLinha(tr);
  }

  function prepararLinha(tr) {
    if (tr.querySelector('.om30a-td-senha')) return;
    if (!tr.querySelector(SEL_REMOVER)) {
      // linha "nenhum registro": só alarga o colspan
      const td = tr.cells[0];
      if (td?.colSpan > 1) td.colSpan += 2;
      return;
    }
    const ref = tr.cells[COL_SENHA] || null;
    const tdSenha = document.createElement('td');
    tdSenha.className = 'om30a-td-senha';
    tdSenha.innerHTML = '<span class="om30a-senha-btn carregando">…</span>';
    const tdOrigem = document.createElement('td');
    tdOrigem.className = 'om30a-td-origem';
    tdOrigem.innerHTML = '<span class="om30a-origem" data-o="PENDENTE">Verificando…</span>';
    tr.insertBefore(tdSenha, ref);
    tr.insertBefore(tdOrigem, ref);
  }

  // ---------------------------------------------------------------------------
  // Filtros
  // ---------------------------------------------------------------------------

  function grupoDaLinha(tr) {
    const o = tr.dataset.om30Origem;
    if (o === 'ACOLHIMENTO' || o === 'MEDICO' || o === 'EMERGENCIA') return o;
    return o ? 'OUTROS' : 'PENDENTE';
  }

  function passaFiltros(tr) {
    if (somenteHoje && !linhaEhDeHoje(tr)) return false;
    const q = semEspaco(busca);
    if (!q) return true;
    const nome = tr.dataset.om30Nome || '';
    const senha = semEspaco(tr.dataset.om30Senha);
    return nome.includes(q) || (!!senha && senha.includes(q));
  }

  function aplicarFiltros() {
    if (!tabelaRef) return;
    const contagem = { TODOS: 0, ACOLHIMENTO: 0, MEDICO: 0, EMERGENCIA: 0, OUTROS: 0 };
    let visiveis = 0;

    for (const tr of tabelaRef.tBodies[0].rows) {
      if (!tr.querySelector(SEL_REMOVER)) continue;
      if (!tr.dataset.om30Nome) tr.dataset.om30Nome = semEspaco(tr.cells[1]?.textContent);
      tr.classList.add('om30a-linha');

      const ok = passaFiltros(tr);
      const grupo = grupoDaLinha(tr);
      if (ok) {
        contagem.TODOS++;
        if (contagem[grupo] !== undefined) contagem[grupo]++;
      }
      const mostrar = ok && (filtroSelecionado === 'TODOS' || grupo === filtroSelecionado);
      tr.style.display = mostrar ? '' : 'none';
      if (mostrar) visiveis++;
    }

    const bar = document.getElementById(BAR_ID);
    if (!bar) return;
    for (const f of FILTROS) {
      const b = bar.querySelector(`[data-filtro="${f.key}"]`);
      if (!b) continue;
      b.classList.toggle('ativo', f.key === filtroSelecionado);
      b.querySelector('.om30a-qtd').textContent = String(contagem[f.key] || 0);
    }
    const vazio = bar.querySelector('.om30a-vazio');
    if (vazio) vazio.hidden = visiveis > 0;
  }

  // ---------------------------------------------------------------------------
  // Linha: senha, origem, quem chamou, bloqueio
  // ---------------------------------------------------------------------------

  const nomeDaLinha = tr => clean(String(tr.cells[1]?.innerText || '').split('\n').map(clean).find(Boolean)) || 'o paciente';
  const rotuloOrigem = r => r.origem === 'OUTROS' && r.setor ? r.setor : (ROTULO_ORIGEM[r.origem] || r.origem);

  function historicoDaOrigem(r) {
    return (r.historico || []).find(h =>
      r.origem === 'MEDICO' ? h.grupo === 'MEDICO'
        : r.origem === 'EMERGENCIA' ? (h.grupo === 'EMERGENCIA' || h.grupo === 'MEDICO')
        : r.origem === 'ACOLHIMENTO' ? h.grupo === 'ACOLHIMENTO'
          : h.fila === r.setor);
  }

  // Na tela do acolhimento só remove ausente do acolhimento; na fila médica, ausente da
  // fila médica (ou de outra fila de atendimento, ex.: emergência). Recepção/acolhimento não.
  function podeRemoverAqui(origem, setor) {
    if (TELA === 'ACOLHIMENTO') return origem === 'ACOLHIMENTO';
    return origem === 'MEDICO' || origem === 'EMERGENCIA' || (origem === 'OUTROS' && setor !== 'Recepção');
  }
  const nomeTela = () => TELA === 'MEDICO' ? 'fila médica' : 'acolhimento';
  const nomeFilaDestino = (origem, setor) =>
    TELA === 'ACOLHIMENTO' ? 'acolhimento'
      : origem === 'EMERGENCIA' ? 'emergência'
        : (origem === 'OUTROS' && setor ? setor : 'fila médica');

  function textoBloqueio(origem, setor) {
    if (origem === 'ACOLHIMENTO' || (TELA === 'MEDICO' && setor === 'Recepção')) {
      const onde = origem === 'ACOLHIMENTO' ? 'acolhimento' : 'recepção';
      return {
        titulo: `Ausente no ${onde}`.replace('no recepção', 'na recepção'),
        paragrafos: [
          `Este paciente foi ausentado ${origem === 'ACOLHIMENTO' ? 'no acolhimento' : 'na recepção'}, não na fila médica.`,
          origem === 'ACOLHIMENTO' ? 'Para tirar da ausência, use a aba AUSENTES da tela do acolhimento.' : 'Para tirar da ausência, use a tela da recepção.',
          'Removendo por aqui, ele sai da lista mas não volta para nenhuma fila.'
        ]
      };
    }
    const onde = origem === 'MEDICO' ? 'fila médica' : origem === 'EMERGENCIA' ? 'emergência' : (setor || 'outra fila');
    const comoRemover = origem === 'MEDICO' || origem === 'EMERGENCIA'
      ? 'Para tirar da ausência, use a aba AUSENTES da tela do médico (Prontuários).'
      : `Para tirar da ausência, use a tela da fila ${onde}.`;
    return {
      titulo: `Ausente na ${onde}`,
      paragrafos: [
        `Este paciente foi ausentado na ${onde}, não no acolhimento.`,
        comoRemover,
        'Removendo por aqui, ele sai da lista mas não volta para nenhuma fila.'
      ]
    };
  }

  function marcarLinha(tr, r) {
    prepararLinha(tr);
    const inf = infoLinha(tr);
    if (inf?.id) { tr.dataset.om30Id = inf.id; detalhes.set(inf.id, r); }
    if (!tr.dataset.om30Nome) tr.dataset.om30Nome = semEspaco(tr.cells[1]?.textContent);
    if (!r.senha && inf?.id) {
      const f = lerJSON(CHAVE_FICHA + inf.id);
      if (MODO_NUMERO !== 'SENHA' && f.senha && Date.now() - f.t < FICHA_MS) { r.senha = f.senha; r.senhaDaFicha = true; }
      else if (MODO_NUMERO !== 'SENHA' && !['ERRO', 'INDEFINIDO', 'PENDENTE'].includes(r.origem)) pedirSenhaFicha(tr);
    }
    // Senha EM é da emergência, sempre.
    if (/^EM/i.test(r.senha || '') && ['MEDICO', 'ACOLHIMENTO', 'OUTROS'].includes(r.origem)) {
      r.origem = 'EMERGENCIA';
      r.setor = 'Emergência';
      const em = (unidadeAtual?.filas || []).find(f => f.grupo === 'EMERGENCIA');
      if (em) r.cat = em.cat;
    }
    tr.dataset.om30Origem = r.origem;
    tr.dataset.om30Erro = r.erroHttp || '';
    if (r.senha) tr.dataset.om30Senha = r.senha; else delete tr.dataset.om30Senha;
    if (r.setor) tr.dataset.om30Setor = r.setor;
    if (r.cat) tr.dataset.om30Cat = r.cat;

    // Coluna Senha
    const tdSenha = tr.querySelector('.om30a-td-senha');
    const bSenha = document.createElement('button');
    bSenha.type = 'button';
    if (r.senha) {
      bSenha.className = 'om30a-senha-btn';
      bSenha.innerHTML = `${esc(r.senha)}<span class="om30a-lupa">▸</span>`;
      bSenha.title = 'Ver detalhes da senha';
    } else {
      bSenha.className = 'om30a-senha-btn sem-numero';
      bSenha.textContent = tr.dataset.om30FichaPedida && !tr.dataset.om30FichaFalhou ? 'lendo ficha…' : 'sem nº';
      bSenha.title = `${r.motivoSemNumero || 'O Senha Simples não mostra o número enquanto a senha está com outro profissional.'}` +
                     `${tr.dataset.om30FichaFalhou ? ` · ${tr.dataset.om30FichaMotivo || 'Ficha: não achei a senha.'}` : ''} O número aparece ao devolver o paciente.`;
    }
    bSenha.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); abrirDetalheSenha(tr); });
    tdSenha.replaceChildren(bSenha);

    // Coluna Ausente em
    const tdOrigem = tr.querySelector('.om30a-td-origem');
    const aqui = historicoDaOrigem(r);
    let rotulo = rotuloOrigem(r);
    if (r.origem === 'ERRO' && r.erroHttp) rotulo += ` (${r.erroHttp})`;
    if (r.origem === 'SEM_SENHA') rotulo = 'Senha não encontrada';
    const horaAusencia = hora(aqui?.concluida);
    let quemHtml = '';
    if (r.chamadoPor || r.guiche) {
      const verbo = r.acao === 'Concluída' ? 'Concluída por' : r.acao === 'Profissional' ? 'Profissional' : 'Chamado por';
      const g = guicheCurto(r.guiche);
      quemHtml = `<div class="om30a-quem" title="${esc(`${r.chamadoPor || ''}${r.guiche ? ` · ${r.guiche}` : ''}`)}">` +
        (r.chamadoPor ? `${verbo} <b>${esc(pessoaCurta(r.chamadoPor))}</b>${g ? ` · ${esc(g)}` : ''}` : `Guichê ${esc(g)}`) +
        '</div>';
    }
    tdOrigem.innerHTML =
      `<span class="om30a-origem" data-o="${esc(r.origem)}">${esc(rotulo)}` +
      `${horaAusencia ? ` <span class="om30a-origem-hora">· ${esc(horaAusencia)}</span>` : ''}</span>${quemHtml}`;

    // Botão remover: bloqueado se a ausência é de outra fila
    const btn = tr.querySelector(SEL_REMOVER);
    if (btn) {
      const bloquear = !podeRemoverAqui(r.origem, r.setor);
      btn.classList.toggle('om30a-bloqueado', bloquear);
      if (bloquear) {
        if (btn.dataset.om30TituloOriginal === undefined) btn.dataset.om30TituloOriginal = btn.getAttribute('title') || '';
        btn.setAttribute('title', ['ACOLHIMENTO', 'MEDICO', 'EMERGENCIA', 'OUTROS'].includes(r.origem)
          ? `Bloqueado: ${textoBloqueio(r.origem, r.setor).paragrafos.slice(0, 2).join(' ')}`
          : 'Bloqueado: origem da ausência não confirmada. Clique em Atualizar.');
      } else if (btn.dataset.om30TituloOriginal !== undefined) {
        btn.setAttribute('title', 'Remover ausência e devolver a senha');
      }
    }
  }

  async function abrirDetalheSenha(tr) {
    let r = detalhes.get(tr.dataset.om30Id);
    if (!r) return;
    // A classificação para cedo; o histórico de todas as filas só é buscado aqui.
    if (r.parcial && unidadeAtual) {
      const inf = infoLinha(tr);
      const bt = tr.querySelector('.om30a-senha-btn');
      bt?.classList.add('carregando');
      try {
        const completo = await origemDoAusente(inf.id, inf.tipo, unidadeAtual, { completo: true });
        if (completo.origem === r.origem) { r = { ...r, historico: completo.historico, senha: r.senha || completo.senha, parcial: false }; detalhes.set(inf.id, r); }
      } catch {}
      bt?.classList.remove('carregando');
    }
    const aqui = historicoDaOrigem(r);
    const linhas = (r.historico || []).map(h => {
      const chamada = hora(h.chamada) || (h.jaChamada ? 'chamada' : '');
      const quem = [pessoaCurta(h.por), guicheCurto(h.guiche)].filter(Boolean).join(' · ');
      const cel = v => v ? esc(v) : '<span class="vazio">—</span>';
      return `<tr${h === aqui ? ' class="aqui"' : ''}>
        <td>${esc(h.fila)}${h === aqui ? '<span class="marca">ausente aqui</span>' : ''}</td>
        <td class="mono">${cel(h.senha)}</td>
        <td>${cel(hora(h.gerada))}</td>
        <td>${cel(chamada)}</td>
        <td>${cel(hora(h.concluida))}</td>
        <td>${cel(quem)}</td>
      </tr>`;
    }).join('');

    const temSemNumero = (r.historico || []).some(h => h.jaChamada && !h.senha);
    const html = `
      <div class="om30a-resumo">
        <span class="om30a-origem" data-o="${esc(r.origem)}">Ausente em: ${esc(rotuloOrigem(r))}</span>
        ${aqui?.concluida ? `<span class="om30a-origem" data-o="PENDENTE">Ausência às ${esc(hora(aqui.concluida))}</span>` : ''}
      </div>
      ${linhas ? `<table class="om30a-hist">
        <thead><tr><th>Fila</th><th>Senha</th><th>Gerada</th><th>Chamada</th><th>Concluída</th><th>Quem</th></tr></thead>
        <tbody>${linhas}</tbody></table>` : ''}
      ${temSemNumero ? '<div class="om30a-nota">"chamada" sem horário: a senha está com outro profissional, e o Senha Simples não informa os detalhes. O número aparece ao devolver o paciente.</div>' : ''}
      ${!linhas ? '<div class="om30a-nota">Nenhuma senha deste atendimento foi encontrada no Senha Simples.</div>' : ''}`;

    dialogo({
      tipo: 'info',
      titulo: nomeDaLinha(tr),
      subtitulo: 'Senha e caminho pelas filas',
      senha: r.senha || 'Número não informado',
      senhaPequena: !r.senha,
      html,
      largo: true,
      botoes: [{ rotulo: 'Fechar', valor: true, primario: true }]
    });
  }

  // ---------------------------------------------------------------------------
  // Classificação de todos os ausentes
  // ---------------------------------------------------------------------------

  let unidadeLite = null;
  async function unidadeSoParametrizacao() {
    if (unidadeLite) return unidadeLite;
    const acolhCat = await comRetentativa(() => lerParametrizacao('acolhimento')).then(p => p?.senha_simples_categoria?.id || null).catch(() => null);
    const medCat = await comRetentativa(() => lerParametrizacao('atendimento')).then(p => p?.senha_simples_categoria?.id || null).catch(() => null);
    unidadeLite = { acolhCat, medCat, filas: [], erros: {} };
    return unidadeLite;
  }

  // ---- Medição de tempo (para comparar os modos) ----
  let tLista = 0, tFim = 0, classificou = false;
  function marcarTempoLista() { if (!tLista) tLista = performance.now() - T0; }
  function verificarConclusao() {
    if (tFim || !classificou || fichasLendo || filaFicha.length) return;
    tFim = performance.now() - T0;
    const linhas = [...(tabelaRef?.tBodies[0]?.rows || [])].filter(tr => infoLinha(tr) && (!somenteHoje || linhaEhDeHoje(tr)));
    const comNumero = linhas.filter(tr => tr.dataset.om30Senha).length;
    const s = v => (v / 1000).toFixed(1).replace('.', ',') + ' s';
    const nome = { AMBOS: 'Senha Simples + ficha', SENHA: 'só Senha Simples', FICHA: 'só ficha' }[MODO_NUMERO];
    const texto = `Lista ${s(tLista)} · tudo ${s(tFim)} · ${comNumero}/${linhas.length} com número`;
    console.info(`[OM30 Ausentes] (${nome}) ${texto}`);
    const el = document.querySelector(`#${BAR_ID} .om30a-tempo`);
    if (el) {
      el.textContent = `⏱ ${texto}`;
      el.dataset.copiar = `OM30 Ausentes v${VERSAO} | modo: ${nome} | tela: ${nomeTela()} | ${texto} | ${new Date().toLocaleString('pt-BR')}`;
      el.title = `Modo do número: ${nome}. Medido desde que a página abriu. Clique para copiar.`;
    }
  }

  async function classificarTodos(forcar = false) {
    if (verificando || !tabelaRef) return;
    verificando = true;
    try {
      definirStatus('Lendo filas…');
      garantirTokenSenha();
      // Esperando o login do Senha Simples: não insiste nele, separa só pelo profissional.
      const unidade = MODO_NUMERO === 'FICHA' ? await unidadeSoParametrizacao()
        : aguardandoToken
          ? { ...(unidadeAtual || {}), filas: [], erros: { categorias: 'HTTP 401' } }
          : await filasDaUnidade(forcar);
      if (!aguardandoToken && MODO_NUMERO !== 'FICHA') unidadeAtual = unidade;
      const deu401 = Object.values(unidade.erros || {}).some(e => /401/.test(e));
      if (deu401) esperarTokenNovo(() => classificarTodos(false));   // segue separando pelo profissional
      const configurado = !deu401 && !!(unidade.acolhCat && unidade.medCat && unidade.filas.length);

      if (!deu401 && MODO_NUMERO !== 'FICHA') definirAviso(configurado ? (unidade.unidadeDiferente
        ? 'O Senha Simples deste computador está em outra unidade. Consultei só o acolhimento e a fila médica desta unidade. Para ver emergência e salas, troque a unidade no site do Senha Simples.'
        : '') :
        !unidade.medCat
          ? `Não encontrei a fila médica na parametrização desta unidade (${unidade.erros?.atendimento || 'sem detalhe'}).`
          : !unidade.acolhCat
            ? `Não encontrei a fila de acolhimento na parametrização desta unidade (${unidade.erros?.acolhimento || 'sem detalhe'}).`
            : `Não consegui ler as filas do Senha Simples (${unidade.erros?.categorias || 'sem detalhe'}).`);

      const linhas = [...tabelaRef.tBodies[0].rows]
        .map(tr => ({ tr, inf: infoLinha(tr) }))
        .filter(x => x.inf?.id)
        .filter(x => !somenteHoje || linhaEhDeHoje(x.tr))   // antigos só quando "Somente hoje" estiver desmarcado
        .sort((a, b) => Number(linhaEhDeHoje(b.tr)) - Number(linhaEhDeHoje(a.tr)));

      if (forcar) linhas.forEach(x => { try { localStorage.removeItem(SESSION_CACHE + x.inf.id); localStorage.removeItem(CHAVE_FICHA + x.inf.id); } catch {} });
      if (forcar) { tFim = 0; classificou = false; }

      let feitos = 0;
      definirStatus(`Verificando 0/${linhas.length}`);
      await emParalelo(linhas, CONCORRENCIA, async ({ tr, inf }) => {
        const p = mapaProf.get(inf.id);
        const r = p
          ? await origemRapida(inf.id, inf.tipo, unidade, p.prof ? 'MEDICO' : 'ACOLHIMENTO', p.prof, configurado)
          : configurado ? await origemDoAusente(inf.id, inf.tipo, unidade) : { origem: 'INDEFINIDO' };
        marcarLinha(tr, r);
        feitos++;
        definirStatus(`Verificando ${feitos}/${linhas.length}`);
        aplicarFiltros();
      });
      definirStatus('');
      ultimaVerificacao = Date.now();
      classificou = true;
      if (!tLista) tLista = performance.now() - T0;
      verificarConclusao();

      // Token venceu no meio: espera o novo e refaz, sem mostrar "Erro".
      if (!deu401 && linhas.some(x => /401/.test(x.tr.dataset.om30Erro || ''))) {
        esperarTokenNovo(() => classificarTodos(false));
        return;
      }

      // Se NENHUM ausente teve a senha encontrada, a leitura das filas veio errada
      // (ex.: Senha Simples ainda trocando de unidade). Refaz sozinho uma vez, do zero.
      const total = linhas.length;
      const semNada = linhas.filter(x => ['SEM_SENHA', 'ERRO', 'INDEFINIDO'].includes(x.tr.dataset.om30Origem)).length;
      if (total && semNada === total && !refezAutomatico) {
        refezAutomatico = true;
        setTimeout(() => classificarTodos(true), 2000);
      } else if (semNada < total) {
        refezAutomatico = false;
      }
    } finally {
      verificando = false;
    }
  }

  let ultimaVerificacao = 0;
  let unidadeAtual = null;
  let refezAutomatico = false;

  // Mantém a lista atualizada sozinha: revisita de tempos em tempos e quando a aba volta ao foco.
  function agendarReverificacao() {
    let ultimaCompleta = Date.now();
    let revisitando = false;
    const revisitar = async () => {
      if (revisitando || verificando || !tabelaRef) return;
      revisitando = true;
      ultimaVerificacao = Date.now();
      try {
        if (Date.now() - ultimaCompleta >= CONFERENCIA_COMPLETA_MS) {
          ultimaCompleta = Date.now();
          await sincronizarLista(tabelaRef, { completa: false });
        } else {
          await buscarNovos(tabelaRef);
        }
      } catch {}
      aplicarFiltros();
      // Quem já foi conferido vem da memória (30 min); só os novos vão ao Senha Simples.
      try { await classificarTodos(false); } finally { revisitando = false; }
    };
    setInterval(() => {
      if (!document.hidden && Date.now() - ultimaVerificacao >= REVERIFICAR_MS) revisitar();
    }, 5000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Date.now() - ultimaVerificacao >= 10000) revisitar();
    });
  }

  // ---------------------------------------------------------------------------
  // Remover ausência
  //   - Ausente do ACOLHIMENTO: remove a ausência, devolve a MESMA senha para a fila do
  //     acolhimento (retornar + desvincular) e mostra o número ao profissional.
  //   - Ausente de outra fila: bloqueado nesta tela.
  // ---------------------------------------------------------------------------

  async function removerAusenciaNativa(href) {
    const csrfParam = document.querySelector('meta[name="csrf-param"]')?.content || 'authenticity_token';
    const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';
    const corpo = new URLSearchParams({ _method: 'delete', [csrfParam]: csrfToken });
    const r = await fetch(href, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: corpo.toString(),
      redirect: 'follow'
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  }

  async function devolverSenha(cat, atendimentoId, tipo) {
    let ultimoErro;
    for (let i = 0; i < 2; i++) {
      try {
        const { data } = await senhaSimplesPutFilas(`${cat}/retornar_para_atendimento`, {
          atendimento_id: Number(atendimentoId), atendimento_type: tipo, categoria_id: cat
        });
        if (data && !data.confirmado_em) {
          // Solta a senha de quem chamou antes da ausência, para qualquer guichê poder chamar.
          try { await desvincularSenha(data, null); } catch (e) { console.warn('[OM30] desvincular após devolver:', e); }
          return data;
        }
        ultimoErro = new Error('a senha continuou concluída');
      } catch (e) {
        ultimoErro = e;
      }
      await new Promise(r => setTimeout(r, 800));
    }
    throw ultimoErro;
  }

  let removendo = false;

  document.addEventListener('click', async ev => {
    const a = ev.target.closest && ev.target.closest(SEL_REMOVER);
    if (!a) return;
    const tr = a.closest('tr');
    const origem = tr?.dataset.om30Origem;

    if (origem && !['ACOLHIMENTO', 'MEDICO', 'EMERGENCIA', 'OUTROS'].includes(origem)) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      dialogo({
        tipo: 'aviso',
        titulo: 'Remoção bloqueada',
        subtitulo: 'Origem da ausência não confirmada',
        texto: [
          'Não consegui confirmar no Senha Simples onde este paciente foi ausentado.',
          'Clique em "Atualizar" na barra acima e tente de novo. Se continuar assim, remova pela tela da fila onde ele foi ausentado.'
        ],
        botoes: [{ rotulo: 'Entendi', valor: true, primario: true }]
      });
      return;
    }
    if (!origem) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      toast({ tipo: 'aviso', titulo: 'Aguarde a verificação', texto: 'Ainda estou conferindo onde este paciente foi ausentado.' });
      return;
    }

    const setor = tr.dataset.om30Setor || '';
    if (!podeRemoverAqui(origem, setor)) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      const b = textoBloqueio(origem, setor);
      dialogo({
        tipo: 'aviso',
        titulo: `Remoção bloqueada na ${nomeTela()}`.replace('na acolhimento', 'no acolhimento'),
        subtitulo: b.titulo,
        texto: b.paragrafos,
        botoes: [{ rotulo: 'Entendi', valor: true, primario: true }]
      });
      return;
    }

    if (!tr.dataset.om30Cat) return; // sem classificação: fluxo nativo
    if (aguardandoToken) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      toast({ tipo: 'aviso', titulo: 'Aguarde o Senha Simples', texto: 'Ainda conectando ao Senha Simples. Sem ele a senha não volta para a fila; tente em alguns segundos.' });
      return;
    }
    const destino = nomeFilaDestino(origem, setor);
    const ao = destino === 'acolhimento' ? 'ao acolhimento' : `à ${destino}`;
    const doDestino = destino === 'acolhimento' ? 'do acolhimento' : `da ${destino}`;

    ev.preventDefault();
    ev.stopImmediatePropagation();
    if (removendo) return;

    const inf = infoLinha(tr);
    const nome = nomeDaLinha(tr);
    const ok = await dialogo({
      tipo: 'pergunta',
      titulo: `Devolver ${ao}?`,
      subtitulo: nome,
      senha: tr.dataset.om30Senha || '',
      senhaRotulo: 'Senha atual',
      texto: [`O paciente sai da lista de ausentes e volta para ${destino === 'acolhimento' ? 'a fila do acolhimento' : `a ${destino}`} com a mesma senha, livre para qualquer guichê chamar.`],
      botoes: [
        { rotulo: 'Cancelar', valor: false },
        { rotulo: 'Remover e devolver', valor: true, primario: true }
      ]
    });
    if (!ok) return;

    removendo = true;
    definirStatus('Removendo ausência…');
    try {
      try {
        await removerAusenciaNativa(a.href);
      } catch (e) {
        await dialogo({
          tipo: 'erro',
          titulo: 'Não foi possível remover a ausência',
          subtitulo: nome,
          texto: ['Nada foi alterado. Tente de novo em alguns segundos.', `Detalhe: ${descricaoErro(e)}`]
        });
        return;
      }

      definirStatus('Devolvendo senha…');
      try {
        const senha = await devolverSenha(tr.dataset.om30Cat, inf.id, inf.tipo);
        try { localStorage.removeItem(SESSION_CACHE + inf.id); } catch {}
        await dialogo({
          tipo: 'sucesso',
          titulo: `Paciente devolvido ${ao}`,
          subtitulo: nome,
          senha: senha.senha || tr.dataset.om30Senha || '—',
          senhaRotulo: 'Mesma senha do munícipe',
          texto: [
            `A senha do munícipe voltou para a fila ${doDestino} e já pode ser chamada em qualquer guichê.`,
            'Ele continua com a mesma senha que já tem; é só avisar que voltou para a fila e aguardar a chamada.'
          ]
        });
      } catch (e) {
        await dialogo({
          tipo: 'erro',
          titulo: 'A senha não voltou para a fila',
          subtitulo: nome,
          texto: [
            'A ausência foi removida, mas o Senha Simples não reativou a senha.',
            'O paciente não vai aparecer no "chamar próximo". Avise o suporte antes de chamá-lo.',
            `Detalhe: ${descricaoErro(e)}`
          ]
        });
      }
      location.reload();
    } finally {
      removendo = false;
      definirStatus('');
    }
  }, true);

  // ---------------------------------------------------------------------------
  // Inicialização
  // ---------------------------------------------------------------------------

  async function iniciar(tabela) {
    tabela.dataset.om30Ausentes = '1';
    if (!tabela.tBodies[0]) tabela.appendChild(document.createElement('tbody'));
    tabelaRef = tabela;

    montarBarra(tabela);
    definirStatus('Carregando ausentes de hoje…');
    esconderPaginacao(tabela);
    await sincronizarLista(tabela, { inicial: true, completa: !somenteHoje }).catch(e => console.warn('[OM30 Ausentes]', e));
    prepararColunas(tabela);
    aplicarFiltros();
    marcarTempoLista();

    if (MODO_NUMERO === 'FICHA') {   // não precisa do Senha Simples para mostrar a lista
      await classificarTodos();
      agendarReverificacao();
      return;
    }

    definirStatus('Aguardando Senha Simples…');
    try {
      await esperar(senhaSimplesPronto);
      garantirTokenSenha();
    } catch {
      definirStatus('');
      definirAviso('Senha Simples não autenticado nesta tela. Recarregue a página e tente de novo.');
      return;
    }
    await classificarTodos();
    agendarReverificacao();
  }

  function tentarIniciar() {
    if (!/^\/(acolhimentos|prontuarios)(\/urgencia_emergencia)?\/?$/.test(location.pathname)) return true;
    const tabela = acharTabelaAusentes();
    if (tabela && !tabela.dataset.om30Ausentes) { iniciar(tabela); return true; }
    return false;
  }

  if (!tentarIniciar()) {
    const obs = new MutationObserver(() => { if (tentarIniciar()) obs.disconnect(); });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 20000);
  }
})();
}
// ===== FIM OM30 AUSENTES EMBUTIDO =====
