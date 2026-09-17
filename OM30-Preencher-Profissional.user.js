// ==UserScript==
// @name         Preencher Profissional - Saúde Simples
// @namespace    saudesimples-guaruja
// @version      4.18
// @updateURL    https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Preencher-Profissional.user.js
// @downloadURL  https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Preencher-Profissional.user.js
// @description  Lê a Ficha de Cadastro (PDF AcroForm), preenche o profissional, deduz órgão de classe pelo CBO e consulta CNS/CNES pelo CPF. Atualização automática via GitHub.
// @author       Pedro Sampaio
// @match        https://guaruja.saudesimples.net/profissionais/new*
// @match        https://*.saudesimples.net/profissionais/new*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      cnes.datasus.gov.br
// @connect      cdnjs.cloudflare.com
// @connect      raw.githubusercontent.com
// @require      https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js
// ==/UserScript==

(async function () {
  'use strict';

  const BASE = 'https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/om30-scripts/preencher-profissional/';
  const PARTES = [
    'core.part1.b64',
    'core.part2.b64',
    'core.part3.b64',
    'core.part4.b64'
  ];

  function baixarTexto(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 20000,
        headers: { 'Cache-Control': 'no-cache' },
        onload: r => {
          if (r.status >= 200 && r.status < 300) resolve(r.responseText || '');
          else reject(new Error('HTTP ' + r.status + ' ao carregar ' + url));
        },
        onerror: () => reject(new Error('Falha de rede ao carregar ' + url)),
        ontimeout: () => reject(new Error('Timeout ao carregar ' + url))
      });
    });
  }

  try {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('Este navegador não suporta DecompressionStream.');
    }

    const partes = await Promise.all(PARTES.map(p => baixarTexto(BASE + p)));
    const pacote = partes.join('').replace(/\s+/g, '');
    const bytes = Uint8Array.from(atob(pacote), c => c.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    const codigo = await new Response(stream).text();
    (0, eval)(codigo);
  } catch (e) {
    console.error('[OM30 · Preencher Profissional] Falha ao carregar o script:', e);
  }
})();
