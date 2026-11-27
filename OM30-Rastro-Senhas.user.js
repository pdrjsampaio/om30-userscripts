// ==UserScript==
// @name         OM30 - Rastro de Senhas
// @namespace    https://github.com/pdrjsampaio/om30-userscripts
// @version      1.2.0
// @description  Diagnóstico temporário da "Senha perdida": só observa o caminho de cada senha (Senha Simples, senha guardada no navegador, cargas de página, abas novas) e envia ao Cloudflare. Não altera nada. Desliga sozinho em ATIVO_ATE.
// @author       OM30
// @match        https://guaruja.saudesimples.net/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// @updateURL    https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Rastro-Senhas.user.js
// @downloadURL  https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Rastro-Senhas.user.js
// ==/UserScript==

// O QUE ESTE SCRIPT FAZ
// Só OBSERVA. Toda função embrulhada (Storage.prototype.setItem/removeItem, window.open) chama a original
// com os mesmos argumentos e devolve o mesmo resultado; os interceptadores do senhaSimplesProxy devolvem a
// MESMA resposta / o MESMO erro. Nada no pedido, na resposta, no store Vue ou nas chaves do sistema no
// localStorage é mudado. As únicas chaves que este script grava são as suas ("om30-rastro-*").
// Nunca envia nome de paciente, CNS, CPF ou data de nascimento: só números de atendimento, códigos e ids
// de senha, nomes de guichê/local/profissional e textos curtos de erro do Senha Simples.
(() => {
  'use strict';
  const VERSAO = '1.2.0';
  // Até quando o rastro fica ligado (horário de Brasília). Depois disso o script não instala nada.
  const ATIVO_ATE = '2026-11-28T23:59:00-03:00';
  // Endereço do Worker: trocar <conta> pelo subdomínio workers.dev da conta Cloudflare.
  const API = 'https://om30-rastro.om30-pedro.workers.dev';
  // Chave de envio: o MESMO texto gravado no secret CLIENT_KEY do Worker. Enquanto estiver com o
  // valor de exemplo (ou o API com <conta>), os eventos ficam só na fila local e nada é enviado.
  const CHAVE = 'xGVd2RRY51MvVzFCcx1brrpw4zMd9N8m';

  const FIM = Date.parse(ATIVO_ATE);
  const ativo = () => { try { return Date.now() < FIM; } catch (_) { return false; } };
  try { if (window.__OM30_RASTRO_SENHAS__) return; } catch (_) { return; }
  if (!ativo()) return;
  try { window.__OM30_RASTRO_SENHAS__ = VERSAO; } catch (_) { return; }

  const K = {
    PC: 'om30-rastro-pc', FILA: 'om30-rastro-fila', TRAVA: 'om30-rastro-envio', CTX: 'om30-rastro-ctx',
    ABA: 'om30-rastro-aba', VINC: 'om30-rastro-vinculos', RECUP: 'om30-rastro-recuperar',
  };
  const MAX_FILA = 500, MAX_LOTE = 200, MAX_BYTES = 56000, CICLO_MS = 10000, RESUMO_RECUP_MS = 5 * 60 * 1000;
  const ID_OK = /^\d{1,14}$/, TIPO_OK = /^[A-Z][A-Za-z]{2,40}$/;

  // ---------- originais (capturados em document-start, antes de qualquer outro script) ----------
  let SP = null;
  try { SP = Storage.prototype; } catch (_) { SP = null; }
  const nativo = SP ? { get: SP.getItem, set: SP.setItem, remove: SP.removeItem } : null;
  let fetchNativo = null;
  try { fetchNativo = typeof window.fetch === 'function' ? window.fetch.bind(window) : null; } catch (_) { fetchNativo = null; }
  const LS = (() => { try { return window.localStorage; } catch (_) { return null; } })();
  const SS = (() => { try { return window.sessionStorage; } catch (_) { return null; } })();

  const ler = (st, k) => { try { return st && nativo ? nativo.get.call(st, k) : null; } catch (_) { return null; } };
  const gravar = (st, k, v) => { try { if (st && nativo) { nativo.set.call(st, k, v); return true; } } catch (_) {} return false; };
  const parse = t => { try { return t == null ? null : JSON.parse(t); } catch (_) { return null; } };
  const lerJSON = (st, k) => parse(ler(st, k));

  // ---------- textos ----------
  const limpo = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  // Texto livre nunca leva sequência longa de dígitos (CNS tem 15, CPF 11) nem CPF formatado.
  const semDocumento = t => t.replace(/\d{3}\.\d{3}\.\d{3}-\d{2}/g, '#').replace(/\d{11,}/g, '#');
  const txt = (v, n) => semDocumento(limpo(v)).slice(0, n);
  const idt = v => { const t = limpo(v).slice(0, 60); return /^[\w.:-]+$/.test(t) ? t : ''; };
  const norm = v => limpo(v).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  const num = v => { const t = limpo(v); return ID_OK.test(t) ? String(parseInt(t, 10)) : null; };
  const atend = (id, tipo) => { const i = num(id), t = limpo(tipo); return i && TIPO_OK.test(t) ? t + '#' + i : ''; };
  const novoId = () => {
    try { if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID(); } catch (_) {}
    return 'r' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  };

  // ---------- identificação: navegador, aba e carga da página ----------
  const PC = (() => {
    let v = ler(LS, K.PC);
    if (!v || !/^[\w-]{8,60}$/.test(v)) { v = novoId(); gravar(LS, K.PC, v); }
    return v;
  })();
  let CARGA = '';
  try { CARGA = Math.round(performance.timeOrigin || Date.now()).toString(36); } catch (_) { CARGA = Date.now().toString(36); }
  // A aba nova aberta por window.open copia o sessionStorage da aba mãe: na 1ª página de uma aba filha
  // (opener presente e histórico de 1 página) nasce um id novo e a mãe fica anotada.
  let ABA = '', ABA_MAE = '';
  (() => {
    let reg = lerJSON(SS, K.ABA);
    const valido = !!(reg && typeof reg.id === 'string' && /^[\w-]{8,60}$/.test(reg.id));
    let filhaNova = false;
    try { filhaNova = !!window.opener && history.length <= 1; } catch (_) { filhaNova = false; }
    if (!valido) reg = { id: novoId(), filha: filhaNova };
    else if (filhaNova && !reg.filha) reg = { id: novoId(), filha: true, mae: reg.id };
    ABA = reg.id;
    ABA_MAE = typeof reg.mae === 'string' ? reg.mae.slice(0, 60) : '';
    gravar(SS, K.ABA, JSON.stringify({ id: reg.id, filha: !!reg.filha, mae: ABA_MAE || undefined }));
  })();

  // ---------- contexto: profissional e unidade (lembrados por aba para eventos antes do DOM) ----------
  const ctxSalvo = lerJSON(SS, K.CTX) || lerJSON(LS, K.CTX) || {};
  const ctx = { profissional: txt(ctxSalvo.profissional, 120), unidade: txt(ctxSalvo.unidade, 120) };
  function atualizarCtx() {
    try {
      const a = document.querySelector('#header-bar a.navbar-avatar, a.navbar-avatar');
      const u = document.querySelector('a[href*="trocar_unidade_saude"]');
      const p = a ? txt(a.textContent, 120) : '', un = u ? txt(norm(u.textContent), 120) : '';
      let mudou = false;
      if (p && p !== ctx.profissional) { ctx.profissional = p; mudou = true; }
      if (un && un !== ctx.unidade) { ctx.unidade = un; mudou = true; }
      if (mudou) { const t = JSON.stringify(ctx); gravar(SS, K.CTX, t); gravar(LS, K.CTX, t); }
    } catch (_) {}
  }

  // ---------- tela pelo endereço ----------
  function telaDe(caminho) {
    const p = String(caminho || '').toLowerCase();
    if (/^\/acolhimentos(\/|$)/.test(p)) return 'ACOLHIMENTO';
    if (/^\/(prontuarios|encaminhamentos_controle_salas)(\/|$)/.test(p) || /^\/atendimentos(_pas)?\/(\d+\/)?prontuario/.test(p)) return 'MEDICO';
    if (/^\/(aplicacoes_medicamentos|encaminhamentos_medicacoes)(\/|$)/.test(p)) return 'SALA_MEDICACAO';
    if (/^\/encaminhamentos_exames(\/|$)/.test(p)) return 'SALA_EXAMES';
    if (/^\/encaminhamentos_procedimentos_enfermagem(\/|$)/.test(p)) return 'SALA_ENFERMAGEM';
    if (/^\/encaminhamentos_radiografias(\/|$)/.test(p)) return 'SALA_RAIOX';
    if (/^\/encaminhamentos_gessos_imobilizacoes(\/|$)/.test(p)) return 'SALA_GESSO';
    if (/^\/(atendimentos_pas|recepcoes|municipes)(\/|$)/.test(p)) return 'RECEPCAO';
    return 'OUTRA';
  }
  const TELA = (() => { try { return telaDe(location.pathname); } catch (_) { return 'OUTRA'; } })();

  // Endereço sem dados pessoais: caminho + só parâmetros de id numérico / tipo de atendimento.
  function urlLimpa(href) {
    try {
      const u = new URL(String(href == null ? '' : href), location.href);
      if (u.origin !== location.origin) return txt(u.host, 80);
      const ok = [];
      u.searchParams.forEach((v, k) => {
        if ((/(^|_)id$/.test(k) && ID_OK.test(v)) || (/_type$/.test(k) && TIPO_OK.test(v)) || (k === 'encaminhar' && /^\w{1,8}$/.test(v))) ok.push(k + '=' + v);
      });
      return txt(u.pathname, 200) + (ok.length ? '?' + ok.join('&') : '');
    } catch (_) { return ''; }
  }
  const nomesParams = () => {
    try {
      return Array.from(new URLSearchParams(location.search).keys())
        .map(k => k.replace(/[^\w[\]]/g, '').slice(0, 40)).filter(Boolean).slice(0, 15).join(',');
    } catch (_) { return ''; }
  };

  // ---------- de qual atendimento é ESTA página (mesma lógica do bloco "OM30 SENHA POR ABA") ----------
  const VALIDADE_VINC = 12 * 3600e3, MAX_VINC = 12;
  const lerVinculos = () => {
    const l = lerJSON(SS, K.VINC);
    return Array.isArray(l) ? l.filter(v => v && ID_OK.test(String(v.p)) && typeof v.a === 'string' && Date.now() - (v.em || 0) < VALIDADE_VINC) : [];
  };
  const gravarVinculo = (p, a) => {
    const l = lerVinculos().filter(v => String(v.p) !== p);
    l.push({ p, a, em: Date.now() });
    gravar(SS, K.VINC, JSON.stringify(l.slice(-MAX_VINC)));
  };
  function numeroProntuario(cedo) {
    const m = /^\/prontuarios\/(\d+)(\/edit)?\/?$/.exec(location.pathname);
    if (m) return num(m[1]);
    if (String(location.pathname).indexOf('/encaminhamentos_controle_salas') === 0) {
      const p = num(new URLSearchParams(location.search).get('prontuario_id'));
      if (p) return p;
      if (!cedo) {
        const c = Array.from(document.querySelectorAll('input')).find(i => i.name === 'encaminhamento_controle_salas[prontuario_id]');
        if (c) return num(c.value);
      }
    }
    return null;
  }
  let identCache = null, identFinal = false;
  function identidade(cedo) {
    if (identCache) return identCache;
    const achadas = new Set();
    let fonte = '';
    const somar = (id, tipo, f) => { const a = atend(id, tipo); if (a) { achadas.add(a); if (!fonte) fonte = f; } };
    try {
      const q = new URLSearchParams(location.search);
      for (const pre of ['prontuariavel', 'acolhivel', 'atendimento']) somar(q.get(pre + '_id'), q.get(pre + '_type'), 'url');
      if (!cedo) {
        const campos = Array.from(document.querySelectorAll('input')).map(i => [String(i.name || ''), i.value]);
        const valor = nome => { const c = campos.find(x => x[0] === nome); return c ? c[1] : null; };
        for (const [nome, v] of campos) {
          for (const campo of ['prontuariavel', 'acolhivel']) {
            const fim = '[' + campo + '_id]';
            if (nome.length > fim.length && nome.endsWith(fim)) somar(v, valor(nome.slice(0, -fim.length) + '[' + campo + '_type]'), 'campo');
          }
        }
        for (const t of Array.from(document.querySelectorAll('limpar-senha-invalida'))) somar(t.getAttribute('atendimento-id'), t.getAttribute('atendimento-type'), 'componente');
        const el = document.querySelector('#app-vue');
        const raiz = el && el.__vue__;
        if (raiz) {
          const fila = [raiz];
          for (let k = 0; k < fila.length && k < 4000; k++) {
            const vm = fila[k], o = vm.$options || {};
            if (o.name === 'limpar-senha-invalida' || o._componentTag === 'limpar-senha-invalida') somar(vm.atendimentoId, vm.atendimentoType, 'componente');
            for (const c of (vm.$children || [])) fila.push(c);
          }
        }
      }
    } catch (_) { return null; }
    let r = null;
    const p = cedo ? (() => { try { return numeroProntuario(true); } catch (_) { return null; } })() : numeroProntuario(false);
    if (achadas.size > 1) r = { a: '', fonte: 'ambigua', p: p || '' };
    else if (achadas.size === 1) {
      r = { a: Array.from(achadas)[0], fonte, p: p || '' };
      if (p) gravarVinculo(p, r.a);   // aprende prontuário -> atendimento para a página de encaminhamento
    } else if (p) {
      const v = lerVinculos().filter(x => String(x.p) === p).pop();
      r = v ? { a: v.a, fonte: 'vinculo', p } : { a: '', fonte: '', p };
    }
    if (!cedo && ((r && r.a) || identFinal)) identCache = r || { a: '', fonte: '', p: '' };
    return r;
  }

  // ---------- senha: só campos permitidos ----------
  const conhecidas = new Map();   // senha.id -> atendimento (aprendido de tudo que esta página viu)
  const codigoSenha = s => {
    let c = s.senha;
    if (c && typeof c === 'object') c = c.senha;
    if (c == null || c === '') c = s.codigo != null ? s.codigo : s.numero;
    return c == null || typeof c === 'object' ? '' : txt(c, 30);
  };
  function resumo(s) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
    const id = idt(s.id);
    const cod = codigoSenha(s);
    if (!id && !cod) return null;
    const r = {
      id, cod, at: atend(s.saude_atendimento_id, s.saude_atendimento_type),
      chamado_em: txt(s.chamado_em, 40), confirmado_em: txt(s.confirmado_em, 40),
      local: txt(s.local_atendimento && s.local_atendimento.nome, 120),
      usuario: txt(s.usuario && s.usuario.nome, 120),
    };
    if (id && r.at) { if (conhecidas.size > 500) conhecidas.clear(); conhecidas.set(id, r.at); }
    return r;
  }
  const camposSenha = s => s ? {
    senha: s.cod, senha_id: s.id, senha_atendimento: s.at, chamado_em: s.chamado_em,
    confirmado_em: s.confirmado_em, local_nome: s.local, usuario_ss: s.usuario,
  } : {};

  // ---------- store Vue e guichê ----------
  const pegarStore = () => {
    try { if (typeof store !== 'undefined' && store && typeof store.dispatch === 'function') return store; } catch (_) {}   // eslint-disable-line no-undef
    try { const el = document.querySelector('#app-vue'); return (el && el.__vue__ && el.__vue__.$store) || null; } catch (_) { return null; }
  };
  const pegarProxy = () => {
    try { if (typeof senhaSimplesProxy !== 'undefined' && senhaSimplesProxy && senhaSimplesProxy.interceptors) return senhaSimplesProxy; } catch (_) {}   // eslint-disable-line no-undef
    try { const p = window.senhaSimplesProxy; return p && p.interceptors ? p : null; } catch (_) { return null; }
  };
  function nomesLocal(loc) {
    if (!loc || typeof loc !== 'object') return '';
    const partes = [];
    try { for (const k of Object.keys(loc)) { const v = loc[k]; if (v && typeof v === 'object' && v.nome) partes.push(k + ':' + limpo(v.nome)); } } catch (_) {}
    return txt(partes.join(' | '), 200);
  }
  function guicheDe(loc) {
    if (!loc || typeof loc !== 'object') return '';
    const pref = TELA === 'MEDICO' ? 'atendimento' : TELA === 'ACOLHIMENTO' ? 'acolhimento' : '';
    if (pref && loc[pref] && loc[pref].nome) return txt(loc[pref].nome, 120);
    return txt(nomesLocal(loc), 120);
  }
  // 1.2.0: todas as salas do Controle de Salas usam /aplicacoes_medicamentos; a sala de verdade é o local escolhido
  // (ex.: "controle_de_salas_raio_x:SALA DE RAIO X"). Sem isso, o Raio-X aparecia como Sala de Medicação.
  function telaDaSala(tela, g) {
    if (tela !== 'SALA_MEDICACAO') return tela;
    const salas = [...new Set([...String(g || '').matchAll(/controle_de_salas_([a-z_]+)/g)].map(m => m[1]))];
    if (salas.length !== 1) return tela;   // nenhuma ou mais de uma sala no local: não adivinha
    const k = salas[0];
    if (/raio|radiograf/.test(k)) return 'SALA_RAIOX';
    if (/exame|coleta/.test(k)) return 'SALA_EXAMES';
    if (/enferm|procedimento/.test(k)) return 'SALA_ENFERMAGEM';
    if (/gesso|imobiliz/.test(k)) return 'SALA_GESSO';
    if (/repouso/.test(k)) return 'SALA_REPOUSO';
    return tela;
  }
  function guiche(st) {
    let loc = null;
    try { loc = st && st.getters ? st.getters.localAtendimentoAtual : null; } catch (_) { loc = null; }
    if (!loc || typeof loc !== 'object') loc = lerJSON(LS, 'localAtendimentoAtual');
    return guicheDe(loc);
  }

  // ---------- versões / scripts OM30 presentes (marcas globais conhecidas) ----------
  let versoesCache = '', carregou = false;
  function versoes() {
    if (versoesCache) return versoesCache;
    let v = 'RASTRO@' + VERSAO;
    try {
      const m = Object.keys(window).filter(k => /^(__OM30_|OM30)/.test(k) && k !== '__OM30_RASTRO_SENHAS__').sort();
      if (m.length) v += ',' + m.join(',');
    } catch (_) {}
    v = v.slice(0, 400);
    if (carregou) versoesCache = v;
    return v;
  }

  // ---------- quem escreveu (pilha de chamadas: script OM30, sistema ou outro) ----------
  function origemPilha() {
    let pilha = '';
    let lim;
    try { lim = Error.stackTraceLimit; Error.stackTraceLimit = 40; } catch (_) {}
    try { pilha = String(new Error().stack || ''); } catch (_) { pilha = ''; }
    try { if (lim !== undefined) Error.stackTraceLimit = lim; } catch (_) {}
    const fontes = [];
    for (const linha of pilha.split('\n').slice(1)) {
      let f = '';
      const m = /[?&]name=([^&:\s)]+)/.exec(linha) || /(OM30[\w%. -]*?)\.user\.js/i.exec(linha);
      if (m) {
        try { f = decodeURIComponent(m[1]); } catch (_) { f = m[1]; }
        f = f.replace(/\.user\.js$/i, '');
        if (/rastro[- ]?(de[- ]?)?senhas/i.test(f)) continue;   // este script
      } else if (/application-[0-9a-f]+\.js/.test(linha)) f = 'sistema';
      else if (/\.js/.test(linha)) f = 'outro';
      else continue;
      if (fontes[fontes.length - 1] !== f) fontes.push(f);
    }
    return txt(fontes.slice(0, 5).join('<') || '?', 160);
  }

  // ---------- fila local de envio ----------
  const lerFila = () => { const f = lerJSON(LS, K.FILA); return Array.isArray(f) ? f.filter(e => e && typeof e === 'object' && e.uid) : []; };
  const gravarFila = f => {
    if (gravar(LS, K.FILA, JSON.stringify(f))) return;
    const metade = f.slice(-Math.floor(MAX_FILA / 2));   // sem espaço: fica com os mais novos
    if (!gravar(LS, K.FILA, JSON.stringify(metade))) gravar(LS, K.FILA, '[]');
  };
  const memoria = [];   // sem localStorage: guarda só nesta página
  function enfileirar(e) {
    if (!LS) { memoria.push(e); if (memoria.length > MAX_FILA) memoria.shift(); return; }
    const f = lerFila();
    f.push(e);
    while (f.length > MAX_FILA) f.shift();
    gravarFila(f);
  }
  function removerDaFila(uids) {
    const s = new Set(uids);
    if (!LS) { for (let i = memoria.length - 1; i >= 0; i--) if (s.has(memoria[i].uid)) memoria.splice(i, 1); return; }
    gravarFila(lerFila().filter(e => !s.has(e.uid)));
  }

  // ---------- evento ----------
  let domPronto = false;
  function evento(acao, x) {
    if (!ativo()) return null;
    try {
      x = x || {};
      const st = pegarStore();
      const ls = resumo(lerJSON(LS, 'senha'));
      let pagina = '';
      if (Object.prototype.hasOwnProperty.call(x, 'pagina_atendimento')) pagina = x.pagina_atendimento || '';
      else { const ident = identidade(!domPronto); pagina = (ident && ident.a) || ''; }
      const g = guiche(st);
      const e = {
        uid: novoId(), em: new Date().toISOString(), pc: PC, aba: ABA, carga: CARGA,
        url: urlLimpa(location.href), tela: telaDaSala(TELA, g), profissional: ctx.profissional, unidade: ctx.unidade,
        guiche: g, acao, ls_senha: ls ? ls.cod : '', ls_senha_id: ls ? ls.id : '',
        pagina_atendimento: pagina, versoes: versoes(), divergente: 0,
      };
      for (const k of Object.keys(x)) { const v = x[k]; if (v !== undefined && v !== null && v !== '') e[k] = v; }
      e.pagina_atendimento = pagina;
      if (x.divergente === undefined) e.divergente = e.pagina_atendimento && e.senha_atendimento && e.pagina_atendimento !== e.senha_atendimento ? 1 : 0;
      enfileirar(e);
      return e;
    } catch (_) { return null; }
  }

  // ---------- (b) e (d) escritas em localStorage: senha e localAtendimentoAtual ----------
  let despacho = null;   // ação do store em andamento (defineSenhaChamada / limpaSenhaChamada)
  function observarEscrita(chave, antesTxt, depoisTxt) {
    if (antesTxt === depoisTxt) return;
    if (chave === 'senha') {
      const a = resumo(parse(antesTxt)), d = resumo(parse(depoisTxt));
      if (!a && !d) return;   // de vazio para vazio
      if (a && d && a.id === d.id && a.cod === d.cod && a.at === d.at && a.chamado_em === d.chamado_em && a.confirmado_em === d.confirmado_em) return;
      const acao = despacho === 'defineSenhaChamada' ? 'DEFINE_SENHA' : despacho === 'limpaSenhaChamada' ? 'LIMPA_SENHA' : 'LS_SENHA';
      evento(acao, Object.assign(camposSenha(d), {
        antes_senha: a ? a.cod : '', antes_senha_id: a ? a.id : '', antes_atendimento: a ? a.at : '',
        detalhe: 'origem=' + origemPilha(),
      }));
    } else {
      const a = nomesLocal(parse(antesTxt)), d = nomesLocal(parse(depoisTxt));
      if (a === d) return;
      evento('LS_LOCAL', { guiche: guicheDe(parse(depoisTxt)), detalhe: txt('antes=' + (a || '-') + ' ; depois=' + (d || '-') + ' ; origem=' + origemPilha(), 400) });
    }
  }
  const alvoLS = (st, k) => {
    try {
      if (!ativo() || !LS || st !== LS) return '';
      const kk = String(k);
      return kk === 'senha' || kk === 'localAtendimentoAtual' ? kk : '';
    } catch (_) { return ''; }
  };
  if (SP && nativo) {
    try {
      SP.setItem = function setItem(k, v) {   // eslint-disable-line no-unused-vars
        const alvo = alvoLS(this, k);
        let antes = null;
        if (alvo) { try { antes = nativo.get.call(this, alvo); } catch (_) { antes = null; } }
        const r = nativo.set.apply(this, arguments);
        if (alvo) { try { observarEscrita(alvo, antes, nativo.get.call(this, alvo)); } catch (_) {} }
        return r;
      };
      SP.removeItem = function removeItem(k) {
        const alvo = alvoLS(this, k);
        let antes = null;
        if (alvo) { try { antes = nativo.get.call(this, alvo); } catch (_) { antes = null; } }
        const r = nativo.remove.apply(this, arguments);
        if (alvo) { try { observarEscrita(alvo, antes, nativo.get.call(this, alvo)); } catch (_) {} }
        return r;
      };
    } catch (_) {}
  }

  // ---------- (d) dispatch do store: defineSenhaChamada / limpaSenhaChamada ----------
  const storesVistos = new WeakSet();
  function instalarStore() {
    const st = pegarStore();
    if (!st) return false;
    if (storesVistos.has(st)) return true;
    storesVistos.add(st);
    try {
      if (typeof st.subscribeAction === 'function') {
        st.subscribeAction(acao => {
          try {
            const t = acao && acao.type;
            if (t === 'defineSenhaChamada' || t === 'limpaSenhaChamada') {
              despacho = t;   // a ação grava o localStorage na mesma volta; a marca some logo depois
              Promise.resolve().then(() => { if (despacho === t) despacho = null; });
            }
          } catch (_) {}
        });
      }
    } catch (_) {}
    return true;
  }

  // ---------- (a) pedidos do senhaSimplesProxy ----------
  function caminhoApi(cfg) {
    const u = String(cfg.url || '').replace(/^https?:\/\/[^/]+/i, '').replace(/^\/+/, '').replace(/^api\/v2\//, '').split('?')[0].split('#')[0];
    return u.split('/').filter(Boolean);
  }
  const ROTAS_2 = {
    recuperar_senha_saude_atendimento: ['RECUPERAR', 'local_id'],
    chamar_senha_saude_atendimento: ['CHAMAR_ATEND', 'local_id'],
    concluir_senha_saude_atendimento: ['CONCLUIR_ATEND', 'local_id'],
    concluir_senha_opcional_saude_atendimento: ['CONCLUIR_OPCIONAL', 'categoria_id'],
    retornar_para_atendimento: ['RETORNAR', 'categoria_id'],
  };
  function classificar(metodo, seg) {
    const r = { acao: '', rota: txt(seg.map(s => /^\d+$/.test(s) ? ':id' : s).join('/'), 160), local_id: '', tipo_id: '', senha_id: '', categoria_id: '' };
    if (seg[0] === 'filas') {
      const a = seg.slice(1);
      if (a[0] === 'quantidade_itens') return null;   // contagem refeita a cada 3 s
      if (a[0] === 'proximo' && a.length === 2) { r.acao = 'CHAMAR_PROXIMO'; r.local_id = idt(a[1]); r.rota = 'filas/proximo/:id'; return r; }
      if (a.length === 2 && ROTAS_2[a[1]]) {
        const [acao, campo] = ROTAS_2[a[1]];
        r.acao = acao; r[campo] = idt(a[0]); r.rota = 'filas/:id/' + a[1];
        return r;
      }
      if (a.length === 4 && /^[a-z_]{3,30}$/.test(a[3])) {
        r.acao = a[3].toUpperCase(); r.local_id = idt(a[0]); r.tipo_id = idt(a[1]); r.senha_id = idt(a[2]);
        r.rota = 'filas/:id/:id/:id/' + a[3];
        return r;
      }
    }
    if (metodo === 'GET') return null;   // listas e consultas não mexem na senha
    r.acao = 'API_OUTRA';
    return r;
  }
  function corpoObj(cfg) {
    const d = cfg.data;
    if (!d) return null;
    if (typeof d === 'string') return parse(d);
    return typeof d === 'object' ? d : null;
  }
  const atendDe = o => (!o || typeof o !== 'object') ? '' :
    (atend(o.atendimento_id, o.atendimento_type) || atend(o.saude_atendimento_id, o.saude_atendimento_type) || atend(o.prontuariavel_id, o.prontuariavel_type) || '');
  // recuperar_senha_saude_atendimento: grava só quando o resultado MUDA para aquele atendimento nesta aba.
  let recup = null;
  function mudouRecuperar(chave, sig) {
    if (!recup) { const m = lerJSON(SS, K.RECUP); recup = m && typeof m === 'object' && !Array.isArray(m) ? m : {}; }
    if (recup[chave] === sig) return false;
    delete recup[chave];
    recup[chave] = sig;
    const ks = Object.keys(recup);
    if (ks.length > 300) for (const k of ks.slice(0, ks.length - 300)) delete recup[k];
    gravar(SS, K.RECUP, JSON.stringify(recup));
    return true;
  }
  // 1.2.0: contagem das checagens feitas pelos scripts OM30 (sem paciente, sem senha: só script e resultado).
  const contRecup = new Map();
  let contRecupDesde = Date.now();
  function contarRecuperarOm30(chave) { contRecup.set(chave, (contRecup.get(chave) || 0) + 1); }
  function resumirRecuperarOm30(forcar) {
    if (!contRecup.size) { contRecupDesde = Date.now(); return; }
    if (!forcar && Date.now() - contRecupDesde < RESUMO_RECUP_MS) return;
    const partes = [...contRecup.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => k + '=' + n);
    const total = [...contRecup.values()].reduce((a, b) => a + b, 0);
    contRecup.clear();
    const seg = Math.round((Date.now() - contRecupDesde) / 1000);
    contRecupDesde = Date.now();
    evento('RECUPERAR_SCRIPTS', { metodo: 'GET', rota: 'filas/:id/recuperar_senha_saude_atendimento', pagina_atendimento: '', detalhe: txt('total=' + total + ' em ' + seg + 's ; ' + partes.join(' ; '), 400) });
  }
  const inicio = new WeakMap();
  const origemPedido = new WeakMap();
  function observarApi(resp, erro) {
    if (!ativo()) return;
    const cfg = (resp && resp.config) || (erro && erro.config) || null;
    if (!cfg || typeof cfg !== 'object') return;
    const metodo = String(cfg.method || 'get').toUpperCase().slice(0, 8);
    const info = classificar(metodo, caminhoApi(cfg));
    if (!info) return;
    const res = resp || (erro && erro.response) || null;
    const status = res ? (Number(res.status) || 0) : 0;
    const data = res ? res.data : null;
    const pedido = atendDe(cfg.params) || atendDe(corpoObj(cfg));
    const s = data && typeof data === 'object' ? resumo(data) : null;
    // 1.2.0: a checagem de senha feita pelos scripts OM30 (origem dos ausentes: ~99% do volume em 26/11) vira só
    // contagem por script e resultado, enviada a cada 5 min. A checagem feita pelo sistema continua como evento.
    const orig = origemPedido.get(cfg);
    if (info.acao === 'RECUPERAR' && orig && /OM30/.test(orig) && (status === 200 || status === 404 || status === 410 || status === 422)) {
      contarRecuperarOm30(((/OM30[^<]*/.exec(orig) || [])[0] || 'OM30') + ' ' + status);
      return;
    }
    if (info.acao === 'RECUPERAR') {
      const sig = [status, s ? s.id : '', s ? s.chamado_em : '', s ? s.confirmado_em : '', data && data.ja_chamada ? 1 : 0].join('|');
      if (!mudouRecuperar(info.local_id + '|' + pedido, sig)) return;
    }
    let erroTxt = '';
    if (!res || status >= 400) {
      const d = data && typeof data === 'object' ? (data.error || data.message || data.erro) : (typeof data === 'string' ? data : '');
      erroTxt = txt(typeof d === 'string' ? d : (d ? JSON.stringify(d) : '') || (erro && erro.message) || '', 200);
    }
    const corpo = corpoObj(cfg) || {};
    const det = [];
    const senhaId = info.senha_id || (s && s.id) || '';
    if (info.senha_id && s && s.id && s.id !== info.senha_id) det.push('nova=' + s.id);
    if (pedido && s && s.at && pedido !== s.at) det.push('pedido=' + pedido);
    const destino = num(corpo.tipo_atendimento_destino_id), risco = num(corpo.grau_risco_id);
    if (destino) det.push('destino=' + destino);
    if (risco) det.push('risco=' + risco);
    if (data && typeof data === 'object' && data.ja_chamada) det.push('ja_chamada');
    const t0 = inicio.get(cfg);
    if (t0) det.push('ms=' + (Date.now() - t0));
    // 1.1.0: quem fez o pedido (sistema ou script OM30, pela pilha na saída) e o último botão clicado antes dele.
    // A biblioteca do pedido fica no código do sistema: se houver script OM30 em QUALQUER ponto da pilha, foi ele.
    if (orig) det.push('origem=' + ((/OM30[^<]*/.exec(orig) || [])[0] || 'sistema') + ' ; pilha=' + orig);
    const ck = ultimoClique && t0 && t0 - ultimoClique.t >= 0 && t0 - ultimoClique.t < 15000 ? ultimoClique : null;
    if (ck) det.push('clique=' + ck.rotulo + ' (' + (t0 - ck.t) + 'ms antes' + (ck.om30 ? ', botão OM30' : '') + ')');
    const at = (s && s.at) || (info.senha_id && conhecidas.get(info.senha_id)) || pedido || '';
    evento(info.acao, Object.assign(camposSenha(s), {
      metodo, rota: info.rota, status, local_id: info.local_id, tipo_id: info.tipo_id, categoria_id: info.categoria_id,
      senha_id: senhaId, senha_atendimento: at, erro: erroTxt, detalhe: txt(det.join(' '), 400),
    }));
  }
  const proxiesVistos = new WeakSet();
  function instalarProxy() {
    const px = pegarProxy();
    if (!px) return false;
    if (proxiesVistos.has(px)) return true;
    proxiesVistos.add(px);
    // Só anota a hora de saída (sem mexer no pedido). synchronous:true mantém o caminho síncrono do axios.
    try {
      px.interceptors.request.use(cfg => {
        try { if (cfg && typeof cfg === 'object') { inicio.set(cfg, Date.now()); origemPedido.set(cfg, origemPilha()); } } catch (_) {}
        return cfg;
      }, undefined, { synchronous: true });
    } catch (_) {}
    try {
      px.interceptors.response.use(
        resp => { try { observarApi(resp, null); } catch (_) {} return resp; },
        erro => { try { observarApi(null, erro); } catch (_) {} return Promise.reject(erro); }
      );
    } catch (_) {}
    return true;
  }

  // ---------- (f) 1.1.0: botões clicados, formulários enviados e mensagens de erro de senha na tela ----------
  // Só observa (ouvinte em captura, sem preventDefault/stopPropagation). Grava só o RÓTULO do botão quando ele é
  // uma ação da lista abaixo (nunca texto de linha da fila, que tem nome de paciente).
  const ACOES_BOTAO = /^(ATENDER|CHAMAR( PROXIMO| NOVAMENTE)?|RECHAMAR|CONFIRMAR( ATENDIMENTO| CHEGADA)?|SALVAR( E [A-Z ]{2,20})?|FINALIZAR( ATENDIMENTO)?|SAIR|ENCAMINHAR|AUSENTAR|AUSENTE|NAO COMPARECEU|DESVINCULAR|REMOVER|DEVOLVER|RETORNAR|CONCLUIR|CANCELAR|VOLTAR|FECHAR|LIBERAR|ALTA|INICIAR( ATENDIMENTO)?|EVOLUIR|TRANSFERIR|REABRIR|OK|SIM|NAO|CONFIRMAR)\b/;
  const PALAVRAS_OK = new Set(('SENHA PERDIDA NAO ENCONTRADA ENCONTRADO ERRO ATENDIMENTO FILA CHAMADA CHAMADO JA FOI OUTRO OUTRA PERTENCE ' +
    'INVALIDA INVALIDO LOCAL GUICHE SALA ACOLHIMENTO MEDICO RECEPCAO TRIAGEM PACIENTE DESTE DESTA DE DO DA NO NA EM PARA COM SEM ' +
    'POSSIVEL VINCULAR VINCULADA SELECIONE FAVOR POR TENTE NOVAMENTE ATENCAO AVISO').split(' '));
  // Sequência de 2+ palavras em MAIÚSCULAS fora da lista acima = provável nome de pessoa → '#'.
  const semNomes = t => String(t).replace(/\b(?:[A-ZÀ-Ú]{2,}\s+){1,}[A-ZÀ-Ú]{2,}\b/g, seq => seq.split(/\s+/).every(w => PALAVRAS_OK.has(norm(w))) ? seq : '#');
  let ultimoClique = null;
  function rotuloBotao(el) {
    const bruto = limpo(el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title')) || '') || limpo(el.value || '') || limpo(el.innerText || el.textContent || '');
    const n = norm(bruto).replace(/[^A-Z ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!n || n.length > 40) return '';
    const m = ACOES_BOTAO.exec(n);
    return m ? m[0] : '';   // só o verbo da lista (o resto do rótulo pode ter nome de paciente)
  }
  function dicaElemento(el) {
    const id = idt(el.id || ''), cls = String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '')
      .split(/\s+/).filter(c => /^[\w-]{2,30}$/.test(c)).slice(0, 4).join('.');
    return txt([el.tagName ? el.tagName.toLowerCase() : '', id ? '#' + id : '', cls ? '.' + cls : ''].join(''), 120);
  }
  function instalarCliques() {
    document.addEventListener('click', ev => {
      try {
        if (!ativo() || !ev.isTrusted) return;
        const el = ev.target && ev.target.closest ? ev.target.closest('button, a, input[type="button"], input[type="submit"], [role="button"], .btn') : null;
        if (!el) return;
        let rotulo = rotuloBotao(el);
        // 1.2.0: botão de AVISO/janela (do sistema ou de script OM30): grava o texto do botão, qualquer que seja
        // (ex.: "Continuar sem retorno", "Voltar e marcar retorno"). Texto de aviso não tem nome de paciente; mesmo
        // assim passa pelo filtro de nomes.
        const emAviso = !!(el.closest && el.closest('.swal2-container, .swal2-popup, [role="dialog"], [aria-modal="true"], .modal, .ui-dialog, [id*="warning"], [class*="warning"], [id^="om30"][id*="backdrop"]'));
        if (!rotulo && emAviso) {
          const t = semNomes(limpo(el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title')) || '') || limpo(el.innerText || el.textContent || ''));
          rotulo = t && t.length <= 60 ? txt(norm(t), 60) : '';
        }
        if (!rotulo) return;
        const om30 = !!(el.closest && el.closest('[id^="om30"], [class*="om30"], [id*="OM30"]'));
        ultimoClique = { t: Date.now(), rotulo, om30 };
        const href = el.tagName === 'A' ? urlLimpa(el.getAttribute('href') || '') : '';
        evento('CLIQUE', { detalhe: txt('botao=' + rotulo + (om30 ? ' ; botao_om30' : ' ; botao_sistema') + (emAviso ? ' ; em_aviso' : '') + ' ; el=' + dicaElemento(el) + (href ? ' ; href=' + href : ''), 400) });
      } catch (_) {}
    }, true);
    document.addEventListener('submit', ev => {
      try {
        if (!ativo()) return;
        const f = ev.target;
        if (!f || f.tagName !== 'FORM') return;
        const quem = ev.submitter ? rotuloBotao(ev.submitter) : '';
        const acao = urlLimpa(f.getAttribute('action') || location.href);
        // 1.2.0: quem disparou (pessoa ou script, com a pilha) e o estado das caixas/ordens importantes NA HORA do envio.
        const porScript = !ev.isTrusted || (ultimoClique ? Date.now() - ultimoClique.t > 600 : true);
        const orig = porScript ? origemPilha() : '';
        evento('FORM_ENVIO', { metodo: String(f.getAttribute('method') || 'get').toUpperCase().slice(0, 8), rota: txt(acao, 160),
          detalhe: txt('form=' + dicaElemento(f) + (quem ? ' ; botao=' + quem : '') + (f.getAttribute('data-remote') ? ' ; remoto' : '') +
            (porScript ? ' ; sem_clique_proprio' + (orig ? ' ; origem=' + orig : '') : '') + estadoCampos(f), 400) });
      } catch (_) {}
    }, true);
    // 1.2.0: caixa de marcar, opção e seleção mudadas (pela pessoa ou por script). Só nome do campo + estado/valor curto.
    document.addEventListener('change', ev => {
      try {
        if (!ativo()) return;
        const el = ev.target;
        if (!el || !el.tagName) return;
        const tipo = String(el.type || '').toLowerCase();
        const nome = nomeCampo(el);
        if (!nome) return;
        let valor = '';
        if (tipo === 'checkbox' || tipo === 'radio') valor = el.checked ? 'MARCADO' : 'DESMARCADO';
        else if (el.tagName === 'SELECT' && CAMPOS_SELECAO.test(nome)) valor = valorSeguro(el.value);
        else return;
        const pessoa = !!ev.isTrusted;
        evento('CAMPO', { detalhe: txt('campo=' + nome + ' ; ' + valor + ' ; por=' + (pessoa ? 'pessoa' : 'script ; origem=' + origemPilha()) + ' ; el=' + dicaElemento(el), 400) });
      } catch (_) {}
    }, true);
  }
  const CAMPOS_SELECAO = /salas?_ordem|ordem|destino|sala|encaminh|retorn|tipo_atendimento|risco|especialidade/i;
  const CAMPOS_ESTADO = /retorn|encaminh|alta|obito|urgen|confirm/i;
  function nomeCampo(el) {
    const n = String(el.getAttribute && el.getAttribute('name') || el.id || '').replace(/^.*\[([^\]]+)\]\[?\]?$/, '$1').replace(/\[\]$/, '');
    return /^[\w.-]{1,60}$/.test(n) ? n : '';
  }
  const valorSeguro = v => { const t = limpo(v); return /^[\w#.:-]{1,40}$/.test(t) ? t : (t ? '?' : ''); };
  function estadoCampos(f) {
    try {
      const partes = [];
      for (const el of f.querySelectorAll('input[type="checkbox"], input[type="radio"]')) {
        const n = nomeCampo(el);
        if (n && CAMPOS_ESTADO.test(n) && (el.type === 'checkbox' || el.checked)) partes.push(n + '=' + (el.checked ? 1 : 0) + (el.type === 'radio' ? ':' + valorSeguro(el.value) : ''));
      }
      const ordens = [...f.querySelectorAll('select')].filter(s => /salas?_ordem/i.test(String(s.getAttribute('name') || ''))).map(s => valorSeguro(s.value)).filter(Boolean);
      if (ordens.length) partes.push('ordem=' + ordens.join(','));
      return partes.length ? ' ; campos: ' + partes.join(' ') : '';
    } catch (_) { return ''; }
  }
  // Mensagem de erro de senha que aparece na tela (aviso do sistema, caixa, alerta do navegador).
  const ERRO_SENHA = /senha[\s\S]{0,80}(perdid|n[aã]o (foi )?encontrad|inv[aá]lid|j[aá] (foi )?chamad|outro atendimento|n[aã]o pertence|n[aã]o vinculad|erro)|(perdid|n[aã]o (foi )?encontrad)[\s\S]{0,40}senha/i;
  const vistosTela = new Map();
  // 1.2.0: janela/aviso que diz para ONDE a senha foi ou que o atendimento terminou (ex.: pop-up ao finalizar no
  // acolhimento, "encaminhado para...", aviso "Salvar sem retorno médico?" do Procedimentos PA).
  const AVISO_FLUXO = /encaminh|finaliz|conclu[ií]|retorn|destino|fila d|enviad[oa] para|direcionad|sala d|raio|alta|ausent|devolvid|cancelad/i;
  function registrarMensagem(origem, texto, ehAviso) {
    const t = limpo(texto);
    if (!t || t.length > 600) return;
    const erro = ERRO_SENHA.test(t);
    if (!erro && !(ehAviso && AVISO_FLUXO.test(t))) return;
    const msg = txt(semNomes(t), 300);
    const agora = Date.now();
    if (vistosTela.get(msg) > agora - 10000) return;   // o mesmo aviso repetido em 10 s conta uma vez
    vistosTela.set(msg, agora);
    if (vistosTela.size > 50) vistosTela.delete(vistosTela.keys().next().value);
    const det = 'onde=' + origem + (ultimoClique && agora - ultimoClique.t < 15000 ? ' ; clique=' + ultimoClique.rotulo + ' (' + (agora - ultimoClique.t) + 'ms antes)' : '');
    if (erro) evento('MENSAGEM_TELA', { erro: msg, detalhe: txt(det, 400) });
    else evento('AVISO_TELA', { detalhe: txt('texto=' + msg + ' ; ' + det, 400) });
  }
  const SEL_AVISO = '.swal2-container, .swal2-popup, .toast, .toast-message, .noty_bar, .alert, [role="dialog"], [role="alertdialog"], [role="alert"], [aria-modal="true"], .modal, .ui-dialog, [id*="warning"], [class*="warning"]';
  function ehNoDeAviso(no) {
    try { return !!((no.matches && no.matches(SEL_AVISO)) || (no.closest && no.closest(SEL_AVISO)) || (no.querySelector && no.querySelector(SEL_AVISO))); } catch (_) { return false; }
  }
  function instalarMensagens() {
    try {
      const obs = new MutationObserver(lista => {
        try {
          for (const m of lista) for (const no of m.addedNodes) {
            if (!no || no.nodeType !== 1) continue;
            const aviso = ehNoDeAviso(no);
            if (no.id && /^om30/i.test(no.id) && !aviso) continue;   // painéis dos scripts OM30 ficam de fora (avisos deles não)
            const t = no.innerText || no.textContent || '';
            if (t && t.length <= 600) registrarMensagem(dicaElemento(no), t, aviso);
          }
        } catch (_) {}
      });
      obs.observe(document.body || document.documentElement, { childList: true, subtree: true });
      setTimeout(() => { try { obs.disconnect(); } catch (_) {} }, Math.max(0, FIM - Date.now()));
    } catch (_) {}
    // alert/confirm: chama o original com os mesmos argumentos e devolve o mesmo resultado.
    for (const nome of ['alert', 'confirm']) {
      try {
        const orig = window[nome];
        if (typeof orig !== 'function') continue;
        window[nome] = function (msg) { try { registrarMensagem('janela_' + nome, msg, true); } catch (_) {} return orig.apply(this, arguments); };
      } catch (_) {}
    }
  }

  // ---------- (e) abertura de aba nova e marca window.name ----------
  function marcaNome(nome) {
    const n = String(nome == null ? '' : nome);
    if (n.indexOf('om30ficha:') === 0) {
      // A marca da Fila Médica/Ausentes leva o nome do paciente: só id, tipo e setor são lidos.
      try {
        const t = JSON.parse(n.slice(10));
        return { marca: 'om30ficha', a: atend(t && t.id, t && t.tipo), setor: /^[A-Z_]{2,20}$/.test(String(t && t.setor || '')) ? t.setor : '' };
      } catch (_) { return { marca: 'om30ficha', a: '', setor: '' }; }
    }
    if (!n) return { marca: '', a: '', setor: '' };
    const base = n.replace(/[-_]?\d+$/, '').slice(0, 40);
    return { marca: /^[\w-]+$/.test(base) ? base : 'outro', a: '', setor: '' };
  }
  try {
    const abrirNativo = window.open;
    if (typeof abrirNativo === 'function') {
      window.open = function open(url, nome) {   // eslint-disable-line no-unused-vars
        const j = abrirNativo.apply(this, arguments);
        try {
          if (ativo()) {
            const m = marcaNome(nome);
            evento('ABRIR_ABA', {
              alvo_atendimento: m.a,
              detalhe: txt('nome=' + (m.marca || '-') + (m.setor ? ' ' + m.setor : '') + ' destino=' + urlLimpa(url) + (j ? '' : ' bloqueada'), 400),
            });
          }
        } catch (_) {}
        return j;
      };
    }
  } catch (_) {}

  // ---------- (c) carga da página ----------
  const lsInicio = resumo(lerJSON(LS, 'senha'));   // senha no navegador quando a página começou a carregar
  let cargaFeita = false;
  function registrarCarga() {
    if (cargaFeita || !ativo()) return;
    cargaFeita = true;
    try {
      const ident = identidade(false);
      const st = pegarStore();
      const temStore = !!(st && st.getters);
      let sv = null;
      try { sv = temStore ? st.getters.senhaChamada : null; } catch (_) { sv = null; }
      const usada = temStore ? resumo(sv) : resumo(lerJSON(LS, 'senha'));
      let nomeAba = { marca: '', a: '', setor: '' }, filha = false;
      try { nomeAba = marcaNome(window.name); } catch (_) {}
      try { filha = !!window.opener; } catch (_) { filha = false; }
      const det = [];
      const ps = nomesParams();
      if (ps) det.push('params=' + ps);
      if (ident && ident.fonte) det.push('fonte=' + ident.fonte);
      if (ident && ident.p) det.push('prontuario=' + ident.p);
      if (nomeAba.marca) det.push('aba_nome=' + nomeAba.marca + (nomeAba.setor ? ' ' + nomeAba.setor : ''));
      if (filha) det.push('filha');
      if (ABA_MAE) det.push('mae=' + ABA_MAE);
      if (!temStore) det.push('sem_store');
      const lsAgora = resumo(lerJSON(LS, 'senha'));
      if (temStore && ((lsAgora && lsAgora.id) || '') !== ((usada && usada.id) || '')) det.push('ls_difere_store');
      evento('CARGA', Object.assign(camposSenha(usada), {
        pagina_atendimento: (ident && ident.a) || '',
        alvo_atendimento: nomeAba.a,
        antes_senha: lsInicio ? lsInicio.cod : '', antes_senha_id: lsInicio ? lsInicio.id : '', antes_atendimento: lsInicio ? lsInicio.at : '',
        detalhe: txt(det.join(' '), 400),
      }));
    } catch (_) {}
  }

  // ---------- envio em lote ----------
  const configurado = () => /^https:\/\/[\w.-]+(\/|$)/.test(API) && API.indexOf('<') < 0 && !!CHAVE && CHAVE !== 'TROCAR-PELA-CHAVE';
  let enviando = false, semKeepalive = false;
  async function postar(lote, saida) {
    const op = {
      method: 'POST', body: JSON.stringify({ v: 1, eventos: lote }),
      headers: { 'Content-Type': 'application/json', 'X-OM30-Key': CHAVE },
      credentials: 'omit', mode: 'cors', cache: 'no-store',
    };
    if (!semKeepalive) {
      try { const r = await fetchNativo(API + '/v1/rastro', Object.assign({ keepalive: true }, op)); return r.status; }
      catch (e) { if (saida) throw e; }
    }
    const r = await fetchNativo(API + '/v1/rastro', op);
    // Só sem keepalive deu certo: este navegador não aceita keepalive com CORS; nesta página segue sem ele.
    if (!semKeepalive) semKeepalive = true;
    return r.status;
  }
  function falhou(tv) {
    const f = Math.min((Number(tv && tv.falhas) || 0) + 1, 5);
    gravar(LS, K.TRAVA, JSON.stringify({ aba: '', ate: 0, prox: Date.now() + Math.min(300000, CICLO_MS * Math.pow(2, f)), falhas: f }));
  }
  async function enviar(motivo) {
    if (!ativo() || !configurado() || !fetchNativo || enviando) return;
    const saida = motivo === 'saida';
    const agora = Date.now();
    const tv = lerJSON(LS, K.TRAVA) || {};
    if (!saida) {
      if (tv.prox && agora < tv.prox) return;                       // esperando depois de falha
      if (tv.aba && tv.aba !== ABA && tv.ate > agora) return;       // outra aba deste navegador está enviando
    }
    const fila = LS ? lerFila() : memoria.slice();
    if (!fila.length) return;
    const lote = [];
    let bytes = 24;
    for (const e of fila) {
      const n = JSON.stringify(e).length + 1;
      if (lote.length >= MAX_LOTE || bytes + n > MAX_BYTES) break;
      lote.push(e); bytes += n;
    }
    if (!lote.length) { removerDaFila([fila[0].uid]); return; }   // evento grande demais: descarta
    if (!saida) gravar(LS, K.TRAVA, JSON.stringify({ aba: ABA, ate: agora + 30000, prox: 0, falhas: Number(tv.falhas) || 0 }));
    enviando = true;
    try {
      const st = await postar(lote, saida);
      if (saida) return;   // na saída não dá para esperar: o Worker ignora repetidos (uid)
      if (st >= 200 && st < 300) {
        removerDaFila(lote.map(e => e.uid));
        gravar(LS, K.TRAVA, JSON.stringify({ aba: '', ate: 0, prox: 0, falhas: 0 }));
        if (fila.length > lote.length) setTimeout(() => { enviar('resto'); }, 1500);
      } else if (st === 400 || st === 413) {
        removerDaFila(lote.map(e => e.uid));   // lote recusado pelo formato: não fica reenviando para sempre
        gravar(LS, K.TRAVA, JSON.stringify({ aba: '', ate: 0, prox: 0, falhas: 0 }));
      } else falhou(tv);
    } catch (_) {
      if (!saida) falhou(tv);
    } finally { enviando = false; }
  }

  // ---------- momentos ----------
  const aoDom = () => {
    domPronto = true;
    atualizarCtx();
    instalarStore();
    instalarProxy();
    registrarCarga();
    try { instalarMensagens(); } catch (_) {}
  };
  try { instalarCliques(); } catch (_) {}
  const aoCarregar = () => {
    setTimeout(() => {
      carregou = true;
      identFinal = true;
      atualizarCtx();
      instalarStore();
      instalarProxy();
    }, 1500);
  };
  try {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', aoDom);
    else aoDom();
    if (document.readyState === 'complete') aoCarregar();
    else window.addEventListener('load', aoCarregar);
  } catch (_) {}
  // Espera o proxy e o store aparecerem (no máximo 60 s; páginas sem Vue simplesmente não têm).
  try {
    let n = 0;
    const t = setInterval(() => {
      let ok = false;
      try { ok = instalarProxy() & instalarStore(); } catch (_) { ok = false; }
      if (ok || ++n > 240 || !ativo()) clearInterval(t);
    }, 250);
  } catch (_) {}
  // Aba copiada pelo navegador (duplicar aba) leva o mesmo sessionStorage: a aba já aberta mantém o id.
  try {
    if (typeof BroadcastChannel === 'function') {
      const bc = new BroadcastChannel('om30-rastro-abas');
      bc.onmessage = ev => {
        try {
          const m = ev && ev.data;
          if (!m || typeof m !== 'object') return;
          if (m.q === ABA && m.c !== CARGA) bc.postMessage({ r: ABA, c: m.c });
          else if (m.r === ABA && m.c === CARGA) {
            const antiga = ABA;
            ABA = novoId(); ABA_MAE = antiga;
            gravar(SS, K.ABA, JSON.stringify({ id: ABA, filha: true, mae: antiga }));
            evento('ABA_COPIA', { detalhe: 'mae=' + antiga });
          }
        } catch (_) {}
      };
      bc.postMessage({ q: ABA, c: CARGA });
    }
  } catch (_) {}
  try {
    setTimeout(() => { enviar('inicio'); }, 3000);
    const ciclo = setInterval(() => { if (!ativo()) { clearInterval(ciclo); return; } try { resumirRecuperarOm30(false); } catch (_) {} enviar('ciclo'); }, CICLO_MS);
    window.addEventListener('pagehide', () => { try { resumirRecuperarOm30(true); } catch (_) {} enviar('saida'); });
    document.addEventListener('visibilitychange', () => { try { if (document.visibilityState === 'hidden') enviar('oculta'); } catch (_) {} });
  } catch (_) {}
})();
