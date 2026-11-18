// ==UserScript==
// @name         OM30 - Baixa Rápida do Controle de Salas
// @namespace    om30-guaruja
// @version      0.1.0
// @description  Enfermagem/técnicos: aba "Pendências" com todos os pacientes pendentes nas salas e, na ficha, baixa de tudo de uma vez (marca o que fez, cancela o que não fez com motivo, salva). Usa os próprios botões do Saúde Simples: faturamento (BPA), estoque e senha seguem o fluxo do sistema; a volta para o médico é a que o médico marcou.
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
      fez: it => ehSim(campo(it, '_realizado')) || ehSim(campo(it, '_realizada')),
      cancelou: it => ehSim(campo(it, '_cancelado')) || ehSim(campo(it, '_cancelada')),
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

  // ---------- aba Pendências (telas de lista do Controle de Salas) ----------
  // Mesmas tabelas da tela "Consultar Repousos/Medicações" (só leitura): [data, hora, nasc., nome, médico, senha, status].
  const CONSULTA = [
    ['Medicação', 'datatable_medicacoes'], ['Exames', 'datatable_exames'], ['Enfermagem', 'datatable_procedimentos_enfermagem'],
    ['Raio-X', 'datatable_radiografias'], ['Repouso', 'datatable_repousos'], ['Gesso', 'datatable_gessos_imobilizacoes'],
  ];
  function paramsConsulta() {
    const p = new URLSearchParams({ sEcho: '1', iColumns: '7', sColumns: '', iDisplayStart: '0', iDisplayLength: '500', sSearch: '', bRegex: 'false', iSortCol_0: '0', sSortDir_0: 'desc', iSortingCols: '1' });
    for (let i = 0; i < 7; i++) { p.set(`mDataProp_${i}`, String(i)); p.set(`sSearch_${i}`, ''); p.set(`bRegex_${i}`, 'false'); p.set(`bSearchable_${i}`, 'true'); p.set(`bSortable_${i}`, 'false'); }
    return p;
  }
  const tempo = (d, h) => { const a = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d), b = /^(\d{1,2}):(\d{2})/.exec(h); return a ? new Date(+a[3], +a[2] - 1, +a[1], b ? +b[1] : 0, b ? +b[2] : 0).getTime() : 0; };
  async function carregarPendencias() {
    const linhas = [];
    const erros = [];
    await Promise.all(CONSULTA.map(async ([sala, tabela]) => {
      try {
        const r = await fetch(`/consultar_repousos_medicacoes/${tabela}.json?${paramsConsulta()}`, { credentials: 'same-origin', cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        for (const l of j?.aaData || []) {
          const st = clean(l[6]);
          if (/FINALIZ|CANCEL|CONCLU/.test(norm(st))) continue;
          linhas.push({ sala, data: clean(l[0]), hora: clean(l[1]), nasc: clean(l[2]), nome: clean(l[3]), medico: clean(l[4]), senha: clean(l[5]), status: st });
        }
      } catch (e) { erros.push(`${sala}: ${e.message}`); }
    }));
    const limite = Date.now() - 24 * 3600e3;   // mais antigos que 24 h costumam ser encaminhamentos nunca fechados
    const por = new Map();
    for (const l of linhas) {
      if (tempo(l.data, l.hora) && tempo(l.data, l.hora) < limite) continue;
      const k = norm(l.nome) + '|' + l.nasc;
      if (!por.has(k)) por.set(k, { nome: l.nome, nasc: l.nasc, senha: '', medico: l.medico, salas: [], desde: Infinity });
      const p = por.get(k);
      p.salas.push(l); if (l.senha && !/^[-—]$/.test(l.senha)) p.senha = l.senha;
      p.desde = Math.min(p.desde, tempo(l.data, l.hora) || Infinity);
    }
    return { pacientes: [...por.values()].sort((a, b) => a.desde - b.desde), erros };
  }
  function ehListaControle() { return /^\/(aplicacoes_medicamentos|encaminhamentos_(exames|procedimentos_enfermagem|radiografias))\/?$/.test(location.pathname); }
  let aba = null, dados = { pacientes: [], erros: [] }, carregando = false;
  function montarAba() {
    css();
    const btn = document.createElement('button');
    btn.className = 'om30pd-btn';
    btn.innerHTML = '📋 Pendências<span class="n">…</span>';
    aba = document.createElement('div');
    aba.className = 'om30pd';
    aba.innerHTML = `<div class="om30pd-topo"><b>📋 Pendências das salas</b><button data-a="rec">↻ Atualizar</button><button data-a="x">✕</button></div>
      <div class="om30pd-busca"><input placeholder="Buscar nome ou senha…"></div><div class="om30pd-lista"></div>`;
    document.body.append(btn, aba);
    btn.onclick = () => { aba.classList.add('on'); atualizarAba(); };
    aba.querySelector('[data-a="x"]').onclick = () => aba.classList.remove('on');
    aba.querySelector('[data-a="rec"]').onclick = () => atualizarAba();
    aba.querySelector('input').oninput = () => pintarAba();
    ['keydown', 'keyup', 'keypress'].forEach(t => aba.addEventListener(t, e => e.stopPropagation()));
    const ciclo = async () => { if (!document.hidden) await atualizarAba(true); btn.querySelector('.n').textContent = String(dados.pacientes.length); };
    ciclo(); setInterval(ciclo, 60000);
  }
  async function atualizarAba(silencioso) {
    if (carregando) return;
    carregando = true;
    if (!silencioso) aba.querySelector('.om30pd-lista').innerHTML = '<div class="om30pd-vazio">Carregando…</div>';
    try { dados = await carregarPendencias(); } finally { carregando = false; }
    document.querySelector('.om30pd-btn .n').textContent = String(dados.pacientes.length);
    pintarAba();
  }
  function pintarAba() {
    const q = norm(aba.querySelector('input').value);
    const xs = dados.pacientes.filter(p => !q || norm(p.nome).includes(q) || norm(p.senha).includes(q));
    const el = aba.querySelector('.om30pd-lista');
    el.innerHTML = (dados.erros.length ? `<div class="om30bl-msg erro">Não li: ${esc(dados.erros.join(' · '))}</div>` : '') +
      (xs.length ? xs.map(p => `<div class="om30pd-p"><div class="nm">${esc(p.nome)}</div>
        <div class="sub">${[p.senha && `Senha <b>${esc(p.senha)}</b>`, p.nasc && `Nasc. ${esc(p.nasc)}`, p.medico && `Dr(a). ${esc(p.medico)}`].filter(Boolean).join(' · ')}</div>
        ${p.salas.map(s => `<span class="om30pd-s ${/ANDAMENTO/.test(norm(s.status)) ? 'and' : ''}" title="${esc(s.data)} ${esc(s.hora)}">${esc(s.sala)} · ${esc(s.status)} · ${esc(s.hora)}</span>`).join('')}</div>`).join('')
        : '<div class="om30pd-vazio">Nenhuma pendência nas salas (últimas 24 h).</div>');
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
