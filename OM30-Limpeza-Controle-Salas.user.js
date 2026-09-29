// ==UserScript==
// @name         OM30 - Limpeza Controle de Salas
// @description  Limpeza controlada da fila de Medicação com filtro interno, horário limite, prévia e log
// @namespace    https://om30.com.br/
// @version      2.6
// @author       OM30
// @match        https://guaruja.saudesimples.net/aplicacoes_medicamentos*
// @require      https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/98186ec4e1e408231bda257a83a7ec18be754ad1/OM30-Limpeza-Controle-Salas.user.js
// @updateURL    https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Limpeza-Controle-Salas.user.js
// @downloadURL  https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Limpeza-Controle-Salas.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const FILTRO_DIA_KEY = 'om30_controle_salas_filtro_dia_v3';

  function salvarDataTemporaria(dataISO) {
    const anterior = localStorage.getItem(FILTRO_DIA_KEY);
    if (dataISO) {
      localStorage.setItem(FILTRO_DIA_KEY, JSON.stringify({
        data: dataISO,
        dataInicial: dataISO,
        dataFinal: dataISO,
        salvoEm: new Date().toISOString()
      }));
    }
    return anterior;
  }

  function restaurarData(anterior) {
    if (anterior === null) localStorage.removeItem(FILTRO_DIA_KEY);
    else localStorage.setItem(FILTRO_DIA_KEY, anterior);
  }

  function instalar() {
    const api = window.OM30LimpezaSala;
    if (!api?.CONFIG) return setTimeout(instalar, 150);

    api.CONFIG.versao = '2.6';
    api.CONFIG.statusLabel = 'Em Andamento';

    const ajustar = () => {
      const previewBtn = document.querySelector('#om30-preview');
      if (previewBtn && !previewBtn.dataset.om30v26) {
        const originalPreview = api.preview;
        previewBtn.dataset.om30v26 = '1';
        previewBtn.onclick = async () => {
          const dataISO = document.querySelector('#om30-limpeza-data')?.value || '';
          const anterior = salvarDataTemporaria(dataISO);
          try {
            api.CONFIG.statusLabel = 'Em Andamento';
            await originalPreview();
          } finally {
            restaurarData(anterior);
          }
        };
      }

      const executarBtn = document.querySelector('#om30-executar');
      if (executarBtn && !executarBtn.dataset.om30v26) {
        const originalExecutar = api.executar;
        executarBtn.dataset.om30v26 = '1';
        executarBtn.onclick = async () => {
          const dataISO = document.querySelector('#om30-limpeza-data')?.value || '';
          const anterior = salvarDataTemporaria(dataISO);
          try {
            api.CONFIG.statusLabel = 'Em Andamento';
            await originalExecutar();
          } finally {
            restaurarData(anterior);
          }
        };
      }

      const regra = document.querySelector('#om30-cleaner .om30-rule');
      if (regra) {
        regra.innerHTML = '<span class="interno">Filtro interno:</span> Data Inicial + Data Final + Em Andamento<br>Sem lista: usa Data + horário · somente Medicação / Em Andamento<br>Com lista: cada linha é DATA + SENHA COMPLETA (sigla + número)<br>Justificativa: “Foi realizado manualmente.”';
      }
    };

    ajustar();
    setInterval(ajustar, 800);
    console.log('[OM30 LIMPEZA] Patch v2.6 ativo: filtro Em Andamento + compatibilidade com Filtro do Dia.');
  }

  instalar();
})();