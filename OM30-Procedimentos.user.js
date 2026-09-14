// ==UserScript==
// @name         OM30 - Procedimentos
// @namespace    https://om30.com.br/
// @version      1.0.0
// @description  Carregador automático e silencioso do OM30 - Procedimentos.
// @author       Pedro Sampaio - Samp
// @match        https://guarujahomolog.saudesimples.net/ambulatorial/atencao_basica/atendimentos/*
// @match        https://guaruja.saudesimples.net/ambulatorial/atencao_basica/atendimentos/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        unsafeWindow
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  const LOADER_VERSION = '1.0.0';

  const MANIFEST_URL =
    'https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/om30-scripts/procedimentos/manifest.json';

  const STORE = {
    CODE: 'OM30_PROCEDIMENTOS_REMOTE_APP_CODE',
    VERSION: 'OM30_PROCEDIMENTOS_REMOTE_APP_VERSION',
    SHA256: 'OM30_PROCEDIMENTOS_REMOTE_APP_SHA256'
  };

  // Impede duas inicializações no mesmo carregamento.
  if (globalThis.__OM30_PROCEDIMENTOS_LOADER_STARTED__) return;
  globalThis.__OM30_PROCEDIMENTOS_LOADER_STARTED__ = true;

  function requestText(url, timeout = 5000) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout,
        headers: {
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        },
        onload: response => {
          if (response.status >= 200 && response.status < 300) {
            resolve(response.responseText);
          } else {
            reject(new Error(`HTTP ${response.status} em ${url}`));
          }
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

    if (!m || m.schema !== 1) {
      throw new Error('Manifesto OM30 inválido.');
    }

    if (!/^\d+\.\d+\.\d+$/.test(String(m.version || ''))) {
      throw new Error('Versão remota inválida.');
    }

    if (!/^https:\/\/raw\.githubusercontent\.com\//.test(String(m.app_url || ''))) {
      throw new Error('URL do aplicativo remoto inválida.');
    }

    if (!/^[a-f0-9]{64}$/i.test(String(m.sha256 || ''))) {
      throw new Error('Hash remoto inválido.');
    }

    return m;
  }

  function compileApp(code) {
    // Compilar antes de substituir o cache evita gravar JS com erro de sintaxe.
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

    console.info(
      `[OM30 - Procedimentos] v${version} carregada (${source}).`
    );
  }

  function showFatal(message) {
    console.error('[OM30 - Procedimentos]', message);

    const id = 'om30-loader-error';
    if (document.getElementById(id)) return;

    const box = document.createElement('div');
    box.id = id;
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
      font: '600 12px/1.4 Segoe UI, Arial, sans-serif',
      boxShadow: '0 8px 25px rgba(0,0,0,.25)'
    });

    document.body.appendChild(box);
  }

  async function boot() {
    const cachedCode = await GM_getValue(STORE.CODE, '');
    const cachedVersion = await GM_getValue(STORE.VERSION, '');
    const cachedSha = await GM_getValue(STORE.SHA256, '');

    try {
      // Cache-busting só no manifesto. app.js só baixa quando a versão/hash muda.
      const manifestText = await requestText(
        `${MANIFEST_URL}?t=${Date.now()}`,
        4000
      );

      const manifest = parseManifest(manifestText);

      const cacheAtual =
        cachedCode &&
        cachedVersion === manifest.version &&
        cachedSha === manifest.sha256;

      if (cacheAtual) {
        runApp(cachedCode, cachedVersion, 'cache atual');
        return;
      }

      const remoteCode = await requestText(
        `${manifest.app_url}?v=${encodeURIComponent(manifest.version)}`,
        8000
      );

      const remoteSha = await sha256(remoteCode);

      if (remoteSha.toLowerCase() !== manifest.sha256.toLowerCase()) {
        throw new Error(
          `Integridade inválida: esperado ${manifest.sha256}, recebido ${remoteSha}`
        );
      }

      // Sintaxe é verificada antes de mexer no armazenamento.
      compileApp(remoteCode);

      // Executa a nova versão primeiro.
      runApp(remoteCode, manifest.version, 'GitHub');

      // Só depois de carregada com sucesso substitui a cópia anterior.
      // As mesmas chaves são sobrescritas: NÃO acumula versões antigas.
      await GM_setValue(STORE.CODE, remoteCode);
      await GM_setValue(STORE.VERSION, manifest.version);
      await GM_setValue(STORE.SHA256, manifest.sha256);

    } catch (err) {
      console.warn(
        '[OM30 - Procedimentos] Atualização remota indisponível:',
        err
      );

      // Sem internet/GitHub: usa SOMENTE a cópia atual salva.
      if (cachedCode) {
        try {
          runApp(cachedCode, cachedVersion || 'cache', 'fallback local');
          return;
        } catch (cacheErr) {
          console.error(
            '[OM30 - Procedimentos] Cache local também falhou:',
            cacheErr
          );
        }
      }

      showFatal(err?.message || String(err));
    }
  }

  boot();
})();
