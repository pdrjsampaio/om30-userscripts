// ==UserScript==
// @name         OM30 - Profissional do Retorno
// @namespace    https://om30.com.br/
// @version      1.0.0
// @description  Exibe o profissional do primeiro atendimento nas linhas marcadas como RETORNO na fila médica.
// @author       Pedro Sampaio - Samp
// @match        https://guaruja.saudesimples.net/prontuarios/urgencia_emergencia*
// @match        https://guarujahomolog.saudesimples.net/prontuarios/urgencia_emergencia*
// @updateURL    https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Profissional-Retorno.user.js
// @downloadURL  https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Profissional-Retorno.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  if (window.__OM30_PROFISSIONAL_RETORNO_V100__) return;
  window.__OM30_PROFISSIONAL_RETORNO_V100__ = true;

  const clean = v =>
    String(v ?? '').replace(/\s+/g, ' ').trim();

  const norm = v =>
    clean(v)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toUpperCase();

  const cache = new Map();

  function acharVueFila() {
    return [...document.querySelectorAll('*')]
      .map(el => el.__vue__)
      .find(vm =>
        vm?.$options?.name === 'collection-with-search-atendimento' &&
        Array.isArray(vm?.$data?.items)
      ) || null;
  }

  function itemDaLinha(row, vm) {
    const cns = clean(row.cells?.[1]?.innerText);

    const nome = clean(
      row.cells?.[2]
        ?.querySelector('span:not(.badge)')
        ?.innerText ||
      row.cells?.[2]?.innerText.replace(/retorno/ig, '')
    );

    return vm.$data.items.find(item =>
      item &&
      String(item.prontuario_com_retorno) === 'true' &&
      (
        (cns && clean(item.codigo_cns) === cns) ||
        (nome && norm(item.nome_municipe) === norm(nome))
      )
    ) || null;
  }

  function parseAtendimento(str) {
    const m = clean(str).match(
      /^(AtendimentoPa|AtendimentoAmbulatorial)#(\d+)$/
    );

    if (!m) return null;

    return {
      tipo: m[1],
      id: m[2]
    };
  }

  function textoHtml(valor) {
    const div = document.createElement('div');
    div.innerHTML = valor || '';
    return clean(div.textContent);
  }

  function extrairNomeProfissional(doc) {
    // Fonte nativa mais direta encontrada no prontuário:
    // data-profissional-nome="<b>PROFISSIONAL:</b> NOME"
    const nomesAtributos = [
      ...doc.querySelectorAll('[data-profissional-nome]')
    ]
      .map(el =>
        textoHtml(
          el.getAttribute('data-profissional-nome')
        )
      )
      .map(v =>
        clean(
          v.replace(/^PROFISSIONAL\s*:\s*/i, '')
        )
      )
      .filter(Boolean);

    const unicosAtributos = [
      ...new Set(nomesAtributos)
    ];

    if (unicosAtributos.length === 1) {
      return unicosAtributos[0];
    }

    // Fallback para tabela "Profissional/Especialidade".
    for (const table of doc.querySelectorAll('table')) {
      const headers = [
        ...table.querySelectorAll('th')
      ];

      const indice = headers.findIndex(th =>
        norm(th.textContent)
          .includes('PROFISSIONAL/ESPECIALIDADE')
      );

      if (indice === -1) continue;

      const linhas = [
        ...table.querySelectorAll('tbody tr')
      ];

      for (const tr of linhas) {
        const cells = [...tr.cells];

        const valor = clean(
          cells[indice]?.textContent
        );

        if (!valor) continue;

        const nome = clean(
          valor.replace(
            /\s+-\s+(M[eé]dico|Enfermeiro|Cirurgi[aã]o|Fisioterapeuta|Psic[oó]logo|Nutricionista|T[eé]cnico|Auxiliar|Fonoaudi[oó]logo|Profissional).*$/i,
            ''
          )
        );

        if (nome) {
          return nome;
        }
      }
    }

    return '';
  }

  async function buscarProfissional(atendimentoStr) {
    if (cache.has(atendimentoStr)) {
      return cache.get(atendimentoStr);
    }

    const atendimento =
      parseAtendimento(atendimentoStr);

    if (!atendimento) return '';

    const promessa = (async () => {
      const url =
        '/prontuarios/new' +
        '?prontuariavel_id=' +
        encodeURIComponent(atendimento.id) +
        '&prontuariavel_type=' +
        encodeURIComponent(atendimento.tipo);

      try {
        const resp = await fetch(url, {
          credentials: 'same-origin',
          redirect: 'follow'
        });

        if (!resp.ok) {
          console.error(
            '[OM30 Retorno] HTTP',
            resp.status
          );
          return '';
        }

        const html = await resp.text();

        const doc =
          new DOMParser().parseFromString(
            html,
            'text/html'
          );

        const nome =
          extrairNomeProfissional(doc);

        console.log(
          '[OM30 Retorno]',
          atendimentoStr,
          '=>',
          nome || 'NÃO LOCALIZADO'
        );

        return nome;

      } catch (e) {
        console.error(
          '[OM30 Retorno]',
          e
        );

        return '';
      }
    })();

    cache.set(atendimentoStr, promessa);

    return promessa;
  }

  function criarInfo(row) {
    const celula = row.cells?.[2];

    if (!celula) return null;

    let info =
      celula.querySelector(
        '.om30-profissional-retorno'
      );

    if (!info) {
      info =
        document.createElement('div');

      info.className =
        'om30-profissional-retorno';

      Object.assign(info.style, {
        marginTop: '3px',
        fontSize: '11px',
        fontWeight: '700',
        color: '#4f6657'
      });

      celula.appendChild(info);
    }

    return info;
  }

  async function processar() {
    const vm = acharVueFila();

    if (!vm) return;

    const rows = [
      ...document.querySelectorAll(
        'table tbody tr.collection-row'
      )
    ];

    for (const row of rows) {
      if (
        !/\bRETORNO\b/.test(
          norm(row.innerText)
        )
      ) {
        continue;
      }

      if (
        row.dataset.om30ProfissionalCarregado === '1'
      ) {
        continue;
      }

      const item =
        itemDaLinha(row, vm);

      if (!item?.atendimento_str) {
        continue;
      }

      row.dataset.om30ProfissionalCarregado = '1';

      const info =
        criarInfo(row);

      if (!info) continue;

      info.textContent =
        '1º atendimento: consultando...';

      const nome =
        await buscarProfissional(
          item.atendimento_str
        );

      if (nome) {
        info.textContent =
          '1º atendimento: ' + nome;
      } else {
        info.textContent =
          'Profissional não localizado';

        info.style.color = '#8a5555';
      }
    }
  }

  let timer;

  new MutationObserver(() => {
    clearTimeout(timer);

    timer = setTimeout(
      processar,
      250
    );
  }).observe(
    document.documentElement,
    {
      childList: true,
      subtree: true
    }
  );

  setTimeout(processar, 500);
  setTimeout(processar, 1500);
  setTimeout(processar, 3000);

  console.info(
    '[OM30] Profissional do Retorno v1.0.0'
  );
})();
