// ==UserScript==
// @name         OM30 - WhatsApp → GLPI
// @namespace    om30
// @version      0.9.6
// @description  Carregador automático e silencioso do OM30 - WhatsApp → GLPI.
// @author       Pedro Sampaio - Samp
// @match        https://web.whatsapp.com/*
// @match        https://suporte.om30.cloud/*
// @updateURL    https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-WhatsApp-GLPI.user.js
// @downloadURL  https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-WhatsApp-GLPI.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        unsafeWindow
// @connect      raw.githubusercontent.com
// @connect      suporte.om30.cloud
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const LOADER_VERSION = '0.9.6';
  const MANIFEST_URL =
    'https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/om30-scripts/whatsapp-glpi/manifest.json';

  const STORE = {
    CODE: 'OM30_WHATSAPP_GLPI_REMOTE_APP_CODE',
    VERSION: 'OM30_WHATSAPP_GLPI_REMOTE_APP_VERSION',
    SHA256: 'OM30_WHATSAPP_GLPI_REMOTE_APP_SHA256'
  };

  if (globalThis.__OM30_WHATSAPP_GLPI_LOADER_STARTED__) return;
  globalThis.__OM30_WHATSAPP_GLPI_LOADER_STARTED__ = true;

  function requestText(url, timeout = 8000) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout,
        headers: {
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        },
        onload: r => {
          if (r.status >= 200 && r.status < 300) resolve(r.responseText);
          else reject(new Error(`HTTP ${r.status} em ${url}`));
        },
        ontimeout: () => reject(new Error(`Timeout em ${url}`)),
        onerror: () => reject(new Error(`Falha de rede em ${url}`))
      });
    });
  }

  async function sha256(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)]
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  function parseManifest(text) {
    const m = JSON.parse(text);

    if (!m || m.schema !== 2) throw new Error('Manifesto OM30 inválido.');
    if (!/^\d+\.\d+\.\d+$/.test(String(m.version || '')))
      throw new Error('Versão remota inválida.');
    if (m.format !== 'gzip-base64-parts')
      throw new Error('Formato remoto não suportado.');
    if (!Array.isArray(m.parts) || !m.parts.length)
      throw new Error('Partes remotas não informadas.');
    if (!/^[a-f0-9]{64}$/i.test(String(m.sha256 || '')))
      throw new Error('Hash remoto inválido.');

    for (const url of m.parts) {
      if (!/^https:\/\/raw\.githubusercontent\.com\//.test(String(url)))
        throw new Error('URL de parte inválida.');
    }

    return m;
  }

  function b64ToBytes(base64) {
    const raw = atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  }

  async function gunzipToText(bytes) {
    if (typeof DecompressionStream !== 'function')
      throw new Error('Navegador sem suporte à descompactação automática.');

    const stream = new Blob([bytes])
      .stream()
      .pipeThrough(new DecompressionStream('gzip'));

    return await new Response(stream).text();
  }

  async function downloadApp(manifest) {
    const chunks = await Promise.all(
      manifest.parts.map((url, i) =>
        requestText(`${url}?v=${encodeURIComponent(manifest.version)}&p=${i + 1}`, 10000)
      )
    );

    const merged = chunks.join('').replace(/\s+/g, '');
    return await gunzipToText(b64ToBytes(merged));
  }

  function compileApp(code) {
    return new Function(
      'GM_getValue',
      'GM_setValue',
      'GM_deleteValue',
      'GM_xmlhttpRequest',
      'GM_openInTab',
      'unsafeWindow',
      'OM30_RUNTIME',
      code
    );
  }

  function runApp(code, version, source) {
    const fn = compileApp(code);
    fn(
      GM_getValue,
      GM_setValue,
      GM_deleteValue,
      GM_xmlhttpRequest,
      GM_openInTab,
      unsafeWindow,
      {
        version,
        loaderVersion: LOADER_VERSION,
        source,
        loadedAt: Date.now()
      }
    );

    console.info(`[OM30 - WhatsApp → GLPI] v${version} carregada (${source}).`);
  }

  function showFatal(err) {
    console.error('[OM30 - WhatsApp → GLPI]', err);

    if (document.getElementById('om30-whatsapp-glpi-loader-error')) return;

    const box = document.createElement('div');
    box.id = 'om30-whatsapp-glpi-loader-error';
    box.textContent =
      'OM30 - WhatsApp → GLPI não conseguiu carregar. Recarregue a página.';

    Object.assign(box.style, {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      zIndex: '2147483647',
      maxWidth: '360px',
      padding: '10px 12px',
      borderRadius: '10px',
      background: '#8B1E1E',
      color: '#fff',
      font: '600 12px/1.4 Segoe UI,Arial,sans-serif',
      boxShadow: '0 8px 25px rgba(0,0,0,.25)'
    });

    document.body.appendChild(box);
  }

  async function boot() {
    const cachedCode = GM_getValue(STORE.CODE, '');
    const cachedVersion = GM_getValue(STORE.VERSION, '');
    const cachedSha = GM_getValue(STORE.SHA256, '');

    try {
      const manifest = parseManifest(
        await requestText(`${MANIFEST_URL}?t=${Date.now()}`, 6000)
      );

      const cacheCurrent =
        cachedCode &&
        cachedVersion === manifest.version &&
        cachedSha === manifest.sha256;

      if (cacheCurrent) {
        runApp(cachedCode, cachedVersion, 'cache atual');
        return;
      }

      const remoteCode = await downloadApp(manifest);
      const remoteSha = await sha256(remoteCode);

      if (remoteSha.toLowerCase() !== manifest.sha256.toLowerCase()) {
        throw new Error(
          `Integridade inválida: esperado ${manifest.sha256}, recebido ${remoteSha}`
        );
      }

      compileApp(remoteCode);
      runApp(remoteCode, manifest.version, 'GitHub');

      GM_setValue(STORE.CODE, remoteCode);
      GM_setValue(STORE.VERSION, manifest.version);
      GM_setValue(STORE.SHA256, manifest.sha256);

    } catch (err) {
      console.warn('[OM30 - WhatsApp → GLPI] Atualização remota indisponível:', err);

      if (cachedCode) {
        try {
          runApp(cachedCode, cachedVersion || 'cache', 'fallback local');
          return;
        } catch (cacheErr) {
          console.error('[OM30 - WhatsApp → GLPI] Cache local falhou:', cacheErr);
        }
      }

      showFatal(err);
    }
  }

  boot();
})();
