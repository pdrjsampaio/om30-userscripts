// ==UserScript==
// @name         OM30 - Rascunho de Evolução
// @namespace    om30-guaruja
// @version      1.0.0
// @updateURL    https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Rascunho-Evolucao.user.js
// @downloadURL  https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Rascunho-Evolucao.user.js
// @description  Rascunho de evolução por paciente durante o atendimento (fila e ficha): anotações com horário e medicação; no final envia para a ficha certa (Motivo do atendimento + seção Medicamentos) e apaga o rascunho ao salvar.
// @author       Pedro Sampaio
// @match        https://guaruja.saudesimples.net/*
// @match        https://guarujahomolog.saudesimples.net/*
// @grant        none
// @inject-into  page
// @run-at       document-idle
// ==/UserScript==

// =====================================================================
// ADAPTADOR — Saúde Simples Guarujá (PA / Urgência e Emergência)
// Seletores tirados dos scripts OM30 já em uso:
//   Fila Médica:  #classificacao tr.collection-row, células [1]=CNS [2]=nome [6]=senha,
//                 botão .botao-atender, itens Vue com atendimento_str "AtendimentoPa#123"
//   Ficha:        /prontuarios/new?prontuariavel_id=…  ou  /atendimentos_pas/{id}/prontuario
//                 #prontuario_prontuariavel_id / _type ; seções .portlet > .portlet-header
//   Medicação:    #prontuario_medicamento_token (tokenInput), #prontuario_tipo_uso_medicamento_id,
//                 #prontuario_posologia_medicamento, #prontuario_observacao_medicamento,
//                 a.incluir_prontuario_medicamento, tr.prontuario-medicamento-row
//   Busca:        /estoque/produtos/aplicacao_local?q=
//   Usuário:      /current_usuario (profissional_id) | #current_profissional | nome na barra
// =====================================================================
(() => {
  const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
  const norm = s => clean(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  const dig = s => String(s ?? '').replace(/\D/g, '');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const q = (s, r = document) => r.querySelector(s);
  const qa = (s, r = document) => [...r.querySelectorAll(s)];
  const visivel = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const fora = el => !el.closest('#evol-painel-host');

  const PAC = 'om30-rasc-pac:';   // nome/CNS/senha capturados na fila, por atendimento (sem texto clínico)
  const SEL = 'om30-rasc-sel';
  const VALIDADE = 24 * 3600e3;

  async function esperar(cond, timeout = 2500, passo = 50) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (cond()) return true; await sleep(passo); }
    return !!cond();
  }
  function setValor(el, v) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('keyup', { bubbles: true }));
  }

  // ---------- onde estou ----------
  const ehFila = () => /^\/prontuarios(\/urgencia_emergencia)?\/?$/i.test(location.pathname);
  function chaveFicha() {
    const rota = location.pathname.match(/\/atendimentos_pas\/(\d+)\/prontuario/i);
    const id = rota?.[1] || [
      q('#prontuario_prontuariavel_id')?.value,
      q('input[name="prontuario[prontuariavel_id]"]')?.value,
      new URLSearchParams(location.search).get('prontuariavel_id'),
    ].map(clean).find(v => /^\d+$/.test(v));
    if (!id) return '';
    const tipo = rota ? 'AtendimentoPa' : clean(
      q('#prontuario_prontuariavel_type')?.value ||
      q('input[name="prontuario[prontuariavel_type]"]')?.value ||
      new URLSearchParams(location.search).get('prontuariavel_type') || 'AtendimentoPa');
    return `${tipo}#${id}`;
  }
  // Ficha = qualquer tela (fora da fila) que tenha o campo de texto clínico. Não depende do endereço.
  const ehFicha = () => !ehFila() && (!!chaveFicha() || /prontuario|atendimento/i.test(location.pathname)) && !!localizarCampoTexto();
  // Chave da ficha: nº do atendimento quando a tela expõe; senão, o endereço da própria tela.
  const chaveAtual = () => chaveFicha() || ('pagina:' + location.pathname + location.search);

  // ---------- paciente capturado na fila ----------
  function guardarPac(p) { try { localStorage.setItem(PAC + p.atendimento, JSON.stringify({ ...p, em: Date.now() })); } catch {} }
  function lerPac(chave) {
    try { const v = JSON.parse(localStorage.getItem(PAC + chave)); if (v && Date.now() - v.em < VALIDADE) return v; } catch {}
    return null;
  }
  function limparPacsAntigos() {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k?.startsWith(PAC) && !lerPac(k.slice(PAC.length))) localStorage.removeItem(k);
      }
    } catch {}
  }
  function itensFila() {
    const raiz = q('#classificacao');
    if (!raiz) return [];
    const vistos = new Set(), out = [];
    for (const el of raiz.querySelectorAll('*')) {
      const vm = el.__vue__;
      if (!vm || vistos.has(vm)) continue;
      vistos.add(vm);
      for (const arr of [vm.$data?.items, vm.$props?.items, vm.items])
        if (Array.isArray(arr)) for (const it of arr) if (it?.atendimento_str) out.push(it);
    }
    return out;
  }
  function itemDaLinha(tr) {
    const senha = clean(tr.cells?.[6]?.innerText);
    if (!senha) return null;
    const porAtend = new Map();
    for (const it of itensFila()) if (norm(it.senha) === norm(senha)) porAtend.set(it.atendimento_str, it);
    if (porAtend.size !== 1) return null;
    const it = [...porAtend.values()][0];
    const cnsLinha = dig(tr.cells?.[1]?.innerText);
    if (cnsLinha && dig(it.codigo_cns) && cnsLinha !== dig(it.codigo_cns)) return null;
    return it;
  }
  const pacienteDoItem = it => ({
    atendimento: clean(it.atendimento_str), nome: clean(it.nome_municipe), cns: clean(it.codigo_cns),
    senha: clean(it.senha), nascimento: clean(it.data_nascimento_municipe || it.data_nascimento || ''),
  });

  let api = null;
  function instalarFila() {
    document.addEventListener('click', ev => {
      const b = ev.target.closest?.('.botao-atender, [class*="botao-atender"]');
      const tr = b?.closest('tr.collection-row');
      if (!tr) return;
      const it = itemDaLinha(tr);
      if (it) guardarPac(pacienteDoItem(it));
    }, true);

    setInterval(() => {
      if (!ehFila()) return;
      for (const tr of qa('#classificacao tr.collection-row')) {
        const cel = tr.cells?.[2];
        if (!cel) continue;
        let b = cel.querySelector('.om30-rasc-btn');
        if (!b) {
          b = document.createElement('button');
          b.type = 'button';
          b.className = 'om30-rasc-btn';
          b.title = 'Rascunho de evolução deste paciente';
          b.textContent = '📝';
          b.addEventListener('click', ev => {
            ev.preventDefault(); ev.stopPropagation();
            const it = itemDaLinha(tr);
            if (!it) { api?.avisar('Não consegui identificar este paciente com segurança (senha/CNS). Atualize a fila e tente de novo.'); return; }
            const p = pacienteDoItem(it);
            guardarPac(p);
            sessionStorage.setItem(SEL, JSON.stringify(p));
            api?.atualizar(true);
          }, true);
          cel.appendChild(b);
        }
        const senha = clean(tr.cells?.[6]?.innerText);
        const n = senha && api?.qtdRascunhoSenha ? api.qtdRascunhoSenha(senha) : 0;
        const txt = n ? `📝 ${n}` : '📝';
        if (b.textContent !== txt) b.textContent = txt;
        b.classList.toggle('tem', n > 0);
        b.title = n ? `Rascunho de evolução: ${n} anotação(ões)` : 'Abrir rascunho de evolução deste paciente';
      }
    }, 1000);

    const st = document.createElement('style');
    st.textContent = `.om30-rasc-btn{margin-left:5px;border:0;background:transparent;border-radius:999px;cursor:pointer;font:600 11px "Segoe UI",Arial;color:#123f68;padding:1px 5px;line-height:18px;vertical-align:middle;opacity:.45;transition:opacity .12s,background .12s}
      tr:hover .om30-rasc-btn,.om30-rasc-btn:hover{opacity:1}.om30-rasc-btn:hover{background:#e8eff5}
      .om30-rasc-btn.tem{opacity:1;background:#e8eff5;padding:1px 8px}.om30-rasc-btn.tem:hover{background:#d6e3ee}`;
    document.head.appendChild(st);
  }

  // Botão "📝 Usar rascunho" dentro da ficha, no cabeçalho da seção do texto clínico.
  function instalarFicha() {
    const st = document.createElement('style');
    // fica à esquerda do ícone de abrir/fechar da seção, sem cobri-lo
    st.textContent = `.om30-usar-rasc{float:right;margin:-3px 30px -3px 8px;border:1px solid #123f68;border-radius:999px;background:#fff;color:#123f68;font:600 11.5px "Segoe UI",Arial;padding:3px 11px;cursor:pointer;line-height:16px}
      .om30-usar-rasc:hover{background:#123f68;color:#fff}.om30-usar-rasc-solto{display:inline-block;float:none;margin:0 0 6px 0}`;
    document.head.appendChild(st);
    setInterval(() => {
      if (ehFila()) return;
      const c = localizarCampoTexto();
      if (!c || document.querySelector('.om30-usar-rasc')) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'om30-usar-rasc';
      b.textContent = '📝 Usar rascunho';
      b.title = 'Enviar para cá o rascunho de evolução deste paciente';
      b.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); api?.usarRascunho(); }, true);
      const header = c.el.closest('.portlet')?.querySelector('.portlet-header');
      if (header) header.appendChild(b);
      else { b.classList.add('om30-usar-rasc-solto'); c.el.parentElement.insertBefore(b, c.el); }
    }, 1000);
  }

  // A tela mostra este paciente? (nome completo ou CNS escrito na página, fora do painel)
  function paginaMostra(pac) {
    const texto = document.body.innerText || '';
    const cns = dig(pac.cns);
    if (cns.length >= 10 && dig(texto).includes(cns)) return true;
    const nome = norm(pac.nome);
    if (nome.length < 5) return false;
    // palavras inteiras (o caso "MARIA DA SILVA" x "MARIA DA SILVA SANTOS" é resolvido no painel)
    const esc = nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(^|[^A-Z])' + esc + '(?![A-Z])').test(norm(texto));
  }

  // ---------- campo de texto clínico da ficha ----------
  // Procura pela SEÇÃO (portlet) e não por um id fixo: Motivo/Descrição do exame clínico/Evolução/Anamnese.
  const SECOES_TEXTO = ['MOTIVO', 'EXAME CLINICO', 'EVOLUCAO', 'ANAMNESE', 'HISTORIA', 'DESCRICAO'];
  function editavelEm(raiz) {
    // CKEditor 4
    for (const [id, inst] of Object.entries(window.CKEDITOR?.instances || {})) {
      const el = document.getElementById(id);
      if (el && raiz.contains(el)) return { tipo: 'ckeditor', el, inst };
    }
    // TinyMCE
    for (const ed of (window.tinymce?.editors || [])) {
      const el = ed.getElement?.();
      if (el && raiz.contains(el)) return { tipo: 'tinymce', el, inst: ed };
    }
    const ce = qa('[contenteditable="true"]', raiz).find(e => visivel(e) && fora(e));
    if (ce) return { tipo: 'contenteditable', el: ce };
    // a seção pode estar recolhida: prefere o visível, senão o primeiro
    const ta = qa('textarea', raiz).filter(fora);
    const t = ta.find(visivel) || ta[0] || null;
    if (t) return { tipo: 'textarea', el: t };
    return null;
  }
  // Nome do campo como aparece na tela (ex.: "Motivo do atendimento e descrição do exame clínico")
  function rotuloCampo(el) {
    const lab = (el.id && q(`label[for="${el.id}"]`)) || el.closest('li')?.querySelector('label');
    const t = clean(lab?.textContent).replace(/\s*\*\s*$/, '');
    return t || clean(el.closest('.portlet')?.querySelector('.portlet-header')?.childNodes[0]?.textContent) || el.name || el.id;
  }
  // Abre a seção se estiver recolhida (ícone de seta do cabeçalho)
  function abrirSecao(el) {
    const p = el.closest('.portlet');
    const conteudo = p && q('.portlet-content', p);
    if (conteudo && !visivel(conteudo)) q('.portlet-header .ui-icon', p)?.click();
  }
  function localizarCampoTexto() {
    const portlets = qa('.portlet').filter(p => q('.portlet-header', p));
    for (const chave of SECOES_TEXTO) {
      for (const p of portlets) {
        const titulo = norm(q('.portlet-header', p).textContent);
        if (!titulo.includes(chave)) continue;
        const ed = editavelEm(p);
        if (ed) return { ...ed, rotulo: rotuloCampo(ed.el) };
      }
    }
    // pelo nome do campo (no Saúde Simples de Guarujá: #prontuario_motivo_atendimento)
    const porNome = q('#prontuario_motivo_atendimento') || qa('textarea').filter(fora).find(t => /motivo|descricao|evolu|anamnese|exame_clinico/i.test(t.id + ' ' + t.name));
    if (porNome) {
      const ck = window.CKEDITOR?.instances?.[porNome.id];
      return { tipo: ck ? 'ckeditor' : 'textarea', el: porNome, inst: ck, rotulo: rotuloCampo(porNome) };
    }
    return null;
  }

  function escreverEvolucao(texto) {
    const c = localizarCampoTexto();
    if (!c) throw new Error('Não achei o campo de texto clínico nesta ficha. Use "Diagnóstico" no menu ⋯ e me mande o resultado.');
    abrirSecao(c.el);
    const html = texto.split('\n').map(l => l.replace(/&/g, '&amp;').replace(/</g, '&lt;')).join('<br>');
    if (c.tipo === 'ckeditor') {
      const atual = c.inst.getData();
      c.inst.setData((clean(atual.replace(/<[^>]+>/g, ' ')) ? atual : '') + '<p>' + html + '</p>');
      c.inst.updateElement?.();
    } else if (c.tipo === 'tinymce') {
      c.inst.setContent(c.inst.getContent() + '<p>' + html + '</p>');
      c.inst.save?.();
    } else if (c.tipo === 'contenteditable') {
      c.el.focus();
      const sel = window.getSelection(); sel.selectAllChildren(c.el); sel.collapseToEnd();
      document.execCommand('insertHTML', false, (clean(c.el.textContent) ? '<br><br>' : '') + html);
    } else {
      const atual = c.el.value.replace(/\s+$/, '');
      setValor(c.el, atual ? atual + '\n\n' + texto : texto);
      // confere se o sistema não desfez
      if (!c.el.value.includes(texto.split('\n')[0])) throw new Error('O sistema não aceitou o texto no campo "' + c.rotulo + '".');
    }
    (c.el.closest('.portlet') || c.el).scrollIntoView({ behavior: 'smooth', block: 'center' });
    return c.rotulo;
  }

  // ---------- medicação ----------
  function vias() {
    const s = q('#prontuario_tipo_uso_medicamento_id');
    const nativas = s ? [...s.options].filter(o => clean(o.value) && clean(o.textContent)).map(o => clean(o.textContent)) : [];
    const base = ['INTRAVENOSA', 'INTRAMUSCULAR', 'ORAL', 'SUBCUTANEA'];
    return nativas.length ? [...base.filter(b => nativas.some(n => norm(n) === b)), ...nativas.filter(n => !base.includes(norm(n)))] : base;
  }
  async function buscarMedicamento(termo) {
    const r = await fetch('/estoque/produtos/aplicacao_local?q=' + encodeURIComponent(termo), {
      credentials: 'same-origin',
      headers: { Accept: 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!r.ok) throw new Error('Busca de medicamento falhou (HTTP ' + r.status + ').');
    const xs = await r.json();
    return (Array.isArray(xs) ? xs : []).map(x => ({ id: x.id, nome: clean(x.nome || x.descricao), raw: x })).filter(x => x.id && x.nome);
  }
  async function adicionarMedicacao(m) {
    const $ = window.jQuery || window.$;
    const token = q('#prontuario_medicamento_token');
    if (!token) throw new Error('Seção Medicamentos não encontrada nesta ficha.');
    if (!$ || typeof $(token).tokenInput !== 'function') throw new Error('O campo de medicamento ainda não carregou. Espere a ficha carregar e envie de novo.');
    if (!m.item?.id) throw new Error(`"${m.nome}" não foi escolhido da lista do estoque.`);
    const selVia = q('#prontuario_tipo_uso_medicamento_id'), pos = q('#prontuario_posologia_medicamento'), obs = q('#prontuario_observacao_medicamento');
    if (!selVia || !pos) throw new Error('Campos de via/posologia não encontrados.');
    const opc = [...selVia.options].find(o => clean(o.value) && norm(o.textContent) === norm(m.via));
    if (!opc) throw new Error(`Via "${m.via}" não existe nesta ficha.`);
    const linhasAtivas = () => qa('tr.prontuario-medicamento-row').filter(r => {
      const d = clean(q('input[name$="[_destroy]"]', r)?.value).toLowerCase();
      return d !== '1' && d !== 'true' && getComputedStyle(r).display !== 'none';
    }).length;
    abrirSecao(token);
    const antes = linhasAtivas();
    try { $(token).tokenInput('clear'); } catch {}
    $(token).tokenInput('add', { ...m.item, id: m.item.id, name: m.nome });
    await sleep(100);
    selVia.value = opc.value; selVia.dispatchEvent(new Event('change', { bubbles: true }));
    setValor(pos, m.posologia);
    // horário do registro vai na Observação do medicamento (ex.: "Horário: 21:20")
    const obsTexto = [m.obs, m.horario && `Horário: ${m.horario}`].filter(Boolean).join(' · ');
    if (obs) setValor(obs, obsTexto);
    await sleep(120);
    const b = q('#prontuario-medicamento-container a.incluir_prontuario_medicamento') || q('a.incluir_prontuario_medicamento');
    if (!b) { try { $(token).tokenInput('clear'); } catch {} throw new Error('Botão "+ Incluir" de Medicamento não encontrado.'); }
    b.click();
    const entrou = await esperar(() => linhasAtivas() > antes, 3000);
    try { $(token).tokenInput('clear'); } catch {}
    if (!entrou) throw new Error(`O Saúde Simples não criou a linha de ${m.nome}.`);
  }

  // ---------- usuário logado ----------
  function nomeNaBarra() {
    const t = qa('.navbar a,.navbar button,.navbar .dropdown-toggle,nav a,nav button,.topbar a,.topbar button')
      .map(el => clean(el.textContent)).filter(t => t.length >= 5 && t.length <= 180)
      .filter(t => /\|\s*[A-Z]{1,8}\s*\d{2,}$/i.test(t))
      .sort((a, b) => b.length - a.length)[0];
    return t ? t.replace(/\s*\|\s*[A-Z]{1,8}\s*\d{2,}\s*$/i, '').trim() : '';
  }
  let ultimaFonteUsuario = '';
  async function identificarMedico() {
    let id = '', nome = nomeNaBarra();
    try {
      const csrf = q('meta[name="csrf-token"]')?.content || '';
      const r = await fetch('/current_usuario', { credentials: 'include', cache: 'no-store',
        headers: { Accept: '*/*', 'X-Requested-With': 'XMLHttpRequest', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) } });
      if (r.ok) {
        const u = await r.json();
        id = clean(u?.profissional_id);
        nome = nome || clean(u?.nome || u?.name || u?.profissional_nome || '');
        if (id) ultimaFonteUsuario = 'current_usuario';
      } else ultimaFonteUsuario = 'current_usuario HTTP ' + r.status;
    } catch (e) { ultimaFonteUsuario = 'current_usuario erro'; }
    if (!id) { id = qa('#current_profissional,input[name="current_profissional"],input[id$="_current_profissional"]').map(e => clean(e.value)).find(Boolean) || ''; if (id) ultimaFonteUsuario = 'current_profissional'; }
    if (!id && nome) { id = 'nome:' + norm(nome); ultimaFonteUsuario = 'nome da barra'; }
    return id ? { id, nome } : null;
  }

  // ---------- diagnóstico (só estrutura, sem dados do paciente) ----------
  function diagnostico() {
    const campo = localizarCampoTexto();
    const $ = window.jQuery || window.$;
    return {
      caminho: location.pathname,
      temQuery: [...new URLSearchParams(location.search).keys()],
      chaveFicha: chaveFicha() ? chaveFicha().replace(/#\d+$/, '#<id>') : '(nenhuma — usando endereço da tela)',
      ehFila: ehFila(), ehFicha: ehFicha(),
      usuario: ultimaFonteUsuario,
      secoes: qa('.portlet .portlet-header').map(h => clean(h.textContent)).slice(0, 40),
      textareas: qa('textarea').filter(fora).map(t => ({ id: t.id, name: t.name, visivel: visivel(t), secao: clean(t.closest('.portlet')?.querySelector('.portlet-header')?.textContent) })).slice(0, 30),
      editaveis: qa('[contenteditable="true"]').filter(fora).map(e => ({ tag: e.tagName, classe: String(e.className).slice(0, 60), visivel: visivel(e) })).slice(0, 10),
      iframes: qa('iframe').map(f => ({ id: f.id, classe: String(f.className).slice(0, 60), titulo: f.title })).slice(0, 10),
      editores: { ckeditor: Object.keys(window.CKEDITOR?.instances || {}), tinymce: (window.tinymce?.editors || []).map(e => e.id), summernote: qa('.note-editable').length },
      campoEscolhido: campo ? { tipo: campo.tipo, id: campo.el.id, name: campo.el.name, rotulo: campo.rotulo } : null,
      medicacao: {
        token: !!q('#prontuario_medicamento_token'), tokenInput: !!($ && q('#prontuario_medicamento_token') && typeof $(q('#prontuario_medicamento_token')).tokenInput === 'function'),
        via: !!q('#prontuario_tipo_uso_medicamento_id'), posologia: !!q('#prontuario_posologia_medicamento'),
        incluir: !!q('a.incluir_prontuario_medicamento'), linhas: qa('tr.prontuario-medicamento-row').length,
      },
      formularios: qa('form').map(f => ({ id: f.id, acao: (f.getAttribute('action') || '').replace(/\d+/g, '<n>') })).slice(0, 10),
      botoes: qa('input[type=submit],button[type=submit],a.btn,button.btn').filter(fora).map(b => clean(b.value || b.textContent)).filter(Boolean).slice(0, 25),
    };
  }

  window.EvolConfig = {
    nomeSistema: 'Saúde Simples',
    prefixo: 'om30-rasc:',
    identificarMedico,
    instalar(painelApi) { api = painelApi; limparPacsAntigos(); instalarFila(); instalarFicha(); },
    paginaRelevante: () => ehFila() || ehFicha(),
    // Só o formulário da própria ficha conta como "salvar a ficha"
    ehFormularioFicha: f => /prontuario/i.test((f.id || '') + ' ' + (f.getAttribute('action') || '')) && !!localizarCampoTexto() && f.contains(localizarCampoTexto().el),
    // Depois de salvar com sucesso, o Saúde Simples sempre leva para uma destas telas
    // (visto na captura): /prontuarios/{id}?encaminhar=1… → /encaminhamentos_controle_salas/new?prontuario_id=…
    // Se o salvar falha, a tela fica em /prontuarios/new — e o rascunho NÃO é apagado.
    paginaPosSalvar: () => /^\/prontuarios\/\d+\/?$/.test(location.pathname) || /^\/encaminhamentos_controle_salas\/new/.test(location.pathname),
    esquecerPaciente(atendimento) {
      try { localStorage.removeItem(PAC + atendimento); } catch {}
      try { const s = JSON.parse(sessionStorage.getItem(SEL)); if (s?.atendimento === atendimento) sessionStorage.removeItem(SEL); } catch {}
    },
    paginaMostra,
    lerPaciente() {
      if (ehFicha()) {
        const chave = chaveAtual();
        const s = lerPac(chave) || {};
        return { atendimento: chave, nome: s.nome || '', cns: s.cns || '', senha: s.senha || '', nascimento: s.nascimento || '', naFicha: true };
      }
      if (ehFila()) {
        try { const p = JSON.parse(sessionStorage.getItem(SEL)); if (p?.atendimento) return { ...p, naFicha: false }; } catch {}
      }
      return null;
    },
    confirmarPaciente(pac) {
      if (!ehFicha()) return { ok: false, motivo: 'Nenhuma ficha aberta nesta tela.' };
      if (chaveAtual() !== pac.atendimento) return { ok: false, motivo: 'A ficha aberta é de outro atendimento.' };
      if (paginaMostra(pac)) return { ok: true };
      return { ok: true, duvida: `Não achei o nome/CNS de ${pac.nome || 'paciente'} escrito nesta tela. Confira com atenção.` };
    },
    destinoTexto() { return localizarCampoTexto()?.rotulo || ''; },
    destinoMed() {
      const t = q('#prontuario_medicamento_token');
      return clean(t?.closest('.portlet')?.querySelector('.portlet-header')?.childNodes[0]?.textContent) || 'Medicamentos';
    },
    // usados para conferir se o que foi enviado continua na ficha (ex.: página recarregada sem salvar)
    textoFicha() {
      const c = localizarCampoTexto();
      if (!c) return null;
      if (c.tipo === 'ckeditor') return c.inst.getData().replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ');
      if (c.tipo === 'tinymce') return c.inst.getContent({ format: 'text' });
      if (c.tipo === 'contenteditable') return c.el.innerText;
      return c.el.value;
    },
    qtdMedicacoesFicha() {
      if (!q('#prontuario_medicamento_token')) return null;
      return qa('tr.prontuario-medicamento-row').filter(r => {
        const d = clean(q('input[name$="[_destroy]"]', r)?.value).toLowerCase();
        return d !== '1' && d !== 'true' && getComputedStyle(r).display !== 'none';
      }).length;
    },
    escreverEvolucao,
    buscarMedicamento,
    adicionarMedicacao,
    vias,
    diagnostico,
    exigeItemDaLista: true,
    favoritos: [
      { busca: 'DIPIRONA', via: 'INTRAVENOSA', posologia: '1 g' },
      { busca: 'ONDANSETRONA', via: 'INTRAVENOSA', posologia: '8 mg' },
      { busca: 'BROMOPRIDA', via: 'INTRAVENOSA', posologia: '10 mg' },
      { busca: 'ESCOPOLAMINA', via: 'INTRAVENOSA', posologia: '20 mg' },
      { busca: 'CETOPROFENO', via: 'INTRAVENOSA', posologia: '100 mg' },
      { busca: 'DEXAMETASONA', via: 'INTRAVENOSA', posologia: '10 mg' },
      { busca: 'CLORETO DE SODIO 0,9%', via: 'INTRAVENOSA', posologia: '500 mL' },
    ],
  };
})();

