// ==UserScript==
// @name         OM30 - Baixa Rápida do Controle de Salas
// @namespace    om30-guaruja
// @version      0.2.4
// @description  Enfermagem/técnicos: aba "Pendências" com todos os pacientes pendentes e baixa de TUDO do paciente (Medicação, Exames, Enfermagem) pela API, com o faturamento (BPA) uma linha por procedimento; na ficha, baixa de tudo de uma vez (marca o que fez, cancela o que não fez com motivo, salva). Usa os próprios botões do Saúde Simples: faturamento (BPA), estoque e senha seguem o fluxo do sistema; a volta para o médico é a que o médico marcou.
// @author       Pedro Sampaio
// @match        https://guaruja.saudesimples.net/*
// @match        https://guarujahomolog.saudesimples.net/*
// @updateURL    https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Baixa-Rapida-Controle-Salas.user.js
// @downloadURL  https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Baixa-Rapida-Controle-Salas.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

// Como o sistema faz (captura de 18/11 na tela /aplicacoes_medicamentos/new):
//  - Aplicar (.btn-atendimento-prescricao-interna-confirmar-aplicacao): espera 500 ms (um timer único para a
//    tela inteira: clicar em dois seguidos cancela o primeiro), chama alterarProcedimentoParametrizadoMedicacao
//    (busca o procedimento pela via e lança o BPA automático) e marca pendente=true, cancelada=false,
//    para_atendimento=true, para_cancelamento=false. Produto com data-baixa-estoque abre almoxarifado/quantidade.
//  - Cancelar: mesmo timer de 500 ms + janela "Motivo do Cancelamento" (swal com textarea).
// Por isso aqui cada item é clicado UM POR VEZ, esperando o campo mudar antes do próximo.
(function () {
  'use strict';
  if (window.__OM30_BAIXA_RAPIDA__) return;
  window.__OM30_BAIXA_RAPIDA__ = true;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
  const norm = s => clean(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const visivel = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const ehSim = el => /^(true|1)$/i.test(String(el?.value ?? '').trim());
  async function esperar(fn, ms = 6000, passo = 60) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(passo); }
    return fn();
  }

  // ---------- salas ----------
  // Cada sala: como achar o formulário, o botão de "feito", o de cancelar e os campos que confirmam.
  const SALAS = {
    medicacao: {
      nome: 'Medicação', verbo: 'Aplicar', feito: 'aplicada',
      form: 'form[id^="edit_encaminhamento_medicacao_"], form.encaminhamento_medicacao',
      btnFez: '.btn-atendimento-prescricao-interna-confirmar-aplicacao',
      btnCancelar: '.btn-atendimento-prescricao-interna-cancelada',
      fez: it => ehSim(campo(it, '_para_atendimento')),
      cancelou: it => ehSim(campo(it, '_para_cancelamento')) || ehSim(campo(it, '_cancelada')),
      motivos: ['Paciente recusou a medicação.', 'Paciente não compareceu à sala de medicação após ser chamado.', 'Medicação em falta na unidade no momento.', 'Medicação já administrada anteriormente.', 'Prescrição suspensa/alterada pelo médico.', 'Difícil acesso venoso.'],
    },
    exames: {
      nome: 'Exames', verbo: 'Coletar', feito: 'coletado',
      form: 'form[id^="edit_encaminhamento_exame_"]',
      btnFez: '.btn-coletar-exame',
      btnCancelar: '.btn-cancelar-exame',
      fez: it => ehSim(campo(it, '_coletado')),
      cancelou: it => ehSim(campo(it, '_cancelado')),
      motivos: ['Exame realizado manualmente.', 'Paciente deixou a unidade antes da realização do exame.', 'Paciente recusou a realização do exame.'],
    },
    enfermagem: {
      nome: 'Procedimentos de Enfermagem', verbo: 'Realizar', feito: 'realizado',
      form: 'form[id*="procedimento_enfermagem"], form[id*="procedimentoenfermagem"]',
      btnFez: null,   // botão "Realizar" achado pelo texto (classe ainda não capturada)
      btnCancelar: '.btn-cancelar-procedimento-enfermagem',
      fez: it => ehSim(campo(it, '_realizado')) || ehSim(campo(it, '_realizada')) || ehSim(campo(it, '_para_atendimento')),
      cancelou: it => ehSim(campo(it, '_cancelado')) || ehSim(campo(it, '_cancelada')) || ehSim(campo(it, '_para_cancelamento')),
      motivos: ['Procedimento realizado manualmente.', 'Paciente deixou a unidade antes da realização do procedimento.', 'Paciente recusou a realização do procedimento.'],
    },
    raio_x: {
      nome: 'Raio-X', verbo: 'Realizar', feito: 'realizado',
      form: 'form[id*="encaminhamento_radiografia"]',
      btnFez: null,
      btnCancelar: '.btn-cancelar-radiografia',
      fez: it => ehSim(campo(it, '_realizado')) || ehSim(campo(it, '_realizada')),
      cancelou: it => ehSim(campo(it, '_cancelado')) || ehSim(campo(it, '_cancelada')),
      motivos: ['Raio-X realizado manualmente.', 'Paciente deixou a unidade antes da realização do Raio-X.', 'Paciente recusou a realização do Raio-X.'],
    },
  };
  function campo(item, sufixo) { return item.querySelector(`input[id$="${sufixo}"], input[name$="[${sufixo.replace(/^_/, '')}]"]`); }
  const desligado = b => !b || b.matches('[disabled]') || b.getAttribute('disabled') === 'disabled' || b.classList.contains('desativado');

  function salaDaFicha() {
    for (const [k, s] of Object.entries(SALAS)) {
      const f = document.querySelector(s.form);
      if (f && f.querySelector('.item-encaminhamento-controle-salas') && document.querySelector('.salvar-encaminhamento-controle-salas')) return { k, s, form: f };
    }
    return null;
  }
  function botaoFez(sala, item) {
    if (sala.s.btnFez) return item.querySelector(sala.s.btnFez);
    return [...item.querySelectorAll('a.btn,button.btn,a[class*="btn-"],button')]
      .find(b => !b.matches(sala.s.btnCancelar) && /realiz|aplicar|coletar/i.test(b.textContent || b.value || '')) || null;
  }
  function nomeItem(item, i) {
    const t = clean(item.innerText || '');
    const m = t.match(/\b(?:Produto|Exame|Procedimento|Radiografia)\s+(.+?)(?=\s+(?:Situa[cç][aã]o|Posologia|Via\s+de|Unidade\s+de|Observa[cç][aã]o|Quantidade|Aplicar|Coletar|Realizar|Cancelar|Justificativa)\b|$)/i);
    if (m?.[1]) return clean(m[1]).slice(0, 120);
    return clean(t.replace(/\b(Aplicar|Coletar|Realizar|Cancelar)\b/gi, '')).slice(0, 80) || `Item ${i + 1}`;
  }
  function detalheItem(item) {
    const t = clean(item.innerText || '');
    const pos = t.match(/Posologia\s+(.+?)(?=\s+(?:Via|Unidade|Observa|Aplicar|Cancelar|Situa)\b|$)/i)?.[1];
    const via = t.match(/Via\s+de\s+Administra[cç][aã]o\s+(.+?)(?=\s+(?:Unidade|Observa|Aplicar|Cancelar|Situa|Posologia)\b|$)/i)?.[1];
    return [pos, via].filter(Boolean).map(clean).join(' · ').slice(0, 90);
  }
  // Item que ainda precisa de ação: nem feito nem cancelado, e com os botões do sistema ativos.
  function itensPendentes(sala) {
    return [...sala.form.querySelectorAll('.item-encaminhamento-controle-salas')].map((item, i) => {
      const bf = botaoFez(sala, item), bc = item.querySelector(sala.s.btnCancelar);
      const resolvido = sala.s.fez(item) || sala.s.cancelou(item);
      const fechado = desligado(bf) && desligado(bc) && !resolvido;   // já finalizado em outra visita
      const estoque = !!item.querySelector('[data-baixa-estoque="true"], [data-baixa-estoque="1"]');
      return { item, i, nome: nomeItem(item, i), det: detalheItem(item), bf, bc, resolvido, fechado, estoque };
    });
  }

  // ---------- janelas do sistema (SweetAlert2) ----------
  const swalAberto = () => [...document.querySelectorAll('.swal2-popup')].find(visivel) || null;
  const tituloSwal = p => norm(p?.querySelector('.swal2-title')?.textContent);
  function preencher(el, v) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function marcarFeito(sala, x) {
    if (sala.s.fez(x.item)) return true;
    if (!x.bf || desligado(x.bf)) throw new Error(`"${x.nome}": botão ${sala.s.verbo} indisponível`);
    x.bf.click();
    // 500 ms do sistema + busca do procedimento/BPA
    const ok = await esperar(() => sala.s.fez(x.item), 8000);
    if (!ok) throw new Error(`"${x.nome}": o sistema não marcou como ${sala.s.feito}`);
    await sleep(150);
    return true;
  }
  async function marcarCancelado(sala, x, motivo) {
    if (sala.s.cancelou(x.item)) return true;
    if (!x.bc || desligado(x.bc)) throw new Error(`"${x.nome}": botão Cancelar indisponível`);
    x.bc.click();
    const pop = await esperar(() => { const p = swalAberto(); return p && p.querySelector('.swal2-textarea, textarea') ? p : null; }, 5000);
    if (!pop) throw new Error(`"${x.nome}": a janela de motivo do cancelamento não abriu`);
    preencher(pop.querySelector('.swal2-textarea, textarea'), motivo);
    pop.querySelector('.swal2-confirm')?.click();
    const ok = await esperar(() => sala.s.cancelou(x.item), 6000);
    if (!ok) throw new Error(`"${x.nome}": o sistema não marcou como cancelado`);
    await esperar(() => !swalAberto(), 3000);
    await sleep(150);
    return true;
  }
  // Produto com baixa de estoque: depois do Aplicar o sistema pede almoxarifado e quantidade.
  function faltaEstoque(x) {
    if (!x.estoque) return false;
    const alm = x.item.querySelector('select[id$="almoxarifado_id"]'), qt = x.item.querySelector('input[id$="_quantidade"]');
    return (alm && visivel(alm) && !alm.value) || (qt && visivel(qt) && !clean(qt.value));
  }
  function reavaliacao(form, marcar, justificativa) {
    const cx = form.querySelector('input[type="checkbox"][name$="[encaminhar_paciente_para_reavaliacao_medica]"]');
    const ju = form.querySelector('textarea[name$="[justificativa_encaminhamento]"], input[name$="[justificativa_encaminhamento]"]');
    if (!cx) return !marcar;
    if (cx.checked !== !!marcar) cx.click();
    if (cx.checked !== !!marcar) { cx.checked = !!marcar; cx.dispatchEvent(new Event('change', { bubbles: true })); }
    if (ju) preencher(ju, marcar ? justificativa : '');
    return true;
  }
  async function salvar() {
    const b = await esperar(() => { const e = document.querySelector('.salvar-encaminhamento-controle-salas'); return visivel(e) ? e : null; }, 3000);
    if (!b) throw new Error('botão Salvar não encontrado');
    b.click();
    // "Atenção — deseja salvar?" do sistema. Qualquer outra janela (ex.: aviso de pendência, Guia SADT) fica para a pessoa.
    const p = await esperar(() => { const x = swalAberto(); return x && /ATENCAO/.test(tituloSwal(x)) ? x : null; }, 8000);
    if (!p) return 'sem-confirmacao';
    p.querySelector('.swal2-confirm')?.click();
    const fim = await esperar(() => { const x = swalAberto(); return x && /SUCESSO|CONCLUID/.test(tituloSwal(x)) ? 'ok' : null; }, 20000, 150);
    return fim || 'sem-sucesso';
  }

  // ---------- painel da ficha ----------
  const CSS = `
  .om30bl{position:fixed;right:14px;top:80px;width:360px;max-height:calc(100vh - 100px);display:flex;flex-direction:column;background:#fff;border-radius:12px;box-shadow:0 14px 40px rgba(15,35,55,.28);z-index:2147482000;font:13px/1.35 "Segoe UI",Arial,sans-serif;color:#1f2f3c;overflow:hidden}
  .om30bl.min{width:auto;max-height:none}.om30bl.min .om30bl-corpo,.om30bl.min .om30bl-rod{display:none}
  .om30bl-topo{background:#0f5132;color:#fff;padding:9px 12px;display:flex;align-items:center;gap:8px;cursor:pointer}
  .om30bl-topo b{flex:1;font-size:14px}.om30bl-topo .n{background:#fff;color:#0f5132;border-radius:999px;padding:0 7px;font-weight:800;font-size:12px}
  .om30bl-corpo{overflow:auto;padding:10px 12px;flex:1}
  .om30bl-acoesgerais{display:flex;gap:6px;margin-bottom:8px}.om30bl-acoesgerais button{flex:1;border:1px solid #cfd8df;background:#f6f8fa;border-radius:7px;padding:5px;font:600 12px inherit;cursor:pointer}
  .om30bl-it{display:flex;align-items:center;gap:8px;border:1px solid #e2e8ee;border-radius:9px;padding:7px 8px;margin-bottom:6px}
  .om30bl-it.nao{background:#fff5f5;border-color:#f3c2c2}.om30bl-it.fez{background:#f1faf4;border-color:#bfe3cb}
  .om30bl-it.feito{opacity:.6}.om30bl-it .tx{flex:1;min-width:0}.om30bl-it .tx b{display:block;word-break:break-word}.om30bl-it .tx small{color:#5f7383}
  .om30bl-it .tg{display:flex;gap:4px;flex:none}.om30bl-it .tg button{border:1px solid #cfd8df;background:#fff;border-radius:7px;padding:4px 8px;font:700 12px inherit;cursor:pointer}
  .om30bl-it .tg button.on[data-v="fez"]{background:#198754;border-color:#198754;color:#fff}.om30bl-it .tg button.on[data-v="nao"]{background:#c0392b;border-color:#c0392b;color:#fff}
  .om30bl-tag{display:inline-block;font-size:10.5px;font-weight:700;border-radius:5px;padding:1px 6px;background:#fff3cd;color:#7a5600;margin-top:2px}
  .om30bl-mot{margin-top:8px;border-top:1px solid #edf1f4;padding-top:8px}.om30bl-mot .rot{font-weight:700;font-size:12px;margin-bottom:4px;color:#8f2a22}
  .om30bl-chips{display:flex;flex-wrap:wrap;gap:4px;margin-bottom:5px}.om30bl-chips button{border:1px solid #e3c4c0;background:#fff;border-radius:999px;padding:3px 8px;font:600 11px inherit;cursor:pointer;color:#7a2a22}
  .om30bl-chips button.on{background:#c0392b;color:#fff;border-color:#c0392b}
  .om30bl textarea{width:100%;box-sizing:border-box;min-height:46px;border:1px solid #cfd8df;border-radius:7px;padding:6px;font:12.5px inherit;resize:vertical}
  .om30bl-reav{display:flex;gap:6px;align-items:flex-start;margin:8px 0 4px;font-weight:700;font-size:12px;cursor:pointer}
  .om30bl-msg{font-size:12px;margin-top:6px;white-space:pre-wrap}.om30bl-msg.erro{color:#a12a1f}.om30bl-msg.ok{color:#0f5132}
  .om30bl-rod{padding:10px 12px;border-top:1px solid #edf1f4}
  .om30bl-go{width:100%;border:0;border-radius:9px;background:#198754;color:#fff;padding:10px;font:700 13.5px inherit;cursor:pointer}.om30bl-go:disabled{background:#9fb5a8;cursor:default}
  .om30bl-marca{outline:3px solid #c0392b!important;outline-offset:2px;border-radius:6px}
  /* aba Pendências (lista) */
  .om30pd-btn{position:fixed;right:14px;bottom:18px;z-index:2147482000;border:0;border-radius:999px;background:#0f5132;color:#fff;padding:10px 16px;font:700 13px "Segoe UI",Arial;box-shadow:0 8px 22px rgba(15,35,55,.3);cursor:pointer}
  .om30pd-btn .n{background:#fff;color:#0f5132;border-radius:999px;padding:0 7px;margin-left:6px;font-size:12px}
  .om30pd{position:fixed;top:0;right:0;bottom:0;width:440px;max-width:96vw;background:#f5f8fa;z-index:2147482001;box-shadow:-10px 0 30px rgba(15,35,55,.25);display:none;flex-direction:column;font:13px/1.35 "Segoe UI",Arial,sans-serif;color:#1f2f3c}
  .om30pd.on{display:flex}.om30pd-topo{background:#0f5132;color:#fff;padding:11px 12px;display:flex;gap:8px;align-items:center}.om30pd-topo b{flex:1;font-size:14.5px}
  .om30pd-topo button{border:0;background:rgba(255,255,255,.15);color:#fff;border-radius:7px;padding:5px 9px;cursor:pointer;font:600 12px inherit}
  .om30pd-busca{padding:8px 12px}.om30pd-busca input{width:100%;box-sizing:border-box;border:1px solid #cfd8df;border-radius:8px;padding:7px 9px;font:13px inherit}
  .om30pd-lista{overflow:auto;flex:1;padding:0 12px 12px}.om30pd-p{background:#fff;border-radius:10px;padding:8px 10px;margin-bottom:7px;box-shadow:0 1px 3px rgba(15,35,55,.08)}
  .om30pd-p .nm{font-weight:700}.om30pd-p .sub{color:#5f7383;font-size:11.5px;margin:1px 0 5px}
  .om30pd-s{display:inline-flex;gap:4px;align-items:center;border-radius:6px;padding:2px 7px;margin:0 4px 4px 0;font-size:11.5px;font-weight:700;background:#e8eff5;color:#24435c}
  .om30pd-s.and{background:#fff3cd;color:#7a5600}.om30pd-vazio{color:#6b7f8e;text-align:center;padding:30px 10px}`;
  function css() { if (document.getElementById('om30bl-css')) return; const s = document.createElement('style'); s.id = 'om30bl-css'; s.textContent = CSS; document.head.appendChild(s); }

  let painel = null, escolha = new Map(), rodando = false, motivoEscolhido = '';
  function montarPainel(sala) {
    css();
    painel = document.createElement('div');
    painel.className = 'om30bl';
    painel.innerHTML = `<div class="om30bl-topo" title="Abrir/fechar"><b>⚡ Baixa rápida · ${esc(sala.s.nome)}</b><span class="n">0</span></div>
      <div class="om30bl-corpo"></div><div class="om30bl-rod"><button class="om30bl-go" disabled>Dar baixa</button><div class="om30bl-msg"></div></div>`;
    document.body.appendChild(painel);
    try { if (localStorage.getItem('om30bl-min') === '1') painel.classList.add('min'); } catch {}
    painel.querySelector('.om30bl-topo').onclick = () => { painel.classList.toggle('min'); try { localStorage.setItem('om30bl-min', painel.classList.contains('min') ? '1' : '0'); } catch {} };
    painel.querySelector('.om30bl-go').onclick = () => darBaixa(sala);
    desenhar(sala);
  }
  const msg = (t, tipo = '') => { const m = painel?.querySelector('.om30bl-msg'); if (m) { m.className = 'om30bl-msg ' + tipo; m.textContent = t || ''; } };

  function desenhar(sala) {
    if (!painel || rodando) return;
    const xs = itensPendentes(sala);
    const abertos = xs.filter(x => !x.resolvido && !x.fechado);
    for (const x of abertos) if (!escolha.has(x.item)) escolha.set(x.item, 'fez');
    painel.querySelector('.n').textContent = String(abertos.length);
    const corpo = painel.querySelector('.om30bl-corpo');
    const nNao = abertos.filter(x => escolha.get(x.item) === 'nao').length;
    // Sem o texto do motivo: redesenhar enquanto a pessoa digita tiraria o foco do campo.
    const assinatura = xs.map(x => `${x.i}:${x.resolvido}:${x.fechado}:${escolha.get(x.item) || ''}`).join('|');
    if (corpo.dataset.a === assinatura) return;
    corpo.dataset.a = assinatura;
    if (!xs.length) { corpo.innerHTML = '<div class="om30pd-vazio">Nenhum item nesta ficha.</div>'; atualizarBotao(sala, abertos); return; }
    const motTxt = corpo.querySelector('.om30bl-mot textarea')?.value ?? motivoEscolhido;
    const reavOn = !!corpo.querySelector('.om30bl-reav input')?.checked, reavTxt = corpo.querySelector('.om30bl-just')?.value || '';
    corpo.innerHTML = (abertos.length > 1 ? `<div class="om30bl-acoesgerais"><button data-todos="fez">✔ Todos feitos</button><button data-todos="nao">✖ Nenhum feito</button></div>` : '') +
      xs.map(x => {
        if (x.resolvido || x.fechado) return `<div class="om30bl-it feito"><div class="tx"><b>${esc(x.nome)}</b><small>${x.fechado ? 'já finalizado' : sala.s.fez(x.item) ? '✔ ' + sala.s.feito : '✖ cancelado'} (marcado na tela)</small></div></div>`;
        const v = escolha.get(x.item);
        return `<div class="om30bl-it ${v}" data-i="${x.i}"><div class="tx"><b>${esc(x.nome)}</b>${x.det ? `<small>${esc(x.det)}</small>` : ''}${x.estoque ? '<br><span class="om30bl-tag">pede almoxarifado/quantidade</span>' : ''}</div>
          <div class="tg"><button data-v="fez" class="${v === 'fez' ? 'on' : ''}" title="${esc(sala.s.verbo)}">✔ Fez</button><button data-v="nao" class="${v === 'nao' ? 'on' : ''}" title="Cancelar">✖ Não</button></div></div>`;
      }).join('') +
      (nNao ? `<div class="om30bl-mot"><div class="rot">Motivo do que não foi feito (${nNao})</div><div class="om30bl-chips">${sala.s.motivos.map(m => `<button data-m="${esc(m)}" class="${m === motTxt ? 'on' : ''}">${esc(m.replace(/\.$/, ''))}</button>`).join('')}</div>
        <textarea placeholder="Justificativa do cancelamento">${esc(motTxt)}</textarea>
        <label class="om30bl-reav"><input type="checkbox"${reavOn ? ' checked' : ''}> <span>Encaminhar para reavaliação médica</span></label>
        <textarea class="om30bl-just" placeholder="Justificativa para o médico"${reavOn ? '' : ' hidden'}>${esc(reavTxt)}</textarea></div>` : '');
    const porI = new Map(xs.map(x => [String(x.i), x]));
    corpo.querySelectorAll('.om30bl-it[data-i] .tg button').forEach(b => b.onclick = () => { escolha.set(porI.get(b.closest('[data-i]').dataset.i).item, b.dataset.v); corpo.dataset.a = ''; desenhar(sala); });
    corpo.querySelectorAll('[data-todos]').forEach(b => b.onclick = () => { abertos.forEach(x => escolha.set(x.item, b.dataset.todos)); corpo.dataset.a = ''; desenhar(sala); });
    corpo.querySelectorAll('.om30bl-chips button').forEach(b => b.onclick = () => { motivoEscolhido = b.dataset.m; corpo.querySelector('.om30bl-mot textarea').value = b.dataset.m; corpo.dataset.a = ''; desenhar(sala); });
    const ta = corpo.querySelector('.om30bl-mot textarea'); if (ta) ta.oninput = () => { motivoEscolhido = ta.value; atualizarBotao(sala, abertos); };
    const rv = corpo.querySelector('.om30bl-reav input'); if (rv) rv.onchange = () => { corpo.querySelector('.om30bl-just').hidden = !rv.checked; atualizarBotao(sala, abertos); };
    const jt = corpo.querySelector('.om30bl-just'); if (jt) jt.oninput = () => atualizarBotao(sala, abertos);
    ['keydown', 'keyup', 'keypress'].forEach(t => painel.addEventListener(t, e => e.stopPropagation()));
    atualizarBotao(sala, abertos);
  }
  function lerMotivo() {
    const c = painel.querySelector('.om30bl-corpo');
    return { motivo: clean(c.querySelector('.om30bl-mot textarea')?.value), reav: !!c.querySelector('.om30bl-reav input')?.checked, just: clean(c.querySelector('.om30bl-just')?.value) };
  }
  function atualizarBotao(sala, abertos) {
    const b = painel.querySelector('.om30bl-go');
    const f = abertos.filter(x => escolha.get(x.item) === 'fez').length, n = abertos.length - f;
    const { motivo, reav, just } = lerMotivo();
    b.disabled = rodando || (n > 0 && !motivo) || (reav && !just);
    b.textContent = !abertos.length ? 'Salvar a ficha'
      : `Dar baixa: ${f ? `${f} ${sala.s.feito}${f > 1 ? 's' : ''}` : ''}${f && n ? ' + ' : ''}${n ? `${n} cancelado${n > 1 ? 's' : ''}` : ''} e salvar`;
    if (n > 0 && !motivo) b.title = 'Escolha o motivo do que não foi feito'; else b.title = '';
  }

  async function darBaixa(sala) {
    if (rodando) return;
    const xs = itensPendentes(sala).filter(x => !x.resolvido && !x.fechado);
    const { motivo, reav, just } = lerMotivo();
    const fez = xs.filter(x => escolha.get(x.item) === 'fez'), nao = xs.filter(x => escolha.get(x.item) === 'nao');
    if (nao.length && !motivo) return msg('Escolha o motivo do que não foi feito.', 'erro');
    const resumo = [fez.length && `${sala.s.verbo.toUpperCase()} (${fez.length}):\n- ${fez.map(x => x.nome).join('\n- ')}`, nao.length && `CANCELAR (${nao.length}):\n- ${nao.map(x => x.nome).join('\n- ')}\nMotivo: ${motivo}`, reav && `Reavaliação médica: SIM — ${just}`].filter(Boolean).join('\n\n');
    if (xs.length && !confirm(`Confirma a baixa desta ficha?\n\n${resumo}\n\nDepois a ficha é salva e o paciente segue para o próximo destino marcado pelo médico.`)) return;
    rodando = true; atualizarBotao(sala, xs);
    const b = painel.querySelector('.om30bl-go');
    let etapa = '';
    try {
      // Um por vez: o sistema usa um timer único de 500 ms para todos os botões.
      for (const [k, x] of fez.entries()) { etapa = `${sala.s.verbo.toLowerCase()} ${k + 1}/${fez.length}`; b.textContent = `${sala.s.verbo}… ${k + 1}/${fez.length}`; await marcarFeito(sala, x); }
      for (const [k, x] of nao.entries()) { etapa = `cancelar ${k + 1}/${nao.length}`; b.textContent = `Cancelando… ${k + 1}/${nao.length}`; await marcarCancelado(sala, x, motivo); }
      const semEstoque = fez.filter(faltaEstoque);
      if (semEstoque.length) {
        semEstoque.forEach(x => x.item.classList.add('om30bl-marca'));
        semEstoque[0].item.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => semEstoque.forEach(x => x.item.classList.remove('om30bl-marca')), 8000);
        throw Object.assign(new Error(`Preencha almoxarifado e quantidade de: ${semEstoque.map(x => x.nome).join(', ')} — depois clique em "Salvar a ficha".`), { parar: true });
      }
      if (reav || nao.length) { etapa = 'reavaliação'; if (!reavaliacao(sala.form, reav, just) && reav) throw new Error('esta ficha não tem a opção de reavaliação médica'); }
      etapa = 'salvar'; b.textContent = 'Salvando…';
      const r = await salvar();
      if (r === 'ok') msg('✔ Baixa feita e ficha salva. O sistema mostra o próximo destino.', 'ok');
      else if (r === 'sem-confirmacao') msg('Itens marcados. O sistema abriu outra janela no lugar da confirmação de salvar: confira e conclua por ela.', 'erro');
      else msg('Salvar foi confirmado, mas o "Sucesso" não apareceu em 20 s. Confira a ficha antes de tentar de novo.', 'erro');
      console.log('[OM30 Baixa Rápida]', { sala: sala.k, feitos: fez.length, cancelados: nao.length, reavaliacao: reav, resultado: r });
    } catch (e) {
      console.warn('[OM30 Baixa Rápida] parou em', etapa, e);
      msg(e.parar ? e.message : `Parou ao ${etapa}: ${e.message}\nO que já foi marcado ficou na tela (nada foi salvo). Confira e clique de novo.`, 'erro');
    } finally {
      rodando = false;
      painel.querySelector('.om30bl-corpo').dataset.a = '';
      desenhar(sala);
    }
  }

  // =====================================================================
  // ABA PENDÊNCIAS — baixa de TUDO do paciente pela API (Medicação + Exames + Enfermagem)
  // Mesmo caminho do "Cancelar todas pela lista" do Controle de Salas: carrega o formulário da sala
  // por fetch, marca os itens nos mesmos campos que os botões do sistema marcam, lança o faturamento
  // (BPA) e salva como o "Salvar" da tela. Nada é salvo se a conferência de alguma sala falhar.
  //
  // Faturamento (captura de 18/11 + parametrização da UPA): cada item consulta o procedimento no
  // sistema (Medicação pela via; Exames/Enfermagem pelo item). Entra UMA linha por código diferente,
  // quantidade 1, só dos itens feitos — 2 orais = 1 "administração por via oral"; hemograma + TGO =
  // 1 "coleta de material"; teste rápido e procedimento de enfermagem têm código próprio.
  // Linha do BPA (igual à criada pelo Aplicar): procedimentos_lancamentos_bpa_temporarios_attributes
  // [n][profissional_ocupacao_id|automatico=true|procedimento_id|procedimento_token=texto|quantidade=1|_destroy=false].
  // =====================================================================
  // 18/11: mesmo formato de faturamento da Medicação nas três salas (confirmado pelo usuário).
  // Campos do item no formato da Medicação (mesmos que o Aplicar/Realizar e o Cancelar do sistema marcam).
  const estiloMed = it => !!it.querySelector('input[id$="_para_atendimento"]');
  const MED_ABERTO = it => valor(it, '_pendente') === 'true' && !['_cancelada', '_cancelado', '_para_atendimento', '_para_cancelamento'].some(c => valor(it, c) === 'true');
  const MED_FAZER = it => { poe(it, '_pendente', 'true'); poe(it, '_cancelada', 'false'); poe(it, '_cancelado', 'false'); poe(it, '_para_atendimento', 'true'); poe(it, '_para_cancelamento', 'false'); };
  const MED_CANCELAR = (it, c) => { poe(it, '_pendente', 'false'); if (!poe(it, '_cancelada', 'true')) poe(it, '_cancelado', 'true'); poe(it, '_para_atendimento', 'false'); poe(it, '_para_cancelamento', 'true'); camposCancelamento(it, c); };
  const FORMATO_BPA_CONFIRMADO = { medicacao: true, exames: true, enfermagem: true };
  // Campos que cada sala precisa ter na ficha. Conferidos ANTES de salvar qualquer sala.
  const REQUER = {
    medicacao: { fez: ['_tipo_uso_medicamento_id', '_para_atendimento'], nao: ['_cancelada', '_justificativa_cancelamento'] },   // [a, b] = um dos dois
    exames: { fez: ['_exame_id', '_coletado'], nao: ['_cancelado', '_justificativa_cancelamento'] },
    enfermagem: { fez: ['_procedimento_enfermagem_id', ['_para_atendimento', '_realizado']], nao: [['_cancelada', '_cancelado'], '_justificativa_cancelamento'] },
  };
  const SALAS_API = [
    {
      k: 'medicacao', nome: 'Medicação', codigo: 'controle_de_salas_medicacao', lista: '/aplicacoes_medicamentos',
      abrir: id => `/aplicacoes_medicamentos/new?encaminhamento_medicacao_id=${encodeURIComponent(id)}`,
      form: 'form[id^="edit_encaminhamento_medicacao_"]',
      proc: it => { const v = valor(it, '_tipo_uso_medicamento_id'); return v && `/aplicacoes_medicamentos/buscar_procedimentos_faturamento?tipo_uso_medicamento_id=${encodeURIComponent(v)}`; },
      aberto: it => MED_ABERTO(it), fazer: it => MED_FAZER(it), cancelar: (it, c) => MED_CANCELAR(it, c),
    },
    {
      k: 'exames', nome: 'Exames', codigo: 'controle_de_salas_exames', lista: '/encaminhamentos_exames',
      abrir: id => `/encaminhamentos_exames/${encodeURIComponent(id)}/edit`,
      form: 'form[id^="edit_encaminhamento_exame_"]',
      proc: it => { const v = valor(it, '_exame_id'); return v && `/encaminhamentos_exames/buscar_procedimentos_faturamento?exame_id=${encodeURIComponent(v)}`; },
      aberto: it => valor(it, '_coletado') !== 'true' && valor(it, '_cancelado') !== 'true',
      fazer: it => { exigir(it, '_coletado'); poe(it, '_coletado', 'true'); poe(it, '_cancelado', 'false'); },
      cancelar: (it, c) => { poe(it, '_coletado', 'false'); exigir(it, '_cancelado'); poe(it, '_cancelado', 'true'); poe(it, '_para_cancelamento', 'true'); camposCancelamento(it, c); },
    },
    {
      k: 'enfermagem', nome: 'Enfermagem', codigo: 'controle_de_salas_procedimento_enfermagem', lista: '/encaminhamentos_procedimentos_enfermagem',
      abrir: id => `/encaminhamentos_procedimentos_enfermagem/${encodeURIComponent(id)}/edit`,
      form: 'form[id*="procedimento_enfermagem"], form[id*="procedimentoenfermagem"]',
      proc: it => { const v = valor(it, '_procedimento_enfermagem_id'); return v && `/encaminhamentos_procedimentos_enfermagem/buscar_procedimentos_faturamento?procedimento_enfermagem_id=${encodeURIComponent(v)}`; },
      // 18/11: igual à Medicação, só o botão muda de "Aplicar" para "Realizar" (mesmos campos).
      // Se a ficha vier com o formato antigo (realizado/cancelado), usa esse.
      aberto: it => estiloMed(it) ? MED_ABERTO(it) : valor(it, '_realizado') !== 'true' && valor(it, '_cancelado') !== 'true',
      fazer: it => { if (estiloMed(it)) return MED_FAZER(it); exigir(it, '_realizado'); poe(it, '_realizado', 'true'); poe(it, '_cancelado', 'false'); },
      cancelar: (it, c) => { if (estiloMed(it)) return MED_CANCELAR(it, c); poe(it, '_realizado', 'false'); exigir(it, '_cancelado'); poe(it, '_cancelado', 'true'); poe(it, '_para_cancelamento', 'true'); camposCancelamento(it, c); },
    },
  ];
  const inp = (it, suf) => it.querySelector(`input[id$="${suf}"], textarea[id$="${suf}"], select[id$="${suf}"]`);
  const valor = (it, suf) => String(inp(it, suf)?.value ?? '').trim();
  function poe(it, suf, v) { const e = inp(it, suf); if (e) e.value = v; return !!e; }
  function exigir(it, suf) { if (!inp(it, suf)) throw new Error(`campo "${suf.slice(1)}" não existe na ficha (formato diferente do esperado)`); }
  function camposCancelamento(it, c) {
    const j = inp(it, '_justificativa_cancelamento');
    if (!j) throw new Error('campo de justificativa do cancelamento não encontrado');
    j.value = c.motivo;
    poe(it, '_canceled_at', c.momento);
    poe(it, '_profissional_cancelamento_id', c.profissional);
  }
  const momentoAgora = () => new Date().toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'America/Sao_Paulo' });
  const dataBR = x => `${String(x.getDate()).padStart(2, '0')}/${String(x.getMonth() + 1).padStart(2, '0')}/${x.getFullYear()}`;
  const HJSON = { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' } };
  async function getJSON(url) {
    const r = await fetch(url, HJSON);
    if (!r.ok) throw new Error(`HTTP ${r.status} em ${url.split('?')[0]}`);
    let j = await r.json();
    if (typeof j === 'string') { try { j = JSON.parse(j); } catch {} }   // algumas rotas devolvem JSON dentro de string
    return j;
  }
  function nomeDoItem(it, i) {
    const t = clean(it.textContent) + ' ' + [...it.querySelectorAll('input[type="text"],input:not([type]),textarea')].map(e => e.value).join(' ');
    const m = t.match(/\b(?:Produto|Medicamento|Exame|Procedimento)\s*:?\s+(.+?)(?=\s+(?:Situa[cç][aã]o|Posologia|Via\s+de|Unidade\s+de|Observa[cç][aã]o|Quantidade|Aplicar|Coletar|Realizar|Cancelar|Justificativa|Almoxarifado)\b|$)/i);
    return clean(m?.[1] || '').slice(0, 110) || `Item ${i + 1}`;
  }

  // 1) Pendências: lista de cada sala (Em Espera + Em Andamento, ontem e hoje), por atendimento.
  async function listarSala(s) {
    // Quem está numa sala aparece nas outras como "Em Outra Sala" (não é Em Espera nem Em Andamento):
    // por isso lê também sem filtro de situação e tira só Finalizado/Cancelado.
    const hoje = new Date(), ontem = new Date(hoje.getTime() - 864e5), out = [];
    for (const st of ['1', '2', '']) for (let page = 1; page <= 5; page++) {
      const q = new URLSearchParams({ format: 'json', sortable: '{}', page: String(page), per_page: '100', profissional: '{}', status: st, grau_risco: '', dataInicial: dataBR(ontem), dataFinal: dataBR(hoje) });
      const arr = await getJSON(`${s.lista}?${q}`).catch(() => []);
      if (!Array.isArray(arr) || !arr.length) break;
      out.push(...arr.filter(x => !/FINALIZ|CANCEL|CONCLU/.test(norm(x.status))));
      if (arr.length < 100) break;
    }
    return out;
  }
  async function carregarPendencias() {
    const por = new Map(), erros = [];
    await Promise.all(SALAS_API.map(async s => {
      try {
        for (const x of await listarSala(s)) {
          const at = clean(x.atendimento_str), enc = String(x.encaminhamento_id || '').split('#').pop();
          if (!/^\w+#\d+$/.test(at) || !/^\d+$/.test(enc)) continue;
          if (!por.has(at)) por.set(at, { atendimento: at, nome: clean(x.nome_municipe), senha: clean(x.senha), salas: [] });
          const p = por.get(at);
          if (!p.salas.some(y => y.s.k === s.k && y.enc === enc)) p.salas.push({ s, enc, status: clean(x.status) });
          if (!p.senha && x.senha) p.senha = clean(x.senha);
        }
      } catch (e) { erros.push(`${s.nome}: ${e.message}`); }
    }));
    const ordem = SALAS_API.map(s => s.k);
    const pacientes = [...por.values()].map(p => ({ ...p, salas: p.salas.sort((a, b) => ordem.indexOf(a.s.k) - ordem.indexOf(b.s.k)) }))
      .sort((a, b) => b.salas.length - a.salas.length || a.nome.localeCompare(b.nome));
    return { pacientes, erros };
  }

  // 1b) O que o médico pediu, SÓ LENDO a tela de consulta de cada sala (não abre a ficha, não muda a situação).
  //     Medicação: /aplicacoes_medicamentos/{id} (a mesma consulta que o Controle de Salas já lê).
  //     Exames/Enfermagem: a consulta da sala, se existir; se o sistema redirecionar, não segue.
  const CONSULTA_ITENS = {
    medicacao: { url: id => `/aplicacoes_medicamentos/${id}`, chave: 'MEDICAMENTO' },
    exames: { url: id => `/encaminhamentos_exames/${id}`, chave: 'EXAME' },
    enfermagem: { url: id => `/encaminhamentos_procedimentos_enfermagem/${id}`, chave: 'PROCEDIMENTO' },
  };
  const CACHE_ITENS = new Map();
  async function itensDoMedico(k, enc) {
    const ck = `${k}#${enc}`, c = CACHE_ITENS.get(ck);
    if (c && Date.now() - c.em < 60e3) return c.v;
    let v = null;
    try {
      const cfg = CONSULTA_ITENS[k];
      const r = await fetch(cfg.url(enc), { credentials: 'same-origin', cache: 'no-store', redirect: 'manual', headers: { Accept: 'text/html' } });
      if (r.ok && r.type !== 'opaqueredirect') {
        const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
        for (const t of doc.querySelectorAll('table')) {
          const ths = [...(t.querySelector('thead') || t).querySelectorAll('th')].map(th => norm(th.textContent));
          const iNome = ths.findIndex(h => h.includes(cfg.chave));
          if (iNome < 0) continue;
          const col = n => ths.findIndex(h => h.includes(n));
          const iVia = col('VIA'), iPos = col('POSOLOGIA'), iSit = col('SITUACAO'), iObs = col('OBSERVACAO'), iQt = col('QUANTIDADE');
          v = [...t.querySelectorAll('tbody tr')].map(tr => {
            const td = [...tr.querySelectorAll('td')].map(x => clean(x.textContent));
            const sit = iSit >= 0 ? td[iSit] || '' : '';
            return {
              nome: td[iNome] || '', det: [iPos >= 0 && td[iPos], iVia >= 0 && td[iVia], iQt >= 0 && td[iQt] && 'qtd ' + td[iQt]].filter(Boolean).join(' · '),
              obs: iObs >= 0 && !/^[-–—]*$/.test(td[iObs] || '') ? td[iObs] : '',
              estado: !norm(sit) || /PENDENTE|AGUARD/.test(norm(sit)) ? 'pendente' : /CANCEL/.test(norm(sit)) ? 'cancelado' : 'feito',
            };
          }).filter(x => x.nome);
          break;
        }
      }
    } catch (_) {}
    CACHE_ITENS.set(ck, { em: Date.now(), v });
    return v;
  }

  // 2) Abrir as fichas do paciente (só leitura do formulário; o sistema põe o paciente "Em Andamento").
  async function carregarFicha(s, enc) {
    const r = await fetch(s.abrir(enc), { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'text/html' } });
    if (!r.ok) throw new Error(`${s.nome}: HTTP ${r.status} ao abrir a ficha`);
    const html = await r.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const form = doc.querySelector(s.form);
    if (!form) throw new Error(`${s.nome}: a ficha não abriu o formulário`);
    const doForm = form.id.match(/(\d+)$/)?.[1];
    if (doForm && doForm !== String(enc)) throw new Error(`${s.nome}: abriu o encaminhamento ${doForm}, não o ${enc}`);
    // O faturamento da sala precisa usar o mesmo formato do Aplicar; sem isso, não salva (evita baixa sem BPA).
    // Medicação: formato confirmado pela captura de 18/11. Exames/Enfermagem: só com o formato visível na ficha.
    const bpaOk = FORMATO_BPA_CONFIRMADO[s.k] || /procedimentos_lancamentos_bpa_temporarios/.test(html);
    const prefixo = (form.querySelector('[name*="[atendimentos_prescricoes_internas_attributes]"],[name*="_attributes]"]')?.name || '').split('[')[0]
      || form.id.replace(/^edit_/, '').replace(/_\d+$/, '');
    const itens = [...form.querySelectorAll('.item-encaminhamento-controle-salas')].map((it, i) => ({
      it, i, nome: nomeDoItem(it, i), aberto: s.aberto(it),
      estoque: !!it.querySelector('[data-baixa-estoque="true"],[data-baixa-estoque="1"]'),
    }));
    return { s, enc, form, prefixo, bpaOk, itens, profissional: (form.querySelector('#current_profissional') || doc.querySelector('#current_profissional'))?.value || '' };
  }

  // 3) Faturamento: procedimento de cada item feito, sem repetir código; ocupação do profissional logado.
  async function montarFaturamento(f, feitos) {
    const porProc = new Map();
    for (const x of feitos) {
      const url = f.s.proc(x.it);
      if (!url) throw new Error(`${f.s.nome}: "${x.nome}" sem o dado que define o faturamento`);
      const p = await getJSON(url);
      if (!p || !p.id) throw new Error(`${f.s.nome}: "${x.nome}" não tem procedimento de faturamento parametrizado`);
      const k = p.fatura_por_aplicacao ? `${p.id}#${x.i}` : String(p.id);   // fatura_por_aplicacao = uma linha por item
      if (!porProc.has(k)) porProc.set(k, { id: p.id, texto: clean(p.procedimento_text || p.codigo || ''), itens: [] });
      porProc.get(k).itens.push(x.nome);
    }
    // Já lançado nesta ficha (ex.: aplicação parcial anterior)? Não repete.
    const jaTem = new Set();
    for (const e of f.form.querySelectorAll('[name*="[procedimentos_lancamentos_bpa_temporarios_attributes]"][name$="[procedimento_id]"]')) {
      const destroy = f.form.querySelector(`[name="${CSS.escape(e.name.replace(/\[procedimento_id\]$/, '[_destroy]'))}"]`);
      if (!/^(true|1)$/.test(destroy?.value || '')) jaTem.add(String(e.value));
    }
    const linhas = [];
    for (const l of porProc.values()) {
      if (!/#/.test(String(l.id)) && jaTem.has(String(l.id))) continue;
      const oc = await getJSON(`/parametrizacoes/procedimentos_faturamento/buscar_profissional_ocupacao_compativel?procedimento_id=${encodeURIComponent(l.id)}`);
      const o = Array.isArray(oc) ? oc[0] : oc;
      if (!o?.id) throw new Error(`${f.s.nome}: nenhuma ocupação compatível com ${l.texto} para quem está logado`);
      linhas.push({ ...l, ocupacao: String(o.id), ocupacaoNome: clean(o.name || '') });
    }
    return linhas;
  }
  function lancarFaturamento(f, linhas) {
    let n = Date.now();
    for (const l of linhas) {
      const base = `${f.prefixo}[procedimentos_lancamentos_bpa_temporarios_attributes][${n++}]`;
      for (const [k, v] of Object.entries({ profissional_ocupacao_id: l.ocupacao, automatico: 'true', procedimento_id: String(l.id), procedimento_token: l.texto, quantidade: '1', _destroy: 'false' })) {
        const e = f.form.ownerDocument.createElement('input');
        e.type = 'hidden'; e.name = `${base}[${k}]`; e.value = v;
        f.form.appendChild(e);
      }
    }
  }

  // 4) Salvar como a tela salva (formulário data-remote) e ler a resposta.
  function serializar(form) {
    const corpo = new URLSearchParams();
    for (const el of form.querySelectorAll('input[name],select[name],textarea[name]')) {
      if (el.disabled) continue;
      const t = (el.type || '').toLowerCase();
      if (['submit', 'button', 'reset', 'image', 'file'].includes(t)) continue;
      if ((t === 'checkbox' || t === 'radio') && !el.checked) continue;
      if (el.tagName === 'SELECT') { for (const o of el.options) if (o.selected) corpo.append(el.name, o.value); continue; }
      corpo.append(el.name, el.value);
    }
    corpo.append('button', '');
    return corpo;
  }
  async function salvarFicha(f) {
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Accept: '*/*;q=0.5, text/javascript, application/javascript, application/ecmascript, application/x-ecmascript', 'X-Requested-With': 'XMLHttpRequest' };
    const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const r = await fetch(f.form.getAttribute('action'), { method: (f.form.getAttribute('method') || 'post').toUpperCase(), credentials: 'same-origin', cache: 'no-store', headers, body: serializar(f.form).toString() });
    const t = await r.text();
    if (!r.ok) throw new Error(`${f.s.nome}: HTTP ${r.status} ao salvar`);
    const erros = [];
    for (let m, re = /inline-errors\\?["'][^>]*>([^<]+)</g; (m = re.exec(t));) erros.push(m[1].replace(/\\(.)/g, '$1').trim());
    if (/\$\(\s*["']\.form["']\s*\)\.replaceWith/.test(t) || erros.length) throw new Error(`${f.s.nome}: o sistema recusou — ${erros.join('; ') || 'o formulário voltou com erro'}`);
    const conc = /concluirSenhaOpcional\(\s*["']([^"']+)["']\s*,\s*\{[\s\S]*?atendimento_id\s*:\s*["']?(\d+)["']?\s*,[\s\S]*?atendimento_type\s*:\s*["']([^"']+)["']/.exec(t);
    const destinos = [...t.matchAll(/(?:redirecionarControleSalasSemSenha|encaminharSenhaControleSalas)\(\s*["']([^"']*)["']\s*,\s*["']([^"']+)["']/g)].map(x => x[2]);
    return { texto: t, conclusao: conc ? { tipo: conc[1], atendimentoId: +conc[2], atendimentoType: conc[3] } : null, destinos };
  }

  // 5) Senha: conclui em cada sala salva e devolve a MESMA senha para o destino final
  //    (o que a resposta do último salvar mandaria: médico, Raio-X…), como o Cancelar da lista faz.
  async function concluirSenhaSala(res, f, atendimento) {
    if (typeof window.concluirSenhaOpcional !== 'function') return;
    const [tipo, id] = atendimento.split('#');
    const c = res.conclusao || { tipo: f.s.codigo, atendimentoId: +id, atendimentoType: tipo };
    try { await window.concluirSenhaOpcional(c.tipo, { atendimento_id: c.atendimentoId, atendimento_type: c.atendimentoType }); } catch (_) {}
  }
  async function senhaParaDestino(atendimento, destino) {
    const [tipo, id] = atendimento.split('#');
    try { const tk = sessionStorage.getItem('senhaSimplesToken'); if (tk && typeof senhaSimplesProxy !== 'undefined') senhaSimplesProxy.defaults.headers = { Authorization: `Bearer ${tk}` }; } catch (_) {}   // eslint-disable-line no-undef
    let ok = false;
    try {
      if (typeof window.senhaSimplesPutFilas !== 'function') throw new Error('Senha Simples indisponível nesta tela');
      const par = await getJSON(`/filas/parametrizacoes/${encodeURIComponent(destino)}.json`);
      const cat = par?.senha_simples_categoria?.id;
      if (!cat) throw new Error('fila sem categoria de senha');
      await window.senhaSimplesPutFilas(`${cat}/retornar_para_atendimento`, { atendimento_id: +id, atendimento_type: tipo, categoria_id: cat });
      ok = true;
    } finally {
      // como o sistema faz ao encaminhar: destino marcado como "não chamado"
      try { if (typeof window.atualizarFilaSenhaControleSalas === 'function') await window.atualizarFilaSenhaControleSalas(destino, +id, tipo); } catch (_) {}
    }
    return ok;
  }
  function marcarReavaliacao(f, sim, just) {
    const cx = f.form.querySelector('input[type="checkbox"][name$="[encaminhar_paciente_para_reavaliacao_medica]"]');
    const ju = f.form.querySelector('textarea[name$="[justificativa_encaminhamento]"], input[name$="[justificativa_encaminhamento]"]');
    if (!cx) return false;
    cx.checked = !!sim;
    if (ju) ju.value = sim ? just : '';
    return true;
  }

  // ---------- interface da aba ----------
  const NOME_DESTINO = { atendimento: 'médico (retorno)', controle_de_salas_medicacao: 'Medicação', controle_de_salas_exames: 'Exames', controle_de_salas_raio_x: 'Raio-X', controle_de_salas_procedimento_enfermagem: 'Enfermagem', controle_de_salas_gesso_imobilizacao: 'Gesso' };
  function ehListaControle() { return /^\/(aplicacoes_medicamentos|encaminhamentos_(exames|procedimentos_enfermagem|radiografias))\/?$/.test(location.pathname); }
  let aba = null, dados = { pacientes: [], erros: [] }, carregando = false, aberto = null, ocupado = false;
  const CSS_ABA = `
  .om30pd-btn{position:fixed;right:14px;bottom:18px;z-index:2147482000;border:0;border-radius:999px;background:#0f5132;color:#fff;padding:10px 16px;font:700 13px "Segoe UI",Arial;box-shadow:0 8px 22px rgba(15,35,55,.3);cursor:pointer}
  .om30pd-btn .n{background:#fff;color:#0f5132;border-radius:999px;padding:0 7px;margin-left:6px;font-size:12px}
  .om30pd{position:fixed;top:0;right:0;bottom:0;width:470px;max-width:97vw;background:#f5f8fa;z-index:2147482001;box-shadow:-10px 0 30px rgba(15,35,55,.25);display:none;flex-direction:column;font:13px/1.35 "Segoe UI",Arial,sans-serif;color:#1f2f3c}
  .om30pd.on{display:flex}.om30pd-topo{background:#0f5132;color:#fff;padding:11px 12px;display:flex;gap:8px;align-items:center}.om30pd-topo b{flex:1;font-size:14.5px}
  .om30pd-topo button{border:0;background:rgba(255,255,255,.15);color:#fff;border-radius:7px;padding:5px 9px;cursor:pointer;font:600 12px inherit}
  .om30pd-busca{padding:8px 12px}.om30pd-busca input{width:100%;box-sizing:border-box;border:1px solid #cfd8df;border-radius:8px;padding:7px 9px;font:13px inherit}
  .om30pd-lista{overflow:auto;flex:1;padding:0 12px 12px}.om30pd-p{background:#fff;border-radius:10px;padding:9px 10px;margin-bottom:7px;box-shadow:0 1px 3px rgba(15,35,55,.08);cursor:pointer}
  .om30pd-p:hover{box-shadow:0 0 0 2px #19875455}.om30pd-p .nm{font-weight:700}.om30pd-p .sub{color:#5f7383;font-size:11.5px;margin:1px 0 5px}
  .om30pd-s{display:inline-block;border-radius:6px;padding:2px 7px;margin:0 4px 4px 0;font-size:11.5px;font-weight:700;background:#e8eff5;color:#24435c}
  .om30pd-s.and{background:#fff3cd;color:#7a5600}.om30pd-abrir{margin-top:4px;font-size:12px;font-weight:700;color:#198754}.om30pd-vazio{color:#6b7f8e;text-align:center;padding:30px 10px}
  .om30pd-sl{margin-top:3px}.om30pd-itens{margin:2px 0 4px 6px;border-left:2px solid #e2e8ee;padding-left:8px}
  .om30pd-it{font-size:12px;line-height:1.35;margin:2px 0}.om30pd-it .mk{display:inline-block;width:14px;color:#8796a0}.om30pd-it small{color:#5f7383}
  .om30pd-it.feito{color:#6b7f8e}.om30pd-it.feito .mk{color:#198754}.om30pd-it.cancelado{color:#9aa7b0;text-decoration:line-through}.om30pd-it.cancelado .mk{color:#c0392b}
  .om30pd-it .obs{margin-left:14px;color:#7a5600;font-size:11.5px}.om30pd-it-nd{font-size:11.5px;color:#8796a0}
  .om30bl-it .tx small{display:block}
  .om30pd-sala{background:#fff;border-radius:10px;padding:8px 10px;margin-bottom:8px;box-shadow:0 1px 3px rgba(15,35,55,.08)}
  .om30pd-sala h4{margin:0 0 6px;font-size:13px;color:#0f5132;display:flex;gap:6px;align-items:center}.om30pd-sala h4 small{color:#6b7f8e;font-weight:600}
  .om30pd-fat{font-size:11.5px;color:#4a6272;background:#f1f6f9;border-radius:7px;padding:5px 7px;margin-top:4px}
  .om30pd-erro{color:#a12a1f;font-size:12px;white-space:pre-wrap;margin:4px 0}
  .om30pd-pac{padding:2px 12px 8px}.om30pd-pac .nm{font-size:15px;font-weight:800}.om30pd-pac .sub{color:#5f7383;font-size:12px}
  .om30pd-rod{padding:10px 12px;border-top:1px solid #e2e8ee;background:#fff}`;
  function montarAba() {
    css();
    if (!document.getElementById('om30pd-css')) { const st = document.createElement('style'); st.id = 'om30pd-css'; st.textContent = CSS_ABA; document.head.appendChild(st); }
    const btn = document.createElement('button');
    btn.className = 'om30pd-btn';
    btn.innerHTML = '📋 Pendências<span class="n">…</span>';
    aba = document.createElement('div');
    aba.className = 'om30pd';
    aba.innerHTML = `<div class="om30pd-topo"><b>📋 Pendências das salas</b><button data-a="rec">↻</button><button data-a="x">✕</button></div><div class="om30pd-conteudo" style="display:flex;flex-direction:column;flex:1;min-height:0"></div>`;
    document.body.append(btn, aba);
    btn.onclick = () => { aba.classList.add('on'); if (!aberto) atualizarAba(); };
    aba.querySelector('[data-a="x"]').onclick = () => { if (!ocupado) aba.classList.remove('on'); };
    aba.querySelector('[data-a="rec"]').onclick = () => { if (!ocupado) { aberto = null; atualizarAba(); } };
    ['keydown', 'keyup', 'keypress'].forEach(t => aba.addEventListener(t, e => e.stopPropagation()));
    const ciclo = async () => { if (!document.hidden && !aberto) await atualizarAba(true); btn.querySelector('.n').textContent = String(dados.pacientes.length); };
    ciclo(); setInterval(ciclo, 60000);
  }
  const conteudo = () => aba.querySelector('.om30pd-conteudo');
  async function atualizarAba(silencioso) {
    if (carregando || aberto) return;
    carregando = true;
    if (!silencioso) conteudo().innerHTML = '<div class="om30pd-vazio">Carregando…</div>';
    try { dados = await carregarPendencias(); } finally { carregando = false; }
    document.querySelector('.om30pd-btn .n').textContent = String(dados.pacientes.length);
    if (!aberto) pintarLista();
  }
  function pintarLista() {
    const c = conteudo();
    const busca = c.querySelector('.om30pd-busca input')?.value || '';
    c.innerHTML = '<div class="om30pd-busca"><input placeholder="Buscar nome ou senha…"></div><div class="om30pd-lista"></div>';
    const input = c.querySelector('input'); input.value = busca;
    const pinta = () => {
      const q = norm(input.value);
      const xs = dados.pacientes.filter(p => !q || norm(p.nome).includes(q) || norm(p.senha).includes(q));
      const el = c.querySelector('.om30pd-lista');
      el.innerHTML = (dados.erros.length ? `<div class="om30pd-erro">Não li: ${esc(dados.erros.join(' · '))}</div>` : '') +
        (xs.length ? xs.map((p, i) => `<div class="om30pd-p" data-i="${dados.pacientes.indexOf(p)}"><div class="nm">${esc(p.nome)}</div>
          <div class="sub">${[p.senha && `Senha <b>${esc(p.senha)}</b>`, `Atend. ${esc(p.atendimento.split('#')[1])}`].filter(Boolean).join(' · ')}</div>
          ${p.salas.map(s => `<div class="om30pd-sl"><span class="om30pd-s ${/ANDAMENTO/.test(norm(s.status)) ? 'and' : ''}">${esc(s.s.nome)} · ${esc(s.status)}</span>
            <div class="om30pd-itens" data-k="${s.s.k}" data-enc="${esc(s.enc)}">…</div></div>`).join('')}
          <div class="om30pd-abrir">Dar baixa ›</div></div>`).join('')
          : '<div class="om30pd-vazio">Nenhum paciente pendente em Medicação, Exames ou Enfermagem.</div>');
      el.querySelectorAll('.om30pd-p').forEach(d => d.onclick = () => abrirPaciente(dados.pacientes[+d.dataset.i]));
      preencherItens(el);
    };
    input.oninput = pinta; pinta();
  }

  const htmlItens = xs => xs === null ? '<span class="om30pd-it-nd">itens: abra para ver</span>'
    : !xs.length ? '<span class="om30pd-it-nd">nenhum item</span>'
    : xs.map(x => `<div class="om30pd-it ${x.estado}"><span class="mk">${x.estado === 'feito' ? '✔' : x.estado === 'cancelado' ? '✖' : '•'}</span><b>${esc(x.nome)}</b>${x.det ? ` <small>${esc(x.det)}</small>` : ''}${x.obs ? `<div class="obs">Obs.: ${esc(x.obs)}</div>` : ''}</div>`).join('');
  async function preencherItens(raiz) {
    const alvos = [...raiz.querySelectorAll('.om30pd-itens')];
    let i = 0;
    const trab = async () => { while (i < alvos.length) { const d = alvos[i++]; const xs = await itensDoMedico(d.dataset.k, d.dataset.enc); if (d.isConnected) d.innerHTML = htmlItens(xs); } };
    await Promise.all([trab(), trab(), trab()]);   // 3 por vez
  }

  async function abrirPaciente(p) {
    const salasTxt = p.salas.map(s => s.s.nome).join(', ');
    if (!confirm(`Abrir as fichas de ${p.nome}?\n\nSalas: ${salasTxt}\n\nComo ao clicar em Atender, o paciente fica "Em Andamento" nessas salas.`)) return;
    aberto = { p, fichas: [], erros: [], escolha: new Map() };
    const c = conteudo();
    c.innerHTML = '<div class="om30pd-vazio">Abrindo as fichas…</div>';
    for (const s of p.salas) {
      try {
        const f = await carregarFicha(s.s, s.enc);
        // nome, dose e via como o médico escreveu (consulta da sala), na mesma ordem da ficha
        const med = await itensDoMedico(s.s.k, s.enc);
        if (med && med.length === f.itens.length) f.itens.forEach((x, i) => { x.nome = med[i].nome || x.nome; x.det = med[i].det; x.obs = med[i].obs; });
        aberto.fichas.push(f);
      } catch (e) { aberto.erros.push(e.message); }
    }
    pintarPaciente();
  }
  function pintarPaciente(msgTxt = '', tipo = '') {
    const a = aberto, c = conteudo();
    const motAnt = c.querySelector('.om30pd-mot')?.value || '', reavAnt = !!c.querySelector('.om30pd-reav')?.checked, justAnt = c.querySelector('.om30pd-just')?.value || '';
    const abertos = a.fichas.flatMap(f => f.itens.filter(x => x.aberto).map(x => ({ f, x })));
    for (const { x } of abertos) if (!a.escolha.has(x.it)) a.escolha.set(x.it, 'fez');
    const nNao = abertos.filter(({ x }) => a.escolha.get(x.it) === 'nao').length;
    const motivosSala = [...new Set(abertos.filter(({ x }) => a.escolha.get(x.it) === 'nao').flatMap(({ f }) => (SALAS[f.s.k] || SALAS.medicacao).motivos))];
    c.innerHTML = `<div class="om30pd-pac"><button class="om30pd-voltar" style="border:0;background:none;color:#0f5132;font-weight:700;cursor:pointer;padding:6px 0">← Voltar</button>
        <div class="nm">${esc(a.p.nome)}</div><div class="sub">${[a.p.senha && 'Senha ' + esc(a.p.senha), 'Atend. ' + esc(a.p.atendimento.split('#')[1])].filter(Boolean).join(' · ')}</div></div>
      <div class="om30pd-lista">
        ${a.erros.map(e => `<div class="om30pd-erro">⚠ ${esc(e)}</div>`).join('')}
        ${abertos.length > 1 ? '<div class="om30bl-acoesgerais"><button data-todos="fez">✔ Tudo feito</button><button data-todos="nao">✖ Nada feito</button></div>' : ''}
        ${a.fichas.map((f, fi) => `<div class="om30pd-sala"><h4>${esc(f.s.nome)} <small>${f.itens.filter(x => x.aberto).length} pendente(s)</small></h4>
          ${f.itens.map(x => {
            if (!x.aberto) return `<div class="om30bl-it feito"><div class="tx"><b>${esc(x.nome)}</b><small>já resolvido</small></div></div>`;
            const v = a.escolha.get(x.it);
            return `<div class="om30bl-it ${v}" data-f="${fi}" data-i="${x.i}"><div class="tx"><b>${esc(x.nome)}</b>${x.det ? `<small>${esc(x.det)}</small>` : ''}${x.obs ? `<small>Obs.: ${esc(x.obs)}</small>` : ''}${x.estoque ? '<br><span class="om30bl-tag">baixa de estoque: fazer pela ficha</span>' : ''}</div>
              <div class="tg"><button data-v="fez" class="${v === 'fez' ? 'on' : ''}">✔ Fez</button><button data-v="nao" class="${v === 'nao' ? 'on' : ''}">✖ Não</button></div></div>`;
          }).join('') || '<div class="om30pd-vazio" style="padding:8px">Nada pendente nesta sala.</div>'}
          ${!f.bpaOk ? '<div class="om30pd-erro">Faturamento desta sala ainda não confirmado: esta sala fica para a ficha (painel ⚡ Baixa rápida) até a captura dela.</div>' : ''}</div>`).join('')}
        ${nNao ? `<div class="om30pd-sala"><h4 style="color:#8f2a22">Motivo do que não foi feito (${nNao})</h4><div class="om30bl-chips">${motivosSala.map(m => `<button data-m="${esc(m)}">${esc(m.replace(/\.$/, ''))}</button>`).join('')}</div>
          <textarea class="om30pd-mot" placeholder="Justificativa do cancelamento">${esc(motAnt)}</textarea></div>` : ''}
        <div class="om30pd-sala"><label class="om30bl-reav"><input type="checkbox" class="om30pd-reav"${reavAnt ? ' checked' : ''}> <span>Encaminhar para reavaliação médica</span></label>
          <textarea class="om30pd-just" placeholder="Justificativa para o médico"${reavAnt ? '' : ' hidden'}>${esc(justAnt)}</textarea>
          <div class="om30pd-fat">Sem marcar, o paciente segue o destino que o médico deixou (retorno ao médico, Raio-X…).</div></div>
        <div class="om30bl-msg ${tipo}">${esc(msgTxt)}</div>
      </div>
      <div class="om30pd-rod"><button class="om30bl-go">Dar baixa em tudo</button></div>`;
    c.querySelector('.om30pd-voltar').onclick = () => { if (ocupado) return; aberto = null; atualizarAba(); };
    c.querySelectorAll('.om30bl-it[data-f] .tg button').forEach(b => b.onclick = () => {
      const d = b.closest('[data-f]'); a.escolha.set(a.fichas[+d.dataset.f].itens[+d.dataset.i].it, b.dataset.v); pintarPaciente();
    });
    c.querySelectorAll('[data-todos]').forEach(b => b.onclick = () => { abertos.forEach(({ x }) => a.escolha.set(x.it, b.dataset.todos)); pintarPaciente(); });
    c.querySelectorAll('.om30bl-chips button').forEach(b => b.onclick = () => { c.querySelector('.om30pd-mot').value = b.dataset.m; validar(); });
    const rv = c.querySelector('.om30pd-reav'); rv.onchange = () => { c.querySelector('.om30pd-just').hidden = !rv.checked; validar(); };
    c.querySelectorAll('textarea').forEach(t => t.oninput = validar);
    const go = c.querySelector('.om30bl-go');
    go.onclick = () => darBaixaTudo();
    function validar() {
      const mot = clean(c.querySelector('.om30pd-mot')?.value), reav = rv.checked, just = clean(c.querySelector('.om30pd-just').value);
      const f = abertos.length - nNao;
      go.disabled = ocupado || !abertos.length || (nNao && !mot) || (reav && !just);
      go.textContent = !abertos.length ? 'Nada pendente' : `Dar baixa em tudo: ${f} feito(s)${nNao ? ` + ${nNao} cancelado(s)` : ''}`;
    }
    validar();
  }

  async function darBaixaTudo() {
    const a = aberto, c = conteudo();
    const motivo = clean(c.querySelector('.om30pd-mot')?.value), reav = !!c.querySelector('.om30pd-reav')?.checked, just = clean(c.querySelector('.om30pd-just')?.value);
    const plano = a.fichas.map(f => {
      const abertos = f.itens.filter(x => x.aberto);
      return { f, fez: abertos.filter(x => a.escolha.get(x.it) === 'fez'), nao: abertos.filter(x => a.escolha.get(x.it) === 'nao') };
    }).filter(p => p.fez.length || p.nao.length);
    if (!plano.length) return;
    ocupado = true;
    const go = c.querySelector('.om30bl-go'); go.disabled = true;
    const passo = t => { go.textContent = t; };
    // Conferência de tudo ANTES de salvar qualquer sala.
    try {
      for (const p of plano) {
        if (!p.f.bpaOk) throw new Error(`${p.f.s.nome}: faturamento em formato desconhecido`);
        for (const [lista, campos] of [[p.fez, REQUER[p.f.s.k].fez], [p.nao, REQUER[p.f.s.k].nao]])
          for (const x of lista) { const falta = campos.filter(c => ![].concat(c).some(y => inp(x.it, y))); if (falta.length) throw new Error(`${p.f.s.nome}: a ficha não tem o campo ${falta.map(c => [].concat(c).map(y => y.slice(1)).join(' ou ')).join(', ')} em "${x.nome}" (formato diferente do esperado)`); }
        const est = p.fez.filter(x => x.estoque);
        if (est.length) throw new Error(`${p.f.s.nome}: ${est.map(x => x.nome).join(', ')} pede almoxarifado/quantidade (baixa de estoque). Faça esta sala pela ficha.`);
        passo(`Conferindo faturamento · ${p.f.s.nome}…`);
        p.linhas = p.fez.length ? await montarFaturamento(p.f, p.fez) : [];
      }
    } catch (e) {
      ocupado = false;
      return pintarPaciente(`Nada foi salvo. ${e.message}`, 'erro');
    }
    const resumo = plano.map(p => `${p.f.s.nome.toUpperCase()}\n` +
      (p.fez.length ? `  ✔ ${p.fez.map(x => x.nome).join('\n  ✔ ')}\n` : '') +
      (p.nao.length ? `  ✖ ${p.nao.map(x => x.nome).join('\n  ✖ ')}\n` : '') +
      (p.linhas.length ? `  Faturamento: ${p.linhas.map(l => l.texto).join(' | ')}\n` : '')).join('\n');
    if (!confirm(`Dar baixa em ${a.p.nome}?\n\n${resumo}${plano.some(p => p.nao.length) ? `\nMotivo: ${motivo}\n` : ''}${reav ? `Reavaliação médica: ${just}\n` : ''}`)) { ocupado = false; return pintarPaciente(); }

    const feitas = [], log = [];
    let ultimo = null;
    try {
      const momento = momentoAgora();
      for (const [k, p] of plano.entries()) {
        passo(`Salvando ${p.f.s.nome} (${k + 1}/${plano.length})…`);
        const prof = p.f.profissional;
        if (p.nao.length && !prof) throw new Error(`${p.f.s.nome}: profissional atual não encontrado na ficha`);
        for (const x of p.fez) p.f.s.fazer(x.it);
        for (const x of p.nao) p.f.s.cancelar(x.it, { motivo, momento, profissional: prof });
        lancarFaturamento(p.f, p.linhas);
        if (reav && !marcarReavaliacao(p.f, true, just) && k === plano.length - 1) log.push(`${p.f.s.nome}: ficha sem opção de reavaliação`);
        const res = await salvarFicha(p.f);
        feitas.push(p.f.s.nome);
        await concluirSenhaSala(res, p.f, a.p.atendimento);
        ultimo = res;
        log.push(`✔ ${p.f.s.nome}: ${p.fez.length} feito(s), ${p.nao.length} cancelado(s)${p.linhas.length ? `, faturamento ${p.linhas.length} linha(s)` : ''}`);
      }
      // Senha para o destino final da última sala salva (o que o sistema faria na tela).
      const destino = (ultimo?.destinos || []).filter(Boolean).pop() || '';
      if (destino && a.p.senha && !/^[-—]$/.test(a.p.senha)) {
        passo('Encaminhando a senha…');
        try { await senhaParaDestino(a.p.atendimento, destino); log.push(`Senha ${a.p.senha} → ${NOME_DESTINO[destino] || destino}`); }
        catch (e) { log.push(`⚠ Senha não foi para ${NOME_DESTINO[destino] || destino} (${e.message}). Use Recuperar na fila de lá.`); }
      } else if (destino) log.push(`Destino: ${NOME_DESTINO[destino] || destino}`);
      console.log('[OM30 Baixa Rápida] baixa pela aba', { atendimento: a.p.atendimento, log });
      aberto = null; ocupado = false;
      alert(`✔ Baixa concluída — ${a.p.nome}\n\n${log.join('\n')}`);
      atualizarAba();
    } catch (e) {
      ocupado = false;
      console.warn('[OM30 Baixa Rápida] baixa pela aba falhou', e);
      const resto = plano.map(p => p.f.s.nome).filter(n => !feitas.includes(n));
      aberto = null;
      alert(`⚠ Parou: ${e.message}\n\n${feitas.length ? `Já salvo: ${feitas.join(', ')}\n` : 'Nada foi salvo.\n'}${resto.length ? `Não salvo: ${resto.join(', ')} — abra essas fichas para conferir.` : ''}`);
      atualizarAba();
    }
  }

  // ---------- início ----------
  function iniciar() {
    if (ehListaControle()) { montarAba(); return; }
    let tent = 0;
    const t = setInterval(() => {
      const sala = salaDaFicha();
      if (sala && !painel) {
        montarPainel(sala);
        let ag = null;
        new MutationObserver(() => { if (ag) return; ag = setTimeout(() => { ag = null; desenhar(sala); }, 250); })
          .observe(sala.form, { subtree: true, attributes: true, attributeFilter: ['value', 'disabled', 'class'], childList: true });
        setInterval(() => desenhar(sala), 1500);   // .value mudado por JS não dispara o observer
      }
      if (painel || ++tent > 40) clearInterval(t);
    }, 500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', iniciar, { once: true }); else iniciar();
})();
