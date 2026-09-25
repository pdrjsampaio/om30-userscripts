// ==UserScript==
// @name         OM30 - Via de Administração Controle de Salas
// @namespace    https://om30.com.br/
// @version      1.3.3
// @description  Exibe a via de administração dos medicamentos pendentes abaixo da Sala em um único indicador compacto com o prefixo VIA, sem quebra visual e com cache persistente entre atualizações da fila.
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
    cacheFrescoMs: 120000,
    cachePersistenteMs: 60 * 60 * 1000,
    intervaloVarredura: 800,
    cacheKey: 'om30_via_controle_salas_cache_v2',
    cacheKeyAntigo: 'om30_via_controle_salas_cache_v1'
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
    if (n === 'INTRAMUSCULAR' || String(id) === '9') return { curto: 'IM', completo: via || 'INTRAMUSCULAR', classe: 'im' };
    if (n === 'INTRAVENOSA' || n === 'ENDOVENOSA' || String(id) === '11') return { curto: 'IV', completo: via || 'INTRAVENOSA', classe: 'iv' };
    if (n === 'SUBCUTANEA') return { curto: 'SC', completo: via || 'SUBCUTÂNEA', classe: 'sc' };
    if (n === 'ORAL' || String(id) === '12') return { curto: 'ORAL', completo: via || 'ORAL', classe: 'oral' };
    if (n === 'PARENTERAL' || String(id) === '18') return { curto: 'PAR', completo: via || 'PARENTERAL', classe: 'parenteral' };
    if (n === 'SUBLINGUAL') return { curto: 'SL', completo: via || 'SUBLINGUAL', classe: 'outros' };
    if (n === 'INALATORIA' || n === 'INALACAO') return { curto: 'INAL', completo: via, classe: 'outros' };
    if (n === 'TOPICA') return { curto: 'TOP', completo: via, classe: 'outros' };
    if (n === 'NASAL') return { curto: 'NAS', completo: via, classe: 'outros' };
    if (n === 'RETAL') return { curto: 'RET', completo: via, classe: 'outros' };
    if (n === 'VAGINAL') return { curto: 'VAG', completo: via, classe: 'outros' };
    if (n === 'INTRADERMICA') return { curto: 'ID', completo: via, classe: 'outros' };
    if (n.includes('OFTALM') || n === 'OCULAR') return { curto: 'OCUL', completo: via, classe: 'outros' };
    if (n.includes('OTOLOG') || n === 'AURICULAR') return { curto: 'OTO', completo: via, classe: 'outros' };
    if (n) {
      const texto = limpar(via).toUpperCase();
      return { curto: texto.length <= 6 ? texto : texto.slice(0, 5) + '…', completo: limpar(via), classe: 'outros' };
    }
    if (id) return { curto: `ID${id}`, completo: `Tipo de uso ${id}`, classe: 'outros' };
    return { curto: '—', completo: 'Via não informada', classe: 'outros' };
  }

  function carregarCachePersistente() {
    try {
      sessionStorage.removeItem(CONFIG.cacheKeyAntigo);
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

  function classeResumo(vias) {
    if (vias.length !== 1) return 'om30-via-multipla';
    switch (vias[0]?.classe) {
      case 'im': return 'om30-via-im';
      case 'iv': return 'om30-via-iv';
      case 'sc': return 'om30-via-sc';
      case 'oral': return 'om30-via-oral';
      case 'parenteral': return 'om30-via-parenteral';
      default: return 'om30-via-outros';
    }
  }

  function style() {
    if (document.querySelector('#om30-via-style')) return;
    const s = document.createElement('style');
    s.id = 'om30-via-style';
    s.textContent = `
      .om30-via-inline{display:flex;align-items:center;justify-content:center;margin-top:3px;min-height:15px;line-height:1;max-width:100%;overflow:hidden}
      .om30-via-badge{display:block;max-width:88px;padding:2px 6px;border:0;border-radius:4px;color:#fff;font-size:9px;line-height:1.15;font-weight:800;letter-spacing:.1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 1px rgba(15,23,42,.14)}
      .om30-via-im{background:#6d3fb3}
      .om30-via-iv{background:#1f5f9f}
      .om30-via-sc{background:#0f766e}
      .om30-via-oral{background:#24704a}
      .om30-via-parenteral{background:#8a4c17}
      .om30-via-multipla{background:#334155}
      .om30-via-outros{background:#475569}
      .om30-via-loading{display:block;max-width:88px;padding:2px 6px;border-radius:4px;background:#eef2f6;color:#657285;font-size:9px;font-weight:700;white-space:nowrap;overflow:hidden}
      .om30-via-empty{color:#8793a1;font-size:9px;line-height:1.2;white-space:nowrap}
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
    box.innerHTML = '<span class="om30-via-loading">VIA …</span>';
  }

  function renderErro(box) {
    box.dataset.om30Estado = 'erro';
    box.innerHTML = '<span class="om30-via-empty" title="Não foi possível consultar a via">VIA —</span>';
  }

  function renderVias(box, vias) {
    box.dataset.om30Estado = 'ok';
    if (!vias.length) {
      box.innerHTML = '<span class="om30-via-empty" title="Nenhum medicamento pendente com via informada">VIA —</span>';
      return;
    }

    const badge = document.createElement('span');
    badge.className = `om30-via-badge ${classeResumo(vias)}`;
    badge.textContent = `VIA ${vias.map(v => v.curto).join('/')}`;
    badge.title = `${vias.length > 1 ? 'Vias' : 'Via'} de administração: ${vias.map(v => v.completo).join(' + ')}`;
    box.replaceChildren(badge);
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
    sessionStorage.removeItem(CONFIG.cacheKeyAntigo);
  }

  function init() {
    if (!pageOk()) return;
    carregarCachePersistente();
    style();
    varrerFila();
    setInterval(varrerFila, CONFIG.intervaloVarredura);
    log('Ativo. A via aparece compacta abaixo de “Medicação”, sem quebrar a linha.');
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