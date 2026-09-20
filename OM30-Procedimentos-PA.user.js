// ==UserScript==
// @name         OM30 - Controle de Salas - Procedimentos
// @namespace    https://om30.com.br/
// @version      1.0.0
// @description  Carregador automático do Controle de Salas - Procedimentos.
// @author       Pedro Sampaio - Samp
// @match        https://guaruja.saudesimples.net/prontuarios/*
// @match        https://guarujahomolog.saudesimples.net/prontuarios/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const APP_URL =
    'https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/om30-scripts/procedimentos-pa/app.js';

  function executar(codigo) {
    const fn = new Function(
      'window',
      'document',
      'localStorage',
      'fetch',
      'getComputedStyle',
      'Event',
      'Node',
      'CSS',
      'URLSearchParams',
      'setTimeout',
      'clearTimeout',
      codigo + '\n//# sourceURL=OM30-Procedimentos-PA-remote.js'
    );

    fn(
      unsafeWindow,
      document,
      unsafeWindow.localStorage,
      unsafeWindow.fetch.bind(unsafeWindow),
      unsafeWindow.getComputedStyle.bind(unsafeWindow),
      unsafeWindow.Event,
      unsafeWindow.Node,
      unsafeWindow.CSS,
      unsafeWindow.URLSearchParams,
      unsafeWindow.setTimeout.bind(unsafeWindow),
      unsafeWindow.clearTimeout.bind(unsafeWindow)
    );
  }

  GM_xmlhttpRequest({
    method: 'GET',
    url: APP_URL + '?_=' + Date.now(),
    headers: {
      'Cache-Control': 'no-cache'
    },
    onload(response) {
      if (response.status < 200 || response.status >= 300) {
        console.error('[OM30 PA] Falha ao carregar atualização:', response.status);
        return;
      }

      try {
        executar(response.responseText);
        console.info('[OM30 PA] Aplicação carregada diretamente do GitHub.');
      } catch (erro) {
        console.error('[OM30 PA] Erro ao executar aplicação remota:', erro);
      }
    },
    onerror(erro) {
      console.error('[OM30 PA] Não foi possível acessar o GitHub.', erro);
    }
  });
})();
