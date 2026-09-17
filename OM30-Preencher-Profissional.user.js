// ==UserScript==
// @name         Preencher Profissional - Saúde Simples
// @namespace    saudesimples-guaruja
// @version      4.19
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
// @require      https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js
// @require      https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/om30-scripts/preencher-profissional/OM30-Preencher-Profissional.core.js?v=4.19
// ==/UserScript==

// O código completo e legível está no arquivo @require acima.
// Este arquivo permanece pequeno apenas para o Tampermonkey controlar versão e atualização automática.
