// ==UserScript==
// @name         OM30 - Via de Administração Controle de Salas
// @namespace    https://om30.com.br/
// @version      1.1.0
// @description  Exibe a via de administração dos medicamentos pendentes abaixo da Sala, sem criar nova coluna, com cache persistente entre atualizações da fila.
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
    cacheFrescoMs: 30000,
    cachePersistenteMs: 30 * 60 * 1000,
    intervaloVarredura: 800,
    cacheKey: 'om30_via_controle_salas_cache_v1'
  };

  const state = {
    cache: new Map(),
    pendentes: new Map(),
    fila: [],
    ativos: 0
  };

  function log(...args) { console.log('[OM30 VIA]', ...args); }
  function pageOk() { return /^\/aplicacoes_medicamentos(?:\/\d+)?\/?$/.test(location.pathname); }
  function limpar(v) { return String(v ?? '').replace(/\s+/g, ' ').trim(); }
  function normalizar(v) {
    return limpar(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
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
    return String(vm?.encaminhamentoStr || '').split('#')[1] || '';
  }

  function valorPorLabel(item, nomeLabel) {
    const alvo = normalizar(nomeLabel);
    const label = [...item.querySelectorAll('label')].find(l => normalizar(l.textContent) === alvo);
    if (!label) return '';
    const bloco = label.closest('li') || label.parentElement;
    if (!bloco) return '';
    const clone = bloco.cloneNode(true);
    clone.querySelectorAll('label').forEach(x => x.remove());
    return limpar(clone.textContent);
  }

  function nomeVia(via, id) {
    const n = normalizar(via);
    if (n === 'INTRAMUSCULAR' || String(id) === '9') return { curto: 'IM', completo: via || 'INTRAMUSCULAR' };
    if (n === 'INTRAVENOSA' || String(id) === '11') return { curto: 'IV', completo: via || 'INTRAVENOSA' };
    if (n === 'ENDOVENOSA') return { curto: 'EV', completo: via };
    if (n === 'ORAL' || String(id) === '12') return { curto: 'ORAL', completo: via || 'ORAL' };
    if (n === 'PARENTERAL' || String(id) === '18') return { curto: 'PARENTERAL', completo: via || 'PARENTERAL' };
    if (n) {
      const texto = limpar(via).toUpperCase();
      return { curto: texto.length <= 14 ? texto : texto.slice(0, 14), completo: limpar(via) };
    }
    if (id) return { curto: `ID ${id}`, completo: `Tipo de uso ${id}` };
    return { curto: '—', completo: 'Via não informada' };
  }

  function carregarCachePersistente() {
    try {
      const bruto = JSON.parse(sessionStorage.getItem(CONFIG.cacheKey) || '{}');
      const agora = Date.now();
      for (const [id, item] of Object.entries(bruto)) {
        if (!item || !Array.isArray(item.vias) || !Number.isFinite(item.timestamp)) continue;
        if (agora - item.timestamp > CONFIG.cachePersistenteMs) continue;
        state.cache.set(id, item);
      }
    } catch (e) {
      console.warn('[OM30 VIA] Cache persistente inválido; ignorando.', e);
    }
  }

  function salvarCachePersistente() {
    try {
      const agora = Date.now();
      const saida = {};
      for (const [id, item] of state.cache.entries()) {
        if (!item || agora - item.timestamp > CONFIG.cachePersistenteMs) continue;
        saida[id] = item;
      }
      sessionStorage.setItem(CONFIG.cacheKey, JSON.stringify(saida));
    } catch (e) {
      console.warn('[OM30 VIA] Não foi possível persistir o cache.', e);
    }
  }

  function cacheValido(encaminhamentoId) {
    const item = state.cache.get(encaminhamentoId);
    if (!item) return null;
    if (Date.now() - item.timestamp > CONFIG.cachePersistenteMs) {
      state.cache.delete(encaminhamentoId);
      salvarCachePersistente();
      return null;
    }
    return item;
  }

  function cacheFresco(item) {
    return Boolean(item && Date.now() - item.timestamp < CONFIG.cacheFrescoMs);
  }

  async function buscarVias(encaminhamentoId) {
    const response = await fetch(`/aplicacoes_medicamentos/new?encaminhamento_medicacao_id=${encodeURIComponent(encaminhamentoId)}`, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'text/html,application/xhtml+xml' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const itens = [...doc.querySelectorAll('.item-encaminhamento-controle-salas')];
    const vias = [];

    for (const item of itens) {
      const pendente = item.querySelector('input[id$="_pendente"]')?.value;
      const cancelada = item.querySelector('input[id$="_cancelada"]')?.value;
      if (String(pendente) !== 'true' || String(cancelada) === 'true') continue;

      const id = item.querySelector('input[id$="_tipo_uso_medicamento_id"]')?.value || '';
      const via = valorPorLabel(item, 'Via de Administração') || valorPorLabel(item, 'Via de administracao');
      const info = nomeVia(via, id);
      if (!vias.some(x => x.curto === info.curto && x.completo === info.completo)) vias.push(info);
    }
    return vias;
  }

  function processarFila() {
    while (state.ativos < CONFIG.concorrencia && state.fila.length) {
      const tarefa = state.fila.shift();
      state.ativos++;
      buscarVias(tarefa.id)
        .then(vias => {
          state.cache.set(tarefa.id, { vias, timestamp: Date.now() });
          salvarCachePersistente();
          tarefa.resolve(vias);
        })
        .catch(tarefa.reject)
        .finally(() => {
          state.ativos--;
          state.pendentes.delete(tarefa.id);
          processarFila();
        });
    }
  }

  function obterVias(encaminhamentoId, forcar = false) {
    const cache = cacheValido(encaminhamentoId);
    if (!forcar && cacheFresco(cache)) return Promise.resolve(cache.vias);
    if (state.pendentes.has(encaminhamentoId)) return state.pendentes.get(encaminhamentoId);

    const promise = new Promise((resolve, reject) => {
      state.fila.push({ id: encaminhamentoId, resolve, reject });
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
      .om30-via-inline{display:flex;align-items:center;justify-content:center;gap:3px;flex-wrap:wrap;margin-top:3px;min-height:14px;line-height:1}
      .om30-via-badge{display:inline-block;padding:1px 4px;border:1px solid #b8c4d1;border-radius:3px;background:#f7f9fb;color:#24364c;font-size:8px;line-height:1.25;font-weight:700;letter-spacing:.1px;white-space:nowrap}
      .om30-via-loading,.om30-via-empty{color:#8793a1;font-size:8px;line-height:1.2}
    `;
    document.head.appendChild(s);
  }

  function encontrarTabela() {
    return [...document.querySelectorAll('table')].find(t => t.querySelector('tbody .botao-atender')) || null;
  }

  function indiceSala(table) {
    return [...table.querySelectorAll('thead th')].findIndex(th => normalizar(th.textContent) === 'SALA');
  }

  function garantirContainerVia(tdSala) {
    let box = tdSala.querySelector(':scope > .om30-via-inline');
    if (box) return box;
    box = document.createElement('span');
    box.className = 'om30-via-inline';
    tdSala.appendChild(box);
    return box;
  }

  function renderLoading(box) {
    box.dataset.om30Estado = 'loading';
    box.innerHTML = '<span class="om30-via-loading">...</span>';
  }

  function renderErro(box) {
    box.dataset.om30Estado = 'erro';
    box.innerHTML = '<span class="om30-via-empty" title="Não foi possível consultar a via">—</span>';
  }

  function renderVias(box, vias) {
    box.dataset.om30Estado = 'ok';
    if (!vias.length) {
      box.innerHTML = '<span class="om30-via-empty" title="Nenhum medicamento pendente com via informada">—</span>';
      return;
    }

    const frag = document.createDocumentFragment();
    for (const via of vias) {
      const badge = document.createElement('span');
      badge.className = 'om30-via-badge';
      badge.textContent = via.curto;
      badge.title = `Via de administração: ${via.completo}`;
      frag.appendChild(badge);
    }
    box.replaceChildren(frag);
  }

  function atualizarLinha(tr, salaIndex) {
    const tdSala = tr.children[salaIndex];
    if (!tdSala) return;

    const encaminhamentoId = encaminhamentoIdDaLinha(tr);
    const box = garantirContainerVia(tdSala);
    if (!encaminhamentoId) {
      renderErro(box);
      return;
    }

    const mesmoEncaminhamento = box.dataset.om30Encaminhamento === encaminhamentoId;
    const cache = cacheValido(encaminhamentoId);
    box.dataset.om30Encaminhamento = encaminhamentoId;

    if (cache) {
      if (!mesmoEncaminhamento || box.dataset.om30Estado !== 'ok') renderVias(box, cache.vias);

      if (!cacheFresco(cache)) {
        obterVias(encaminhamentoId)
          .then(vias => {
            if (!box.isConnected || box.dataset.om30Encaminhamento !== encaminhamentoId) return;
            renderVias(box, vias);
          })
          .catch(erro => console.warn('[OM30 VIA] Falha atualizando encaminhamento', encaminhamentoId, erro?.message || erro));
      }
      return;
    }

    if (mesmoEncaminhamento && box.dataset.om30Estado === 'loading') return;

    renderLoading(box);
    obterVias(encaminhamentoId)
      .then(vias => {
        if (!box.isConnected || box.dataset.om30Encaminhamento !== encaminhamentoId) return;
        renderVias(box, vias);
      })
      .catch(erro => {
        if (!box.isConnected || box.dataset.om30Encaminhamento !== encaminhamentoId) return;
        renderErro(box);
        console.warn('[OM30 VIA] Falha no encaminhamento', encaminhamentoId, erro?.message || erro);
      });
  }

  function varrerFila() {
    if (!pageOk()) return;
    style();
    const table = encontrarTabela();
    if (!table) return;
    const salaIndex = indiceSala(table);
    if (salaIndex < 0) return;

    const rows = [...table.querySelectorAll('tbody tr')].filter(tr => tr.querySelector('.botao-atender'));
    for (const tr of rows) atualizarLinha(tr, salaIndex);
  }

  function limparCache() {
    state.cache.clear();
    sessionStorage.removeItem(CONFIG.cacheKey);
  }

  function init() {
    if (!pageOk()) return;
    carregarCachePersistente();
    style();
    varrerFila();
    setInterval(varrerFila, CONFIG.intervaloVarredura);
    log('Ativo. A via aparece abaixo de “Medicação”, sem criar nova coluna.');
  }

  window.OM30ViaControleSalas = {
    atualizar: () => {
      const table = encontrarTabela();
      if (!table) return;
      const salaIndex = indiceSala(table);
      if (salaIndex < 0) return;

      for (const tr of table.querySelectorAll('tbody tr')) {
        if (!tr.querySelector('.botao-atender')) continue;
        const id = encaminhamentoIdDaLinha(tr);
        const box = tr.children[salaIndex]?.querySelector(':scope > .om30-via-inline');
        if (!id) continue;

        obterVias(id, true)
          .then(vias => {
            if (box?.isConnected && box.dataset.om30Encaminhamento === id) renderVias(box, vias);
          })
          .catch(() => {});
      }
    },
    limparCache,
    get cache() { return state.cache; }
  };

  init();
})();