// =====================================================================
// PAINEL DE RASCUNHO DE EVOLUÇÃO (genérico)
// Cada rascunho é preso a UM atendimento e a UM profissional. Tudo que é do sistema
// fica no adaptador (window.EvolConfig): adaptador-saude-simples.js ou adaptador-demo.js.
// =====================================================================
(() => {
  if (document.getElementById('evol-painel-host')) return;
  const C = window.EvolConfig;
  if (!C) return;

  const PREFIXO = C.prefixo || 'evol:';
  const VALIDADE_MS = 24 * 60 * 60 * 1000;

  // ---------- armazenamento: só neste computador ----------
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
    todos(prefixo) {
      const out = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith(prefixo)) out.push([k, this.get(k)]);
        }
      } catch {}
      return out;
    },
  };

  // Cada médico só enxerga os próprios rascunhos: a chave leva o id do profissional logado.
  let medico = null;
  const base = () => PREFIXO + 'm' + medico.id + ':';
  const meus = () => medico ? store.todos(base()).filter(([, v]) => v?.paciente) : [];
  const chaveDe = p => base() + p.atendimento;
  const agoraHHMM = () => new Date().toTimeString().slice(0, 5);
  const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
  const corDe = p => { let h = 0; for (const c of String(p.atendimento)) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 60% 42%)`; };
  const limparPac = p => ({ atendimento: p.atendimento, nome: p.nome || '', cns: p.cns || '', senha: p.senha || '', nascimento: p.nascimento || '' });
  const novoRascunho = p => ({ paciente: limparPac(p), entradas: [], textoPendente: '', criadoEm: Date.now(), atualizadoEm: Date.now() });
  const nomeExibido = p => p.nome || `Atendimento ${String(p.atendimento).split('#').pop()}`;
  const textoEntrada = e => e.tipo === 'med'
    ? [e.med.nome, e.med.posologia, e.med.via && 'via ' + e.med.via.toLowerCase()].filter(Boolean).join(', ').replace(/\s+/g, ' ').trim()
    : e.texto.trim();
  // Conduta e orientações fecham a evolução: vão num bloco no final, sem horário.
  const ehFechamento = e => e.tipo === 'nota' && /^(conduta|orienta)/i.test(e.texto.trim());
  const linhaEvolucao = e => ehFechamento(e) ? textoEntrada(e) : `${e.hora} - ${e.tipo === 'med' ? 'Medicação: ' : ''}${textoEntrada(e)}`;
  // Momento real da entrada (o horário pode ter sido ajustado à mão; trata a virada da meia-noite).
  function momento(e) {
    const base = new Date(e.id);
    const [h, m] = String(e.hora || '').split(':').map(Number);
    if (Number.isNaN(h)) return e.id;
    const d = new Date(base); d.setHours(h, m || 0, 0, 0);
    let t = d.getTime();
    if (t - e.id > 12 * 3600e3) t -= 24 * 3600e3;
    if (e.id - t > 12 * 3600e3) t += 24 * 3600e3;
    return t;
  }
  const ordenar = xs => [...xs].sort((a, b) => (momento(a) - momento(b)) || (a.id - b.id));
  function montarTexto(entradas) {
    const xs = ordenar(entradas);
    const linhas = xs.filter(e => !ehFechamento(e)).map(linhaEvolucao);
    const fecho = xs.filter(ehFechamento).map(linhaEvolucao);
    if (fecho.length) { if (linhas.length) linhas.push(''); linhas.push(...fecho); }
    return linhas.join('\n');
  }
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- interface (Shadow DOM: não mistura com o CSS do sistema) ----------
  const host = document.createElement('div');
  host.id = 'evol-painel-host';
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
  <style>
    :host { all: initial; }
    * { box-sizing: border-box; font-family: "Segoe UI", Arial, sans-serif; margin: 0; }
    button { font: inherit; cursor: pointer; }
    .painel { position: fixed; top: 0; right: 0; bottom: 0; width: 372px; background: #f4f7f9; color: #263942;
      box-shadow: -8px 0 28px rgba(18,40,56,.18); display: flex; flex-direction: column; z-index: 2147483000; font-size: 13.5px;
      transition: transform .18s ease; }
    .painel.recolhido { transform: translateX(100%); box-shadow: none; }
    .lingueta { position: fixed; right: 0; top: 42%; z-index: 2147483000; display: none; align-items: center; gap: 6px;
      background: #123f68; color: #fff; border: 0; border-radius: 10px 0 0 10px; padding: 10px 10px 10px 12px;
      box-shadow: -3px 3px 14px rgba(18,40,56,.25); font-size: 12.5px; font-weight: 600; }
    .lingueta:hover { background: #17507f; }
    .painel.recolhido ~ .lingueta { display: flex; }
    .lingueta .n { background: #fff; color: #123f68; border-radius: 999px; padding: 0 6px; font-size: 11px; font-weight: 800; line-height: 17px; }

    /* cabeçalho */
    .topo { background: #123f68; color: #fff; padding: 10px 10px 10px 14px; display: flex; align-items: center; gap: 8px; }
    .topo .tit { font-size: 14px; font-weight: 700; flex: 1; letter-spacing: .1px; }
    .ico { width: 30px; height: 30px; border: 0; border-radius: 8px; background: transparent; color: #fff; font-size: 16px; display: grid; place-items: center; }
    .ico:hover { background: rgba(255,255,255,.14); }
    .prof { background: #0e3354; color: #b8cde0; font-size: 11.5px; padding: 5px 14px; display: flex; gap: 6px; align-items: center; }
    .prof b { color: #fff; font-weight: 600; }
    .prof .cad { margin-left: auto; opacity: .8; }
    .menu { position: absolute; right: 10px; top: 44px; background: #fff; border-radius: 10px; box-shadow: 0 10px 28px rgba(18,40,56,.22);
      padding: 4px; display: none; z-index: 5; min-width: 200px; }
    .menu.on { display: block; }
    .menu button { display: block; width: 100%; text-align: left; border: 0; background: transparent; padding: 9px 10px; border-radius: 7px; color: #263942; font-size: 13px; }
    .menu button:hover { background: #eef4f7; }

    /* paciente */
    .card { margin: 10px 10px 0; background: #fff; border-radius: 12px; box-shadow: 0 1px 4px rgba(18,40,56,.08); overflow: hidden; display: flex; }
    .faixa { width: 6px; flex: none; background: #9aa7b0; }
    .cardc { padding: 10px 12px; flex: 1; min-width: 0; }
    .cardtopo { display: flex; align-items: center; gap: 6px; margin-bottom: 3px; }
    .rot { font-size: 10.5px; font-weight: 700; letter-spacing: .6px; color: #8796a0; text-transform: uppercase; flex: 1; }
    .estado { font-size: 10.5px; font-weight: 700; border-radius: 999px; padding: 2px 8px; }
    .estado.ficha { background: #e3f4e8; color: #23733d; }
    .estado.fila { background: #e8eff5; color: #3d5a70; }
    .nome { font-size: 17px; font-weight: 700; color: #16324a; line-height: 1.2; word-break: break-word; }
    .tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
    .tag { font-size: 11px; background: #f0f4f7; color: #4a6272; border-radius: 6px; padding: 2px 7px; }
    .tag.senha { background: #123f68; color: #fff; font-weight: 700; }
    .card.pisca { animation: pisca .45s 3; }
    @keyframes pisca { 50% { box-shadow: 0 0 0 3px rgba(18,63,104,.35); } }

    .outros { margin: 6px 14px 0; font-size: 11.5px; color: #8796a0; display: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .outros.on { display: block; }
    .outros b { color: #4a6272; font-weight: 600; }
    .aviso-fila { margin: 6px 10px 0; font-size: 12px; color: #3d5a70; background: #e8eff5; border-radius: 8px; padding: 7px 9px; display: none; line-height: 1.35; }
    .aviso-fila.on { display: block; }

    /* linha do tempo */
    .tempo { flex: 1; overflow-y: auto; padding: 10px 10px 4px; min-height: 80px; }
    .vazio { color: #8796a0; font-size: 12.5px; text-align: center; padding: 22px 10px; line-height: 1.45; }
    .ent { position: relative; display: flex; gap: 9px; padding: 0 0 10px 0; }
    .ent::before { content: ""; position: absolute; left: 44px; top: 18px; bottom: 0; width: 2px; background: #dfe7ec; }
    .ent:last-child::before { display: none; }
    .hora { width: 36px; flex: none; font: 600 11.5px Consolas, monospace; color: #6c808c; padding-top: 7px; text-align: right; }
    .ponto { width: 10px; height: 10px; flex: none; border-radius: 50%; background: #fff; border: 2px solid #123f68; margin-top: 8px; z-index: 1; }
    .ent.med .ponto { border-color: #23733d; background: #e3f4e8; }
    .bolha { flex: 1; min-width: 0; background: #fff; border-radius: 10px; padding: 7px 9px; box-shadow: 0 1px 3px rgba(18,40,56,.07); position: relative; }
    .bolha .txt { white-space: pre-wrap; word-break: break-word; line-height: 1.4; color: #263942; padding-right: 16px; }
    .pill { display: inline-block; font-size: 10px; font-weight: 800; letter-spacing: .4px; color: #23733d; background: #e3f4e8; border-radius: 5px; padding: 1px 6px; margin-bottom: 3px; }
    .feito { font-size: 10.5px; color: #23733d; margin-top: 3px; font-weight: 600; }
    .rem { position: absolute; top: 4px; right: 4px; width: 20px; height: 20px; border: 0; border-radius: 6px; background: transparent; color: #b3bfc6; font-size: 15px; line-height: 18px; padding: 0; opacity: 0; }
    .bolha:hover .rem { opacity: 1; }
    .rem:hover { background: #fbeaea; color: #b23f3f; }

    /* escolher rascunho na ficha */
    .escolha { background: #fff; border-radius: 12px; padding: 10px; box-shadow: 0 1px 4px rgba(18,40,56,.08); }
    .esc-tit { font-size: 13px; font-weight: 700; color: #16324a; margin-bottom: 2px; }
    .esc-sub { font-size: 11.5px; color: #8796a0; margin-bottom: 8px; line-height: 1.35; }
    .opc { display: flex; align-items: center; gap: 8px; border: 1px solid #e3e9ed; border-radius: 10px; padding: 8px 9px; margin-top: 6px; }
    .opc.provavel { border-color: #23733d; background: #f3faf5; }
    .opc .info { flex: 1; min-width: 0; }
    .opc .info b { display: block; font-size: 13px; color: #16324a; word-break: break-word; }
    .opc .info span { font-size: 11.5px; color: #6c808c; }
    .opc .prov { display: inline-block; font-size: 10px; font-weight: 800; color: #23733d; background: #e3f4e8; border-radius: 5px; padding: 1px 6px; margin-bottom: 2px; }

    /* escrever */
    .editor { background: #fff; border-top: 1px solid #e3e9ed; padding: 8px 10px 10px; }
    .abas { display: grid; grid-template-columns: 1fr 1fr; gap: 3px; background: #eef2f5; border-radius: 9px; padding: 3px; margin-bottom: 8px; }
    .aba { border: 0; background: transparent; color: #6c808c; padding: 6px; border-radius: 7px; font-size: 12.5px; font-weight: 700; }
    .aba.on { background: #fff; color: #123f68; box-shadow: 0 1px 4px rgba(18,40,56,.12); }
    .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
    .chip { border: 1px solid #dbe4ea; background: #fff; color: #3d5a70; border-radius: 999px; padding: 3px 9px; font-size: 11.5px; }
    .chip:hover { background: #eef4f7; border-color: #c4d3dc; }
    textarea, input, select { width: 100%; font-size: 13.5px; padding: 8px 9px; border: 1px solid #dbe4ea; border-radius: 9px; background: #fff; color: #263942; outline: none; }
    textarea:focus, input:focus, select:focus { border-color: #9fb9cc; box-shadow: 0 0 0 3px rgba(18,63,104,.08); }
    textarea { min-height: 64px; max-height: 180px; resize: vertical; line-height: 1.4; }
    .linha { display: flex; gap: 6px; margin-top: 6px; align-items: center; }
    .linha > * { min-width: 0; }
    .dica { font-size: 11px; color: #94a3ac; flex: 1; }
    .btn { border: 0; border-radius: 9px; background: #123f68; color: #fff; padding: 8px 14px; font-size: 13px; font-weight: 700; white-space: nowrap; }
    .btn:hover { background: #17507f; }
    .btn.verde { background: #23733d; }
    .btn.verde:hover { background: #2a8549; }
    .btn:disabled { background: #b9c6cf; cursor: not-allowed; }
    .busca { position: relative; }
    .busca input { padding-left: 30px; border-radius: 999px; background: #f4f7f9; }
    .busca::before { content: "⌕"; position: absolute; left: 11px; top: 6px; font-size: 16px; color: #8796a0; }
    .resultados { position: absolute; left: 0; right: 0; bottom: calc(100% + 4px); background: #fff; border-radius: 10px; box-shadow: 0 10px 28px rgba(18,40,56,.22);
      max-height: 210px; overflow-y: auto; display: none; z-index: 4; padding: 4px; }
    .resultados.on { display: block; }
    .resultados div { padding: 7px 9px; border-radius: 7px; cursor: pointer; font-size: 12.5px; }
    .resultados div:hover { background: #eef4f7; color: #123f68; }
    .escolhido { display: none; align-items: center; gap: 6px; margin-top: 6px; background: #e3f4e8; color: #1f5f33; border-radius: 8px; padding: 6px 9px; font-size: 12.5px; font-weight: 600; }
    .escolhido.on { display: flex; }
    .escolhido span { flex: 1; min-width: 0; }
    .escolhido button { border: 0; background: transparent; color: #1f5f33; font-size: 15px; }
    .grade { display: grid; grid-template-columns: 1fr 1fr 82px; gap: 6px; margin-top: 6px; }
    .esconde { display: none !important; }

    /* rodapé */
    .msg { margin: 0 10px 8px; padding: 8px 10px; border-radius: 9px; font-size: 12.5px; line-height: 1.4; display: none; }
    .msg.erro { display: block; background: #fdecea; color: #8f2a22; font-weight: 600; }
    .msg.ok { display: block; background: #e3f4e8; color: #1f5f33; }
    .rodape { background: #fff; padding: 10px; border-top: 1px solid #e3e9ed; }
    .enviar { width: 100%; padding: 11px; font-size: 14px; border-radius: 10px; }
    .apagar { display: block; margin: 6px auto 0; border: 0; background: transparent; color: #a34d4d; font-size: 12px; font-weight: 600; padding: 3px 8px; border-radius: 6px; }
    .apagar:hover { background: #fbeaea; }
    .apagar:disabled { color: #c3ccd2; background: transparent; cursor: default; }

    /* janela de confirmação (no lugar do aviso cinza do navegador) */
    .dlg-fundo { position: fixed; inset: 0; background: rgba(10,30,48,.48); display: none; align-items: center; justify-content: center;
      z-index: 2147483647; padding: 16px; font-size: 13.5px; color: #263942; }
    .dlg-fundo.on { display: flex; }
    .dlg { width: 440px; max-width: 100%; max-height: calc(100vh - 32px); overflow-y: auto; background: #fff; border-radius: 14px;
      box-shadow: 0 18px 48px rgba(10,30,48,.35); }
    .dlg-topo { display: flex; align-items: center; gap: 8px; padding: 14px 18px 4px; font-size: 16px; font-weight: 700; color: #123f68; }
    .dlg.perigo .dlg-topo { color: #a3322a; }
    .dlg.alerta .dlg-topo { color: #8a5a00; }
    .dlg-corpo { padding: 6px 18px 4px; line-height: 1.45; }
    .dlg-pac { display: flex; border: 1px solid #e3e9ed; border-radius: 11px; overflow: hidden; margin: 6px 0 10px; }
    .dlg-pac .fx { width: 6px; flex: none; }
    .dlg-pac .cx { padding: 9px 12px; min-width: 0; }
    .dlg-pac .nm { font-size: 17px; font-weight: 700; color: #16324a; line-height: 1.2; word-break: break-word; }
    .dlg-aviso { background: #fff4e0; color: #7a4d00; border-radius: 9px; padding: 8px 10px; margin: 0 0 10px; font-weight: 600; font-size: 12.5px; }
    .dlg-aviso.verm { background: #fdecea; color: #8f2a22; }
    .dlg-sec { font-size: 10.5px; font-weight: 700; letter-spacing: .6px; color: #8796a0; text-transform: uppercase; margin: 4px 0 6px; }
    .dlg-item { display: flex; gap: 10px; align-items: flex-start; background: #f4f7f9; border-radius: 9px; padding: 8px 10px; margin-bottom: 6px; }
    .dlg-item .ic { font-size: 16px; line-height: 20px; }
    .dlg-item b { color: #16324a; }
    .dlg-item small { display: block; color: #6c808c; font-size: 12px; margin-top: 2px; }
    .dlg-prev { margin: 4px 0 2px; }
    .dlg-prev summary { cursor: pointer; color: #123f68; font-weight: 600; font-size: 12.5px; padding: 3px 0; }
    .dlg-prev pre { margin-top: 6px; background: #f4f7f9; border-radius: 9px; padding: 9px 10px; font: 12px/1.45 Consolas, monospace; white-space: pre-wrap; word-break: break-word; max-height: 180px; overflow-y: auto; color: #34495a; }
    .dlg-check { display: none; align-items: flex-start; gap: 8px; margin: 2px 18px 0; padding: 9px 10px; border-radius: 9px; background: #fdecea; color: #8f2a22; font-weight: 600; font-size: 12.5px; cursor: pointer; }
    .dlg-check.on { display: flex; }
    .dlg-check input { width: 16px; height: 16px; margin-top: 1px; flex: none; }
    .dlg-botoes { display: flex; gap: 8px; justify-content: flex-end; padding: 14px 18px 16px; }
    .btn.sec { background: #eef2f5; color: #3d5a70; }
    .btn.sec:hover { background: #e2e9ee; }
    .btn.perigo { background: #b23f3f; }
    .btn.perigo:hover { background: #c24a4a; }
    .btn.alerta { background: #8a5a00; }

    /* diagnóstico */
    .modal { position: absolute; inset: 0; background: rgba(14,38,58,.45); display: none; align-items: center; justify-content: center; z-index: 10; padding: 14px; }
    .modal.on { display: flex; }
    .caixa { background: #fff; border-radius: 12px; padding: 12px; width: 100%; box-shadow: 0 10px 28px rgba(0,0,0,.25); }
    .caixa h3 { font-size: 14px; color: #123f68; margin-bottom: 4px; }
    .caixa p { font-size: 12px; color: #6c808c; margin-bottom: 8px; line-height: 1.4; }
    .caixa textarea { min-height: 220px; font: 11px/1.35 Consolas, monospace; }
  </style>

  <div class="painel" id="painel">
    <div class="topo">
      <div class="tit">📝 Rascunho de evolução</div>
      <button class="ico" id="btnMenu" title="Mais opções">⋯</button>
      <button class="ico" id="btnRecolher" title="Recolher">›</button>
    </div>
    <div class="menu" id="menu">
      <button id="mDiag">🔍 Diagnóstico (para suporte)</button>
      <button id="mRecolher">Recolher painel</button>
    </div>
    <div class="prof" id="prof">Identificando profissional…</div>

    <div class="card" id="card">
      <div class="faixa" id="faixa"></div>
      <div class="cardc">
        <div class="cardtopo"><span class="rot">Paciente</span><span class="estado" id="estado"></span></div>
        <div class="nome" id="pacNome">Nenhum paciente</div>
        <div class="tags" id="tags"></div>
      </div>
    </div>
    <div class="aviso-fila" id="avisoFila">Pode anotar à vontade. Para mandar para a ficha, clique em <b>Atender</b> e abra a ficha deste paciente.</div>
    <div class="outros" id="outros"></div>

    <div class="tempo" id="tempo"></div>

    <div class="editor" id="editor">
      <div class="abas">
        <button class="aba on" id="abaNota">Anotação</button>
        <button class="aba" id="abaMed">Medicação</button>
      </div>
      <div id="paneNota">
        <div class="chips" id="rapidos"></div>
        <textarea id="nota" placeholder="O que foi feito ou observado agora…"></textarea>
        <div class="linha"><span class="dica">Ctrl+Enter adiciona · hora automática</span><button class="btn" id="addNota">Adicionar</button></div>
      </div>
      <div id="paneMed" class="esconde">
        <div class="chips" id="favoritos"></div>
        <div class="busca">
          <input id="medNome" placeholder="Buscar medicamento…" autocomplete="off">
          <div class="resultados" id="medRes"></div>
        </div>
        <div class="escolhido" id="medEsc"><span id="medEscNome"></span><button id="medEscX" title="Trocar">×</button></div>
        <div class="grade">
          <input id="medPos" placeholder="Dose / posologia">
          <select id="medVia"></select>
          <input id="medHora" type="time" title="Horário">
        </div>
        <div class="linha"><span class="dica">Entra na evolução e na seção Medicamentos</span><button class="btn verde" id="addMed">Registrar</button></div>
      </div>
    </div>

    <div class="msg" id="msg"></div>
    <div class="rodape">
      <button class="btn enviar" id="enviar">Enviar para a ficha</button>
      <button class="apagar" id="apagar">Finalizei a ficha — apagar rascunho</button>
    </div>

    <div class="modal" id="modal">
      <div class="caixa">
        <h3>Diagnóstico</h3>
        <p>Só a estrutura da tela (nomes de campos e seções), sem nome, CNS ou texto do paciente. Copie e mande para o suporte.</p>
        <textarea id="diagTxt" readonly></textarea>
        <div class="linha"><span class="dica" id="diagOk"></span><button class="btn" id="diagFechar" style="background:#6c808c">Fechar</button><button class="btn" id="diagCopiar">Copiar</button></div>
      </div>
    </div>
  </div>
  <button class="lingueta" id="lingueta">📝 Rascunho <span class="n" id="lingN">0</span></button>
  <div class="dlg-fundo" id="dlgFundo">
    <div class="dlg" id="dlg" role="dialog" aria-modal="true">
      <div class="dlg-topo"><span id="dlgIco"></span><span id="dlgTit"></span></div>
      <div class="dlg-corpo" id="dlgCorpo"></div>
      <label class="dlg-check" id="dlgCheck"><input type="checkbox" id="dlgCheckInput"><span id="dlgCheckTxt"></span></label>
      <div class="dlg-botoes"><button class="btn sec" id="dlgNao"></button><button class="btn" id="dlgSim"></button></div>
    </div>
  </div>`;

  const $ = id => root.getElementById(id);
  const painelEl = $('painel');

  // ---------- janela de confirmação ----------
  // perguntar({ titulo, corpo (html), sim, nao, tipo: 'normal'|'alerta'|'perigo', marcar: 'texto do checkbox obrigatório' })
  let dlgResolver = null;
  function perguntar({ titulo, corpo, sim = 'Confirmar', nao = 'Cancelar', tipo = 'normal', marcar = '' }) {
    if (dlgResolver) dlgResolver(false);
    const ico = { normal: '📝', alerta: '⚠️', perigo: '🗑️' }[tipo] || '📝';
    $('dlg').className = 'dlg ' + tipo;
    $('dlgIco').textContent = ico;
    $('dlgTit').textContent = titulo;
    $('dlgCorpo').innerHTML = corpo;
    $('dlgSim').textContent = sim;
    $('dlgNao').textContent = nao;
    $('dlgSim').className = 'btn' + (tipo === 'perigo' ? ' perigo' : tipo === 'alerta' ? ' alerta' : '');
    $('dlgCheck').classList.toggle('on', !!marcar);
    $('dlgCheckTxt').textContent = marcar;
    $('dlgCheckInput').checked = false;
    $('dlgSim').disabled = !!marcar;
    $('dlgFundo').classList.add('on');
    setTimeout(() => (marcar ? $('dlgCheckInput') : $('dlgSim')).focus(), 30);
    return new Promise(res => { dlgResolver = res; });
  }
  function fecharDlg(resposta) {
    $('dlgFundo').classList.remove('on');
    const r = dlgResolver; dlgResolver = null;
    r?.(resposta);
  }
  $('dlgCheckInput').addEventListener('change', () => { $('dlgSim').disabled = !$('dlgCheckInput').checked; });
  $('dlgSim').onclick = () => fecharDlg(true);
  $('dlgNao').onclick = () => fecharDlg(false);
  $('dlgFundo').addEventListener('click', ev => { if (ev.target === $('dlgFundo')) fecharDlg(false); });
  $('dlgFundo').addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Escape') fecharDlg(false); });
  // bloco do paciente usado nas janelas
  const pacHtml = p => `<div class="dlg-pac"><div class="fx" style="background:${corDe(p)}"></div><div class="cx">
      <div class="nm">${esc(nomeExibido(p))}</div>
      <div class="tags">${[p.senha && `<span class="tag senha">${esc(p.senha)}</span>`, p.cns && `<span class="tag">CNS ${esc(p.cns)}</span>`, p.nascimento && `<span class="tag">Nasc. ${esc(p.nascimento)}</span>`].filter(Boolean).join('')}</div>
    </div></div>`;

  // ---------- recolher / abrir ----------
  function recolher(sim) {
    painelEl.classList.toggle('recolhido', sim);
    try { localStorage.setItem(PREFIXO + '_recolhido', sim ? '1' : '0'); } catch {}
  }
  try { if (localStorage.getItem(PREFIXO + '_recolhido') === '1') painelEl.classList.add('recolhido'); } catch {}
  $('btnRecolher').onclick = () => recolher(true);
  $('mRecolher').onclick = () => { $('menu').classList.remove('on'); recolher(true); };
  $('lingueta').onclick = () => recolher(false);
  $('btnMenu').onclick = ev => { ev.stopPropagation(); $('menu').classList.toggle('on'); };
  root.addEventListener('click', ev => { if (!ev.target.closest?.('#menu') && ev.target.id !== 'btnMenu') $('menu').classList.remove('on'); });

  // ---------- abas ----------
  function abrirAba(qual) {
    $('abaNota').classList.toggle('on', qual === 'nota');
    $('abaMed').classList.toggle('on', qual === 'med');
    $('paneNota').classList.toggle('esconde', qual !== 'nota');
    $('paneMed').classList.toggle('esconde', qual !== 'med');
    (qual === 'nota' ? $('nota') : $('medNome')).focus();
  }
  $('abaNota').onclick = () => abrirAba('nota');
  $('abaMed').onclick = () => abrirAba('med');

  // ordem do atendimento: examina → pede exames → vê resultado → reavalia → conduta → orienta
  ['Exame físico: ', 'Solicitado: ', 'Resultado: ', 'Reavaliação: ', 'Conduta: ', 'Orientado ']
    .forEach(t => {
      const b = document.createElement('button');
      b.className = 'chip'; b.textContent = t.trim().replace(/:$/, '');
      b.onclick = () => { const n = $('nota'); n.value = (n.value ? n.value.replace(/\s*$/, '\n') : '') + t; n.focus(); salvarPendente(); };
      $('rapidos').appendChild(b);
    });

  function preencherVias() {
    const sel = $('medVia'), atual = sel.value;
    sel.innerHTML = '';
    ['', ...C.vias()].forEach(v => { const o = document.createElement('option'); o.value = v; o.textContent = v || 'Via…'; sel.appendChild(o); });
    sel.value = atual;
  }
  preencherVias();

  // ---------- medicação ----------
  let medItem = null, tBusca = null, buscaSeq = 0;
  // O horário da medicação é o do momento do registro, a menos que o médico mude o campo.
  let medHoraEditada = false;
  $('medHora').addEventListener('input', () => { medHoraEditada = true; });
  setInterval(() => { if (!medHoraEditada) $('medHora').value = agoraHHMM(); }, 20000);
  function limparMed() {
    medItem = null; $('medNome').value = ''; $('medPos').value = ''; $('medVia').value = '';
    $('medEsc').classList.remove('on'); $('medNome').parentElement.classList.remove('esconde');
    $('medRes').classList.remove('on'); $('medHora').value = agoraHHMM(); medHoraEditada = false;
  }
  function escolherMed(item) {
    medItem = item;
    $('medEscNome').textContent = item.nome;
    $('medEsc').classList.add('on');
    $('medNome').parentElement.classList.add('esconde');
    $('medRes').classList.remove('on');
    ($('medPos').value ? $('medVia') : $('medPos')).focus();
  }
  $('medEscX').onclick = () => { medItem = null; $('medEsc').classList.remove('on'); $('medNome').parentElement.classList.remove('esconde'); $('medNome').focus(); };
  async function buscarMed(termo) {
    if (!C.buscarMedicamento || termo.length < 3) { $('medRes').classList.remove('on'); return; }
    const seq = ++buscaSeq;
    let xs = [];
    try { xs = await C.buscarMedicamento(termo); } catch (e) { msg(e.message, 'erro'); return; }
    if (seq !== buscaSeq) return;
    const box = $('medRes');
    box.innerHTML = '';
    xs.slice(0, 15).forEach(x => { const d = document.createElement('div'); d.textContent = x.nome; d.onclick = () => escolherMed(x); box.appendChild(d); });
    if (!xs.length) box.innerHTML = '<div style="color:#8796a0;cursor:default">Nada encontrado no estoque</div>';
    box.classList.add('on');
  }
  $('medNome').addEventListener('input', () => { clearTimeout(tBusca); tBusca = setTimeout(() => buscarMed($('medNome').value.trim()), 300); });
  $('medNome').addEventListener('blur', () => setTimeout(() => $('medRes').classList.remove('on'), 200));
  (C.favoritos || []).forEach(f => {
    const b = document.createElement('button');
    b.className = 'chip';
    const nome = f.busca || f.nome;
    b.textContent = `${nome.charAt(0) + nome.slice(1).toLowerCase()} ${f.posologia}`;
    b.onclick = () => {
      limparMed();
      $('medPos').value = f.posologia; $('medVia').value = f.via;
      if (C.buscarMedicamento) { $('medNome').value = nome; $('medNome').focus(); buscarMed(nome); }
      else escolherMed({ id: null, nome: f.nome });
    };
    $('favoritos').appendChild(b);
  });

  // ---------- estado ----------
  let paciente = null;
  let rascunho = null;

  function msg(texto, tipo) { const m = $('msg'); m.className = 'msg ' + (tipo || ''); m.textContent = texto || ''; }

  function salvar() {
    if (!rascunho || !medico) return;
    rascunho.atualizadoEm = Date.now();
    if (rascunho.entradas.length || rascunho.textoPendente) store.set(chaveDe(rascunho.paciente), rascunho);
    else store.del(chaveDe(rascunho.paciente));
    atualizarOutros();
  }
  function salvarPendente() { if (!rascunho) return; rascunho.textoPendente = $('nota').value; salvar(); }

  const pendentesEvol = () => rascunho ? rascunho.entradas.filter(e => !e.enviadoEvolucao) : [];
  const pendentesMed = () => rascunho ? rascunho.entradas.filter(e => e.tipo === 'med' && !e.enviadoControle) : [];

  function render() {
    // profissional
    $('prof').innerHTML = medico
      ? (medico.nome ? `<span>Profissional:</span><b>${esc(medico.nome)}</b>` : '<b>Profissional identificado</b>')
      : '<span>⚠ Profissional não identificado — rascunho desligado</span>';

    const temPac = !!paciente;
    $('editor').classList.toggle('esconde', !temPac);
    $('card').classList.toggle('esconde', !temPac);
    $('avisoFila').classList.toggle('on', temPac && !paciente.naFicha);

    // botão enviar: o texto explica o estado
    const nPend = pendentesEvol().length + pendentesMed().filter(e => e.enviadoEvolucao).length;
    const b = $('enviar');
    if (!medico) { b.disabled = true; b.textContent = 'Profissional não identificado'; }
    else if (!temPac) { b.disabled = true; b.textContent = 'Escolha um paciente'; }
    else if (!rascunho.entradas.length) { b.disabled = true; b.textContent = 'Nada anotado ainda'; }
    else if (!nPend) { b.disabled = true; b.textContent = '✓ Tudo já está na ficha'; }
    else if (!paciente.naFicha) { b.disabled = true; b.textContent = 'Abra a ficha para enviar'; }
    else { b.disabled = false; b.textContent = `Enviar ${nPend} ${nPend === 1 ? 'item' : 'itens'} para a ficha`; }
    $('apagar').disabled = !rascunho || !rascunho.entradas.length;
    $('lingN').textContent = String(meus().length);

    const tempo = $('tempo');
    if (!temPac) {
      tempo.innerHTML = medico
        ? '<div class="vazio">Clique em <b>📝</b> ao lado do nome do paciente na fila<br>ou abra a ficha dele.</div>'
        : '<div class="vazio">Não consegui identificar quem está logado.<br>Por segurança o rascunho fica desligado.<br>Recarregue a página depois de entrar no sistema.</div>';
      return;
    }
    const p = rascunho.paciente;
    $('faixa').style.background = corDe(p);
    $('pacNome').textContent = nomeExibido(p);
    $('estado').className = 'estado ' + (paciente.naFicha ? 'ficha' : 'fila');
    $('estado').textContent = paciente.naFicha ? 'Ficha aberta' : 'Na fila';
    $('tags').innerHTML = [
      p.senha && `<span class="tag senha">${esc(p.senha)}</span>`,
      p.cns && `<span class="tag">CNS ${esc(p.cns)}</span>`,
      p.nascimento && `<span class="tag">Nasc. ${esc(p.nascimento)}</span>`,
      `<span class="tag">Atend. ${esc(String(p.atendimento).split('#').pop())}</span>`,
    ].filter(Boolean).join('');

    tempo.innerHTML = '';
    if (!rascunho.entradas.length) {
      const outros = paciente.naFicha ? meus().filter(([k]) => k !== chaveDe(paciente)) : [];
      if (!outros.length) { tempo.innerHTML = '<div class="vazio">Nada anotado ainda para este paciente.</div>'; return; }
      renderEscolha(tempo, outros);
      return;
    }
    ordenar(rascunho.entradas).forEach(e => {
      const d = document.createElement('div');
      d.className = 'ent' + (e.tipo === 'med' ? ' med' : '');
      d.innerHTML = `<div class="hora">${esc(e.hora)}</div><div class="ponto"></div><div class="bolha">${e.tipo === 'med' ? '<div class="pill">MEDICAÇÃO</div>' : ''}<div class="txt"></div></div>`;
      d.querySelector('.txt').textContent = textoEntrada(e);
      const bol = d.querySelector('.bolha');
      const tudo = e.enviadoEvolucao && (e.tipo !== 'med' || e.enviadoControle);
      if (tudo) bol.insertAdjacentHTML('beforeend', '<div class="feito">✓ na ficha</div>');
      else if (e.enviadoEvolucao) bol.insertAdjacentHTML('beforeend', '<div class="feito" style="color:#9a6a00">✓ no texto · falta na seção Medicamentos</div>');
      else {
        const x = document.createElement('button'); x.className = 'rem'; x.title = 'Remover'; x.textContent = '×';
        x.onclick = () => { rascunho.entradas = rascunho.entradas.filter(y => y !== e); salvar(); render(); };
        bol.appendChild(x);
      }
      tempo.appendChild(d);
    });
    tempo.scrollTop = tempo.scrollHeight;
  }

  // Na ficha, quando não há rascunho ligado a ela: lista os rascunhos do médico para ele escolher.
  // O que tem nome/CNS escrito na tela aparece primeiro, marcado como "provável".
  // A ficha mostra este paciente? CNS na tela confirma. Pelo nome: se outro rascunho tem um nome
  // mais longo que contém este ("…DA SILVA" x "…DA SILVA SANTOS") e também aparece, a tela é do outro.
  function mostraPagina(pac) {
    if (!C.paginaMostra) return false;
    if (pac.cns && C.paginaMostra({ nome: '', cns: pac.cns })) return true;
    if (!C.paginaMostra({ nome: pac.nome, cns: '' })) return false;
    const n = norm(pac.nome);
    return !meus().some(([, v]) => {
      const m = norm(v.paciente.nome);
      return m !== n && m.length > n.length && m.includes(n) && C.paginaMostra({ nome: v.paciente.nome, cns: '' });
    });
  }

  function renderEscolha(tempo, outros) {
    const itens = outros.map(([k, v]) => ({ k, v, prov: mostraPagina(v.paciente) }))
      .sort((a, b) => (b.prov - a.prov) || (b.v.atualizadoEm - a.v.atualizadoEm));
    const box = document.createElement('div');
    box.className = 'escolha';
    box.innerHTML = '<div class="esc-tit">Qual rascunho é deste paciente?</div><div class="esc-sub">Não liguei sozinho esta ficha a um rascunho. Escolha o paciente certo — vou conferir o nome na tela.</div>';
    for (const it of itens) {
      const p = it.v.paciente;
      const ult = it.v.entradas?.length ? it.v.entradas[it.v.entradas.length - 1].hora : '';
      const d = document.createElement('div');
      d.className = 'opc' + (it.prov ? ' provavel' : '');
      d.innerHTML = `<div class="info">${it.prov ? '<div class="prov">PROVÁVEL — nome na tela</div>' : ''}<b></b><span></span></div><button class="btn">Usar</button>`;
      d.querySelector('b').textContent = nomeExibido(p);
      d.querySelector('span').textContent = [p.senha, `${it.v.entradas?.length || 0} anotação(ões)`, ult && 'última ' + ult].filter(Boolean).join(' · ');
      d.querySelector('button').onclick = () => vincular(it.k);
      box.appendChild(d);
    }
    tempo.appendChild(box);
  }

  async function vincular(k) {
    const v = store.get(k);
    if (!v?.paciente || !paciente?.naFicha) return;
    const mostra = C.paginaMostra ? mostraPagina(v.paciente) : true;
    const n = v.entradas?.length || 0;
    const corpo = pacHtml(v.paciente) +
      (mostra
        ? '<div class="dlg-sec">Confere</div><div class="dlg-item"><span class="ic">✅</span><div>O nome ou o CNS deste paciente aparece nesta ficha.</div></div>'
        : `<div class="dlg-aviso verm">⚠ Não achei o nome nem o CNS de ${esc(nomeExibido(v.paciente))} escrito nesta ficha.</div>`) +
      `<div class="dlg-item"><span class="ic">📝</span><div><b>${n} ${n === 1 ? 'anotação' : 'anotações'}</b> passam a ser desta ficha.</div></div>`;
    const ok = await perguntar({
      titulo: 'Usar este rascunho nesta ficha?', corpo,
      sim: 'Usar rascunho', nao: 'Cancelar', tipo: mostra ? 'normal' : 'alerta',
      marcar: mostra ? '' : `Conferi: esta ficha é de ${nomeExibido(v.paciente)}`,
    });
    if (!ok || !paciente?.naFicha) return;
    store.del(k);
    v.paciente.atendimentoOriginal = v.paciente.atendimentoOriginal || v.paciente.atendimento;
    v.paciente.atendimento = paciente.atendimento;
    if (rascunho?.textoPendente) v.textoPendente = (v.textoPendente ? v.textoPendente + '\n' : '') + rascunho.textoPendente;
    rascunho = v;
    salvar();
    $('nota').value = rascunho.textoPendente || '';
    render();
    msg('Rascunho ligado a esta ficha. Confira e clique em "Enviar".', 'ok');
  }

  function atualizarOutros() {
    const outros = meus().filter(([k]) => !paciente || k !== chaveDe(paciente)).map(([, v]) => nomeExibido(v.paciente));
    const el = $('outros');
    el.classList.toggle('on', outros.length > 0);
    el.innerHTML = `Outros rascunhos: <b>${outros.length}</b> · ${esc(outros.join(' · '))}`;
    el.title = outros.join('\n');
    $('lingN').textContent = String(meus().length);
  }

  // ---------- troca de paciente ----------
  let ultimoId = null;
  function verificarPaciente(forcar) {
    // painel só aparece na fila e na ficha
    host.style.display = (!C.paginaRelevante || C.paginaRelevante()) ? '' : 'none';
    const p = medico ? C.lerPaciente() : null;
    const id = p ? `${p.atendimento}|${p.naFicha ? 'F' : 'L'}` : '';
    if (id === ultimoId && !forcar) return;
    const mudou = (p?.atendimento || '') !== (paciente?.atendimento || '');
    if (rascunho && mudou) { rascunho.textoPendente = $('nota').value; salvar(); }
    ultimoId = id;
    paciente = p;
    if (!mudou && rascunho) { render(); return; }
    msg('');
    if (p) {
      const salvo = store.get(chaveDe(p));
      if (salvo?.paciente && salvo.paciente.cns && p.cns && norm(salvo.paciente.cns) !== norm(p.cns)) {
        msg('Atenção: havia um rascunho com este nº de atendimento mas de outro CNS. Ele não foi carregado.', 'erro');
        rascunho = novoRascunho(p);
      } else if (salvo?.paciente) {
        rascunho = salvo;
        for (const k of ['nome', 'cns', 'senha', 'nascimento']) if (!rascunho.paciente[k] && p[k]) rascunho.paciente[k] = p[k];
      } else rascunho = novoRascunho(p);
    } else rascunho = null;
    $('nota').value = rascunho ? rascunho.textoPendente || '' : '';
    limparMed();
    preencherVias();
    render();
    atualizarOutros();
    if (p) { $('card').classList.remove('pisca'); void $('card').offsetWidth; $('card').classList.add('pisca'); }
  }
  // Confere na ficha se o que foi enviado ainda está lá. Se a ficha foi recarregada/fechada sem
  // salvar, o texto some do campo: os itens voltam a "pendente" para não se perderem.
  // Regras conservadoras para não duplicar: o texto só volta se NENHUMA linha enviada estiver no campo
  // (se algumas estão, o médico pode ter editado); a medicação só volta se a ficha estiver sem nenhuma.
  const compacto = s => norm(s).replace(/\s+/g, ' ');
  function reconciliar() {
    if (!paciente?.naFicha || !rascunho || enviando) return;
    let voltou = 0;
    const txt = C.textoFicha ? C.textoFicha() : null;
    const enviadas = rascunho.entradas.filter(e => e.enviadoEvolucao);
    if (txt !== null && enviadas.length) {
      const t = compacto(txt);
      if (!enviadas.some(e => t.includes(compacto(linhaEvolucao(e))))) { enviadas.forEach(e => { e.enviadoEvolucao = false; }); voltou += enviadas.length; }
    }
    const nMed = C.qtdMedicacoesFicha ? C.qtdMedicacoesFicha() : null;
    const medsEnviadas = rascunho.entradas.filter(e => e.tipo === 'med' && e.enviadoControle);
    if (nMed === 0 && medsEnviadas.length) { medsEnviadas.forEach(e => { e.enviadoControle = false; }); voltou += medsEnviadas.length; }
    if (voltou) {
      salvar(); render();
      msg('Esta ficha não tem mais o que tinha sido enviado (provavelmente foi recarregada sem salvar). Os itens voltaram para pendente — clique em Enviar de novo.', 'erro');
    }
  }

  const aindaOMesmo = () => { const p = C.lerPaciente(); return !!(p && rascunho && p.atendimento === rascunho.paciente.atendimento); };

  // ---------- ações ----------
  function adicionarNota() {
    const texto = $('nota').value.trim();
    if (!texto) return;
    if (!aindaOMesmo()) { verificarPaciente(); msg('O paciente mudou. O texto ficou guardado no rascunho do paciente anterior.', 'erro'); return; }
    rascunho.entradas.push({ id: Date.now(), hora: agoraHHMM(), tipo: 'nota', texto });
    $('nota').value = ''; rascunho.textoPendente = '';
    salvar(); render(); msg('');
    $('nota').focus();
  }

  function adicionarMed() {
    const nome = medItem ? medItem.nome : $('medNome').value.trim();
    const med = { nome, item: medItem?.id ? { id: medItem.id, ...(medItem.raw || {}) } : null, posologia: $('medPos').value.trim(), via: $('medVia').value, horario: (medHoraEditada && $('medHora').value) || agoraHHMM() };
    if (C.exigeItemDaLista && !med.item) { msg('Busque o medicamento e clique nele na lista do estoque.', 'erro'); $('medNome').focus(); return; }
    if (!med.nome || !med.posologia || !med.via) { msg('Preencha medicamento, dose e via.', 'erro'); return; }
    if (!aindaOMesmo()) { verificarPaciente(); msg('O paciente mudou. Confira antes de registrar.', 'erro'); return; }
    rascunho.entradas.push({ id: Date.now(), hora: med.horario, tipo: 'med', med });
    limparMed();
    salvar(); render(); msg('');
  }

  let enviando = false;
  async function enviar() {
    if (enviando) return;
    if ($('nota').value.trim()) adicionarNota();
    if (!aindaOMesmo()) {
      const de = rascunho ? nomeExibido(rascunho.paciente) : '?';
      verificarPaciente();
      msg(`Bloqueado: o rascunho era de ${de}, mas a tela mudou${paciente ? ' para ' + nomeExibido(paciente) : ''}. Nada foi enviado.`, 'erro');
      return;
    }
    const conf = C.confirmarPaciente ? C.confirmarPaciente(rascunho.paciente) : { ok: true };
    if (!conf.ok) { msg('Bloqueado: ' + conf.motivo + ' Nada foi enviado.', 'erro'); return; }
    // O Saúde Simples tem autosalvamento próprio da ficha: depois de recarregar, o texto pode
    // já estar de volta no campo. Linhas que já estão lá não são coladas de novo (evita duplicar).
    const noCampo = C.textoFicha ? compacto(C.textoFicha() || '') : '';
    if (noCampo) {
      const ja = pendentesEvol().filter(e => noCampo.includes(compacto(linhaEvolucao(e))));
      if (ja.length) { ja.forEach(e => { e.enviadoEvolucao = true; }); salvar(); render(); }
    }
    const pe = pendentesEvol(), pm = pendentesMed();
    if (!pe.length && !pm.length) { msg('Tudo já está na ficha.', 'ok'); return; }
    const p = rascunho.paciente;
    const destino = (C.destinoTexto && C.destinoTexto()) || 'texto clínico';
    const destinoMed = (C.destinoMed && C.destinoMed()) || 'Medicamentos';
    const texto = montarTexto(pe);
    const nLinhas = pe.length;
    const nNotas = pe.filter(e => e.tipo !== 'med').length, nMedTxt = nLinhas - nNotas;
    const resumoTxt = [nNotas && `${nNotas} ${nNotas === 1 ? 'anotação' : 'anotações'}`, nMedTxt && `${nMedTxt} ${nMedTxt === 1 ? 'medicação' : 'medicações'}`].filter(Boolean).join(' + ');
    const corpo = pacHtml(p) +
      (conf.duvida ? `<div class="dlg-aviso">⚠ ${esc(conf.duvida)}</div>` : '') +
      '<div class="dlg-sec">Vai entrar na ficha</div>' +
      (nLinhas ? `<div class="dlg-item"><span class="ic">📝</span><div><b>${resumoTxt}</b> no texto de <i>${esc(destino)}</i></div></div>` : '') +
      (pm.length ? `<div class="dlg-item"><span class="ic">💊</span><div><b>${pm.length} ${pm.length === 1 ? 'medicação' : 'medicações'}</b> na seção <i>${esc(destinoMed)}</i><small>${esc(pm.map(e => e.med.nome).join(' · '))}</small></div></div>` : '') +
      (nLinhas ? `<details class="dlg-prev"><summary>Ver o texto que vai entrar</summary><pre>${esc(texto)}</pre></details>` : '');
    const primeiro = nomeExibido(p).split(' ')[0];
    if (!await perguntar({ titulo: 'Enviar para a ficha', corpo, sim: `Enviar para ${primeiro}`, nao: 'Cancelar', tipo: conf.duvida ? 'alerta' : 'normal' })) return;
    if (!aindaOMesmo()) { verificarPaciente(); msg('Bloqueado: a tela mudou enquanto a janela estava aberta. Nada foi enviado.', 'erro'); return; }
    enviando = true;
    $('enviar').disabled = true; $('enviar').textContent = 'Enviando…';
    try {
      if (pe.length) {
        C.escreverEvolucao(texto);
        pe.forEach(e => e.enviadoEvolucao = true);
        salvar();
      }
      for (const e of pm) {
        await C.adicionarMedicacao(e.med);
        e.enviadoControle = true;
        salvar();
      }
      msg('Pronto. Confira o texto e a medicação na ficha e finalize no sistema. Depois clique em "Finalizei a ficha — apagar rascunho".', 'ok');
    } catch (err) {
      salvar();
      msg('Parou no meio: ' + err.message + ' O que já entrou está marcado com ✓; o resto continua no rascunho.', 'erro');
      console.warn('[OM30 Rascunho] erro ao enviar', err);
    } finally {
      enviando = false;
      render();
    }
  }

  async function apagar() {
    if (!rascunho) return;
    const nao = pendentesEvol().length + pendentesMed().filter(e => e.enviadoEvolucao).length;
    const corpo = pacHtml(rascunho.paciente) +
      (nao ? `<div class="dlg-aviso verm">⚠ ${nao} ${nao === 1 ? 'item ainda NÃO foi' : 'itens ainda NÃO foram'} para a ficha e ${nao === 1 ? 'vai ser perdido' : 'vão ser perdidos'}.</div>`
           : '<div class="dlg-item"><span class="ic">✅</span><div>Tudo deste rascunho já está na ficha.</div></div>') +
      '<div style="color:#6c808c;font-size:12.5px">Use depois de finalizar o atendimento no sistema. Não dá para desfazer.</div>';
    if (!await perguntar({ titulo: 'Apagar rascunho?', corpo, sim: 'Apagar rascunho', nao: 'Cancelar', tipo: 'perigo', marcar: nao ? 'Entendi que o que não foi enviado será perdido' : '' })) return;
    store.del(chaveDe(rascunho.paciente));
    rascunho = novoRascunho(paciente);
    $('nota').value = '';
    render(); atualizarOutros(); msg('Rascunho apagado.', 'ok');
  }

  // ---------- diagnóstico ----------
  $('mDiag').onclick = () => {
    $('menu').classList.remove('on');
    let d;
    try { d = C.diagnostico ? C.diagnostico() : {}; } catch (e) { d = { erroDiagnostico: e.message }; }
    d.painel = {
      versao: (typeof GM_info !== 'undefined' && GM_info?.script?.version) || 'dev',
      profissional: !!medico, paciente: !!paciente, naFicha: !!paciente?.naFicha,
      entradas: rascunho?.entradas.length || 0, pendentesTexto: pendentesEvol().length, pendentesMed: pendentesMed().length,
      ultimaMensagem: $('msg').textContent.replace(/[A-ZÀ-Ú]{3,}( [A-ZÀ-Ú]{2,})+/g, '<nome>'),
      botaoEnviar: $('enviar').textContent,
    };
    $('diagTxt').value = 'OM30_RASCUNHO_DIAG\n' + JSON.stringify(d, null, 2);
    $('diagOk').textContent = '';
    $('modal').classList.add('on');
    $('diagTxt').select();
  };
  $('diagFechar').onclick = () => $('modal').classList.remove('on');
  $('diagCopiar').onclick = async () => {
    try { await navigator.clipboard.writeText($('diagTxt').value); $('diagOk').textContent = 'Copiado ✓'; }
    catch { $('diagTxt').select(); document.execCommand?.('copy'); $('diagOk').textContent = 'Copiado ✓'; }
  };

  $('addNota').onclick = adicionarNota;
  $('addMed').onclick = adicionarMed;
  $('enviar').onclick = enviar;
  $('apagar').onclick = apagar;
  $('nota').addEventListener('input', salvarPendente);
  $('nota').addEventListener('keydown', e => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); adicionarNota(); } });
  // teclas digitadas no painel não vazam para atalhos do sistema
  ['keydown', 'keyup', 'keypress'].forEach(t => painelEl.addEventListener(t, e => e.stopPropagation()));

  // rascunhos esquecidos (24h sem mexer) somem — de qualquer profissional
  for (const [k, v] of store.todos(PREFIXO)) if (!k.endsWith('_recolhido') && (!v || Date.now() - (v.atualizadoEm || 0) > VALIDADE_MS)) store.del(k);

  // ---------- proteção ao sair ----------
  let enviandoFormulario = false, liberado = false;
  // Ao salvar a ficha, anota (nesta aba) qual rascunho era. Se a próxima tela for a de
  // "ficha salva", o rascunho é apagado sozinho — atendimento finalizado não deixa rastro.
  const CHAVE_SALVANDO = PREFIXO + '_salvando';
  function marcarSalvando() {
    if (!rascunho || !medico || !paciente?.naFicha) return;
    try {
      sessionStorage.setItem(CHAVE_SALVANDO, JSON.stringify({
        k: chaveDe(rascunho.paciente), atendimento: rascunho.paciente.atendimento,
        nome: nomeExibido(rascunho.paciente), em: Date.now(),
      }));
    } catch {}
  }
  document.addEventListener('submit', ev => {
    if (C.ehFormularioFicha && !C.ehFormularioFicha(ev.target)) return;
    const faltam = paciente?.naFicha && rascunho ? pendentesEvol().length + pendentesMed().length : 0;
    if (liberado || !faltam) { enviandoFormulario = true; marcarSalvando(); return; }
    // segura o envio da ficha e pergunta na janela própria
    ev.preventDefault(); ev.stopImmediatePropagation();
    const form = ev.target, botao = ev.submitter;
    recolher(false);
    perguntar({
      titulo: 'O rascunho ainda não foi para a ficha', tipo: 'alerta',
      corpo: pacHtml(rascunho.paciente) +
        `<div class="dlg-aviso">⚠ ${faltam} ${faltam === 1 ? 'item do rascunho ainda NÃO está' : 'itens do rascunho ainda NÃO estão'} nesta ficha.</div>` +
        '<div style="color:#6c808c;font-size:12.5px">Se finalizar agora, o rascunho continua guardado, mas não entra na ficha.</div>',
      sim: 'Finalizar mesmo assim', nao: 'Voltar e enviar',
    }).then(ok => {
      if (!ok) return;
      liberado = true; enviandoFormulario = true;
      if (botao && botao.isConnected) botao.click(); else if (form.requestSubmit) form.requestSubmit(); else form.submit();
      setTimeout(() => { liberado = false; }, 4000);
    });
  }, true);
  window.addEventListener('beforeunload', ev => {
    if (rascunho) { rascunho.textoPendente = $('nota').value; salvar(); }
    if (enviandoFormulario || !paciente?.naFicha || !rascunho) return;
    if (pendentesEvol().length || pendentesMed().length) { ev.preventDefault(); ev.returnValue = ''; }
  });
  window.addEventListener('pagehide', () => { if (rascunho) { rascunho.textoPendente = $('nota').value; salvar(); } });

  const api = {
    atualizar(abrir) { if (abrir) recolher(false); verificarPaciente(true); },
    avisar(texto) { recolher(false); msg(texto, 'erro'); },
    // botão "📝 Usar rascunho" de dentro da ficha
    usarRascunho() {
      recolher(false);
      verificarPaciente(true);
      if (!medico) { msg('Não identifiquei o profissional logado. Recarregue a página.', 'erro'); return; }
      if (!paciente?.naFicha) { msg('Não reconheci esta tela como ficha. Use ⋯ → Diagnóstico e mande para o suporte.', 'erro'); return; }
      if (rascunho?.entradas.length) {
        if (pendentesEvol().length || pendentesMed().length) enviar();
        else msg('Tudo deste rascunho já está na ficha.', 'ok');
      } else if (meus().length) msg('Escolha no painel qual rascunho é deste paciente.', 'ok');
      else msg('Você não tem nenhum rascunho aberto.', 'erro');
    },
    temRascunhoSenha(senha) { return this.qtdRascunhoSenha(senha) > 0; },
    qtdRascunhoSenha(senha) {
      const r = meus().find(([, v]) => v?.entradas?.length && norm(v.paciente?.senha) === norm(senha));
      return r ? r[1].entradas.length : 0;
    },
  };
  window.EvolPainel = api;

  async function conferirMedico() {
    let m = null;
    try { m = C.identificarMedico ? await C.identificarMedico() : { id: 'unico', nome: '' }; } catch {}
    if ((m?.id || '') === (medico?.id || '')) { if (m && medico) medico.nome = m.nome || medico.nome; render(); return; }
    if (rascunho && medico) { rascunho.textoPendente = $('nota').value; salvar(); }
    medico = m; rascunho = null; paciente = null; ultimoId = null;
    verificarPaciente(true);
  }

  // Chegou na tela de "ficha salva" logo depois de salvar? Então o atendimento foi finalizado:
  // apaga o rascunho e os dados do paciente guardados pelo painel.
  (function apagarSeFichaSalva() {
    let r = null;
    try { r = JSON.parse(sessionStorage.getItem(CHAVE_SALVANDO)); } catch {}
    if (!r) return;
    if (Date.now() - (r.em || 0) > 5 * 60e3) { try { sessionStorage.removeItem(CHAVE_SALVANDO); } catch {} return; }
    if (!C.paginaPosSalvar || !C.paginaPosSalvar()) return;   // ainda na ficha (salvar falhou?) — não apaga
    store.del(r.k);
    C.esquecerPaciente?.(r.atendimento);
    try { sessionStorage.removeItem(CHAVE_SALVANDO); } catch {}
    const t = document.createElement('div');
    t.textContent = `📝 Atendimento finalizado — rascunho de ${r.nome} apagado.`;
    t.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#123f68;color:#fff;font:600 13px "Segoe UI",Arial;padding:10px 14px;border-radius:10px;box-shadow:0 8px 24px rgba(10,30,48,.3)';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 5000);
  })();

  C.instalar?.(api);
  render();
  conferirMedico().then(() => {
    setInterval(verificarPaciente, 700);
    setInterval(conferirMedico, 30000);
    setTimeout(reconciliar, 1500);          // a ficha costuma terminar de carregar depois
    setInterval(reconciliar, 3000);
  });
})();
