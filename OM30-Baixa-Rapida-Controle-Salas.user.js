// ==UserScript==
// @name         OM30 - Baixa Rápida do Controle de Salas
// @namespace    om30-guaruja
// @version      0.4.1
// @description  Enfermagem/técnicos: botão "Pendências" em cada paciente da fila, com o que o médico pediu em cada sala e baixa de TUDO do paciente (Medicação, Exames, Enfermagem, Raio-X) pela API, com o faturamento (BPA) uma linha por procedimento; na ficha, baixa de tudo de uma vez (marca o que fez, cancela o que não fez com motivo, salva). Usa os próprios botões do Saúde Simples: faturamento (BPA), estoque e senha seguem o fluxo do sistema; a volta para o médico é a que o médico marcou.
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
    },
    exames: {
      nome: 'Exames', verbo: 'Coletar', feito: 'coletado',
      form: 'form[id^="edit_encaminhamento_exame_"]',
      btnFez: '.btn-coletar-exame',
      btnCancelar: '.btn-cancelar-exame',
      fez: it => ehSim(campo(it, '_coletado')),
      cancelou: it => ehSim(campo(it, '_cancelado')),
    },
    enfermagem: {
      nome: 'Procedimentos de Enfermagem', verbo: 'Realizar', feito: 'realizado',
      form: 'form[id*="procedimento_enfermagem"], form[id*="procedimentoenfermagem"]',
      btnFez: null,   // botão "Realizar" achado pelo texto (classe ainda não capturada)
      btnCancelar: '.btn-cancelar-procedimento-enfermagem',
      fez: it => ehSim(campo(it, '_realizado')) || ehSim(campo(it, '_realizada')) || ehSim(campo(it, '_para_atendimento')),
      cancelou: it => ehSim(campo(it, '_cancelado')) || ehSim(campo(it, '_cancelada')) || ehSim(campo(it, '_para_cancelamento')),
    },
    raio_x: {
      nome: 'Raio-X', verbo: 'Realizar', feito: 'realizado',
      form: 'form[id*="encaminhamento_radiografia"]',
      btnFez: null,
      btnCancelar: '.btn-cancelar-radiografia',
      fez: it => ehSim(campo(it, '_realizado')) || ehSim(campo(it, '_realizada')),
      cancelou: it => ehSim(campo(it, '_cancelado')) || ehSim(campo(it, '_cancelada')),
    },
  };
  // Motivos do cancelamento pensados para o PA/UPA: curtos no botão, texto completo na justificativa.
  // Os comuns valem para qualquer sala; cada sala acrescenta os dela.
  const MOTIVOS_COMUNS = [
    ['Evadiu', 'Paciente evadiu da unidade antes do atendimento.'],
    ['Não respondeu ao chamado', 'Paciente não respondeu ao chamado.'],
    ['Recusou', 'Paciente recusou o procedimento.'],
    ['Médico suspendeu', 'Suspenso/alterado pelo médico.'],
    ['Foi para a emergência', 'Paciente encaminhado à sala de emergência; conduta alterada.'],
    ['Transferido', 'Paciente transferido/removido antes do atendimento.'],
    ['Pedido em duplicidade', 'Item prescrito em duplicidade.'],
  ];
  const MOTIVOS_SALA = {
    medicacao: [['Em falta', 'Medicação em falta na unidade.'], ['Já administrada', 'Medicação já administrada anteriormente.'], ['Sem acesso venoso', 'Sem acesso venoso (difícil acesso).'], ['Alergia referida', 'Paciente refere alergia ao medicamento; médico comunicado.']],
    exames: [['Insumo em falta', 'Insumo para coleta em falta na unidade.'], ['Sem acesso venoso', 'Sem acesso venoso para coleta (difícil acesso).'], ['Já coletado', 'Exame já coletado anteriormente.'], ['Não feito na unidade', 'Exame não realizado nesta unidade.']],
    enfermagem: [['Material em falta', 'Material em falta na unidade.'], ['Já realizado', 'Procedimento já realizado anteriormente.']],
    raio_x: [['Aparelho indisponível', 'Aparelho de Raio-X indisponível no momento.'], ['Possível gestação', 'Contraindicação (possível gestação); médico comunicado.'], ['Já realizado', 'Raio-X já realizado anteriormente.']],
  };
  function motivosPara(salas) {
    const out = [], vistos = new Set();
    for (const [c, t] of MOTIVOS_COMUNS) { out.push({ curto: c, texto: t, sala: '' }); vistos.add(t); }
    for (const k of salas) for (const [c, t] of MOTIVOS_SALA[k] || []) if (!vistos.has(t)) { vistos.add(t); out.push({ curto: c, texto: t, sala: k }); }
    return out;
  }
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
  .om30bl-chips button.on{background:#c0392b;color:#fff;border-color:#c0392b}.om30bl-chips button.sl{background:#fffaf3;border-color:#ecd9b8;color:#6b4a00}
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
      (nNao ? `<div class="om30bl-mot"><div class="rot">Motivo do que não foi feito (${nNao})</div><div class="om30bl-chips">${motivosPara([sala.k]).map(m => `<button data-m="${esc(m.texto)}" title="${esc(m.texto)}" class="${m.sala ? 'sl ' : ''}${m.texto === motTxt ? 'on' : ''}">${esc(m.curto)}</button>`).join('')}</div>
        <textarea placeholder="Justificativa do cancelamento">${esc(motTxt)}</textarea></div>` : '');
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
    if (xs.length && !await janela({ tipo: 'aviso', icone: '⚡', titulo: 'Dar baixa nesta ficha?', html: `<div style="white-space:pre-wrap;font-size:12.5px">${esc(resumo)}</div><div class="om30x-nota">Depois a ficha é salva e o paciente segue o destino que o médico deixou.</div>`, botoes: [{ txt: 'Voltar', valor: false }, { txt: 'Confirmar baixa', classe: 'p', valor: true }] })) return;
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
  const FORMATO_BPA_CONFIRMADO = { medicacao: true, exames: true, enfermagem: true, raio_x: true };
  // Campos que cada sala precisa ter na ficha. Conferidos ANTES de salvar qualquer sala.
  const REQUER = {
    medicacao: { fez: ['_tipo_uso_medicamento_id', '_para_atendimento'], nao: ['_cancelada', '_justificativa_cancelamento'] },   // [a, b] = um dos dois
    exames: { fez: ['_exame_id', '_coletado'], nao: ['_cancelado', '_justificativa_cancelamento'] },
    enfermagem: { fez: ['_procedimento_enfermagem_id', ['_para_atendimento', '_realizado']], nao: [['_cancelada', '_cancelado'], '_justificativa_cancelamento'] },
    raio_x: { fez: [['_para_atendimento', '_realizado', '_realizada']], nao: [['_cancelada', '_cancelado'], '_justificativa_cancelamento'] },
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
    {
      // 18/11: Raio-X não é faturado (sem BPA) e a baixa não grava o nome de quem fez.
      // Campos como a Medicação ("Realizar" no lugar de "Aplicar"); se vier o formato realizado/cancelado, usa esse.
      k: 'raio_x', nome: 'Raio-X', codigo: 'controle_de_salas_raio_x', lista: '/encaminhamentos_radiografias', fatura: false,
      abrir: id => `/encaminhamentos_radiografias/${encodeURIComponent(id)}/edit`,
      form: 'form[id*="encaminhamento_radiografia"]',
      proc: () => null,
      aberto: it => estiloMed(it) ? MED_ABERTO(it) : !['_realizado', '_realizada', '_cancelado', '_cancelada'].some(c => valor(it, c) === 'true'),
      fazer: it => { if (estiloMed(it)) return MED_FAZER(it); if (!poe(it, '_realizado', 'true')) { exigir(it, '_realizada'); poe(it, '_realizada', 'true'); } poe(it, '_cancelado', 'false'); poe(it, '_cancelada', 'false'); },
      cancelar: (it, c) => { if (estiloMed(it)) return MED_CANCELAR(it, c); poe(it, '_realizado', 'false'); poe(it, '_realizada', 'false'); if (!poe(it, '_cancelado', 'true')) { exigir(it, '_cancelada'); poe(it, '_cancelada', 'true'); } poe(it, '_para_cancelamento', 'true'); camposCancelamento(it, c); },
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
          if (!p.salas.some(y => y.s.k === s.k && y.enc === enc)) p.salas.push({ s, enc, status: clean(x.status), raw: x });
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
    raio_x: { url: id => `/encaminhamentos_radiografias/${id}`, chave: ['RADIOGRAFIA', 'EXAME', 'PROCEDIMENTO'] },
  };
  const CACHE_ITENS = new Map();
  // O que a fila do sistema já traz em cada linha (coluna "Exames", "Medicamentos", "Procedimentos"…),
  // como o Controle de Salas mostra. Lido do próprio item da lista, sem abrir nada.
  function nomesDaLista(raw) {
    if (!raw || typeof raw !== 'object') return [];
    const out = [];
    const nomeDe = o => typeof o === 'string' ? o : o && (o.nome || o.descricao || o.name || o.procedimento_text || o.text || o.produto || o.exame?.nome || o.exame?.descricao || o.procedimento?.nome || o.procedimento?.descricao || o.radiografia?.nome || o.produto?.nome);
    const chaveOk = k => /exame|procedimento|radiograf|medicament|produto|prescri|item/i.test(k) && !/_id$|^id$|data|hora|status|senha|municipe|profissional|medico|risco|atendimento/i.test(k);
    for (const [k, v] of Object.entries(raw)) {
      if (!chaveOk(k)) continue;
      if (Array.isArray(v)) for (const o of v) { const n = clean(nomeDe(o)); if (n) out.push(n); }
      else if (typeof v === 'string' && clean(v).length > 2 && !/^\d+$/.test(v) && !/#\d+$/.test(v)) out.push(...v.split(/\s*(?:<br\s*\/?>|\n|;|\|)\s*/i).map(t => clean(t.replace(/<[^>]+>/g, ' '))).filter(Boolean));
      else if (v && typeof v === 'object') { const n = clean(nomeDe(v)); if (n) out.push(n); }
    }
    if (!out.length) console.info('[OM30 Baixa Rápida] campos do item da fila (para achar os itens):', Object.keys(raw).join(', '));
    return [...new Set(out)];
  }
  async function itensDoMedico(k, enc) {
    const ck = `${k}#${enc}`, c = CACHE_ITENS.get(ck);
    if (c && Date.now() - c.em < 60e3) return c.v;
    let v = null;
    try {
      const cfg = CONSULTA_ITENS[k];
      // igual ao Controle de Salas: GET da consulta /{id} (nunca o /edit)
      const r = await fetch(cfg.url(enc), { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'text/html,application/xhtml+xml' } });
      if (r.ok && !/\/edit(\b|$)|\/new(\b|$)/.test(new URL(r.url || cfg.url(enc), location.href).pathname)) {
        const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
        for (const t of doc.querySelectorAll('table')) {
          const ths = [...(t.querySelector('thead') || t).querySelectorAll('th')].map(th => norm(th.textContent));
          const iNome = ths.findIndex(h => [].concat(cfg.chave).some(c => h.includes(c)));
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
        // Mesma leitura do Controle de Salas (extrairDetalhesShow, v3.x): a tabela com a coluna "Situação"
        // (fora as de profissional/especialidade); 1ª célula = o que o médico pediu, última = situação.
        if (!v) for (const t of doc.querySelectorAll('table')) {
          const hs = [...t.querySelectorAll('thead th, tr:first-child th')].map(th => norm(th.textContent));
          if (!hs.includes('SITUACAO') || hs.includes('PROFISSIONAL') || hs.includes('ESPECIALIDADE')) continue;
          const xs = [];
          for (const tr of t.querySelectorAll('tbody tr, tr')) {
            const cs = [...tr.querySelectorAll(':scope > td')].map(td => clean(td.textContent));
            if (cs.length < 2) continue;
            const nome = cs[0], sit = norm(cs[cs.length - 1]);
            if (!nome || /^(DESCRICAO|PROCEDIMENTO|EXAME|RADIOGRAFIA)$/.test(norm(nome))) continue;
            xs.push({ nome, det: cs.length > 2 ? cs.slice(1, -1).filter(t => t && !/^[-–—\s]*$/.test(t) && !/^0*\d{1,2}$/.test(t)).join(' · ').slice(0, 90) : '', obs: '',
              estado: /CANCEL/.test(sit) ? 'cancelado' : /COLETAD|REALIZAD|FINALIZAD|APLICAD/.test(sit) ? 'feito' : 'pendente' });
          }
          if (xs.length) { v = xs; break; }
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

  // ---------- interface: botão "Pendências" em cada linha da fila + painel lateral do paciente ----------
  const NOME_DESTINO = { atendimento: 'médico (retorno)', controle_de_salas_medicacao: 'Medicação', controle_de_salas_exames: 'Exames', controle_de_salas_raio_x: 'Raio-X', controle_de_salas_procedimento_enfermagem: 'Enfermagem', controle_de_salas_gesso_imobilizacao: 'Gesso' };
  const ICONE = { medicacao: '💊', exames: '🧪', enfermagem: '🩹', raio_x: '🩻' };
  function ehListaControle() { return /^\/(aplicacoes_medicamentos|encaminhamentos_(exames|procedimentos_enfermagem|radiografias))\/?$/.test(location.pathname); }

  const CSS_X = `
  .om30x-rowbtn{display:inline-flex;align-items:center;gap:5px;margin:3px 0 0;border:1px solid #9fd3b4;background:#effaf3;color:#0f5132;border-radius:6px;padding:3px 8px;font:700 11.5px "Segoe UI",Arial;cursor:pointer;white-space:nowrap;width:100%;justify-content:center;box-sizing:border-box}
  .om30x-rowbtn:hover{background:#198754;color:#fff;border-color:#198754}.om30x-rowbtn .n{background:#198754;color:#fff;border-radius:999px;padding:0 6px;font-size:10.5px}
  .om30x-rowbtn:hover .n{background:#fff;color:#198754}
  .om30x-fundo{position:fixed;inset:0;background:rgba(10,25,40,.28);z-index:2147482000;opacity:0;pointer-events:none;transition:opacity .15s}
  .om30x-fundo.on{opacity:1;pointer-events:auto}
  .om30x{position:fixed;top:0;right:0;bottom:0;width:480px;max-width:97vw;background:#f3f6f8;z-index:2147482001;box-shadow:-14px 0 40px rgba(10,25,40,.25);display:flex;flex-direction:column;font:13.5px/1.4 "Segoe UI",Arial,sans-serif;color:#1d2d3a;transform:translateX(105%);transition:transform .18s ease}
  .om30x.on{transform:none}
  .om30x *{box-sizing:border-box}
  .om30x-cab{background:linear-gradient(135deg,#0f5132,#157347);color:#fff;padding:14px 16px 12px}
  .om30x-cab .l1{display:flex;align-items:center;gap:8px}.om30x-cab .t{font-size:11px;letter-spacing:.7px;text-transform:uppercase;opacity:.8;flex:1;font-weight:700}
  .om30x-cab .x{border:0;background:rgba(255,255,255,.16);color:#fff;width:30px;height:30px;border-radius:8px;font-size:15px;cursor:pointer}
  .om30x-cab .x:hover{background:rgba(255,255,255,.28)}
  .om30x-cab .nm{font-size:18px;font-weight:800;margin-top:4px;line-height:1.2}
  .om30x-cab .tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}.om30x-cab .tag{background:rgba(255,255,255,.16);border-radius:6px;padding:2px 8px;font-size:12px;font-weight:600}
  .om30x-cab .tag.s{background:#fff;color:#0f5132;font-weight:800}
  .om30x-corpo{flex:1;overflow:auto;padding:12px}
  .om30x-barra{display:flex;justify-content:flex-end;margin:-2px 0 8px}.om30x-barra button{border:0;background:none;padding:2px 4px;font:700 12px inherit;cursor:pointer;color:#157347;text-decoration:underline}
  .om30x-barra button:hover{border-color:#198754;color:#0f5132}
  .om30x-sala{background:#fff;border-radius:12px;margin-bottom:10px;box-shadow:0 1px 4px rgba(10,25,40,.07);overflow:hidden}
  .om30x-sala .h{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid #eef2f5}
  .om30x-sala .h .ic{font-size:16px}.om30x-sala .h b{flex:1;font-size:14px}.om30x-sala .h .st{font-size:11px;font-weight:700;border-radius:999px;padding:2px 8px;background:#e8eff5;color:#3d5a70}
  .om30x-sala .h .st.and{background:#fff3cd;color:#7a5600}
  .om30x-it{display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:1px solid #f1f4f6;transition:background .1s}
  .om30x-it:last-child{border-bottom:0}.om30x-it.nao{background:#fff6f5}.om30x-it .tx{flex:1;min-width:0}
  .om30x-it .tx b{display:block;font-size:13.5px;word-break:break-word}.om30x-it .tx small{display:block;color:#62788a;font-size:12px}
  .om30x-it .tx .obs{color:#8a5a00;font-size:12px}.om30x-it.nao .tx b{color:#8f2a22;text-decoration:line-through}
  .om30x-it.res{opacity:.55}.om30x-it.res .tx b{font-weight:600}
  .om30x-seg{display:flex;border:1px solid #d3dce3;border-radius:9px;overflow:hidden;flex:none}
  .om30x-seg button{border:0;background:#fff;padding:6px 10px;font:700 12px inherit;cursor:pointer;color:#5f7383}
  .om30x-seg button+button{border-left:1px solid #d3dce3}
  .om30x-seg button.on.f{background:#198754;color:#fff}.om30x-seg button.on.n{background:#c0392b;color:#fff}
  .om30x-feito{font-size:11.5px;font-weight:700;color:#198754;flex:none}.om30x-feito.c{color:#c0392b}
  .om30x-vazio{padding:12px;color:#6b7f8e;font-size:12.5px}.om30x-vazio button{margin-top:6px;border:1px solid #198754;background:#fff;color:#0f5132;border-radius:7px;padding:5px 10px;font:700 12px inherit;cursor:pointer}
  .om30x-tag{display:inline-block;margin-top:3px;font-size:11px;font-weight:700;border-radius:5px;padding:1px 6px;background:#fff3cd;color:#7a5600}
  .om30x-bloco{background:#fff;border-radius:12px;padding:11px 12px;margin-bottom:10px;box-shadow:0 1px 4px rgba(10,25,40,.07)}
  .om30x-bloco .rot{font-weight:800;font-size:12.5px;margin-bottom:6px}.om30x-bloco .rot.r{color:#8f2a22}
  .om30x-chips{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:7px}.om30x-chips button{border:1px solid #e6c9c5;background:#fff;border-radius:8px;padding:6px 8px;font:700 12px inherit;cursor:pointer;color:#7a2a22;text-align:left;line-height:1.2}.om30x-chips button:hover{border-color:#c0392b}.om30x-chips button.sl{background:#fffaf3;border-color:#ecd9b8;color:#6b4a00}
  .om30x-chips button.on{background:#c0392b;border-color:#c0392b;color:#fff}
  .om30x textarea{width:100%;min-height:52px;border:1px solid #d3dce3;border-radius:8px;padding:7px 9px;font:13px inherit;resize:vertical}
  .om30x textarea:focus{outline:2px solid #19875455;border-color:#198754}
  .om30x-chk{display:flex;gap:8px;align-items:center;font-weight:700;font-size:12.5px;cursor:pointer}.om30x-chk input{width:16px;height:16px}
  .om30x-nota{font-size:12px;color:#62788a;margin-top:6px}
  .om30x-mot{background:#fff6f5;border-top:1px dashed #f0c9c4;padding:8px 12px 10px}.om30x-mot .rot{font-weight:800;font-size:12px;color:#8f2a22;margin-bottom:6px}
  .om30x-outro{display:flex;gap:6px}.om30x-outro input{flex:1;border:1px solid #d3dce3;border-radius:8px;padding:6px 9px;font:13px inherit}
  .om30x-outro button{border:0;border-radius:8px;background:#c0392b;color:#fff;font:700 12px inherit;padding:0 14px;cursor:pointer}
  .om30x-todos{margin-top:7px;font-size:12px;color:#7a2a22}
  .om30x-motok{background:#fff6f5;padding:0 12px 8px 12px;font-size:12px;font-weight:700;color:#8f2a22;cursor:pointer}.om30x-motok span{color:#62788a;font-weight:600;text-decoration:underline;margin-left:4px}
  .om30x-erro{background:#fdecea;color:#8f2a22;border-radius:9px;padding:8px 10px;font-size:12.5px;margin-bottom:10px;white-space:pre-wrap}
  .om30x-rod{background:#fff;border-top:1px solid #e2e8ee;padding:12px}
  .om30x-res{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:9px;font-size:12px;font-weight:700}.om30x-res span{border-radius:999px;padding:3px 9px;background:#e9f6ee;color:#0f5132}.om30x-res span.n{background:#fdecea;color:#8f2a22}
  .om30x-go{width:100%;border:0;border-radius:10px;background:#198754;color:#fff;padding:12px;font:800 14px inherit;cursor:pointer;box-shadow:0 4px 12px rgba(25,135,84,.3)}
  .om30x-go:hover{background:#157347}.om30x-go:disabled{background:#a9bdb1;box-shadow:none;cursor:default}
  .om30x-carr{display:flex;align-items:center;gap:10px;justify-content:center;padding:40px 10px;color:#5f7383}
  .om30x-spin{width:18px;height:18px;border:3px solid #cfe3d7;border-top-color:#198754;border-radius:50%;animation:om30xg .8s linear infinite}
  @keyframes om30xg{to{transform:rotate(360deg)}}
  /* janela própria (no lugar do confirm/alert do navegador) */
  .om30x-dlgf{position:fixed;inset:0;background:rgba(10,25,40,.45);z-index:2147483600;display:flex;align-items:center;justify-content:center;padding:16px;font:13.5px/1.4 "Segoe UI",Arial,sans-serif;color:#1d2d3a}
  .om30x-dlg{background:#fff;border-radius:14px;width:min(460px,96vw);max-height:88vh;display:flex;flex-direction:column;box-shadow:0 24px 60px rgba(0,0,0,.3);overflow:hidden}
  .om30x-dlg .dh{padding:14px 16px 10px;display:flex;gap:10px;align-items:center}.om30x-dlg .dh .ic{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;font-size:17px;background:#e9f6ee;flex:none}
  .om30x-dlg.erro .dh .ic{background:#fdecea}.om30x-dlg.aviso .dh .ic{background:#fff3cd}
  .om30x-dlg .dh b{font-size:15.5px}.om30x-dlg .dc{padding:0 16px 6px;overflow:auto}
  .om30x-dlg .db{display:flex;gap:8px;justify-content:flex-end;padding:12px 16px 14px}
  .om30x-dlg .db button{border:0;border-radius:9px;padding:9px 16px;font:700 13px inherit;cursor:pointer;background:#eef2f5;color:#33485a}
  .om30x-dlg .db button.p{background:#198754;color:#fff}.om30x-dlg .db button.d{background:#c0392b;color:#fff}
  .om30x-rs{border:1px solid #eef2f5;border-radius:10px;margin-bottom:8px;overflow:hidden}
  .om30x-rs .rh{background:#f6f9fb;padding:6px 10px;font-weight:800;font-size:12.5px}
  .om30x-rs ul{margin:0;padding:6px 10px 6px 26px;font-size:12.5px}.om30x-rs li{margin:2px 0}.om30x-rs li.n{color:#8f2a22}
  .om30x-rs .fat{padding:6px 10px;border-top:1px dashed #e2e8ee;font-size:11.5px;color:#3d5a70}.om30x-rs .fat b{display:block;font-size:11px;color:#62788a;text-transform:uppercase;letter-spacing:.4px}
  .om30x-passos{list-style:none;margin:0;padding:0}.om30x-passos li{display:flex;gap:8px;align-items:center;padding:5px 0;font-size:13px}
  .om30x-passos .b{width:18px;text-align:center}`;
  function cssX() { if (document.getElementById('om30x-css')) return; const st = document.createElement('style'); st.id = 'om30x-css'; st.textContent = CSS_X; document.head.appendChild(st); }

  // Janela: { tipo: 'ok'|'aviso'|'erro', icone, titulo, html, botoes: [{ txt, classe, valor }] } → valor do botão
  function janela({ tipo = 'ok', icone = '✅', titulo, html = '', botoes = [{ txt: 'OK', classe: 'p', valor: true }] }) {
    cssX();
    return new Promise(res => {
      const f = document.createElement('div');
      f.className = 'om30x-dlgf';
      f.innerHTML = `<div class="om30x-dlg ${tipo}"><div class="dh"><span class="ic">${icone}</span><b>${esc(titulo)}</b></div><div class="dc">${html}</div><div class="db"></div></div>`;
      const db = f.querySelector('.db');
      const fechar = v => { f.remove(); document.removeEventListener('keydown', tecla, true); res(v); };
      for (const b of botoes) { const e = document.createElement('button'); e.textContent = b.txt; if (b.classe) e.className = b.classe; e.onclick = () => fechar(b.valor); db.appendChild(e); }
      const tecla = ev => { if (ev.key === 'Escape') { ev.stopPropagation(); fechar(botoes.find(b => b.valor === false || b.valor === null)?.valor ?? null); } };
      document.addEventListener('keydown', tecla, true);
      document.body.appendChild(f);
      setTimeout(() => db.querySelector('button.p, button.d, button:last-child')?.focus(), 30);
    });
  }
  function janelaProgresso(titulo) {
    cssX();
    const f = document.createElement('div');
    f.className = 'om30x-dlgf';
    f.innerHTML = `<div class="om30x-dlg"><div class="dh"><span class="ic"><span class="om30x-spin"></span></span><b>${esc(titulo)}</b></div><div class="dc"><ul class="om30x-passos"></ul></div><div class="db"></div></div>`;
    document.body.appendChild(f);
    const ul = f.querySelector('ul');
    return {
      passo(txt) { const li = document.createElement('li'); li.innerHTML = `<span class="b"><span class="om30x-spin" style="width:13px;height:13px;border-width:2px"></span></span><span>${esc(txt)}</span>`; ul.appendChild(li); return { ok: (t) => { li.querySelector('.b').textContent = '✔'; li.querySelector('.b').style.color = '#198754'; if (t) li.lastChild.textContent = t; }, erro: (t) => { li.querySelector('.b').textContent = '✖'; li.querySelector('.b').style.color = '#c0392b'; if (t) li.lastChild.textContent = t; } }; },
      fechar() { f.remove(); },
    };
  }

  // ---------- linha da fila → atendimento ----------
  // Itens que o Vue da fila do Controle de Salas tem (nome, senha, atendimento_str, encaminhamento_id).
  function itensDaFila() {
    const vistos = new Set(), out = [];
    for (const el of document.querySelectorAll('table, tbody, tr')) {
      const vm = el.__vue__;
      if (!vm || vistos.has(vm)) continue;
      vistos.add(vm);
      for (let v = vm, n = 0; v && n < 4; v = v.$parent, n++) {
        for (const arr of [v.items, v.$data?.items, v.$props?.items, v.colecao, v.collection])
          if (Array.isArray(arr)) for (const it of arr) if (it?.atendimento_str && !out.includes(it)) out.push(it);
      }
    }
    return out;
  }
  function itemDaLinha(tr, itens) {
    const t = norm(tr.textContent);
    const cands = itens.filter(it => it.nome_municipe && t.includes(norm(it.nome_municipe)));
    if (cands.length <= 1) return cands[0] || null;
    const porSenha = cands.filter(it => it.senha && t.includes(norm(it.senha)));
    return porSenha.length === 1 ? porSenha[0] : null;
  }
  let PEND = { em: 0, por: new Map(), promessa: null };
  async function pendenciasCache(forcar) {
    if (!forcar && Date.now() - PEND.em < 30e3) return PEND;
    if (PEND.promessa) return PEND.promessa;
    PEND.promessa = carregarPendencias().then(d => { PEND = { em: Date.now(), por: new Map(d.pacientes.map(p => [p.atendimento, p])), erros: d.erros, promessa: null }; return PEND; })
      .catch(() => { PEND.promessa = null; return PEND; });
    return PEND.promessa;
  }
  function instalarBotoesLinhas() {
    cssX();
    const tick = () => {
      if (document.hidden) return;
      const linhas = [...document.querySelectorAll('tr')].filter(tr => tr.querySelector('.botao-atender, .botao-chamar'));
      if (!linhas.length) return;
      const itens = itensDaFila();
      for (const tr of linhas) {
        const it = itemDaLinha(tr, itens);
        let b = tr.querySelector('.om30x-rowbtn');
        if (!it) { b?.remove(); continue; }
        if (!b) {
          b = document.createElement('button');
          b.type = 'button'; b.className = 'om30x-rowbtn';
          b.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); abrirPainel(b._it, b.closest('tr')); }, true);
          const alvo = tr.querySelector('.botao-atender')?.closest('td') || tr.cells[tr.cells.length - 1];
          alvo?.appendChild(b);
        }
        b._it = it;
        const p = PEND.por.get(String(it.atendimento_str));
        const n = p ? p.salas.length : 0;
        const html = `📋 Pendências${n > 1 ? ` <span class="n">${n} salas</span>` : ''}`;
        if (b.dataset.h !== html) { b.dataset.h = html; b.innerHTML = html; }
        b.title = p ? `Pendências em: ${p.salas.map(s => s.s.nome).join(', ')}` : 'Ver e dar baixa em tudo deste paciente';
      }
    };
    setInterval(tick, 1200);
    const ciclo = async () => { if (!document.hidden) { await pendenciasCache(true); tick(); } };
    ciclo(); setInterval(ciclo, 45000);
  }

  // ---------- painel lateral do paciente ----------
  let painelX = null, fundoX = null, estado = null, ocupado = false;
  function montarPainelX() {
    if (painelX) return;
    cssX(); css();
    fundoX = document.createElement('div'); fundoX.className = 'om30x-fundo';
    painelX = document.createElement('div'); painelX.className = 'om30x';
    document.body.append(fundoX, painelX);
    fundoX.onclick = () => fecharPainel();
    ['keydown', 'keyup', 'keypress'].forEach(t => painelX.addEventListener(t, e => e.stopPropagation()));
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && painelX.classList.contains('on') && !document.querySelector('.om30x-dlgf')) fecharPainel(); });
  }
  function fecharPainel() { if (ocupado) return; painelX?.classList.remove('on'); fundoX?.classList.remove('on'); estado = null; }
  const chave = (k, enc, i) => `${k}#${enc}#${i}`;

  // Coluna "Exames"/"Medicamentos"/"Procedimentos" da própria linha da fila (o que o médico pediu, como aparece na tela).
  function nomesDaLinha(tr) {
    if (!tr) return [];
    const tab = tr.closest('table');
    const ths = [...(tab?.querySelectorAll('thead th') || [])];
    const i = ths.findIndex(th => /EXAME|MEDICAMENTO|MEDICACAO|PROCEDIMENTO|RADIOGRAF/.test(norm(th.textContent)) && !/MEDICO/.test(norm(th.textContent)));
    const td = i >= 0 ? tr.cells[i] : null;
    if (!td) return [];
    const partes = [...td.querySelectorAll('li, span, div, p')].filter(e => !e.children.length).map(e => clean(e.textContent)).filter(t => t.length > 2);
    const lista = partes.length ? partes : clean(td.innerText || td.textContent).split(/\n|;/).map(clean).filter(t => t.length > 2);
    return [...new Set(lista)];
  }

  async function abrirPainel(it, tr) {
    montarPainelX();
    painelX.classList.add('on'); fundoX.classList.add('on');
    estado = { at: String(it.atendimento_str), nome: clean(it.nome_municipe), senha: clean(it.senha), salas: [], escolha: new Map(), motivos: new Map(), editando: '', outro: '', motivo: '', reav: false, just: '', carregando: true, erros: [] };
    pintarPainel();
    const st = estado;
    const pend = await pendenciasCache(true);
    if (estado !== st) return;
    const p = pend.por.get(st.at);
    if (pend.erros?.length) st.erros.push(...pend.erros.map(e => 'Não li ' + e));
    st.salas = (p ? p.salas : []).map(x => ({ s: x.s, enc: x.enc, status: x.status, med: undefined, ficha: null }));
    if (p?.senha && !st.senha) st.senha = p.senha;
    // ordem: Medicação, Exames, Enfermagem (como o médico costuma mandar)
    await Promise.all(st.salas.map(async x => {
      x.med = await itensDoMedico(x.s.k, x.enc);
      x.fonte = x.med ? 'consulta' : '';
      if (!x.med) {   // sem tela de consulta: o que a fila mostra (ex.: coluna "Exames")
        let nomes = nomesDaLista(x.raw);
        if (!nomes.length && location.pathname.replace(/\/$/, '') === x.s.lista) nomes = nomesDaLinha(tr);
        if (nomes.length) { x.med = nomes.map(n => ({ nome: n, det: '', obs: '', estado: 'pendente' })); x.fonte = 'lista'; }
      }
    }));
    if (estado !== st) return;
    st.carregando = false;
    pintarPainel();
  }

  // Itens que o técnico decide: da consulta (o que o médico pediu); sem consulta, da ficha aberta.
  function itensDaSala(x) {
    if (x.med) return x.med.map((m, i) => ({ i, nome: m.nome, det: m.det, obs: m.obs, pendente: m.estado === 'pendente', estado: m.estado, estoque: x.ficha?.itens[i]?.estoque }));
    if (x.ficha) return x.ficha.itens.map(f => ({ i: f.i, nome: f.nome, det: f.det || '', obs: f.obs || '', pendente: f.aberto, estado: f.aberto ? 'pendente' : 'feito', estoque: f.estoque }));
    return null;
  }
  function pendentesTodos() {
    const out = [];
    for (const x of estado.salas) for (const y of itensDaSala(x) || []) if (y.pendente) {
      const k = chave(x.s.k, x.enc, y.i);
      if (!estado.escolha.has(k)) estado.escolha.set(k, 'fez');
      out.push({ x, y, k, v: estado.escolha.get(k) });
    }
    return out;
  }

  function pintarPainel() {
    const e = estado;
    if (!e || !painelX) return;
    const ativo = document.activeElement;
    const foco = ativo && painelX.contains(ativo) && ativo.dataset.f ? ativo.dataset.f : '';
    const cab = `<div class="om30x-cab"><div class="l1"><span class="t">Pendências do paciente</span><button class="x" data-a="fechar" title="Fechar (Esc)">✕</button></div>
      <div class="nm">${esc(e.nome || 'Paciente')}</div>
      <div class="tags">${e.senha ? `<span class="tag s">${esc(e.senha)}</span>` : ''}<span class="tag">Atend. ${esc(e.at.split('#')[1])}</span>${e.salas.length ? `<span class="tag">${e.salas.length} sala${e.salas.length > 1 ? 's' : ''}</span>` : ''}</div></div>`;
    if (e.carregando) { painelX.innerHTML = cab + '<div class="om30x-corpo"><div class="om30x-carr"><span class="om30x-spin"></span> Buscando o que o médico pediu…</div></div>'; ligarPainel(); return; }
    const pend = pendentesTodos();
    const nF = pend.filter(p => p.v === 'fez').length, nN = pend.length - nF;
    // O motivo é por item: o 1º "Não" sem motivo abre a escolha; escolheu, fecha e passa para o próximo.
    const semMotivo = pend.filter(p => p.v === 'nao' && !clean(e.motivos.get(p.k)));
    const abrindo = e.editando && pend.some(p => p.k === e.editando && p.v === 'nao') ? e.editando : (semMotivo[0]?.k || '');
    const curtoDe = t => motivosPara(Object.keys(MOTIVOS_SALA)).find(m => m.texto === t)?.curto || t;
    const salasHtml = e.salas.map((x, xi) => {
      const its = itensDaSala(x);
      const corpo = its === null
        ? `<div class="om30x-vazio">Não consegui ler os itens desta sala sem abrir a ficha.<br><button data-a="abrirficha" data-x="${xi}">Abrir a ficha desta sala</button><div class="om30x-nota">Abrir a ficha deixa o paciente "Em Andamento" nela, como o Atender.</div></div>`
        : !its.length ? '<div class="om30x-vazio">Nenhum item.</div>'
        : its.map(y => {
          const k = chave(x.s.k, x.enc, y.i), v = e.escolha.get(k);
          const tx = `<div class="tx"><b>${esc(y.nome)}</b>${y.det ? `<small>${esc(y.det)}</small>` : ''}${y.obs ? `<small class="obs">Obs.: ${esc(y.obs)}</small>` : ''}${y.estoque && y.pendente ? '<span class="om30x-tag">pede almoxarifado/quantidade: fazer pela ficha</span>' : ''}</div>`;
          if (!y.pendente) return `<div class="om30x-it res">${tx}<span class="om30x-feito ${y.estado === 'cancelado' ? 'c' : ''}">${y.estado === 'cancelado' ? '✖ cancelado' : '✔ já feito'}</span></div>`;
          const mot = clean(e.motivos.get(k));
          const linha = `<div class="om30x-it ${v === 'nao' ? 'nao' : ''}">${tx}<div class="om30x-seg"><button class="f ${v === 'fez' ? 'on' : ''}" data-k="${esc(k)}" data-v="fez">✔ ${esc(x.s.k === 'medicacao' ? 'Aplicado' : x.s.k === 'exames' ? 'Coletado' : 'Realizado')}</button><button class="n ${v === 'nao' ? 'on' : ''}" data-k="${esc(k)}" data-v="nao">✖ Não</button></div></div>`;
          if (v !== 'nao') return linha;
          if (k !== abrindo) return linha + `<div class="om30x-motok" data-editar="${esc(k)}" title="Trocar o motivo">✖ ${esc(curtoDe(mot))} <span>trocar</span></div>`;
          const outros = semMotivo.filter(p => p.k !== k).length;
          return linha + `<div class="om30x-mot"><div class="rot">Por que não ${esc(x.s.k === 'medicacao' ? 'aplicou' : x.s.k === 'exames' ? 'coletou' : 'realizou')}?</div>
            <div class="om30x-chips">${motivosPara([x.s.k]).map(m => `<button data-k="${esc(k)}" data-m="${esc(m.texto)}" title="${esc(m.texto)}" class="${m.sala ? 'sl ' : ''}${m.texto === mot ? 'on' : ''}">${esc(m.curto)}</button>`).join('')}</div>
            <div class="om30x-outro"><input data-f="outro" data-k="${esc(k)}" placeholder="Outro motivo…" value="${esc(e.outro)}"><button data-ok="${esc(k)}">OK</button></div>
            ${outros ? `<label class="om30x-chk om30x-todos"><input type="checkbox" data-f="todosmot"${e.todosMot ? ' checked' : ''}> Usar o mesmo motivo nos outros ${outros} item(ns)</label>` : ''}</div>`;
        }).join('');
      return `<div class="om30x-sala"><div class="h"><span class="ic">${ICONE[x.s.k] || '•'}</span><b>${esc(x.s.nome)}</b><span class="st ${/ANDAMENTO/.test(norm(x.status)) ? 'and' : ''}">${esc(x.status)}</span></div>${corpo}</div>`;
    }).join('');
    painelX.innerHTML = cab + `<div class="om30x-corpo">
      ${e.erros.map(t => `<div class="om30x-erro">⚠ ${esc(t)}</div>`).join('')}
      ${!e.salas.length ? '<div class="om30x-vazio">Nenhuma pendência em Medicação, Exames, Enfermagem ou Raio-X para este atendimento.</div>' : ''}
      ${pend.some(p => p.v === 'nao') ? '<div class="om30x-barra"><button data-a="todos" data-v="fez">↺ Voltar todos para feito</button></div>' : ''}
      ${salasHtml}
      ${'' ? `<div class="om30x-bloco"><div class="rot r">Por que não foi feito? (${nN})</div><div class="om30x-chips">${motivos.map(m => `<button data-m="${esc(m.texto)}" title="${esc(m.texto)}" class="${m.sala ? 'sl ' : ''}${m.texto === e.motivo ? 'on' : ''}">${m.sala ? (ICONE[m.sala] || '') + ' ' : ''}${esc(m.curto)}</button>`).join('')}</div>
        <textarea data-f="motivo" placeholder="Toque num motivo acima ou escreva">${esc(e.motivo)}</textarea></div>` : ''}
      ${e.salas.length ? '<div class="om30x-nota" style="padding:0 4px">Depois da baixa o paciente segue o destino que o médico deixou (retorno ao médico, Raio-X…).</div>' : ''}
    </div>
    <div class="om30x-rod">${pend.length ? `<div class="om30x-res"><span>✔ ${nF} ${nF === 1 ? 'feito' : 'feitos'}</span>${nN ? `<span class="n">✖ ${nN} não ${nN === 1 ? 'feito' : 'feitos'}</span>` : ''}</div>` : ''}
      <button class="om30x-go" data-a="go">Realizar tudo e dar baixa</button></div>`;
    ligarPainel();
    if (foco) { const t = painelX.querySelector(`[data-f="${foco}"]`); if (t) { t.focus(); try { t.setSelectionRange(t.value.length, t.value.length); } catch {} } }
    validarPainel();
  }
  function validarPainel() {
    const e = estado, go = painelX.querySelector('[data-a="go"]');
    if (!go || !e) return;
    const pend = pendentesTodos(), nN = pend.filter(p => p.v === 'nao').length;
    const sem = pend.filter(p => p.v === 'nao' && !clean(e.motivos.get(p.k))).length;
    const falta = ocupado ? 'Dando baixa…' : !pend.length ? 'Nada pendente' : sem ? `Falta o motivo de ${sem} item(ns)` : '';
    go.disabled = !!falta;
    go.textContent = falta || `Dar baixa · ${pend.length} ${pend.length === 1 ? 'item' : 'itens'}`;
  }
  function ligarPainel() {
    const e = estado;
    painelX.querySelector('[data-a="fechar"]').onclick = () => fecharPainel();
    painelX.querySelectorAll('.om30x-seg button').forEach(b => b.onclick = () => { e.escolha.set(b.dataset.k, b.dataset.v); e.editando = b.dataset.v === 'nao' && !clean(e.motivos.get(b.dataset.k)) ? b.dataset.k : ''; pintarPainel(); });
    painelX.querySelectorAll('[data-a="todos"]').forEach(b => b.onclick = () => { for (const p of pendentesTodos()) e.escolha.set(p.k, b.dataset.v); pintarPainel(); });
    const definir = (k, texto) => {
      e.motivos.set(k, texto); e.outro = ''; e.editando = '';
      if (e.todosMot) for (const p of pendentesTodos()) if (p.v === 'nao' && !clean(e.motivos.get(p.k))) e.motivos.set(p.k, texto);
      e.todosMot = false;
      pintarPainel();
    };
    painelX.querySelectorAll('.om30x-mot .om30x-chips button').forEach(b => b.onclick = () => definir(b.dataset.k, b.dataset.m));
    painelX.querySelectorAll('[data-ok]').forEach(b => b.onclick = () => { const t = clean(e.outro); if (t) definir(b.dataset.ok, t); });
    const ou = painelX.querySelector('[data-f="outro"]'); if (ou) { ou.oninput = () => { e.outro = ou.value; }; ou.onkeydown = ev => { if (ev.key === 'Enter' && clean(ou.value)) definir(ou.dataset.k, clean(ou.value)); }; }
    const tm = painelX.querySelector('[data-f="todosmot"]'); if (tm) tm.onchange = () => { e.todosMot = tm.checked; };
    painelX.querySelectorAll('[data-editar]').forEach(d => d.onclick = () => { e.editando = d.dataset.editar; pintarPainel(); });
    const mt = painelX.querySelector('[data-f="motivo"]'); if (mt) mt.oninput = () => { e.motivo = mt.value; painelX.querySelectorAll('.om30x-chips button').forEach(c => c.classList.toggle('on', c.dataset.m === mt.value)); validarPainel(); };
    const rv = painelX.querySelector('[data-f="reav"]'); if (rv) rv.onchange = () => { e.reav = rv.checked; pintarPainel(); };
    const ju = painelX.querySelector('[data-f="just"]'); if (ju) ju.oninput = () => { e.just = ju.value; validarPainel(); };
    painelX.querySelectorAll('[data-a="abrirficha"]').forEach(b => b.onclick = async () => {
      const x = e.salas[+b.dataset.x];
      b.disabled = true; b.textContent = 'Abrindo…';
      try { x.ficha = await carregarFicha(x.s, x.enc); } catch (er) { e.erros.push(er.message); }
      pintarPainel();
    });
    const go = painelX.querySelector('[data-a="go"]'); if (go) go.onclick = () => realizarTudo();
  }

  function mapearItens(x, f, daqui) {
    const m = new Map();
    const nf = f.itens.map(it => norm(it.nome));
    const usados = new Set();
    let porNome = true;
    for (const p of daqui) {
      const alvo = norm(p.y.nome);
      const cands = f.itens.filter((it, i) => !usados.has(i) && nf[i] && !/^ITEM \d+$/.test(nf[i]) && (nf[i] === alvo || nf[i].includes(alvo) || alvo.includes(nf[i])));
      if (cands.length !== 1) { porNome = false; break; }
      usados.add(cands[0].i); m.set(p.k, cands[0]);
    }
    if (porNome) return m;
    m.clear();
    if (x.fonte === 'consulta' && x.med.length === f.itens.length) { for (const p of daqui) m.set(p.k, f.itens[p.y.i]); return m; }
    if (!x.med) { for (const p of daqui) m.set(p.k, f.itens[p.y.i]); return m; }   // itens vieram da própria ficha
    const iguais = daqui.every(p => p.v === daqui[0].v);
    const abertos = f.itens.filter(it => it.aberto);
    if (iguais && abertos.length === daqui.length) { daqui.forEach((p, i) => m.set(p.k, abertos[i])); return m; }
    return { erro: `não consegui casar os itens da fila com os da ficha (${daqui.length} na fila, ${abertos.length} na ficha).` };
  }

  async function realizarTudo() {
    const e = estado;
    if (!e || ocupado) return;
    const pend = pendentesTodos();
    if (!pend.length) return;
    ocupado = true; validarPainel();
    let plano = [];
    // 1) Abrir as fichas e conferir tudo antes de salvar qualquer sala.
    const prog = janelaProgresso('Conferindo antes de salvar');
    try {
      for (const x of e.salas) {
        const daqui = pend.filter(p => p.x === x);
        if (!daqui.length) continue;
        const pa = prog.passo(`${x.s.nome}: abrindo a ficha`);
        if (!x.ficha) x.ficha = await carregarFicha(x.s, x.enc);
        const f = x.ficha;
        // Item escolhido no painel → item da ficha. Pelo nome (seguro com qualquer ordem); pela posição só
        // quando a consulta tem o mesmo número de itens. Itens da fila sem nome que case: só se a escolha
        // for igual para todos (aí a ordem não importa).
        const mapa = mapearItens(x, f, daqui);
        if (mapa.erro) { pa.erro(); throw new Error(`${x.s.nome}: ${mapa.erro} Faça esta sala pela ficha.`); }
        const fez = [], nao = [];
        for (const p of daqui) {
          const fi = mapa.get(p.k);
          if (!fi || !fi.aberto) continue;   // já resolvido entre a consulta e agora
          fi.nome = p.y.nome || fi.nome;
          if (p.v === 'nao') { fi.motivo = clean(e.motivos.get(p.k)); if (!fi.motivo) { pa.erro(); throw new Error(`"${fi.nome}" está sem motivo`); } }
          (p.v === 'fez' ? fez : nao).push(fi);
        }
        if (!f.bpaOk) { pa.erro(); throw new Error(`${x.s.nome}: faturamento em formato desconhecido`); }
        for (const [lista, campos] of [[fez, REQUER[x.s.k].fez], [nao, REQUER[x.s.k].nao]])
          for (const y of lista) { const falta = campos.filter(c => ![].concat(c).some(z => inp(y.it, z))); if (falta.length) { pa.erro(); throw new Error(`${x.s.nome}: a ficha não tem o campo ${falta.map(c => [].concat(c).map(z => z.slice(1)).join(' ou ')).join(', ')} em "${y.nome}"`); } }
        const est = fez.filter(y => y.estoque);
        if (est.length) { pa.erro(); throw new Error(`${x.s.nome}: ${est.map(y => y.nome).join(', ')} pede almoxarifado/quantidade (baixa de estoque). Faça esta sala pela ficha.`); }
        pa.ok(`${x.s.nome}: conferindo o faturamento`);
        const linhas = fez.length && x.s.fatura !== false ? await montarFaturamento(f, fez) : [];
        plano.push({ x, f, fez, nao, linhas });
      }
    } catch (er) {
      prog.fechar(); ocupado = false;
      await janela({ tipo: 'erro', icone: '⚠️', titulo: 'Nada foi salvo', html: `<div>${esc(er.message)}</div>` });
      return pintarPainel();
    }
    prog.fechar();
    if (!plano.length) { ocupado = false; return pintarPainel(); }
    // Salva por último a Medicação: se Exames/Enfermagem forem recusados, a Medicação ainda não mudou.
    plano.sort((a, b) => (a.x.s.k === 'medicacao') - (b.x.s.k === 'medicacao'));

    // 2) Confirmação com o resumo de cada sala e o faturamento.
    const resumo = plano.map(p => `<div class="om30x-rs"><div class="rh">${ICONE[p.x.s.k] || ''} ${esc(p.x.s.nome)}</div><ul>
        ${p.fez.map(y => `<li>✔ ${esc(y.nome)}</li>`).join('')}${p.nao.map(y => `<li class="n">✖ ${esc(y.nome)} <small style="color:#62788a">— ${esc(y.motivo)}</small></li>`).join('')}</ul>
        ${p.linhas.length ? `<div class="fat"><b>Faturamento</b>${p.linhas.map(l => esc(l.texto)).join('<br>')}</div>` : ''}</div>`).join('') +
'';
    const ok = await janela({ tipo: 'aviso', icone: '📋', titulo: `Dar baixa em ${e.nome}?`, html: resumo, botoes: [{ txt: 'Voltar', valor: false }, { txt: 'Confirmar baixa', classe: 'p', valor: true }] });
    if (!ok) { ocupado = false; return pintarPainel(); }

    // 3) Salvar sala por sala, concluir a senha e mandar para o destino final.
    const prog2 = janelaProgresso('Dando baixa');
    const feitas = [], log = [];
    let ultimo = null;
    try {
      const momento = momentoAgora();
      for (const p of plano) {
        const pa = prog2.passo(`${p.x.s.nome}: salvando`);
        const prof = p.f.profissional;
        try {
          if (p.nao.length && !prof) throw new Error(`${p.x.s.nome}: profissional atual não encontrado na ficha`);
          for (const y of p.fez) p.x.s.fazer(y.it);
          for (const y of p.nao) p.x.s.cancelar(y.it, { motivo: y.motivo, momento, profissional: prof });
          lancarFaturamento(p.f, p.linhas);
          const res = await salvarFicha(p.f);
          feitas.push(p.x.s.nome);
          await concluirSenhaSala(res, p.f, e.at);
          ultimo = res;
          pa.ok(`${p.x.s.nome}: ${p.fez.length} feito(s)${p.nao.length ? `, ${p.nao.length} cancelado(s)` : ''}${p.linhas.length ? ` · ${p.linhas.length} faturamento(s)` : ''}`);
        } catch (er) { pa.erro(`${p.x.s.nome}: não salvou`); throw er; }
      }
      const destino = (ultimo?.destinos || []).filter(Boolean).pop() || '';
      if (destino && e.senha && !/^[-—]$/.test(e.senha)) {
        const pa = prog2.passo(`Senha ${e.senha} → ${NOME_DESTINO[destino] || destino}`);
        try { await senhaParaDestino(e.at, destino); pa.ok(); log.push(`Senha <b>${esc(e.senha)}</b> foi para <b>${esc(NOME_DESTINO[destino] || destino)}</b>.`); }
        catch (er) { pa.erro(); log.push(`⚠ A senha não foi para ${esc(NOME_DESTINO[destino] || destino)} (${esc(er.message)}). Use Recuperar na fila de lá.`); }
      } else if (destino) log.push(`Próximo destino: <b>${esc(NOME_DESTINO[destino] || destino)}</b>.`);
      prog2.fechar();
      console.log('[OM30 Baixa Rápida] baixa pelo painel', { atendimento: e.at, salas: feitas });
      ocupado = false; fecharPainel();
      await janela({ titulo: 'Baixa concluída', html: `<div style="font-weight:700;margin-bottom:6px">${esc(e.nome)}</div>${plano.map(p => `<div>${ICONE[p.x.s.k] || ''} ${esc(p.x.s.nome)}: ${p.fez.length} feito(s)${p.nao.length ? `, ${p.nao.length} cancelado(s)` : ''}</div>`).join('')}${log.length ? `<div class="om30x-nota">${log.join('<br>')}</div>` : ''}` });
    } catch (er) {
      prog2.fechar();
      ocupado = false;
      console.warn('[OM30 Baixa Rápida] baixa pelo painel falhou', er);
      const resto = plano.map(p => p.x.s.nome).filter(n => !feitas.includes(n));
      fecharPainel();
      await janela({ tipo: 'erro', icone: '⚠️', titulo: 'A baixa parou', html: `<div>${esc(er.message)}</div><div class="om30x-nota">${feitas.length ? `<b>Já salvo:</b> ${esc(feitas.join(', '))}<br>` : '<b>Nada foi salvo.</b><br>'}${resto.length ? `<b>Não salvo:</b> ${esc(resto.join(', '))}. Abra essas fichas para conferir.` : ''}</div>` });
    } finally {
      PEND.em = 0; CACHE_ITENS.clear();
      try { for (const vm of document.querySelectorAll('.cs-fila')) vm.__vue__?.fetchCollection?.(); } catch (_) {}
    }
  }

  // ---------- início ----------
  function iniciar() {
    if (ehListaControle()) { instalarBotoesLinhas(); return; }
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
