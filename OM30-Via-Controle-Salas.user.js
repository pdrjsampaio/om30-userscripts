// ==UserScript==
// @name         OM30 - Via de Administração Controle de Salas
// @namespace    https://om30.com.br/
// @version      1.0.0
// @description  Exibe a via de administração dos medicamentos pendentes diretamente na fila de Medicação do Controle de Salas.
// @author       OM30
// @match        https://guaruja.saudesimples.net/aplicacoes_medicamentos*
// @updateURL    https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Via-Controle-Salas.user.js
// @downloadURL  https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Via-Controle-Salas.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    concorrencia: 4,
    cacheMs: 60000,
    intervaloVarredura: 1000
  };

  const state = {
    cache: new Map(),
    pendentes: new Map(),
    fila: [],
    ativos: 0,
    ultimaTabela: null
  };

  function log(...args) {
    console.log('[OM30 VIA]', ...args);
  }

  function pageOk() {
    return /^\/aplicacoes_medicamentos(?:\/\d+)?\/?$/.test(location.pathname);
  }

  function limpar(v) {
    return String(v ?? '').replace(/\s+/g, ' ').trim();
  }

  function normalizar(v) {
    return limpar(v)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase();
  }

  function getVue(el) {
    let node = el;
    for (let i = 0; node && i < 15; i++, node = node.parentElement) {
      if (node.__vue__) return node.__vue__;
    }
    return null;
  }

  function encaminhamentoIdDaLinha(tr) {
    const botaoAtender = tr.querySelector('.botao-atender');
    if (!botaoAtender) return '';

    const vm = getVue(botaoAtender);
    const str = String(vm?.encaminhamentoStr || '');
    return str.split('#')[1] || '';
  }

  function valorPorLabel(item, nomeLabel) {
    const alvo = normalizar(nomeLabel);

    const label = [...item.querySelectorAll('label')].find(
      l => normalizar(l.textContent) === alvo
    );

    if (!label) return '';

    const bloco = label.closest('li') || label.parentElement;
    if (!bloco) return '';

    const clone = bloco.cloneNode(true);
    clone.querySelectorAll('label').forEach(x => x.remove());

    return limpar(clone.textContent);
  }

  function nomeVia(via, id) {
    const n = normalizar(via);

    if (n === 'INTRAMUSCULAR' || String(id) === '9') {
      return { curto: 'IM', completo: via || 'INTRAMUSCULAR' };
    }

    if (n === 'INTRAVENOSA' || String(id) === '11') {
      return { curto: 'IV', completo: via || 'INTRAVENOSA' };
    }

    if (n === 'ENDOVENOSA') {
      return { curto: 'EV', completo: via };
    }

    if (n === 'ORAL' || String(id) === '12') {
      return { curto: 'ORAL', completo: via || 'ORAL' };
    }

    if (n === 'PARENTERAL' || String(id) === '18') {
      return { curto: 'PARENTERAL', completo: via || 'PARENTERAL' };
    }

    if (n) {
      return {
        curto: limpar(via).length <= 14 ? limpar(via).toUpperCase() : limpar(via).toUpperCase().slice(0, 14),
        completo: limpar(via)
      };
    }

    if (id) {
      return { curto: `ID ${id}`, completo: `Tipo de uso ${id}` };
    }

    return { curto: '—', completo: 'Via não informada' };
  }

  async function buscarVias(encaminhamentoId) {
    const response = await fetch(
      `/aplicacoes_medicamentos/new?encaminhamento_medicacao_id=${encodeURIComponent(encaminhamentoId)}`,
      {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          Accept: 'text/html,application/xhtml+xml'
        }
      }
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const itens = [...doc.querySelectorAll('.item-encaminhamento-controle-salas')];

    const vias = [];
    for (const item of itens) {
      const pendente = item.querySelector('input[id$="_pendente"]')?.value;
      const cancelada = item.querySelector('input[id$="_cancelada"]')?.value;

      if (String(pendente) !== 'true' || String(cancelada) === 'true') continue;

      const id =
        item.querySelector('input[id$="_tipo_uso_medicamento_id"]')?.value || '';

      const via =
        valorPorLabel(item, 'Via de Administração') ||
        valorPorLabel(item, 'Via de administracao');

      const info = nomeVia(via, id);

      if (!vias.some(x => x.curto === info.curto && x.completo === info.completo)) {
        vias.push(info);
      }
    }

    return vias;
  }

  function processarFila() {
    while (state.ativos < CONFIG.concorrencia && state.fila.length) {
      const tarefa = state.fila.shift();
      state.ativos++;

      buscarVias(tarefa.id)
        .then(vias => {
          state.cache.set(tarefa.id, {
            vias,
            timestamp: Date.now()
          });
          tarefa.resolve(vias);
        })
        .catch(erro => {
          tarefa.reject(erro);
        })
        .finally(() => {
          state.ativos--;
          state.pendentes.delete(tarefa.id);
          processarFila();
        });
    }
  }

  function obterVias(encaminhamentoId) {
    const cache = state.cache.get(encaminhamentoId);

    if (cache && Date.now() - cache.timestamp < CONFIG.cacheMs) {
      return Promise.resolve(cache.vias);
    }

    if (state.pendentes.has(encaminhamentoId)) {
      return state.pendentes.get(encaminhamentoId);
    }

    const promise = new Promise((resolve, reject) => {
      state.fila.push({
        id: encaminhamentoId,
        resolve,
        reject
      });
      processarFila();
    });

    state.pendentes.set(encaminhamentoId, promise);
    return promise;
  }

  function style() {
    if (document.querySelector('#om30-via-style')) return;

    const s = document.createElement('style');
    s.id = 'om30-via-style';
    s.textContent = `
      th.om30-via-th,
      td.om30-via-cell {
        text-align: center !important;
        vertical-align: middle !important;
        white-space: nowrap;
      }

      th.om30-via-th {
        min-width: 92px;
      }

      td.om30-via-cell {
        min-width: 92px;
      }

      .om30-via-wrap {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 3px;
        flex-wrap: wrap;
        max-width: 170px;
      }

      .om30-via-badge {
        display: inline-block;
        padding: 2px 6px;
        border: 1px solid #b9c5d3;
        border-radius: 4px;
        background: #f6f8fa;
        color: #24364c;
        font-size: 10px;
        line-height: 1.3;
        font-weight: 700;
        letter-spacing: .15px;
      }

      .om30-via-loading {
        color: #7a8795;
        font-size: 11px;
      }

      .om30-via-empty {
        color: #7a8795;
        font-size: 11px;
      }
    `;

    document.head.appendChild(s);
  }

  function encontrarTabela() {
    return [...document.querySelectorAll('table')].find(
      t => t.querySelector('tbody .botao-atender')
    ) || null;
  }

  function indiceInsercao(table) {
    const headers = [...table.querySelectorAll('thead th')];

    const status = headers.findIndex(th => normalizar(th.textContent) === 'STATUS');
    if (status >= 0) return status;

    const acao = headers.findIndex(th => {
      const t = normalizar(th.textContent);
      return t === 'ACAO' || t === 'AÇÃO';
    });

    if (acao >= 0) return acao;

    return Math.max(0, headers.length - 1);
  }

  function garantirCabecalho(table) {
    const existente = table.querySelector('thead th.om30-via-th');
    if (existente) return [...existente.parentElement.children].indexOf(existente);

    const row = table.querySelector('thead tr');
    if (!row) return -1;

    const idx = indiceInsercao(table);
    const th = document.createElement('th');

    th.className = 'om30-via-th';
    th.textContent = 'Via';
    th.setAttribute('scope', 'col');
    th.title = 'Via de administração dos medicamentos pendentes';

    const ref = row.children[idx] || null;
    row.insertBefore(th, ref);

    return [...row.children].indexOf(th);
  }

  function garantirCelula(tr, index) {
    let td = tr.querySelector('td.om30-via-cell');

    if (!td) {
      td = document.createElement('td');
      td.className = 'om30-via-cell';

      const ref = tr.children[index] || null;
      tr.insertBefore(td, ref);
    }

    return td;
  }

  function renderLoading(td) {
    if (td.dataset.om30Estado === 'loading') return;

    td.dataset.om30Estado = 'loading';
    td.innerHTML = '<span class="om30-via-loading">...</span>';
  }

  function renderErro(td) {
    td.dataset.om30Estado = 'erro';
    td.innerHTML = '<span class="om30-via-empty" title="Não foi possível consultar a via">—</span>';
  }

  function renderVias(td, vias) {
    td.dataset.om30Estado = 'ok';

    if (!vias.length) {
      td.innerHTML = '<span class="om30-via-empty" title="Nenhum medicamento pendente com via informada">—</span>';
      return;
    }

    const wrap = document.createElement('span');
    wrap.className = 'om30-via-wrap';

    for (const via of vias) {
      const badge = document.createElement('span');
      badge.className = 'om30-via-badge';
      badge.textContent = via.curto;
      badge.title = via.completo;
      wrap.appendChild(badge);
    }

    td.replaceChildren(wrap);
  }

  function varrerFila() {
    if (!pageOk()) return;

    style();

    const table = encontrarTabela();
    if (!table) return;

    state.ultimaTabela = table;

    const index = garantirCabecalho(table);
    if (index < 0) return;

    const rows = [...table.querySelectorAll('tbody tr')].filter(
      tr => tr.querySelector('.botao-atender')
    );

    for (const tr of rows) {
      const td = garantirCelula(tr, index);
      const encaminhamentoId = encaminhamentoIdDaLinha(tr);

      if (!encaminhamentoId) {
        renderErro(td);
        continue;
      }

      if (
        td.dataset.om30Encaminhamento === encaminhamentoId &&
        ['loading', 'ok'].includes(td.dataset.om30Estado)
      ) {
        continue;
      }

      td.dataset.om30Encaminhamento = encaminhamentoId;
      renderLoading(td);

      obterVias(encaminhamentoId)
        .then(vias => {
          if (!td.isConnected) return;
          if (td.dataset.om30Encaminhamento !== encaminhamentoId) return;
          renderVias(td, vias);
        })
        .catch(erro => {
          if (!td.isConnected) return;
          if (td.dataset.om30Encaminhamento !== encaminhamentoId) return;
          renderErro(td);
          console.warn('[OM30 VIA] Falha no encaminhamento', encaminhamentoId, erro?.message || erro);
        });
    }
  }

  function init() {
    if (!pageOk()) return;

    style();
    varrerFila();

    setInterval(varrerFila, CONFIG.intervaloVarredura);

    log('Ativo. Coluna VIA será preenchida conforme as fichas da fila forem consultadas.');
  }

  window.OM30ViaControleSalas = {
    atualizar: () => {
      state.cache.clear();
      varrerFila();
    },
    limparCache: () => state.cache.clear()
  };

  init();
})();
