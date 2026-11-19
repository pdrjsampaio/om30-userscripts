// ==UserScript==
// @name         OM30 - Rascunho de Evolução
// @namespace    om30-guaruja
// @version      1.3.1
// @updateURL    https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Rascunho-Evolucao.user.js
// @downloadURL  https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Rascunho-Evolucao.user.js
// @description  Rascunho de evolução por paciente durante o atendimento (fila e ficha): anotações com horário e medicação; no final envia para a ficha certa (Motivo do atendimento + seção Medicamentos) e apaga o rascunho ao salvar. Histórico compartilhado entre os profissionais do computador, com o nome de quem fez a 1ª evolução e de quem seguiu.
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
  // Telas do Controle de Salas (enfermagem/técnicos): o painel abre só para consultar o histórico.
  const ehControleSalas = () => /^\/(aplicacoes_medicamentos|encaminhamentos_(exames|radiografias|procedimentos_enfermagem|gessos?_imobilizac\w*|repousos?)|consultar_repousos_medicacoes)(\/|$)/i.test(location.pathname);
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
  const ehFicha = () => !ehFila() && !ehControleSalas() && (!!chaveFicha() || /prontuario|atendimento/i.test(location.pathname)) && !!localizarCampoTexto();
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

  // ---------- Controle de Salas: Raio X, Exames e Enfermagem ----------
  // Mesmo jeito do Procedimentos PA: o item entra nas seções nativas da ficha (Exames / Procedimentos)
  // pelo tokenInput e pelo "+ Incluir" do próprio sistema, um por vez. Nada é salvo nem encaminhado
  // aqui: o encaminhamento para o Controle de Salas acontece quando o médico salva a ficha.
  // Lista padrão do Procedimentos PA (favoritosPadraoPA), sem a medicação (que tem o registro próprio).
  const FAVORITOS_CONTROLE = [
    { type: 'exame', group: 'raiox', code: '0204030153', name: 'RADIOGRAFIA DE TORAX (PA E PERFIL)', query: '0204030153' },
    { type: 'exame', group: 'raiox', code: '0204050120', name: 'RADIOGRAFIA DE ABDOMEN AGUDO (MINIMO DE 3 INCIDENCIAS)', query: '0204050120' },

    { type: 'exame', group: 'exames', code: '0202020380', name: 'HEMOGRAMA COMPLETO', query: '0202020380' },
    { type: 'exame', group: 'exames', code: '0202010694', name: 'DOSAGEM DE UREIA', query: '0202010694' },
    { type: 'exame', group: 'exames', code: '0202010317', name: 'DOSAGEM DE CREATININA', query: '0202010317' },
    { type: 'exame', group: 'exames', code: '0202010635', name: 'DOSAGEM DE SODIO', query: '0202010635' },
    { type: 'exame', group: 'exames', code: '0202010600', name: 'DOSAGEM DE POTASSIO', query: '0202010600' },
    { type: 'exame', group: 'exames', code: '0202010643', name: 'DOSAGEM DE TRANSAMINASE GLUTAMICO-OXALACETICA (TGO)', query: '0202010643' },
    { type: 'exame', group: 'exames', code: '0202010651', name: 'DOSAGEM DE TRANSAMINASE GLUTAMICO-PIRUVICA (TGP)', query: '0202010651' },
    { type: 'exame', group: 'exames', code: '0202030202', name: 'DOSAGEM DE PROTEINA C REATIVA', query: '0202030202' },
    { type: 'exame', group: 'exames', code: '0202050017', name: 'ANALISE DE CARACTERES FISICOS, ELEMENTOS E SEDIMENTO DA URINA', query: '0202050017' },

    { type: 'procedimento', group: 'enfermagem', code: '0214010015', name: 'GLICEMIA CAPILAR', query: '0214010015' },
    { type: 'procedimento', group: 'enfermagem', code: '0301100039', name: 'AFERIÇÃO DE PRESSÃO ARTERIAL', query: '0301100039' },
    { type: 'procedimento', group: 'enfermagem', code: '0301100284', name: 'CURATIVO SIMPLES', query: '0301100284' },
    { type: 'procedimento', group: 'enfermagem', code: '0401010066', name: 'EXCISÃO E/OU SUTURA SIMPLES DE PEQUENAS LESÕES / FERIMENTOS DE PELE / ANEXOS E MUCOSA', query: '0401010066' },
  ];
  // Grupo rápido do Procedimentos PA (gruposExamesPA)
  const GRUPOS_EXAMES = [
    {
      id: 'sadt-clinico-porta',
      nome: 'CLÍNICO PORTA',
      codigos: [
        '0202020380', // HEMOGRAMA COMPLETO
        '0202010317', // CREATININA
        '0202010694', // UREIA
        '0202010651', // TGP
        '0202010643', // TGO
        '0202030202', // PCR
        '0202050017', // URINA
        '0202010635', // SODIO
        '0202010600', // POTASSIO
      ],
    },
  ];
  // Regiões do Raio X do Procedimentos PA (gruposRX): [rótulo, termo]. O termo é pedido ao sistema, que devolve as radiografias dela.
  const REGIOES_RX = [
    ['Tórax', 'RADIOGRAFIA TORAX'], ['Cabeça / Crânio', 'RADIOGRAFIA CRANIO'], ['Face', 'RADIOGRAFIA FACE'], ['Coluna', 'RADIOGRAFIA COLUNA'],
    ['Membro superior', 'RADIOGRAFIA MAO'], ['Membro inferior', 'RADIOGRAFIA PE'], ['Abdome', 'RADIOGRAFIA ABDOME'], ['Bacia / Pelve / Quadril', 'RADIOGRAFIA BACIA'],
  ];
  // Medicações da lista padrão do Procedimentos PA (favoritosPadraoPA, grupo medicação).
  const FAVORITOS_MED_PA = [
    { type: 'medicamento', group: 'medicacao', code: '1035', name: 'DIPIRONA 500 MG CP' },
    { type: 'medicamento', group: 'medicacao', code: '1681', name: 'DIPIRONA SODICA 500 MG/ML INJ' },
    { type: 'medicamento', group: 'medicacao', code: '1680', name: 'DEXAMETASONA 4 MG/ML, INJ - 2,5 ML' },
    { type: 'medicamento', group: 'medicacao', code: '1678', name: 'DICLOFENACO SAL SODICO, 25 MG/ML SOLUCAO INJETAVE' },
    { type: 'medicamento', group: 'medicacao', code: '1271', name: 'ESCOPOLAMINA BUTILBROMETO, 20MG/ML, SOL INJ 1ML' },
    { type: 'medicamento', group: 'medicacao', code: '1672', name: 'ONDANSETRONA CLORIDRATO, 2MG/ML, INJ, 4ML' },
    { type: 'medicamento', group: 'medicacao', code: '937', name: 'DIMENIDRATO ASSOCIADO COM PIRIDOXINA' },
    { type: 'medicamento', group: 'medicacao', code: '966', name: 'CETOPROFENO 1MG/ML' },
    { type: 'medicamento', group: 'medicacao', code: '1660', name: 'TENOXICAM 20 MG INJETAVEL' },
    { type: 'medicamento', group: 'medicacao', code: '1545', name: 'TRAMADOL CLORIDRATO 50 MG/ML SOLUCAO INJETAVEL 2 M' },
    { type: 'medicamento', group: 'medicacao', code: '1519', name: 'PROMETAZINA CLORIDRATO 25 MG' },
  ];
  // Favoritos do Procedimentos PA neste computador, SÓ LEITURA (mesmas chaves e regras de defs/renderFavs):
  // lista importada pela unidade, ou a padrão sem os que a unidade escondeu; mais as estrelas do médico.
  // Com o PA instalado, o localStorage.getItem dele já devolve as chaves pessoais do profissional logado.
  const PA_STORE = 'OM30_PA_FAVORITOS_PC_V1', PA_STORE_UNIT = 'OM30_PA_FAVORITOS_UNIDADE_V2', PA_STORE_OCULTOS = 'OM30_PA_FAVORITOS_PADRAO_OCULTOS_V1';
  const lerJsonLocal = k => { try { const v = JSON.parse(localStorage.getItem(k) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
  const unidadePA = () => norm(qa('a.nav-link,.navbar a,.navbar-nav a').map(x => clean(x.innerText)).find(t => /\b(UPA|PRONTO|UNIDADE|USAFA|UBS|CAPS|CENTRO|PS\b|PA\b)/i.test(t)) || 'UNIDADE NÃO IDENTIFICADA');
  const grupoFavPA = (type, nome) => type === 'procedimento' ? 'enfermagem' : type === 'medicamento' ? 'medicacao' : /RADIOGRAFIA/i.test(nome) ? 'raiox' : 'exames';
  // Escondido no PA: "grupo|codigo|NOME" (antigo) ou "@OM30CODE|GRUPO|CODIGO" (estável), em qualquer chave de unidade.
  function escondidosPA() {
    const out = new Set();
    for (const lista of Object.values(lerJsonLocal(PA_STORE_OCULTOS))) for (const raw of (Array.isArray(lista) ? lista : [])) {
      const p = String(raw || '').split('|');
      const [g, c] = p[0].startsWith('@') ? [p[1], p[2]] : [p[0], p[1]];
      if (g && dig(c)) out.add(norm(g) + '|' + dig(c));
    }
    return out;
  }
  function favoritosPA() {
    const un = unidadePA();
    const imp = lerJsonLocal(PA_STORE_UNIT)[un];
    const importados = Array.isArray(imp) ? imp.filter(x => x && x.name) : [];
    const oc = importados.length ? new Set() : escondidosPA();
    const base = importados.length ? importados
      : [...FAVORITOS_CONTROLE, ...FAVORITOS_MED_PA].filter(x => !oc.has(norm(x.group) + '|' + dig(x.code)));
    const locais = Object.values(lerJsonLocal(PA_STORE)).filter(x => x && x.unit === un && x.item).map(x => {
      const nome = clean(x.type === 'medicamento' ? (x.item.nome || x.item.descricao) : x.item.nome);
      return { type: x.type, code: clean(x.item.codigo || x.item.codigo_externo || ''), name: nome };
    });
    const vistos = new Set(), out = [];
    for (const x of [...base, ...locais]) {
      const type = x.type === 'procedimento' || x.type === 'medicamento' ? x.type : 'exame';
      const name = clean(x.name);
      const group = ['raiox', 'exames', 'medicacao', 'enfermagem'].includes(x.group) ? x.group : grupoFavPA(type, name);
      if (!name) continue;
      if (type === 'exame' && (group === 'raiox') !== /RADIOGRAFIA/i.test(name)) continue; // como o defs do PA
      const k = group + '|' + dig(x.code) + '|' + norm(name);
      if (vistos.has(k)) continue;
      vistos.add(k); out.push({ type, group, code: clean(x.code), name });
    }
    return out;
  }

  // Ocupação do profissional na ficha (campo do bloco PROCEDIMENTOS/CIDS), como no Procedimentos PA.
  function occupationValue(v) {
    const s = clean(v);
    if (!s) return null;
    const m = s.match(/-(\d+)$/);
    if (m) return m[1];
    if (/^\d+$/.test(s)) return s;
    return null;
  }
  function occupation() {
    const diretoId = occupationValue(q('#prontuario_ocupacao_id')?.value);
    if (diretoId) return diretoId;
    const seletores = ['input[name*="[ocupacao_id]"]', 'select[name*="[ocupacao_id]"]', 'input[name*="profissional_ocupacao_id"]', 'input[id*="profissional_ocupacao_id"]'];
    for (const sel of seletores) for (const el of qa(sel)) { const id = occupationValue(el.value); if (id) return id; }
    return null;
  }

  async function apiJson(url) {
    const r = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json, text/javascript, */*; q=0.01', 'X-Requested-With': 'XMLHttpRequest' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  const listaJson = xs => (Array.isArray(xs) ? xs : []);
  const codigoItem = x => clean(x?.codigo || x?.codigo_externo || '');
  const nomeItem = x => clean(x?.nome);
  const urlExame = t => '/procedimentos/search.json?exame=1&q=' + encodeURIComponent(t);
  const urlProcedimento = (occ, t) => '/procedimentos/procedimentos_ocupacoes.json?' + new URLSearchParams({ ocupacao_id: occ, q: t });
  function mergeLista(listas) {
    const map = new Map();
    for (const xs of listas) for (const x of listaJson(xs)) {
      const k = codigoItem(x) || String(x.id || '') + '|' + nomeItem(x);
      if (!map.has(k)) map.set(k, x);
    }
    return [...map.values()];
  }
  function filtroCodigoExato(xs, termo) {
    const n = dig(termo);
    if (n.length !== 10) return xs;
    return xs.filter(x => dig(codigoItem(x)) === n);
  }
  const ehEletrocardiograma = (cd, nm) => dig(cd).slice(0, 10) === '0211020036' || /ELETROCARDIOGRAMA/i.test(String(nm || ''));
  // Exames de diagnóstico não são pedidos em Enfermagem (coleta 0201, ECG 0211 e glicemia capilar ficam).
  const ehPedidoEmExames = cd => {
    const c = dig(cd).slice(0, 10);
    if (!/^02\d{8}$/.test(c)) return false;
    if (/^0201|^0211/.test(c) || c === '0214010015') return false;
    return true;
  };
  // Busca do Raio-X do Procedimentos PA (buscarRaioX): tira rx/raio x/radiografia/de, busca
  // "RADIOGRAFIA DE <parte>", "<parte>" e cada palavra, e fica só com as radiografias.
  const STOP_RX = new Set(['RX', 'RAIO', 'X', 'RAIOX', 'RADIOGRAFIA', 'RADIOGRAFIAS', 'RADIO', 'DE', 'DO', 'DA', 'DOS', 'DAS', 'E', 'EM', 'NO', 'NA']);
  async function buscarRaioX(termo) {
    const somenteNomeRx = xs => xs.filter(x => /RADIOGRAFIA/i.test(nomeItem(x)));
    if (/^\d{10}$/.test(dig(termo))) return somenteNomeRx(filtroCodigoExato(listaJson(await apiJson(urlExame(clean(termo))).catch(() => [])), termo));
    const palavras = norm(termo).replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/).filter(w => w && !STOP_RX.has(w));
    const resto = palavras.join(' ');
    const SIN_RX = { LOMBAR: ['LOMBAR', 'LOMBO'], TORACICA: ['TORACICA', 'TORACO'], SACRO: ['SACRO', 'SACRA'], CERVICAL: ['CERVICAL'], CRANIO: ['CRANIO'], FACE: ['FACE', 'SEIOS'], SEIOS: ['SEIOS'], DEDO: ['DEDO', 'DEDOS'], DEDOS: ['DEDOS', 'DEDO'], OMBRO: ['OMBRO', 'ESCAPULO'], TORNOZELO: ['TORNOZELO', 'TIBIO'], COXA: ['COXA', 'FEMUR'], FEMUR: ['FEMUR', 'COXA'], QUADRIL: ['QUADRIL', 'COXO', 'BACIA'] };
    const formas = w => SIN_RX[w] || [w];
    const consultas = resto
      ? ['RADIOGRAFIA DE ' + resto, 'RADIOGRAFIA ' + resto, resto, ...palavras.flatMap(w => formas(w)).filter(w => w.length >= 3)]
      : ['RADIOGRAFIA'];
    const listas = await Promise.all([...new Set(consultas)].map(t => apiJson(urlExame(t)).catch(() => [])));
    let xs = somenteNomeRx(mergeLista(listas));
    if (palavras.length) {
      const nomeN = x => ' ' + norm(nomeItem(x)).replace(/[^A-Z0-9]+/g, ' ') + ' ';
      // Palavra curta (PE, PA) tem que bater inteira; as outras podem ser começo de palavra.
      const bate = (n, w) => formas(w).some(f => f.length <= 2 ? n.includes(' ' + f + ' ') : n.includes(' ' + f));
      const fortes = xs.filter(x => palavras.every(w => bate(nomeN(x), w)));
      if (fortes.length) xs = fortes;
      const pontos = x => { const n = nomeN(x); let p = 0; for (const w of palavras) { if (n.includes(' ' + w + ' ')) p += 3; else if (formas(w).some(f => n.includes(' ' + f + ' '))) p += 2; else if (bate(n, w)) p += 1; } if (n.includes(' RADIOGRAFIA DE ' + resto + ' ')) p += 5; return p; };
      xs.sort((a, b) => pontos(b) - pontos(a) || nomeItem(a).length - nomeItem(b).length);
    }
    return xs;
  }
  // grupo: 'raiox' | 'exames' | 'enfermagem' → [{ codigo, nome, tipoNativo }]
  async function buscarControle(grupo, termo) {
    const t = clean(termo);
    let xs = [], tipoNativo = 'exame';
    if (grupo === 'raiox') xs = await buscarRaioX(t);
    else if (grupo === 'exames') {
      xs = filtroCodigoExato(listaJson(await apiJson(urlExame(t))), t)
        .filter(x => !/RADIOGRAFIA/i.test(nomeItem(x)) && !ehEletrocardiograma(codigoItem(x), nomeItem(x)));
    } else if (grupo === 'enfermagem') {
      const occ = occupation();
      if (!occ) throw new Error('Ocupação profissional não identificada na ficha.');
      tipoNativo = 'procedimento';
      xs = filtroCodigoExato(listaJson(await apiJson(urlProcedimento(occ, t))), t).filter(x => !ehPedidoEmExames(codigoItem(x)));
    }
    return mergeLista([xs]).map(x => ({ codigo: codigoItem(x), nome: nomeItem(x), tipoNativo })).filter(x => x.codigo && x.nome);
  }
  // Item nativo pelo código exato (o que o tokenInput da ficha espera)
  async function resolverItemNativo(ex) {
    const cd = dig(ex.codigo);
    let xs;
    if (ex.tipoNativo === 'procedimento') {
      const occ = occupation();
      if (!occ) throw new Error('Ocupação profissional não identificada na ficha.');
      xs = await apiJson(urlProcedimento(occ, cd));
    } else xs = await apiJson(urlExame(cd));
    return listaJson(xs).find(x => dig(codigoItem(x)) === cd) || null;
  }

  const TOKEN_EXAME = '#prontuario_exame_token', TOKEN_PROC = '#prontuario_procedimento_token';
  const LINHA_EXAME = 'tr.prontuario-exame-row', LINHA_PROC = 'tr.prontuario-lancamento-bpa-row';
  const botaoIncluirExame = () => q('#addFieldsButton a[onclick*="add_prontuarios_exames_fields"]');
  const botaoIncluirProcedimento = () => q('#add_fields_lancamento_bpa_procedimentos_cids a[onclick*="add_lancamentos_bpa_fields"]');
  function rowAtiva(row) {
    if (!row) return false;
    const dv = clean(q('input[name$="[_destroy]"]', row)?.value).toLowerCase();
    if (dv === '1' || dv === 'true') return false;
    return getComputedStyle(row).display !== 'none';
  }
  function codigoLinhaExame(row) {
    if (!row) return '';
    const direto = dig(row.dataset.om30Codigo || q('.codigo_exame', row)?.value || q('input[name*="[exame_token_codigo]"]', row)?.value || '');
    if (direto.length >= 10) return direto.slice(0, 10);
    return qa('input', row).map(el => dig(el.value || '')).find(v => v.length === 10) || '';
  }
  function codigoLinhaProcedimento(row) {
    if (!row) return '';
    const ds = dig(row.dataset.om30Codigo || '');
    if (ds.length >= 10) return ds.slice(0, 10);
    const fv = dig(q('input[name*="[procedimento_token]"]', row)?.value || '');
    if (fv.length >= 10) return fv.slice(0, 10);
    return qa('input', row).map(el => dig(el.value || '')).find(v => v.length === 10) || '';
  }
  const linhaExameComCodigo = cd => qa(LINHA_EXAME).find(r => rowAtiva(r) && codigoLinhaExame(r) === dig(cd)) || null;
  const linhaProcedimentoComCodigo = cd => qa(LINHA_PROC).find(r => rowAtiva(r) && codigoLinhaProcedimento(r) === dig(cd)) || null;
  // Linhas ativas na seção nativa (null = seção não está nesta tela). Usado para devolver a pendente
  // o que foi incluído numa ficha recarregada sem salvar (mesma regra da medicação: só com a seção vazia).
  const qtdLinhasAtivas = (token, linha) => q(token) ? qa(linha).filter(rowAtiva).length : null;
  function tokenGet(sel) {
    const $ = window.jQuery || window.$;
    try { const xs = $(sel).tokenInput('get'); return Array.isArray(xs) ? xs : (xs ? [xs] : []); } catch { return []; }
  }
  function tokenTemCodigo(sel, cd) {
    const alvo = dig(cd);
    return tokenGet(sel).some(x => dig(x?.codigo || x?.codigo_externo || x?.name || x?.nome || '').includes(alvo));
  }
  function tokenClear(sel) {
    const $ = window.jQuery || window.$;
    try { $(sel).tokenInput('clear'); } catch { const el = q(sel); if (el) el.value = ''; }
  }
  async function esperarNovaLinha(sel, antes, timeout = 3500, passo = 50) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const nova = qa(sel).find(r => !antes.has(r));
      if (nova) return nova;
      await sleep(passo);
    }
    return qa(sel).find(r => !antes.has(r)) || null;
  }
  // ex: { codigo, nome, tipoNativo: 'exame' | 'procedimento' }. Inclui na seção nativa (Exames ou
  // Procedimentos/CIDs) como o incluirSimples do Procedimentos PA. Se já existe linha com o mesmo
  // código, não inclui de novo. Nunca clica em salvar/encaminhar.
  async function incluirExame(ex) {
    const $ = window.jQuery || window.$;
    const proc = ex?.tipoNativo === 'procedimento';
    const cd = dig(ex?.codigo).slice(0, 10);
    if (cd.length !== 10) throw new Error('Código inválido: ' + (ex?.codigo || ''));
    const sel = proc ? TOKEN_PROC : TOKEN_EXAME, linhaSel = proc ? LINHA_PROC : LINHA_EXAME;
    const linhaCom = proc ? linhaProcedimentoComCodigo : linhaExameComCodigo;
    if (!q(sel)) throw new Error('Seção ' + (proc ? 'Procedimentos' : 'Exames') + ' não encontrada nesta ficha.');
    if (!$ || typeof $(sel).tokenInput !== 'function') throw new Error('TokenInput não disponível.');
    if (linhaCom(cd)) return { jaEstava: true };
    const item = await resolverItemNativo(ex);
    if (!item) throw new Error('Código ' + cd + ' não localizado na busca do sistema.');
    const nm = nomeItem(item) || clean(ex.nome);
    if (!proc) {
      const interno = q('#prontuario_exame_externo_false');
      if (interno) { interno.checked = true; interno.dispatchEvent(new Event('change', { bubbles: true })); }
    }
    const mesmo = tokenTemCodigo(sel, cd);
    if (tokenGet(sel).length && !mesmo) throw new Error('Existe outro item aguardando inclusão na seção nativa.');
    const antes = new Set(qa(linhaSel));
    if (!mesmo) $(sel).tokenInput('add', { ...item, id: item.id, name: cd + ' - ' + nm });
    await sleep(100);
    const b = proc ? botaoIncluirProcedimento() : botaoIncluirExame();
    if (!b) { if (tokenTemCodigo(sel, cd)) tokenClear(sel); throw new Error('Botão nativo + Incluir não encontrado.'); }
    b.click();
    let row = await esperarNovaLinha(linhaSel, antes, 3500);
    if (!row) row = linhaCom(cd);
    if (!row) {
      // o próprio sistema consumiu o token: inclusão feita (a lista nativa é a fonte real)
      if (!tokenTemCodigo(sel, cd)) return { jaEstava: false, confirmadoPeloToken: true };
      tokenClear(sel);
      throw new Error('Não foi possível confirmar a inclusão de ' + cd + '.');
    }
    row.dataset.om30Codigo = cd;
    row.dataset.om30Nome = nm;
    if (tokenTemCodigo(sel, cd)) tokenClear(sel);
    return { jaEstava: false };
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
      controleSalas: {
        tokenExame: !!q(TOKEN_EXAME), incluirExame: !!botaoIncluirExame(), linhasExame: qa(LINHA_EXAME).length,
        tokenProcedimento: !!q(TOKEN_PROC), incluirProcedimento: !!botaoIncluirProcedimento(), linhasProcedimento: qa(LINHA_PROC).length,
        ocupacao: !!occupation(),
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
    paginaRelevante: () => ehFila() || ehFicha() || (ehControleSalas() && window.EvolPainel?.qtdTotal?.() > 0),
    naFila: () => ehFila(),
    naConsulta: () => ehControleSalas(),
    selecionar(p) { try { sessionStorage.setItem(SEL, JSON.stringify(p)); } catch {} },
    limparSelecao() { try { sessionStorage.removeItem(SEL); } catch {} },
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
    // Controle de Salas (Raio X / Exames / Enfermagem): entra nas seções nativas da ficha no envio
    favoritosControle: favoritosPA,
    favoritosControlePadrao: FAVORITOS_CONTROLE,
    gruposExames: GRUPOS_EXAMES,
    regioesRaioX: REGIOES_RX,
    buscarControle,
    // a busca de Enfermagem depende da ocupação do profissional, que só existe na ficha
    buscaControleDisponivel: grupo => grupo !== 'enfermagem' || (ehFicha() && !!occupation()),
    incluirExame,
    qtdExamesFicha: () => qtdLinhasAtivas(TOKEN_EXAME, LINHA_EXAME),
    qtdProcedimentosFicha: () => qtdLinhasAtivas(TOKEN_PROC, LINHA_PROC),
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
// v1.2.0: aba Controle de Salas (Raio X | Exames | Medicação | Enfermagem, como no Procedimentos PA);
//         a Medicação passou para dentro dela sem mudar nada; Raio X, Exames e Enfermagem ficam no
//         rascunho e no "Enviar para a ficha" entram nas seções nativas pelo "+ Incluir" (fora do texto).
//         Favoritos = os do Procedimentos PA neste computador (só leitura); Raio X com as 8 regiões do PA
//         (cada uma lista todas as radiografias dela); Medicação também com os medicamentos do PA.
//         Raio X com as regiões do PA; Raio X, Exames e Enfermagem pesquisam no sistema como no Procedimentos PA, em lista que fica aberta.
// v1.3.1: menu ⋯ → Configurações → tamanho do painel (Normal, Grande, Muito grande), guardado por profissional neste computador.
//         Medicação só com a pesquisa: saíram os botões de medicamentos comuns (pedido do dono: pequenos demais).
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

  // v1.2.0: o rascunho é do PACIENTE, não do médico. Todos os profissionais deste computador veem
  // o histórico; cada anotação guarda quem escreveu (autor). Só precisa de profissional logado para escrever.
  let medico = null;
  const base = () => PREFIXO + 'c:';
  const meus = () => store.todos(base()).filter(([, v]) => v?.paciente);
  const chaveDe = p => base() + p.atendimento;
  const eu = () => medico ? { id: String(medico.id), nome: medico.nome || '' } : null;
  const mesmoAutor = (a, b) => String(a?.id || '') === String(b?.id || '');
  const ehMeu = e => !e.autor || mesmoAutor(e.autor, eu());   // anotação antiga (sem autor) = de quem está logado
  // Autores na ordem em que entraram no rascunho
  function autoresDe(entradas) {
    const out = [];
    for (const e of ordenar(entradas || [])) if (e.autor && !out.some(a => mesmoAutor(a, e.autor))) out.push(e.autor);
    return out;
  }
  const nomeAutor = a => a?.nome || 'profissional não identificado';
  // Rascunhos da versão 1.1 (um por médico: om30-rasc:m<id>:<atendimento>) viram compartilhados.
  function migrarAntigos() {
    for (const [k, v] of store.todos(PREFIXO + 'm')) {
      const m = k.slice(PREFIXO.length).match(/^m(.+?):(.+)$/);
      if (!m || !v?.paciente) { continue; }
      const autor = { id: m[1], nome: medico && String(medico.id) === m[1] ? medico.nome || '' : '' };
      for (const e of v.entradas || []) if (!e.autor) e.autor = autor;
      const novo = PREFIXO + 'c:' + m[2];
      const ja = store.get(novo);
      if (ja?.paciente) { ja.entradas = [...(ja.entradas || []), ...(v.entradas || [])]; ja.atualizadoEm = Math.max(ja.atualizadoEm || 0, v.atualizadoEm || 0); store.set(novo, ja); }
      else store.set(novo, v);
      store.del(k);
    }
  }
  // Anotações sem nome do autor ganham o nome quando esse profissional entra no computador.
  function completarNomes() {
    const me = eu();
    if (!me?.nome) return;
    for (const [k, v] of meus()) {
      let mudou = false;
      for (const e of v.entradas || []) if (e.autor && mesmoAutor(e.autor, me) && !e.autor.nome) { e.autor.nome = me.nome; mudou = true; }
      if (mudou) store.set(k, v);
    }
  }
  const agoraHHMM = () => new Date().toTimeString().slice(0, 5);
  const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
  const corDe = p => { let h = 0; for (const c of String(p.atendimento)) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 60% 42%)`; };
  const limparPac = p => ({ atendimento: p.atendimento, nome: p.nome || '', cns: p.cns || '', senha: p.senha || '', nascimento: p.nascimento || '' });
  const novoRascunho = p => ({ paciente: limparPac(p), entradas: [], textoPendente: '', criadoEm: Date.now(), atualizadoEm: Date.now() });
  const nomeExibido = p => p.nome || `Atendimento ${String(p.atendimento).split('#').pop()}`;
  const textoEntrada = e => e.tipo === 'med'
    ? [e.med.nome, e.med.posologia, e.med.via && 'via ' + e.med.via.toLowerCase()].filter(Boolean).join(', ').replace(/\s+/g, ' ').trim()
    : e.tipo === 'exame' ? String(e.exame?.nome || e.exame?.codigo || '').trim()
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
  // Um profissional só: texto sem nome (como sempre foi). Mais de um: o nome aparece quando o
  // profissional muda — "1ª evolução: FULANO" no começo e "Seguimento: CICLANO (1ª evolução: FULANO)".
  // "todas" = todas as anotações do rascunho, inclusive as já enviadas, para saber quem começou.
  function montarTexto(entradas, todas = entradas) {
    // Raio X / Exames / Enfermagem não entram no texto da evolução (vão para as seções nativas)
    const xs = ordenar(entradas.filter(e => e.tipo !== 'exame'));
    const autores = autoresDe(todas.filter(e => e.tipo !== 'exame'));
    const varios = autores.length > 1;
    const primeiro = autores[0];
    const corpo = xs.filter(e => !ehFechamento(e)), fechoXs = xs.filter(ehFechamento);
    const linhas = [];
    if (varios) {
      const seq = ordenar(todas).filter(e => e.tipo !== 'exame' && !ehFechamento(e));
      for (const e of corpo) {
        const i = seq.indexOf(e);
        const anterior = i > 0 ? seq[i - 1] : null;
        const precisa = !anterior || !mesmoAutor(anterior.autor, e.autor) || linhas.length === 0;
        if (precisa) {
          if (linhas.length) linhas.push('');
          linhas.push(mesmoAutor(e.autor, primeiro)
            ? `1ª evolução: ${nomeAutor(e.autor)}`
            : `Seguimento: ${nomeAutor(e.autor)} (1ª evolução: ${nomeAutor(primeiro)})`);
        }
        linhas.push(linhaEvolucao(e));
      }
    } else linhas.push(...corpo.map(linhaEvolucao));
    const ultimoAutor = corpo.length ? corpo[corpo.length - 1].autor : null;
    const fecho = fechoXs.map(e => linhaEvolucao(e) + (varios && !mesmoAutor(e.autor, ultimoAutor) ? ` (${nomeAutor(e.autor)})` : ''));
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

    /* lista "Meus rascunhos" */
    .outros { cursor: pointer; }
    .outros:hover { color: #123f68; }
    .bolha .autor { font-size: 10.5px; font-weight: 700; color: #5b7487; margin-bottom: 2px; }
    .ver-info { font-size: 12px; color: #4a6272; background: #fff; border-radius: 9px; padding: 7px 9px; margin-bottom: 8px; line-height: 1.45; }
    .ver-info span { color: #8796a0; font-size: 11px; }
    .lista-topo { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .lista-topo .t { flex: 1; font-size: 14px; font-weight: 700; color: #16324a; }
    .voltar { border: 0; background: #eef2f5; color: #3d5a70; border-radius: 8px; padding: 5px 10px; font-size: 12px; font-weight: 600; }
    .voltar:hover { background: #e2e9ee; }
    .rasc { display: flex; align-items: center; gap: 8px; background: #fff; border-radius: 10px; padding: 8px 8px 8px 0; margin-bottom: 6px;
      box-shadow: 0 1px 3px rgba(18,40,56,.07); overflow: hidden; }
    .rasc .fx { width: 5px; align-self: stretch; flex: none; }
    .rasc .info { flex: 1; min-width: 0; }
    .rasc .info b { display: block; font-size: 13px; color: #16324a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .rasc .info .resumo { display: block; font-size: 11.5px; color: #6c808c; }
    .mini { border: 0; border-radius: 7px; padding: 5px 9px; font-size: 12px; font-weight: 600; background: #e8eff5; color: #123f68; white-space: nowrap; }
    .mini:hover { background: #d6e3ee; }
    .mini.lixo { background: transparent; color: #a34d4d; padding: 5px 7px; }
    .mini.lixo:hover { background: #fbeaea; }

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
    .abas.sub { grid-template-columns: repeat(4, 1fr); }
    .abas.sub .aba { padding: 6px 2px; }
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
    .resultados.lista { position: static; box-shadow: none; border: 1px solid #dbe4ea; max-height: 190px; margin-bottom: 6px; }
    .chip.regiao { border-color: #b9cddb; color: #123f68; font-weight: 600; }
    .chip.on { background: #123f68; border-color: #123f68; color: #fff; }
    .resultados div.feito { color: #23733d; }
    .resultados div.feito::before { content: '✓ '; }
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
    /* configurações */
    .cfg-rot { font-size: 12.5px; color: #42545e; font-weight: 600; margin: 6px 0 6px; }
    .cfg-ops { display: flex; gap: 6px; margin-bottom: 10px; }
    .cfg-op { flex: 1; border: 1px solid #c4d3dc; background: #fff; color: #263942; border-radius: 9px; padding: 9px 6px; font-weight: 600; }
    .cfg-op[data-z="1.2"] { font-size: 15px; }
    .cfg-op[data-z="1.4"] { font-size: 17px; }
    .cfg-op.on { background: #123f68; border-color: #123f68; color: #fff; }
  </style>

  <div class="painel" id="painel">
    <div class="topo">
      <div class="tit">📝 Rascunho de evolução</div>
      <button class="ico" id="btnMenu" title="Mais opções">⋯</button>
      <button class="ico" id="btnRecolher" title="Recolher">›</button>
    </div>
    <div class="menu" id="menu">
      <button id="mLista">📋 Rascunhos deste computador</button>
      <button id="mCfg">⚙️ Configurações</button>
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
        <button class="aba" id="abaCtl">Controle de Salas</button>
      </div>
      <div id="paneNota">
        <div class="chips" id="rapidos"></div>
        <textarea id="nota" placeholder="O que foi feito ou observado agora…"></textarea>
        <div class="linha"><span class="dica">Ctrl+Enter adiciona · hora automática</span><button class="btn" id="addNota">Adicionar</button></div>
      </div>
      <div id="paneCtlWrap" class="esconde">
      <div class="abas sub" id="subAbas">
        <button class="aba" data-g="raiox">Raio X</button>
        <button class="aba" data-g="exames">Exames</button>
        <button class="aba" data-g="med" id="abaMed">Medicação</button>
        <button class="aba" data-g="enfermagem">Enfermagem</button>
      </div>
      <div id="paneCtl" class="esconde">
        <div class="chips" id="ctlFav"></div>
        <div class="busca">
          <input id="ctlBusca" placeholder="Buscar radiografia…" autocomplete="off">
          <div class="resultados" id="ctlRes"></div>
        </div>
      </div>
      <div id="paneMed" class="esconde">
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

    <div class="modal" id="modalCfg">
      <div class="caixa">
        <h3>Configurações</h3>
        <div class="cfg-rot">Tamanho do texto e dos botões</div>
        <div class="cfg-ops" id="cfgTam">
          <button class="cfg-op" data-z="1">Normal</button>
          <button class="cfg-op" data-z="1.2">Grande</button>
          <button class="cfg-op" data-z="1.4">Muito grande</button>
        </div>
        <div class="linha"><span class="dica"></span><button class="btn" id="cfgFechar">Fechar</button></div>
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
  // No Controle de Salas o painel começa recolhido (só a lingueta), para não cobrir a lista.
  if (C.naConsulta?.()) painelEl.classList.add('recolhido');
  $('btnRecolher').onclick = () => recolher(true);
  $('mRecolher').onclick = () => { $('menu').classList.remove('on'); recolher(true); };
  $('lingueta').onclick = () => recolher(false);
  $('btnMenu').onclick = ev => { ev.stopPropagation(); $('menu').classList.toggle('on'); };
  root.addEventListener('click', ev => { if (!ev.target.closest?.('#menu') && ev.target.id !== 'btnMenu') $('menu').classList.remove('on'); });

  // ---------- abas ----------
  // Anotação | Controle de Salas. Dentro do Controle de Salas, as sub-abas do Procedimentos PA:
  // Raio X | Exames | Medicação | Enfermagem (Medicação = o registro de medicação de sempre).
  const temCtl = typeof C.incluirExame === 'function';
  let subAtual = temCtl ? 'raiox' : 'med';
  if (!temCtl) $('subAbas').classList.add('esconde');
  function abrirAba(qual) {
    $('abaNota').classList.toggle('on', qual === 'nota');
    $('abaCtl').classList.toggle('on', qual === 'ctl');
    $('paneNota').classList.toggle('esconde', qual !== 'nota');
    $('paneCtlWrap').classList.toggle('esconde', qual !== 'ctl');
    if (qual === 'nota') $('nota').focus(); else abrirSub(subAtual);
  }
  function abrirSub(g, foco = true) {
    subAtual = g;
    root.querySelectorAll('#subAbas .aba').forEach(b => b.classList.toggle('on', b.dataset.g === g));
    $('paneMed').classList.toggle('esconde', g !== 'med');
    $('paneCtl').classList.toggle('esconde', g === 'med');
    if (g === 'med') { if (foco) $('medNome').focus(); return; }   // v1.3.1: Medicação só com a pesquisa (sem botões de medicamento)
    grupoCtl = g;
    limparCtl();
    renderFavCtl();
    atualizarBuscaCtl();
    if (foco && !$('ctlBusca').disabled) $('ctlBusca').focus();
  }
  $('abaNota').onclick = () => abrirAba('nota');
  $('abaCtl').onclick = () => abrirAba('ctl');
  root.querySelectorAll('#subAbas .aba').forEach(b => { b.onclick = () => abrirSub(b.dataset.g); });

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

  // ---------- Controle de Salas: Raio X, Exames, Enfermagem ----------
  // Cada item vira uma entrada do rascunho; no "Enviar para a ficha" entra na seção nativa da ficha
  // (Exames / Procedimentos) pelo "+ Incluir" do sistema. Não vai para o texto da evolução.
  const ROTULO_CTL = { raiox: 'RAIO-X', exames: 'EXAME', enfermagem: 'ENFERMAGEM' };
  const BUSCA_CTL = { raiox: 'Buscar radiografia…', exames: 'Buscar exame…', enfermagem: 'Buscar procedimento…' };
  const digCod = s => String(s ?? '').replace(/\D/g, '');
  const rotuloItem = s => { const t = String(s ?? '').trim(); return t.charAt(0) + t.slice(1).toLowerCase(); };
  const rotuloGrupo = s => String(s ?? '').trim().toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase());
  let grupoCtl = 'raiox', tBuscaCtl = null, buscaCtlSeq = 0;
  const jaNoRascunho = codigo => !!rascunho && rascunho.entradas.some(e => e.tipo === 'exame' && !e.enviadoControle && digCod(e.exame?.codigo) === digCod(codigo));
  // itens: [{ codigo, nome, tipoNativo }] → devolve quantos entraram
  function adicionarExames(grupo, itens) {
    if (!rascunho) return 0;
    if (!aindaOMesmo()) { verificarPaciente(); msg('O paciente mudou. Confira antes de registrar.', 'erro'); return 0; }
    const t0 = Date.now(), hora = agoraHHMM();
    let n = 0;
    for (const it of itens) {
      if (!digCod(it.codigo) || jaNoRascunho(it.codigo)) continue;
      rascunho.entradas.push({ id: t0 + n, tipo: 'exame', grupo, exame: { codigo: digCod(it.codigo), nome: it.nome, tipoNativo: it.tipoNativo === 'procedimento' ? 'procedimento' : 'exame' }, hora, autor: eu() });
      n++;
    }
    if (!n) {
      msg(itens.length > 1 ? 'Estes exames já estão no rascunho.' : grupo === 'enfermagem' ? 'Este procedimento já está no rascunho.' : 'Este exame já está no rascunho.', 'erro');
      return 0;
    }
    salvar(); render(); msg('');
    return n;
  }
  const itemFavorito = f => ({ codigo: f.code, nome: f.name, tipoNativo: f.type === 'procedimento' ? 'procedimento' : 'exame' });
  // Favoritos: os do Procedimentos PA neste computador (função do adaptador) ou uma lista fixa.
  const listaFavoritos = () => { try { const f = typeof C.favoritosControle === 'function' ? C.favoritosControle() : C.favoritosControle; return Array.isArray(f) ? f : []; } catch (e) { console.warn('[OM30 Rascunho] favoritos', e); return []; } };
  let regiaoRx = null, sistemaCtl = [], buscouCtl = false;
  function renderFavCtl() {
    const box = $('ctlFav'), g = grupoCtl, favs = listaFavoritos();
    box.innerHTML = '';
    const chip = (texto, fn, cls = '') => { const b = document.createElement('button'); b.className = 'chip' + (cls ? ' ' + cls : ''); b.textContent = texto; b.onclick = fn; box.appendChild(b); return b; };
    if (g === 'raiox') for (const [rotulo, termo] of (C.regioesRaioX || [])) {
      // como no Procedimentos PA: uma busca com o termo da região; clicar de novo na região ativa desliga e limpa a lista
      const b = chip(rotulo, () => {
        const desligar = regiaoRx === rotulo;
        limparCtl();                        // zera texto, região e lista (e cancela busca em andamento)
        if (desligar) { renderFavCtl(); return; }
        regiaoRx = rotulo; renderFavCtl();
        buscarCtl(termo);
      }, 'regiao');
      if (regiaoRx === rotulo) b.classList.add('on');
    }
    if (g === 'exames') for (const gr of (C.gruposExames || [])) {
      const todos = [...favs, ...(C.favoritosControlePadrao || [])];
      const itens = gr.codigos.map(cd => todos.find(f => digCod(f.code) === digCod(cd))).filter(Boolean).map(itemFavorito);
      if (itens.length) chip(rotuloGrupo(gr.nome), () => adicionarExames('exames', itens));
    }
    for (const f of favs.filter(f => f.group === g)) chip(rotuloItem(f.name), () => adicionarExames(g, [itemFavorito(f)]));
  }
  function limparCtl() { clearTimeout(tBuscaCtl); buscaCtlSeq++; regiaoRx = null; sistemaCtl = []; buscouCtl = false; $('ctlBusca').value = ''; renderListaCtl(); }
  // Lista fixa embaixo da caixa de busca (como no Procedimentos PA, pesquisando no sistema): mostra tudo o que o sistema
  // devolveu para a região ou para o texto, fica aberta para pedir vários itens e marca com ✓ o que já está no rascunho.
  // Sem texto e sem região, fica escondida (só os chips).
  function renderListaCtl() {
    const box = $('ctlRes'), g = grupoCtl;
    box.innerHTML = '';
    if (!buscouCtl) { box.classList.remove('on'); return; }
    for (const x of sistemaCtl) {
      const d = document.createElement('div');
      d.textContent = x.nome;
      d.dataset.codigo = digCod(x.codigo);
      if (jaNoRascunho(x.codigo)) d.classList.add('feito');
      d.onclick = () => { if (adicionarExames(g, [x])) d.classList.add('feito'); };
      box.appendChild(d);
    }
    if (!sistemaCtl.length) box.innerHTML = '<div style="color:#8796a0;cursor:default">Nada encontrado</div>';
    box.classList.add('lista'); box.classList.add('on');
  }
  // Mantém o ✓ da lista em dia quando o rascunho muda (item apagado, enviado, outro paciente).
  function marcarFeitosCtl() {
    for (const d of Array.from($('ctlRes').children)) if (d.dataset && d.dataset.codigo) d.classList.toggle('feito', jaNoRascunho(d.dataset.codigo));
  }
  function atualizarBuscaCtl() {
    const inp = $('ctlBusca');
    const ok = !C.buscaControleDisponivel || !!C.buscaControleDisponivel(grupoCtl);
    if (!ok && !inp.disabled) limparCtl();
    inp.disabled = !ok;
    inp.placeholder = ok ? BUSCA_CTL[grupoCtl] : 'Busca disponível com a ficha aberta';
  }
  // Pesquisa no sistema (texto digitado ou termo da região): a lista mostra tudo o que ele devolveu.
  const MIN_BUSCA_CTL = 2;
  async function buscarCtl(termo) {
    const g = grupoCtl;
    if (!C.buscarControle || termo.length < MIN_BUSCA_CTL || (C.buscaControleDisponivel && !C.buscaControleDisponivel(g))) return;
    const seq = ++buscaCtlSeq;
    let xs = [];
    try { xs = await C.buscarControle(g, termo); } catch (e) {
      console.warn('[OM30 Rascunho] busca do Controle de Salas', e);
      if (seq === buscaCtlSeq && g === grupoCtl) { sistemaCtl = []; buscouCtl = false; renderListaCtl(); msg('Busca indisponível no momento.', 'erro'); }
      return;
    }
    if (seq !== buscaCtlSeq || g !== grupoCtl) return;
    sistemaCtl = Array.isArray(xs) ? xs : [];
    buscouCtl = true;
    if ($('msg').textContent === 'Busca indisponível no momento.') msg('');
    renderListaCtl();
  }
  // Digitar desliga a região; com menos de 2 letras a lista some; senão pesquisa depois de 300 ms.
  function aoDigitarCtl() {
    clearTimeout(tBuscaCtl); buscaCtlSeq++;
    const termo = $('ctlBusca').value.trim();
    const eraRegiao = !!regiaoRx;
    if (eraRegiao) { regiaoRx = null; renderFavCtl(); }
    if (eraRegiao || termo.length < MIN_BUSCA_CTL) { sistemaCtl = []; buscouCtl = false; renderListaCtl(); }
    tBuscaCtl = setTimeout(() => buscarCtl(termo), 300);
  }
  $('ctlBusca').addEventListener('input', aoDigitarCtl);

  // ---------- estado ----------
  let paciente = null;
  let rascunho = null;
  abrirSub(subAtual, false);   // depois do estado: a lista marca o que já está no rascunho

  function msg(texto, tipo) { const m = $('msg'); m.className = 'msg ' + (tipo || ''); m.textContent = texto || ''; }

  function salvar() {
    if (!rascunho || !medico) return;
    rascunho.atualizadoEm = Date.now();
    if (rascunho.entradas.length || rascunho.textoPendente) store.set(chaveDe(rascunho.paciente), rascunho);
    else store.del(chaveDe(rascunho.paciente));
    atualizarOutros();
  }
  function salvarPendente() { if (!rascunho) return; rascunho.textoPendente = $('nota').value; salvar(); }

  const pendentesEvol = () => rascunho ? rascunho.entradas.filter(e => e.tipo !== 'exame' && !e.enviadoEvolucao) : [];
  const pendentesMed = () => rascunho ? rascunho.entradas.filter(e => e.tipo === 'med' && !e.enviadoControle) : [];
  // Raio X / Exames / Enfermagem: só vão para as seções nativas da ficha (enviadoControle)
  const pendentesCtl = () => rascunho ? rascunho.entradas.filter(e => e.tipo === 'exame' && !e.enviadoControle) : [];

  function render() {
    // profissional
    $('prof').innerHTML = medico
      ? (medico.nome ? `<span>Profissional:</span><b>${esc(medico.nome)}</b>` : '<b>Profissional identificado</b>')
      : '<span>Só consulta — profissional não identificado</span>';

    const temPac = !!paciente;
    $('editor').classList.toggle('esconde', !temPac);
    $('card').classList.toggle('esconde', !temPac);
    $('avisoFila').classList.toggle('on', temPac && !paciente.naFicha);

    // botão enviar: o texto explica o estado
    const nPend = pendentesEvol().length + pendentesMed().filter(e => e.enviadoEvolucao).length + pendentesCtl().length;
    if (temCtl) { atualizarBuscaCtl(); marcarFeitosCtl(); }
    const b = $('enviar');
    if (!medico) { b.disabled = true; b.textContent = 'Profissional não identificado'; }
    else if (!temPac) { b.disabled = true; b.textContent = 'Escolha um paciente'; }
    else if (!rascunho.entradas.length) { b.disabled = true; b.textContent = 'Nada anotado ainda'; }
    else if (!nPend) { b.disabled = true; b.textContent = '✓ Tudo já está na ficha'; }
    else if (!paciente.naFicha) { b.disabled = true; b.textContent = 'Abra a ficha para enviar'; }
    else { b.disabled = false; b.textContent = `Enviar ${nPend} ${nPend === 1 ? 'item' : 'itens'} para a ficha`; }
    $('apagar').disabled = !rascunho || !rascunho.entradas.length;
    $('lingN').textContent = String(meus().length);
    $('apagar').classList.toggle('esconde', !!rascunho && !podeApagar(rascunho));

    const tempo = $('tempo');
    if (vendo) { renderVer(tempo, vendo); return; }
    // lista: pedida no menu, ou sem paciente escolhido (inclui quem só consulta, sem profissional identificado)
    if (modoLista || (!temPac && meus().length)) { renderLista(tempo, temPac); return; }
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
    const variosAutores = autoresDe(rascunho.entradas).length > 1;
    if (!rascunho.entradas.length) {
      const outros = paciente.naFicha ? meus().filter(([k]) => k !== chaveDe(paciente)) : [];
      if (!outros.length) { tempo.innerHTML = '<div class="vazio">Nada anotado ainda para este paciente.</div>'; return; }
      renderEscolha(tempo, outros);
      return;
    }
    ordenar(rascunho.entradas).forEach(e => {
      const d = document.createElement('div');
      d.className = 'ent' + (e.tipo === 'med' ? ' med' : '');
      const pill = e.tipo === 'med' ? 'MEDICAÇÃO' : e.tipo === 'exame' ? (ROTULO_CTL[e.grupo] || 'EXAME') : '';
      d.innerHTML = `<div class="hora">${esc(e.hora)}</div><div class="ponto"></div><div class="bolha">${pill ? `<div class="pill">${pill}</div>` : ''}<div class="txt"></div></div>`;
      d.querySelector('.txt').textContent = textoEntrada(e);
      const bol = d.querySelector('.bolha');
      if (variosAutores && e.autor) bol.insertAdjacentHTML('afterbegin', `<div class="autor">${esc(nomeAutor(e.autor))}</div>`);
      const tudo = e.tipo === 'exame' ? !!e.enviadoControle : e.enviadoEvolucao && (e.tipo !== 'med' || e.enviadoControle);
      if (tudo) bol.insertAdjacentHTML('beforeend', '<div class="feito">✓ na ficha</div>');
      else if (e.enviadoEvolucao) bol.insertAdjacentHTML('beforeend', '<div class="feito" style="color:#9a6a00">✓ no texto · falta na seção Medicamentos</div>');
      else if (medico && ehMeu(e)) {
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
    el.title = 'Ver todos os seus rascunhos';
    $('lingN').textContent = String(meus().length);
  }

  // ---------- lista dos rascunhos do computador: abrir, ver ou apagar, mesmo sem o paciente na fila ----------
  let modoLista = false;
  let vendo = null;   // chave do rascunho aberto só para leitura (ex.: enfermagem no Controle de Salas)
  // Apaga quem escreveu alguma anotação nele (ou rascunho vazio). Os outros só veem.
  const podeApagar = v => !!medico && (!(v?.entradas || []).length || (v.entradas || []).some(ehMeu));

  function renderVer(tempo, k) {
    const v = store.get(k);
    $('card').classList.add('esconde'); $('editor').classList.add('esconde');
    $('avisoFila').classList.remove('on'); $('outros').classList.remove('on');
    tempo.innerHTML = '';
    const topo = document.createElement('div');
    topo.className = 'lista-topo';
    topo.innerHTML = '<span class="t"></span><button class="voltar">← Voltar</button>';
    topo.querySelector('.voltar').addEventListener('click', () => { vendo = null; modoLista = true; render(); });
    if (!v?.paciente) { vendo = null; render(); return; }
    topo.querySelector('.t').textContent = nomeExibido(v.paciente);
    tempo.appendChild(topo);
    const p = v.paciente;
    const autores = autoresDe(v.entradas);
    tempo.insertAdjacentHTML('beforeend', `<div class="ver-info">${[p.senha && `Senha <b>${esc(p.senha)}</b>`, p.nascimento && `Nasc. ${esc(p.nascimento)}`, autores.length && `1ª evolução: <b>${esc(nomeAutor(autores[0]))}</b>`, autores.length > 1 && `seguimento: ${autores.slice(1).map(a => esc(nomeAutor(a))).join(', ')}`].filter(Boolean).join(' · ')}<br><span>Só leitura neste computador.</span></div>`);
    if (!(v.entradas || []).length) { tempo.insertAdjacentHTML('beforeend', '<div class="vazio">Nada anotado.</div>'); return; }
    const varios = autores.length > 1;
    for (const e of ordenar(v.entradas)) {
      const d = document.createElement('div');
      d.className = 'ent' + (e.tipo === 'med' ? ' med' : '');
      d.innerHTML = `<div class="hora">${esc(e.hora)}</div><div class="ponto"></div><div class="bolha">${varios && e.autor ? `<div class="autor">${esc(nomeAutor(e.autor))}</div>` : ''}${e.tipo === 'med' ? '<div class="pill">MEDICAÇÃO</div>' : e.tipo === 'exame' ? `<div class="pill">${esc(ROTULO_CTL[e.grupo] || 'EXAME')}</div>` : ''}<div class="txt"></div>${(e.tipo === 'exame' ? e.enviadoControle : e.enviadoEvolucao) ? '<div class="feito">✓ na ficha</div>' : ''}</div>`;
      d.querySelector('.txt').textContent = textoEntrada(e);
      tempo.appendChild(d);
    }
  }

  function renderLista(tempo, temPac) {
    $('card').classList.add('esconde'); $('editor').classList.add('esconde');
    $('avisoFila').classList.remove('on'); $('outros').classList.remove('on');
    const naTelaFila = !!(medico && C.naFila && C.naFila());
    const itens = meus().map(([k, v]) => ({ k, v })).sort((a, b) => b.v.atualizadoEm - a.v.atualizadoEm);
    tempo.innerHTML = '';
    const topo = document.createElement('div');
    topo.className = 'lista-topo';
    topo.innerHTML = `<span class="t">Rascunhos deste computador (${itens.length})</span>${temPac ? '<button class="voltar">← Voltar</button>' : ''}`;
    topo.querySelector('.voltar')?.addEventListener('click', () => { modoLista = false; render(); atualizarOutros(); });
    tempo.appendChild(topo);
    if (!itens.length) { tempo.insertAdjacentHTML('beforeend', '<div class="vazio">Nenhum rascunho aberto.</div>'); return; }
    for (const it of itens) {
      const p = it.v.paciente;
      const n = it.v.entradas?.length || 0;
      const ult = n ? ordenar(it.v.entradas)[n - 1].hora : '';
      const d = document.createElement('div');
      d.className = 'rasc';
      d.innerHTML = `<div class="fx" style="background:${corDe(p)}"></div><div class="info"><b></b><span class="resumo"></span></div>` +
        (naTelaFila ? '<button class="mini abrir">Abrir</button>' : '<button class="mini ver">Ver</button>') +
        (podeApagar(it.v) ? '<button class="mini lixo" title="Apagar rascunho">🗑</button>' : '');
      d.querySelector('b').textContent = nomeExibido(p);
      const quem = autoresDe(it.v.entradas).map(nomeAutor).join(' → ');
      d.querySelector('.resumo').textContent = [p.senha, `${n} ${n === 1 ? 'anotação' : 'anotações'}`, ult && 'última ' + ult, quem].filter(Boolean).join(' · ');
      d.querySelector('.abrir')?.addEventListener('click', () => { C.selecionar?.(p); modoLista = false; verificarPaciente(true); });
      d.querySelector('.ver')?.addEventListener('click', () => { vendo = it.k; render(); });
      d.querySelector('.lixo')?.addEventListener('click', () => apagarDaLista(it));
      tempo.appendChild(d);
    }
  }

  async function apagarDaLista(it) {
    const nao = (it.v.entradas || []).filter(e => e.tipo === 'exame' ? !e.enviadoControle : !e.enviadoEvolucao).length;
    const corpo = pacHtml(it.v.paciente) +
      (nao ? `<div class="dlg-aviso">⚠ ${nao} ${nao === 1 ? 'anotação ainda não foi' : 'anotações ainda não foram'} para a ficha.</div>` : '');
    if (!await perguntar({ titulo: 'Apagar rascunho?', corpo, sim: 'Apagar', nao: 'Cancelar', tipo: 'perigo' })) return;
    store.del(it.k);
    C.esquecerPaciente?.(it.v.paciente.atendimento);
    if (rascunho && paciente && chaveDe(rascunho.paciente) === it.k) { rascunho = novoRascunho(paciente); $('nota').value = ''; }
    msg('Rascunho apagado.', 'ok');
    render(); atualizarOutros();
  }

  $('mLista').onclick = () => { $('menu').classList.remove('on'); recolher(false); modoLista = true; vendo = null; render(); };
  $('outros').onclick = () => { modoLista = true; render(); };

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
    limparCtl();
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
    // v1.2.0: Raio X, Exames e Enfermagem — voltam só se a seção da ficha estiver sem nenhuma linha.
    for (const [qtd, nativo] of [[C.qtdExamesFicha, 'exame'], [C.qtdProcedimentosFicha, 'procedimento']]) {
      const n = qtd ? qtd() : null;
      const enviados = rascunho.entradas.filter(e => e.tipo === 'exame' && e.enviadoControle && (e.exame?.tipoNativo || 'exame') === nativo);
      if (n === 0 && enviados.length) { enviados.forEach(e => { e.enviadoControle = false; }); voltou += enviados.length; }
    }
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
    rascunho.entradas.push({ id: Date.now(), hora: agoraHHMM(), tipo: 'nota', texto, autor: eu() });
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
    rascunho.entradas.push({ id: Date.now(), hora: med.horario, tipo: 'med', med, autor: eu() });
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
    const pe = pendentesEvol(), pm = pendentesMed(), px = pendentesCtl();
    if (!pe.length && !pm.length && !px.length) { msg('Tudo já está na ficha.', 'ok'); return; }
    const p = rascunho.paciente;
    const destino = (C.destinoTexto && C.destinoTexto()) || 'texto clínico';
    const destinoMed = (C.destinoMed && C.destinoMed()) || 'Medicamentos';
    const texto = montarTexto(pe, rascunho.entradas);
    const nLinhas = pe.length;
    const nNotas = pe.filter(e => e.tipo !== 'med').length, nMedTxt = nLinhas - nNotas;
    const resumoTxt = [nNotas && `${nNotas} ${nNotas === 1 ? 'anotação' : 'anotações'}`, nMedTxt && `${nMedTxt} ${nMedTxt === 1 ? 'medicação' : 'medicações'}`].filter(Boolean).join(' + ');
    const corpo = pacHtml(p) +
      (conf.duvida ? `<div class="dlg-aviso">⚠ ${esc(conf.duvida)}</div>` : '') +
      '<div class="dlg-sec">Vai entrar na ficha</div>' +
      (nLinhas ? `<div class="dlg-item"><span class="ic">📝</span><div><b>${resumoTxt}</b> no texto de <i>${esc(destino)}</i></div></div>` : '') +
      (pm.length ? `<div class="dlg-item"><span class="ic">💊</span><div><b>${pm.length} ${pm.length === 1 ? 'medicação' : 'medicações'}</b> na seção <i>${esc(destinoMed)}</i><small>${esc(pm.map(e => e.med.nome).join(' · '))}</small></div></div>` : '') +
      (px.length ? `<div class="dlg-item"><span class="ic">🧪</span><div><b>${px.length} ${px.length === 1 ? 'item' : 'itens'} do Controle de Salas</b><small>${esc(px.map(e => e.exame.nome).join(' · '))}</small></div></div>` : '') +
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
      // Raio X / Exames / Enfermagem: um por vez na seção nativa; falha num item não para os outros
      const falhas = [];
      let nOk = 0;
      for (const e of px) {
        try {
          await C.incluirExame(e.exame);
          e.enviadoControle = true; nOk++;
          salvar();
        } catch (err) {
          falhas.push(e);
          console.warn('[OM30 Rascunho] item do Controle de Salas não incluído', e.exame?.codigo, err);
        }
      }
      if (!px.length) msg('Pronto. Confira o texto e a medicação na ficha e finalize no sistema. Depois clique em "Finalizei a ficha — apagar rascunho".', 'ok');
      else {
        const soExames = px.every(e => e.exame?.tipoNativo !== 'procedimento');
        const feito = !nOk ? '' : `${nOk} ${soExames ? (nOk === 1 ? 'exame incluído' : 'exames incluídos') : (nOk === 1 ? 'item incluído' : 'itens incluídos')} na ficha.`;
        if (falhas.length) msg([feito, 'Não foi possível incluir: ' + falhas.map(e => rotuloItem(e.exame?.nome || e.exame?.codigo)).join(', ') + '.'].filter(Boolean).join(' '), 'erro');
        else msg(`Pronto. ${feito} Confira e finalize no sistema. Depois clique em "Finalizei a ficha — apagar rascunho".`, 'ok');
      }
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
    const nao = pendentesEvol().length + pendentesMed().filter(e => e.enviadoEvolucao).length + pendentesCtl().length;
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
      entradas: rascunho?.entradas.length || 0, pendentesTexto: pendentesEvol().length, pendentesMed: pendentesMed().length, pendentesControle: pendentesCtl().length,
      ultimaMensagem: $('msg').textContent.replace(/[A-ZÀ-Ú]{3,}( [A-ZÀ-Ú]{2,})+/g, '<nome>'),
      botaoEnviar: $('enviar').textContent,
    };
    $('diagTxt').value = 'OM30_RASCUNHO_DIAG\n' + JSON.stringify(d, null, 2);
    $('diagOk').textContent = '';
    $('modal').classList.add('on');
    $('diagTxt').select();
  };
  $('diagFechar').onclick = () => $('modal').classList.remove('on');

  // ---------- configurações: tamanho do painel ----------
  // v1.3.1: para quem enxerga pouco. Aumenta o painel inteiro (texto, botões e largura) com zoom no host.
  // Guardado neste computador para cada profissional (o mesmo PC é usado por vários); sem profissional, vale o último escolhido.
  const CHAVE_CFG = 'om30-rasc-cfg';
  const TAMANHOS = [1, 1.2, 1.4];
  const lerCfg = () => { try { const c = JSON.parse(localStorage.getItem(CHAVE_CFG) || '{}'); return c && typeof c === 'object' ? c : {}; } catch { return {}; } };
  function tamanhoAtual() {
    const c = lerCfg();
    const z = medico && c.porProfissional ? c.porProfissional[String(medico.id)] : undefined;
    const v = Number(z ?? c.ultimo ?? 1);
    return TAMANHOS.includes(v) ? v : 1;
  }
  function aplicarTamanho(z = tamanhoAtual()) {
    host.style.zoom = z === 1 ? '' : String(z);
    root.querySelectorAll('#cfgTam .cfg-op').forEach(b => b.classList.toggle('on', Number(b.dataset.z) === z));
  }
  function guardarTamanho(z) {
    const c = lerCfg();
    c.ultimo = z;
    if (medico) { c.porProfissional = c.porProfissional && typeof c.porProfissional === 'object' ? c.porProfissional : {}; c.porProfissional[String(medico.id)] = z; }
    try { localStorage.setItem(CHAVE_CFG, JSON.stringify(c)); } catch {}
  }
  $('mCfg').onclick = () => { $('menu').classList.remove('on'); aplicarTamanho(); $('modalCfg').classList.add('on'); };
  $('cfgFechar').onclick = () => $('modalCfg').classList.remove('on');
  root.querySelectorAll('#cfgTam .cfg-op').forEach(b => { b.onclick = () => { const z = Number(b.dataset.z); guardarTamanho(z); aplicarTamanho(z); }; });
  aplicarTamanho();
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
    const faltam = paciente?.naFicha && rascunho ? pendentesEvol().length + pendentesMed().length + pendentesCtl().length : 0;
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
    if (pendentesEvol().length || pendentesMed().length || pendentesCtl().length) { ev.preventDefault(); ev.returnValue = ''; }
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
        if (pendentesEvol().length || pendentesMed().length || pendentesCtl().length) enviar();
        else msg('Tudo deste rascunho já está na ficha.', 'ok');
      } else if (meus().length) msg('Escolha no painel qual rascunho é deste paciente.', 'ok');
      else msg('Você não tem nenhum rascunho aberto.', 'erro');
    },
    qtdTotal() { return meus().length; },
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
    if ((m?.id || '') === (medico?.id || '')) { if (m && medico) { medico.nome = m.nome || medico.nome; completarNomes(); } render(); return; }
    if (rascunho && medico) { rascunho.textoPendente = $('nota').value; salvar(); }
    medico = m; rascunho = null; paciente = null; ultimoId = null; vendo = null;
    aplicarTamanho();   // v1.3.1: tamanho escolhido por este profissional
    migrarAntigos(); completarNomes();
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
