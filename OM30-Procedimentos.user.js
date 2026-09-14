// ==UserScript==
// @name         OM30 - Procedimentos
// @namespace    https://om30.com.br/
// @version      1.1.0
// @description  Carregador automático e silencioso do OM30 - Procedimentos.
// @author       Pedro Sampaio - Samp
// @match        https://guarujahomolog.saudesimples.net/ambulatorial/atencao_basica/atendimentos/*
// @match        https://guaruja.saudesimples.net/ambulatorial/atencao_basica/atendimentos/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const LOADER_VERSION = '1.1.0';
  const MANIFEST_URL =
    'https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/om30-scripts/procedimentos/manifest.json';

  const STORE = {
    CODE: 'OM30_PROCEDIMENTOS_REMOTE_APP_CODE',
    VERSION: 'OM30_PROCEDIMENTOS_REMOTE_APP_VERSION',
    SHA256: 'OM30_PROCEDIMENTOS_REMOTE_APP_SHA256'
  };

  if (globalThis.__OM30_PROCEDIMENTOS_LOADER_STARTED__) return;
  globalThis.__OM30_PROCEDIMENTOS_LOADER_STARTED__ = true;

  function requestText(url, timeout = 6000) {
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

  async function baixarApp(manifest) {
    const partes = await Promise.all(
      manifest.parts.map((url, i) =>
        requestText(`${url}?v=${encodeURIComponent(manifest.version)}&p=${i + 1}`, 8000)
      )
    );

    const base64 = partes.join('').replace(/\s+/g, '');
    return await gunzipToText(b64ToBytes(base64));
  }

  function compileApp(code) {
    return new Function('unsafeWindow', 'OM30_RUNTIME', code);
  }

  function runApp(code, version, source) {
    const fn = compileApp(code);
    fn(unsafeWindow, {
      version,
      loaderVersion: LOADER_VERSION,
      source,
      loadedAt: Date.now()
    });

    console.info(`[OM30 - Procedimentos] v${version} carregada (${source}).`);
  }

  function showFatal(err) {
    console.error('[OM30 - Procedimentos]', err);

    if (document.getElementById('om30-loader-error')) return;

    const box = document.createElement('div');
    box.id = 'om30-loader-error';
    box.textContent =
      'OM30 - Procedimentos não conseguiu carregar. Recarregue a página.';

    Object.assign(box.style, {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      zIndex: '2147483647',
      maxWidth: '340px',
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
    const cachedCode = await GM_getValue(STORE.CODE, '');
    const cachedVersion = await GM_getValue(STORE.VERSION, '');
    const cachedSha = await GM_getValue(STORE.SHA256, '');

    try {
      const manifest = parseManifest(
        await requestText(`${MANIFEST_URL}?t=${Date.now()}`, 5000)
      );

      const cacheAtual =
        cachedCode &&
        cachedVersion === manifest.version &&
        cachedSha === manifest.sha256;

      if (cacheAtual) {
        runApp(cachedCode, cachedVersion, 'cache atual');
        return;
      }

      const remoteCode = await baixarApp(manifest);
      const remoteSha = await sha256(remoteCode);

      if (remoteSha.toLowerCase() !== manifest.sha256.toLowerCase()) {
        throw new Error(
          `Integridade inválida: esperado ${manifest.sha256}, recebido ${remoteSha}`
        );
      }

      compileApp(remoteCode);
      runApp(remoteCode, manifest.version, 'GitHub');

      // Sobrescreve sempre as mesmas 3 chaves. Não acumula versões.
      await GM_setValue(STORE.CODE, remoteCode);
      await GM_setValue(STORE.VERSION, manifest.version);
      await GM_setValue(STORE.SHA256, manifest.sha256);

    } catch (err) {
      console.warn('[OM30 - Procedimentos] Atualização remota indisponível:', err);

      if (cachedCode) {
        try {
          runApp(cachedCode, cachedVersion || 'cache', 'fallback local');
          return;
        } catch (cacheErr) {
          console.error('[OM30 - Procedimentos] Cache local falhou:', cacheErr);
        }
      }

      showFatal(err);
    }
  }

  boot();
})();
