// ==UserScript==
// @name         OM30 - Pendências do Controle de Salas
// @namespace    https://om30.com.br/
// @version      0.2.5
// @description  Mostra, durante o atendimento no Controle de Salas, somente as salas em que o paciente ainda possui pendência.
// @author       OM30
// @match        https://guaruja.saudesimples.net/*
// @updateURL    https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Pendencias-Controle-Salas.user.js
// @downloadURL  https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Pendencias-Controle-Salas.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const ID_PAINEL = 'om30-pendencias-controle-salas';

  // Fontes nativas da tela "Consulta do Controle de Salas".
  const SALAS = [
    {
      key: 'medicacao',
      nome: 'Medicação',
      endpoint: '/consultar_repousos_medicacoes/datatable_medicacoes.json'
    },
    {
      key: 'exames',
      nome: 'Exames',
      endpoint: '/consultar_repousos_medicacoes/datatable_exames.json'
    },
    {
      key: 'repouso',
      nome: 'Repouso',
      endpoint: '/consultar_repousos_medicacoes/datatable_repousos.json'
    },
    {
      key: 'radiografia',
      nome: 'Raio-X',
      endpoint: '/consultar_repousos_medicacoes/datatable_radiografias.json'
    },
    {
      key: 'enfermagem',
      nome: 'Procedimentos de Enfermagem',
      endpoint: '/consultar_repousos_medicacoes/datatable_procedimentos_enfermagem.json'
    },
    {
      key: 'gesso',
      nome: 'Gesso e Imobilização',
      endpoint: '/consultar_repousos_medicacoes/datatable_gessos_imobilizacoes.json'
    }
  ];

  const normalizar = valor => String(valor ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();

  const texto = el => String(el?.textContent ?? '')
    .replace(/\s+/g, ' ')
    .trim();

  const senhaVazia = valor => {
    const v = normalizar(valor);
    return !v || v === '-' || v === '—' || v === 'SEM SENHA';
  };

  function valorDepoisDoRotulo(regex) {
    const fortes = [...document.querySelectorAll('strong, b')];

    for (const forte of fortes) {
      if (!regex.test(texto(forte))) continue;

      const pai = forte.parentElement;
      if (!pai) continue;

      const clone = pai.cloneNode(true);
      clone.querySelectorAll('strong, b').forEach(x => x.remove());
      const valor = texto(clone);
      if (valor) return valor;
    }

    return '';
  }

  function obterSenhaDaPagina() {
    const candidatos = [...document.querySelectorAll('div, span, li, p, label')]
      .map(el => texto(el))
      .filter(t => /^SENHA\s*:/i.test(t) && t.length <= 80);

    for (const candidato of candidatos) {
      const m = candidato.match(/^SENHA\s*:\s*(.+)$/i);
      if (m && m[1]) return m[1].trim();
    }

    const pagina = String(document.body?.innerText ?? '');
    const m = pagina.match(/(?:^|\n)\s*SENHA\s*:\s*([^\n\r]+)/i);
    return m ? m[1].trim() : '';
  }

  function obterIdentidade() {
    return {
      nome: valorDepoisDoRotulo(/^MUN[IÍ]CIPE$/i),
      nascimento: valorDepoisDoRotulo(/^DATA DE NASCIMENTO$/i),
      medico: valorDepoisDoRotulo(/^M[EÉ]DICO RESPONS[AÁ]VEL$/i),
      senha: obterSenhaDaPagina()
    };
  }

  function detectarSalaAtual() {
    const seletores = [
      ['medicacao', 'input[name^="encaminhamento_medicacao["], form.encaminhamento_medicacao'],
      ['exames', 'input[name^="encaminhamento_exame["], form[id^="edit_encaminhamento_exame_"]'],
      ['radiografia', 'input[name^="encaminhamento_radiografia["], form[id*="encaminhamento_radiografia"]'],
      ['enfermagem', 'input[name^="encaminhamento_procedimento_enfermagem["], input[name^="encaminhamento_procedimentoenfermagem["], form[id*="procedimento_enfermagem"], form[id*="procedimentoenfermagem"]'],
      ['repouso', 'input[name^="encaminhamento_repouso["], form[id*="encaminhamento_repouso"]'],
      ['gesso', 'input[name^="encaminhamento_gesso_imobilizacao["], input[name^="encaminhamento_gessoimobilizacao["], form[id*="gesso_imobilizacao"], form[id*="gessoimobilizacao"]']
    ];

    for (const [key, seletor] of seletores) {
      if (document.querySelector(seletor)) return key;
    }

    const path = location.pathname.toLowerCase();
    if (path.startsWith('/aplicacoes_medicamentos/')) return 'medicacao';
    if (path.startsWith('/encaminhamentos_exames/')) return 'exames';

    return null;
  }

  function ehTelaDeAtendimentoDoControle() {
    if (location.pathname.startsWith('/consultar_repousos_medicacoes')) return false;

    const identidade = obterIdentidade();
    if (!identidade.nome || !identidade.nascimento) return false;

    if (document.querySelector('.salvar-encaminhamento-controle-salas')) return true;
    if (detectarSalaAtual()) return true;

    return false;
  }

  function parametrosDataTable(busca) {
    const p = new URLSearchParams();
    p.set('sEcho', '1');
    p.set('iColumns', '7');
    p.set('sColumns', '');
    p.set('iDisplayStart', '0');
    p.set('iDisplayLength', '100');
    p.set('sSearch', busca || '');
    p.set('bRegex', 'false');

    for (let i = 0; i < 7; i++) {
      p.set(`mDataProp_${i}`, String(i));
      p.set(`sSearch_${i}`, '');
      p.set(`bRegex_${i}`, 'false');
      p.set(`bSearchable_${i}`, 'true');
      p.set(`bSortable_${i}`, 'false');
    }

    p.set('iSortCol_0', '0');
    p.set('sSortDir_0', 'desc');
    p.set('iSortingCols', '1');
    return p;
  }

  async function buscarSala(sala, busca) {
    const url = `${sala.endpoint}?${parametrosDataTable(busca).toString()}`;
    const resp = await fetch(url, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store'
    });

    if (!resp.ok) {
      throw new Error(`${sala.nome}: HTTP ${resp.status}`);
    }

    const json = await resp.json();
    const linhas = Array.isArray(json?.aaData) ? json.aaData : [];

    return linhas.map(linha => ({
      sala: sala.key,
      salaNome: sala.nome,
      data: String(linha?.[0] ?? '').trim(),
      hora: String(linha?.[1] ?? '').trim(),
      nascimento: String(linha?.[2] ?? '').trim(),
      nome: String(linha?.[3] ?? '').trim(),
      medico: String(linha?.[4] ?? '').trim(),
      senha: String(linha?.[5] ?? '').trim(),
      status: String(linha?.[6] ?? '').trim()
    }));
  }

  function correspondeAoPaciente(linha, identidade) {
    if (normalizar(linha.nome) !== normalizar(identidade.nome)) return false;

    if (
      identidade.nascimento &&
      linha.nascimento &&
      normalizar(linha.nascimento) !== normalizar(identidade.nascimento)
    ) return false;

    if (
      identidade.medico &&
      linha.medico &&
      normalizar(linha.medico) !== normalizar(identidade.medico)
    ) return false;

    if (
      !senhaVazia(identidade.senha) &&
      !senhaVazia(linha.senha) &&
      normalizar(linha.senha) !== normalizar(identidade.senha)
    ) return false;

    return true;
  }

  function timestampLinha(linha) {
    const m = String(linha.data).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    const h = String(linha.hora).match(/^(\d{2}):(\d{2})/);
    if (!m || !h) return 0;

    return new Date(
      Number(m[3]),
      Number(m[2]) - 1,
      Number(m[1]),
      Number(h[1]),
      Number(h[2]),
      0,
      0
    ).getTime();
  }

  function statusEh(linha, valor) {
    return normalizar(linha.status) === normalizar(valor);
  }

  function escolherEpisodio(linhas, identidade, salaAtual) {
    const compativeis = linhas.filter(l => correspondeAoPaciente(l, identidade));
    if (!compativeis.length) return null;

    let ancoras = salaAtual
      ? compativeis.filter(l => l.sala === salaAtual)
      : [];

    if (ancoras.length) {
      const andamento = ancoras.filter(l => statusEh(l, 'Em Andamento'));
      const espera = ancoras.filter(l => statusEh(l, 'Em Espera'));
      ancoras = andamento.length ? andamento : (espera.length ? espera : ancoras);
    } else {
      ancoras = compativeis;
    }

    ancoras.sort((a, b) => timestampLinha(b) - timestampLinha(a));
    const ancora = ancoras[0];
    if (!ancora) return null;

    const episodio = compativeis.filter(l =>
      l.data === ancora.data &&
      l.hora === ancora.hora
    );

    return {
      ancora,
      linhas: episodio,
      ambiguo: ancoras.length > 1 && timestampLinha(ancoras[0]) === timestampLinha(ancoras[1])
    };
  }

  function statusAtivo(status) {
    const s = normalizar(status);
    return !/CONCLUI|FINALIZ|CANCEL/.test(s);
  }

  function instalarCss() {
    if (document.getElementById('om30-pendencias-controle-salas-css')) return;

    const style = document.createElement('style');
    style.id = 'om30-pendencias-controle-salas-css';
    style.textContent = `
      #${ID_PAINEL}{
        margin:0 0 18px 0;
        border:1px solid #dfe6ea;
        border-radius:10px;
        background:#fff;
        box-shadow:0 3px 12px rgba(38,57,66,.08);
        font-family:"Segoe UI",Arial,Helvetica,sans-serif;
        overflow:hidden;
      }
      #${ID_PAINEL} .om30cs-head{
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:14px;
        padding:13px 15px;
        background:#f8fafb;
        border-bottom:1px solid #e8edef;
      }
      #${ID_PAINEL} .om30cs-heading{
        display:flex;
        align-items:center;
        gap:10px;
        min-width:0;
      }
      #${ID_PAINEL} .om30cs-mark{
        width:4px;
        height:30px;
        border-radius:999px;
        background:#c62828;
        flex:0 0 auto;
      }
      #${ID_PAINEL} .om30cs-title-wrap{
        min-width:0;
      }
      #${ID_PAINEL} .om30cs-title{
        color:#263942;
        font-size:14px;
        line-height:1.2;
        font-weight:700;
        letter-spacing:.1px;
      }
      #${ID_PAINEL} .om30cs-subtitle{
        margin-top:2px;
        color:#7a8a92;
        font-size:11px;
        line-height:1.25;
      }
      #${ID_PAINEL} .om30cs-body{
        padding:14px 15px 13px;
      }
      #${ID_PAINEL} .om30cs-meta{
        display:flex;
        flex-wrap:wrap;
        gap:7px;
        margin-bottom:12px;
      }
      #${ID_PAINEL} .om30cs-chip{
        display:inline-flex;
        align-items:center;
        min-height:24px;
        padding:3px 8px;
        border:1px solid #e1e7ea;
        border-radius:999px;
        background:#f8fafb;
        color:#60727b;
        font-size:11px;
        line-height:1.2;
      }
      #${ID_PAINEL} .om30cs-section-head{
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:12px;
        margin-bottom:8px;
      }
      #${ID_PAINEL} .om30cs-note{
        margin:0 0 10px 0;
        padding:9px 11px;
        border:1px solid #ead9d7;
        border-left:3px solid #c62828;
        border-radius:8px;
        background:#fffafa;
        color:#4f626b;
        font-size:11px;
        line-height:1.4;
      }
      #${ID_PAINEL} .om30cs-note strong{
        color:#a12622;
        font-weight:700;
      }
      #${ID_PAINEL} .om30cs-label{
        color:#263942;
        font-size:13px;
        font-weight:700;
      }
      #${ID_PAINEL} .om30cs-count{
        display:inline-flex;
        align-items:center;
        justify-content:center;
        min-width:24px;
        height:24px;
        padding:0 7px;
        border-radius:999px;
        background:#eef2f4;
        color:#52666f;
        font-size:11px;
        font-weight:700;
      }
      #${ID_PAINEL} .om30cs-list{
        display:grid;
        gap:7px;
      }
      #${ID_PAINEL} .om30cs-row{
        display:flex;
        align-items:center;
        gap:10px;
        min-height:42px;
        padding:9px 11px;
        border:1px solid #e4eaed;
        border-radius:8px;
        background:#fff;
      }
      #${ID_PAINEL} .om30cs-dot{
        width:9px;
        height:9px;
        border-radius:50%;
        background:#c62828;
        box-shadow:0 0 0 3px rgba(198,40,40,.10);
        flex:0 0 auto;
      }
      #${ID_PAINEL} .om30cs-room{
        color:#2d414a;
        font-size:13px;
        font-weight:600;
        line-height:1.3;
      }
      #${ID_PAINEL} .om30cs-empty{
        padding:11px 12px;
        border:1px solid #e3e9ec;
        border-radius:8px;
        background:#f8fafb;
        color:#60727b;
        font-size:13px;
      }
      #${ID_PAINEL} .om30cs-error{
        padding:10px 12px;
        border:1px solid #efd2d0;
        border-radius:8px;
        background:#fff8f7;
        color:#a12622;
        font-size:13px;
      }
      #${ID_PAINEL} .om30cs-foot{
        margin-top:10px;
        color:#98a5aa;
        font-size:10px;
        text-align:right;
      }
    `;
    document.head.appendChild(style);
  }

  function garantirPainel() {
    let painel = document.getElementById(ID_PAINEL);
    if (painel) return painel;

    instalarCss();

    painel = document.createElement('div');
    painel.id = ID_PAINEL;
    painel.innerHTML = `
      <div class="om30cs-head">
        <div class="om30cs-heading">
          <span class="om30cs-mark"></span>
          <div class="om30cs-title-wrap">
            <div class="om30cs-title">Salas pendentes do munícipe</div>
          </div>
        </div>
      </div>
      <div class="om30cs-body">
        <div class="om30cs-empty">Carregando pendências...</div>
      </div>
    `;

    const pageContent = document.querySelector('.page-content');
    const contentBox = pageContent?.querySelector('.content-box');

    if (contentBox?.parentElement) {
      contentBox.parentElement.insertBefore(painel, contentBox);
    } else if (pageContent) {
      pageContent.prepend(painel);
    } else {
      document.body.prepend(painel);
    }

    return painel;
  }

  function escaparHtml(valor) {
    return String(valor ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function renderizarCarregando() {
    const painel = garantirPainel();
    const body = painel.querySelector('.om30cs-body');
    body.innerHTML = '<div class="om30cs-empty">Carregando pendências...</div>';
  }

  function renderizarErro(msg) {
    const painel = garantirPainel();
    const body = painel.querySelector('.om30cs-body');
    body.innerHTML = `
      <div class="om30cs-error">${escaparHtml(msg)}</div>
      <div class="om30cs-foot">Nenhuma decisão de fluxo foi tomada pelo script.</div>
    `;
  }

  function renderizarResultado(identidade, salaAtual, episodio) {
    const painel = garantirPainel();
    const body = painel.querySelector('.om30cs-body');

    if (!episodio) {
      renderizarErro('Não foi possível localizar com segurança este atendimento na Consulta do Controle de Salas.');
      return;
    }

    const pendencias = episodio.linhas
      .filter(l => statusAtivo(l.status))
      .filter(l => !salaAtual || l.sala !== salaAtual)
      .sort((a, b) => {
        const ordem = ['medicacao', 'exames', 'repouso', 'radiografia', 'enfermagem', 'gesso'];
        return ordem.indexOf(a.sala) - ordem.indexOf(b.sala);
      });

    const senha = episodio.ancora.senha || identidade.senha || '—';

    let html = `
      <div class="om30cs-meta">
        <span class="om30cs-chip">${escaparHtml(episodio.ancora.data)} às ${escaparHtml(episodio.ancora.hora)}</span>
        <span class="om30cs-chip">Senha: ${escaparHtml(senha || '—')}</span>
      </div>
      <div class="om30cs-note">
        <strong>Atenção:</strong> a ordem é definida pelo médico e pode diferir da lista abaixo. Oriente o munícipe a acompanhar o painel de senhas.
      </div>
      <div class="om30cs-section-head">
        <div class="om30cs-label">Ainda precisa passar por</div>
        <div class="om30cs-count">${pendencias.length}</div>
      </div>
    `;

    if (!pendencias.length) {
      html += '<div class="om30cs-empty">Nenhuma outra sala pendente identificada.</div>';
    } else {
      html += '<div class="om30cs-list">';
      for (const p of pendencias) {
        html += `
          <div class="om30cs-row">
            <span class="om30cs-dot"></span>
            <div class="om30cs-room">${escaparHtml(p.salaNome)}</div>
          </div>
        `;
      }
      html += '</div>';
    }

    if (episodio.ambiguo) {
      html += `
        <div class="om30cs-foot">Confira os dados: há mais de um registro no mesmo horário.</div>
      `;
    }

    body.innerHTML = html;
  }

  let atualizando = false;

  async function atualizar() {
    if (atualizando) return;
    if (!ehTelaDeAtendimentoDoControle()) return;

    atualizando = true;
    renderizarCarregando();

    try {
      const identidade = obterIdentidade();
      const salaAtual = detectarSalaAtual();

      if (!identidade.nome || !identidade.nascimento) {
        throw new Error('Não consegui identificar o munícipe e a data de nascimento nesta tela.');
      }

      const resultados = await Promise.allSettled(
        SALAS.map(sala => buscarSala(sala, identidade.nome))
      );

      const linhas = [];
      const erros = [];

      resultados.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          linhas.push(...r.value);
        } else {
          erros.push(`${SALAS[i].nome}: ${r.reason?.message || r.reason}`);
        }
      });

      if (!linhas.length && erros.length) {
        throw new Error(`Falha ao consultar o Controle de Salas (${erros.join(' | ')})`);
      }

      const episodio = escolherEpisodio(linhas, identidade, salaAtual);
      renderizarResultado(identidade, salaAtual, episodio);
    } catch (e) {
      console.error('[OM30 Controle de Salas]', e);
      renderizarErro(e?.message || String(e));
    } finally {
      atualizando = false;
    }
  }

  function iniciar() {
    if (!ehTelaDeAtendimentoDoControle()) return;

    garantirPainel();
    atualizar();
  }

  iniciar();
})();