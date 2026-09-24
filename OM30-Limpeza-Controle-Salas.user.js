// ==UserScript==
// @name         OM30 - Limpeza Controle de Salas
// @description  Limpeza controlada da fila de Medicação com filtro interno, horário limite, prévia e log
// @namespace    https://om30.com.br/
// @version      1.7
// @author       OM30
// @updateURL    https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Limpeza-Controle-Salas.user.js
// @downloadURL  https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Limpeza-Controle-Salas.user.js
// @match        https://guaruja.saudesimples.net/aplicacoes_medicamentos*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    if (location.pathname !== '/aplicacoes_medicamentos') return;

    const CONFIG = {
        versao: '1.7',
        statusLabel: 'Em Espera',
        justificativa: 'Foi realizado manualmente.',
        pausaEntreAtendimentos: 700,
        limitePaginasSeguranca: 100,
        timeoutAtualizacao: 10000
    };

    const STATE = {
        candidatos: [],
        executando: false,
        previewExecutando: false,
        abortar: false,
        dataPreview: null,
        horaPreview: null,
        logs: [],
        filtroDiagnostico: null,
        resultados: {
            sucessos: [],
            ignorados: [],
            falhas: []
        }
    };

    // =========================================================
    // UTILITÁRIOS
    // =========================================================

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    const clean = valor => String(valor ?? '')
        .replace(/\s+/g, ' ')
        .trim();

    const normalizar = valor => clean(valor)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();

    const normalizarChave = valor => normalizar(valor)
        .replace(/[^a-z0-9]/g, '');

    function agora() {
        return new Date().toLocaleString('pt-BR');
    }

    function hojeBR() {
        return new Date().toLocaleDateString('pt-BR');
    }

    function brParaISO(data) {
        const m = String(data || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
    }

    function isoParaBR(data) {
        const m = String(data || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
        return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
    }

    function horaMinutos(hora) {
        const m = String(hora || '').match(/^(\d{2}):(\d{2})$/);
        return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
    }

    function visivel(el) {
        if (!el) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' &&
               style.visibility !== 'hidden' &&
               rect.width > 0 &&
               rect.height > 0;
    }

    function escapeHtml(valor) {
        return String(valor ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    async function nextTick(vm) {
        if (vm && typeof vm.$nextTick === 'function') {
            await new Promise(resolve => vm.$nextTick(resolve));
        } else {
            await Promise.resolve();
        }
    }

    // =========================================================
    // LOG
    // =========================================================

    function sanitizarErro(erro) {
        let response = null;
        try {
            response = erro?.response?.data ?? erro?.resposta ?? null;
            if (response && typeof response === 'object') {
                response = JSON.stringify(response);
            }
            if (response) response = String(response).slice(0, 1800);
        } catch {}

        return {
            message: erro?.message || String(erro),
            status: erro?.response?.status || erro?.status || null,
            response,
            stack: erro?.stack
                ? erro.stack.split('\n').slice(0, 8).join(' | ')
                : null
        };
    }

    function log(tipo, mensagem, dados = null) {
        const linha = `[${agora()}] [${tipo}] ${mensagem}`;
        STATE.logs.push(linha);

        if (dados !== null) {
            try {
                STATE.logs.push(JSON.stringify(dados, null, 2));
            } catch {
                STATE.logs.push(String(dados));
            }
        }

        if (tipo === 'ERRO') console.error('[OM30 LIMPEZA]', mensagem, dados || '');
        else if (tipo === 'AVISO') console.warn('[OM30 LIMPEZA]', mensagem, dados || '');
        else console.log('[OM30 LIMPEZA]', mensagem, dados || '');

        atualizarLogVisual();
    }

    // =========================================================
    // VUE - LOCALIZA O CONTROLE DE SALAS REAL
    // =========================================================

    function subirVms(vm) {
        const lista = [];
        const vistos = new Set();
        let atual = vm;

        while (atual && !vistos.has(atual)) {
            vistos.add(atual);
            lista.push(atual);
            atual = atual.$parent;
        }
        return lista;
    }

    function coletarArvoreVue(raiz, limite = 500) {
        const out = [];
        const fila = [raiz];
        const vistos = new Set();

        while (fila.length && out.length < limite) {
            const vm = fila.shift();
            if (!vm || vistos.has(vm)) continue;
            vistos.add(vm);
            out.push(vm);

            if (Array.isArray(vm.$children)) {
                fila.push(...vm.$children);
            }
        }
        return out;
    }

    function acharControleSalaVM() {
        const seeds = [
            ...document.querySelectorAll('.atualizar-listagem, #btn_filtro_modal, .botao-chamar, .botao-atender')
        ];

        const candidatos = [];
        const vistos = new Set();

        for (const seed of seeds) {
            let node = seed;
            for (let i = 0; node && i < 15; i++, node = node.parentElement) {
                const vm = node.__vue__;
                if (!vm) continue;

                for (const x of subirVms(vm)) {
                    if (vistos.has(x)) continue;
                    vistos.add(x);

                    if (
                        x.$refs?.filtroMunicipe &&
                        x.$refs?.listagemFila &&
                        typeof x.atualizarListagemFila === 'function'
                    ) {
                        candidatos.push(x);
                    }
                }
            }
        }

        if (!candidatos.length) {
            // fallback: procura VMs raiz em elementos Vue visíveis
            for (const el of document.querySelectorAll('body *')) {
                const vm = el.__vue__;
                if (!vm) continue;
                for (const x of subirVms(vm)) {
                    if (vistos.has(x)) continue;
                    vistos.add(x);
                    if (
                        x.$refs?.filtroMunicipe &&
                        x.$refs?.listagemFila &&
                        typeof x.atualizarListagemFila === 'function'
                    ) candidatos.push(x);
                }
            }
        }

        const escolhido = candidatos.find(vm =>
            String(vm.salaValorSelecionado || '').includes('medicacao') ||
            String(vm.dataSource || '').includes('/aplicacoes_medicamentos')
        ) || candidatos[0];

        if (!escolhido) {
            throw new Error('Componente Vue do Controle de Salas não encontrado.');
        }

        return escolhido;
    }

    function getVue(el) {
        let node = el;
        for (let i = 0; node && i < 10; i++, node = node.parentElement) {
            if (node.__vue__) return node.__vue__;
        }
        return null;
    }

    // =========================================================
    // FILTRO INTERNO - SEM ABRIR MODAL / CALENDÁRIO
    // =========================================================

    function scoreObjetoCondicoes(obj) {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return -1;
        const keys = Object.keys(obj).map(normalizarChave);
        let score = 0;

        if (keys.some(k => k === 'status' || k.includes('status'))) score += 8;
        if (keys.some(k => k.includes('datainicial') || k.includes('datainicio'))) score += 10;
        if (keys.some(k => k.includes('datafinal') || k.includes('datafim'))) score += 10;
        if (keys.some(k => k.includes('profissional'))) score += 2;
        if (keys.some(k => k.includes('risco'))) score += 2;

        return score;
    }

    function acharObjetoCondicoesOpcional(filtroVM) {
        const vms = coletarArvoreVue(filtroVM, 120);
        const candidatos = [];
        const vistos = new Set();

        function adicionar(vm, origem, obj) {
            if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
            if (vistos.has(obj)) return;
            vistos.add(obj);
            candidatos.push({ vm, origem, obj, score: scoreObjetoCondicoes(obj) });
        }

        for (const vm of vms) {
            try { adicionar(vm, 'vm.conditions', vm.conditions); } catch {}
            try { adicionar(vm, '$data.conditions', vm.$data?.conditions); } catch {}
            try { adicionar(vm, '$props.conditions', vm.$props?.conditions); } catch {}

            for (const container of [vm.$data, vm.$props]) {
                if (!container || typeof container !== 'object') continue;
                for (const [k, v] of Object.entries(container)) {
                    if (/cond|filter|filtro/i.test(k)) adicionar(vm, `${k}`, v);
                }
            }
        }

        candidatos.sort((a, b) => b.score - a.score);
        return candidatos[0] || null;
    }

    function acharChave(obj, tipos) {
        const keys = Object.keys(obj || {});
        const regras = {
            status: k => k === 'status' || k.includes('status'),
            dataInicial: k => k.includes('datainicial') || k.includes('datainicio'),
            dataFinal: k => k.includes('datafinal') || k.includes('datafim'),
            profissional: k => k.includes('profissional'),
            risco: k => k.includes('risco')
        };

        for (const tipo of tipos) {
            const regra = regras[tipo];
            const achou = keys.find(original => regra(normalizarChave(original)));
            if (achou) return achou;
        }
        return null;
    }

    function zerarComo(valorAtual) {
        if (Array.isArray(valorAtual)) return [];
        if (valorAtual && typeof valorAtual === 'object' && !(valorAtual instanceof Date)) return {};
        return '';
    }

    function dataComo(valorAtual, iso) {
        if (valorAtual instanceof Date) return new Date(`${iso}T00:00:00`);
        return iso;
    }

    function resolverStatusEmEspera(filtroVM) {
        // 1) Se o select existir no DOM (mesmo oculto), usa o value exato do sistema.
        const selects = [...document.querySelectorAll('#status_select, select')];
        for (const select of selects) {
            const option = [...(select.options || [])].find(o =>
                normalizar(o.textContent) === normalizar(CONFIG.statusLabel)
            );
            if (option) return option.value;
        }

        // 2) Procura a collection dentro dos componentes Vue.
        for (const vm of coletarArvoreVue(filtroVM, 120)) {
            const fontes = [
                vm.statusCollection,
                vm.statusCollectionFormatado,
                vm.$props?.statusCollection,
                vm.$data?.statusCollection
            ];

            for (let fonte of fontes) {
                if (!fonte) continue;
                if (typeof fonte === 'string') {
                    try { fonte = JSON.parse(fonte); } catch { continue; }
                }
                if (!Array.isArray(fonte)) continue;

                for (const item of fonte) {
                    if (Array.isArray(item) && item.length >= 2) {
                        if (normalizar(item[0]) === normalizar(CONFIG.statusLabel)) return item[1];
                    } else if (item && typeof item === 'object') {
                        const label = item.label ?? item.text ?? item.nome ?? item.name;
                        const value = item.value ?? item.id ?? item.valor;
                        if (normalizar(label) === normalizar(CONFIG.statusLabel)) return value;
                    }
                }
            }
        }

        return CONFIG.statusLabel;
    }

    function setarCampoReativo(vm, chave, valor) {
        try {
            if (typeof vm.$set === 'function' && vm.$data && Object.prototype.hasOwnProperty.call(vm.$data, chave)) {
                vm.$set(vm.$data, chave, valor);
            }
            vm[chave] = valor;
            return true;
        } catch {
            return false;
        }
    }

    function prepararCamposInternosFiltro(filtroVM, dataISO, statusValue) {
        const vms = coletarArvoreVue(filtroVM, 120);
        const alterados = [];

        for (const vm of vms) {
            const data = vm.$data;
            if (!data || typeof data !== 'object') continue;

            for (const chave of Object.keys(data)) {
                const nk = normalizarChave(chave);
                let alvo = false;
                let valor;

                // Campos selecionados do modal customizado.
                if (nk.includes('status') && (nk.includes('selecion') || nk === 'status')) {
                    alvo = true;
                    valor = statusValue;
                } else if (nk.includes('profissional') && nk.includes('selecion')) {
                    alvo = true;
                    valor = zerarComo(data[chave]);
                } else if (nk.includes('risco') && nk.includes('selecion')) {
                    alvo = true;
                    valor = zerarComo(data[chave]);
                } else if (nk.includes('datainicial') || nk.includes('datainicio')) {
                    alvo = true;
                    valor = dataComo(data[chave], dataISO);
                } else if (nk.includes('datafinal') || nk.includes('datafim')) {
                    alvo = true;
                    valor = dataComo(data[chave], dataISO);
                }

                if (alvo && setarCampoReativo(vm, chave, valor)) {
                    alterados.push({
                        componente: vm.$options?.name || null,
                        chave,
                        valor: valor instanceof Date ? valor.toISOString() : String(valor ?? '')
                    });
                }
            }
        }

        return { vms, alterados };
    }

    async function aguardarListaAtualizar(collectionVM, fingerprintAntes) {
        const inicio = Date.now();
        let viuLoading = false;

        while (Date.now() - inicio < CONFIG.timeoutAtualizacao) {
            const loading = Boolean(collectionVM?.isLoading || collectionVM?.preparingLoading);
            if (loading) viuLoading = true;

            const depois = fingerprintTabela();
            if (!loading && (viuLoading || depois !== fingerprintAntes || Date.now() - inicio > 1400)) {
                await sleep(250);
                return;
            }
            await sleep(100);
        }

        throw new Error('Timeout aguardando a listagem filtrada atualizar.');
    }

    async function aplicarFiltroInterno() {
        const dataISO = document.querySelector('#om30-limpeza-data')?.value;
        if (!dataISO) throw new Error('Data da limpeza não informada.');
        const dataBR = isoParaBR(dataISO);

        const controle = acharControleSalaVM();
        const filtroVM = controle.$refs.filtroMunicipe;
        const listaVM = controle.$refs.listagemFila;
        const collectionVM = listaVM?.$refs?.collectionWithSearch || null;

        if (!filtroVM || !listaVM) {
            throw new Error('Refs internos filtroMunicipe/listagemFila não encontrados.');
        }

        const statusValue = resolverStatusEmEspera(filtroVM);
        const preparado = prepararCamposInternosFiltro(filtroVM, dataISO, statusValue);
        const cond = acharObjetoCondicoesOpcional(filtroVM);
        let condDiag = null;

        // Também atualiza o objeto conditions, quando existir. Isso cobre
        // tanto o wrapper filtro-controle-salas quanto custom-filter-with-modal.
        if (cond && cond.score >= 8) {
            const condicoes = cond.obj;
            const keyStatus = acharChave(condicoes, ['status']);
            const keyInicial = acharChave(condicoes, ['dataInicial']);
            const keyFinal = acharChave(condicoes, ['dataFinal']);
            const keyProf = acharChave(condicoes, ['profissional']);
            const keyRisco = acharChave(condicoes, ['risco']);

            if (keyProf) condicoes[keyProf] = zerarComo(condicoes[keyProf]);
            if (keyRisco) condicoes[keyRisco] = zerarComo(condicoes[keyRisco]);
            if (keyStatus) condicoes[keyStatus] = statusValue;
            if (keyInicial) condicoes[keyInicial] = dataComo(condicoes[keyInicial], dataISO);
            if (keyFinal) condicoes[keyFinal] = dataComo(condicoes[keyFinal], dataISO);

            condDiag = {
                componente: cond.vm?.$options?.name || null,
                origem: cond.origem,
                score: cond.score,
                chaves: { keyStatus, keyInicial, keyFinal, keyProf, keyRisco }
            };
        }

        // O próprio modal do sistema usa o método fetchFilter() ao salvar.
        // Chamamos esse método diretamente, sem abrir o modal e sem clicar.
        const fetchVM = preparado.vms.find(vm => typeof vm.fetchFilter === 'function') || null;

        if (!fetchVM && (!cond || cond.score < 18)) {
            const diag = preparado.vms.slice(0, 25).map(vm => ({
                componente: vm.$options?.name || null,
                dataKeys: Object.keys(vm.$data || {})
            }));
            const erro = new Error('Não encontrei o método/estado interno necessário para aplicar o filtro sem abrir o modal.');
            erro.resposta = JSON.stringify(diag);
            throw erro;
        }

        STATE.filtroDiagnostico = {
            componenteControle: controle.$options?.name || null,
            componenteFiltro: filtroVM.$options?.name || null,
            fetchFilterComponente: fetchVM?.$options?.name || null,
            statusValue: String(statusValue),
            dataISO,
            camposAlterados: preparado.alterados,
            conditions: condDiag
        };

        log('INFO', `Aplicando filtro INTERNAMENTE: ${dataBR} | ${CONFIG.statusLabel}`);
        log('DEBUG', 'Estado interno do filtro preparado.', STATE.filtroDiagnostico);

        for (const vm of preparado.vms) await nextTick(vm);

        const antes = fingerprintTabela();
        let retorno;

        if (fetchVM) {
            log('DEBUG', 'Executando fetchFilter() diretamente; nenhum modal/calendário será aberto.');
            retorno = fetchVM.fetchFilter();
        } else {
            log('DEBUG', 'fetchFilter() não exposto; usando atualizarListagemFila() interno com conditions já preenchidas.');
            retorno = controle.atualizarListagemFila();
        }

        if (retorno && typeof retorno.then === 'function') await retorno;
        await aguardarListaAtualizar(collectionVM, antes);
        await voltarPrimeiraPaginaInterna();

        validarPaginaFiltrada(dataBR);

        const paginas = totalPaginas();
        if (paginas > CONFIG.limitePaginasSeguranca) {
            throw new Error(`Filtro interno não reduziu a fila: ${paginas} páginas. Execução bloqueada.`);
        }

        log('INFO', `Filtro interno aplicado. Páginas filtradas: ${paginas}.`);
        return { controle, filtroVM, listaVM, collectionVM, paginas, dataBR };
    }

    // =========================================================
    // TABELA / CANDIDATOS
    // =========================================================

    function encontrarTabelaFila() {
        const candidatas = [...document.querySelectorAll('table')]
            .map(table => {
                const headers = [...table.querySelectorAll('thead th')].map(th => clean(th.innerText));
                const rows = [...table.querySelectorAll('tbody tr')].filter(tr => tr.querySelectorAll('td').length > 0);
                const texto = normalizar(headers.join(' '));
                let pontos = 0;
                if (table.classList.contains('b-table')) pontos += 100;
                if (visivel(table)) pontos += 50;
                if (rows.length) pontos += 50;
                if (texto.includes('municipe')) pontos += 20;
                if (texto.includes('senha')) pontos += 20;
                if (texto.includes('status')) pontos += 20;
                if (texto.includes('sala')) pontos += 10;
                return { table, headers, rows, pontos };
            })
            .filter(x => x.rows.length > 0)
            .sort((a, b) => b.pontos - a.pontos);

        if (!candidatas.length) {
            throw new Error('Tabela visível do Controle de Salas não encontrada.');
        }
        return candidatas[0];
    }

    function mapearColunas(headers) {
        const h = headers.map(normalizar);
        const achar = fn => h.findIndex(fn);

        const dataHora = achar(x => x.includes('data hora') || x.includes('data/hora'));
        const data = dataHora >= 0 ? dataHora : achar(x => x === 'data' || x.startsWith('data '));
        const hora = dataHora >= 0 ? -1 : achar(x => x === 'hora' || x.startsWith('hora '));
        const municipe = achar(x => x.includes('municipe'));
        const sala = achar(x => x === 'sala' || x.includes('sala'));
        const senha = achar(x => x.includes('senha'));
        const status = achar(x => x.includes('status'));

        if ([data, municipe, sala, senha, status].some(i => i < 0)) {
            throw new Error(`Não foi possível mapear a tabela. Cabeçalhos: ${headers.join(' | ')}`);
        }
        return { data, hora, municipe, sala, senha, status };
    }

    function extrairLinha(tr, col) {
        const cells = [...tr.querySelectorAll('td')];
        const textoData = clean(cells[col.data]?.innerText);
        let data = textoData.match(/\d{2}\/\d{2}\/\d{4}/)?.[0] || '';
        let hora = textoData.match(/\b\d{2}:\d{2}\b/)?.[0] || '';

        if (!hora && col.hora >= 0) {
            hora = clean(cells[col.hora]?.innerText).match(/\b\d{2}:\d{2}\b/)?.[0] || '';
        }

        return {
            data,
            hora,
            nome: clean(cells[col.municipe]?.innerText),
            sala: clean(cells[col.sala]?.innerText),
            senha: clean(cells[col.senha]?.innerText),
            status: clean(cells[col.status]?.innerText)
        };
    }

    function fingerprintTabela() {
        try {
            const { rows } = encontrarTabelaFila();
            return rows.slice(0, 10).map(row => clean(row.innerText)).join('||');
        } catch {
            return '';
        }
    }

    function validarPaginaFiltrada(dataEsperada) {
        let tabela;
        try {
            tabela = encontrarTabelaFila();
        } catch {
            // Fila sem registros é válida.
            return true;
        }

        const col = mapearColunas(tabela.headers);
        for (const tr of tabela.rows.slice(0, 10)) {
            const item = extrairLinha(tr, col);

            if (item.data && item.data !== dataEsperada) {
                throw new Error(`Filtro de data falhou. Encontrado ${item.data}; esperado ${dataEsperada}.`);
            }
            if (item.status && normalizar(item.status) !== normalizar(CONFIG.statusLabel)) {
                throw new Error(`Filtro de status falhou. Encontrado "${item.status}".`);
            }
        }
        log('DEBUG', 'Validação visual do filtro aprovada.');
        return true;
    }

    function lerPagina() {
        let tabela;
        try {
            tabela = encontrarTabelaFila();
        } catch {
            return [];
        }

        const col = mapearColunas(tabela.headers);
        const dataDesejada = isoParaBR(document.querySelector('#om30-limpeza-data').value);
        const limite = horaMinutos(document.querySelector('#om30-limpeza-hora').value);

        if (!Number.isFinite(limite)) throw new Error('Horário limite inválido.');

        const encontrados = [];

        for (const tr of tabela.rows) {
            const info = extrairLinha(tr, col);
            if (!info.data || !info.hora) continue;
            if (info.data !== dataDesejada) continue;
            if (normalizar(info.status) !== normalizar(CONFIG.statusLabel)) continue;
            if (horaMinutos(info.hora) > limite) continue;
            if (!normalizar(info.sala).includes('medic')) continue;

            const vmChamar = getVue(tr.querySelector('.botao-chamar'));
            const vmAtender = getVue(tr.querySelector('.botao-atender'));
            const atendimentoStr = vmChamar?.atendimentoStr || vmAtender?.atendimentoStr || '';
            const encaminhamentoStr = vmAtender?.encaminhamentoStr || '';
            const [atendimentoType, atendimentoId] = atendimentoStr.split('#');
            const [, encaminhamentoId] = encaminhamentoStr.split('#');

            encontrados.push({
                ...info,
                atendimentoType: atendimentoType || '',
                atendimentoId: atendimentoId || '',
                encaminhamentoId: encaminhamentoId || '',
                valido: Boolean(atendimentoType && atendimentoId && encaminhamentoId)
            });
        }

        return encontrados;
    }

    // =========================================================
    // PAGINAÇÃO - TENTA VUE; CLIQUE É APENAS FALLBACK
    // =========================================================

    function raizListagemFila() {
        // Primeiro usa a raiz Vue exata da fila de Controle de Salas.
        try {
            const controle = acharControleSalaVM();
            const el = controle?.$refs?.listagemFila?.$el;
            if (el) return el;
        } catch {}

        // Fallback: sobe a partir da tabela visível que nós já identificamos.
        try {
            const { table } = encontrarTabelaFila();
            return table.closest('.listagem-fila') ||
                   table.closest('.collection-with-search') ||
                   table.parentElement ||
                   null;
        } catch {
            return null;
        }
    }

    function collectionFilaVM() {
        try {
            const controle = acharControleSalaVM();
            return controle?.$refs?.listagemFila?.$refs?.collectionWithSearch || null;
        } catch {
            return null;
        }
    }

    function botoesPaginacao() {
        const raiz = raizListagemFila();
        if (!raiz) return [];

        return [...raiz.querySelectorAll(
            '.b-pagination .page-link, .pagination .page-link, .b-pagination button, .pagination button'
        )].filter(visivel);
    }

    function acharPaginationVM() {
        // Caminho mais confiável: a paginação que é FILHA do collectionWithSearch da fila.
        const collection = collectionFilaVM();
        if (collection) {
            const arvore = coletarArvoreVue(collection, 100);
            const vm = arvore.find(x => {
                const nome = normalizar(x?.$options?.name || '');
                return nome.includes('pagination') && typeof x.$emit === 'function';
            });
            if (vm) return vm;
        }

        // Fallback DOM, mas sempre limitado à listagem correta.
        const raiz = raizListagemFila();
        if (!raiz) return null;

        const pags = [...raiz.querySelectorAll('.b-pagination, .pagination')].filter(visivel);
        for (const pag of pags) {
            let node = pag;
            for (let i = 0; node && i < 8; i++, node = node.parentElement) {
                let vm = node.__vue__;
                while (vm) {
                    const nome = normalizar(vm.$options?.name || '');
                    if (nome.includes('pagination') && typeof vm.$emit === 'function') return vm;
                    vm = vm.$parent;
                }
            }
        }
        return null;
    }

    function numeroVue(vm, chaves) {
        if (!vm) return null;
        for (const chave of chaves) {
            try {
                const valor = Number(vm[chave]);
                if (Number.isFinite(valor) && valor > 0) return valor;
            } catch {}
            try {
                const valor = Number(vm.$data?.[chave]);
                if (Number.isFinite(valor) && valor > 0) return valor;
            } catch {}
            try {
                const valor = Number(vm.$props?.[chave]);
                if (Number.isFinite(valor) && valor > 0) return valor;
            } catch {}
        }
        return null;
    }

    function paginaAtual() {
        const raiz = raizListagemFila();

        // Não procura mais paginação no documento inteiro.
        if (raiz) {
            const ativo = raiz.querySelector(
                '.b-pagination .page-item.active .page-link, ' +
                '.pagination .page-item.active .page-link, ' +
                '.b-pagination [aria-current="page"], ' +
                '.pagination [aria-current="page"]'
            );
            const n = Number(clean(ativo?.textContent));
            if (Number.isFinite(n) && n > 0) return n;
        }

        const pvm = acharPaginationVM();
        const doVue = numeroVue(pvm, [
            'localValue', 'value', 'computedCurrentPage', 'currentPage', 'page'
        ]);
        if (doVue) return doVue;

        const collection = collectionFilaVM();
        const daCollection = numeroVue(collection, [
            'currentPage', 'page', 'paginaAtual', 'pagina'
        ]);
        if (daCollection) return daCollection;

        // Sem paginação renderizada = página única = página 1.
        return 1;
    }

    function totalPaginas() {
        const pvm = acharPaginationVM();
        const totalVue = numeroVue(pvm, [
            'numberOfPages', 'computedNumberOfPages', 'localNumberOfPages', 'pageCount', 'pages'
        ]);
        if (totalVue) return Math.max(1, totalVue);

        const botoes = botoesPaginacao();
        const aria = botoes
            .map(b => Number(b.getAttribute('aria-setsize')))
            .filter(n => Number.isFinite(n) && n > 0);
        const nums = botoes
            .map(b => Number(clean(b.textContent)))
            .filter(n => Number.isFinite(n) && n > 0);

        // Se o BootstrapVue não renderiza paginação porque só existe uma página,
        // o resultado correto é 1 e não devemos tentar localizar botão "1".
        return Math.max(1, ...aria, ...nums);
    }

    async function mudarPaginaViaCollection(numero) {
        const collection = collectionFilaVM();
        if (!collection) return false;

        let alterou = false;
        for (const chave of ['currentPage', 'page', 'paginaAtual', 'pagina']) {
            try {
                if (chave in collection || chave in (collection.$data || {})) {
                    collection[chave] = numero;
                    alterou = true;
                    break;
                }
            } catch {}
        }

        if (!alterou) return false;
        await nextTick(collection);

        if (typeof collection.fetchCollection === 'function') {
            const retorno = collection.fetchCollection();
            if (retorno && typeof retorno.then === 'function') await retorno;
        }
        return true;
    }

    async function irPaginaInterna(numero) {
        numero = Number(numero);
        if (!Number.isFinite(numero) || numero < 1) {
            throw new Error(`Página inválida: ${numero}.`);
        }

        const total = totalPaginas();
        if (numero > total) {
            throw new Error(`Página ${numero} não existe mais. Total atual: ${total}.`);
        }

        if (paginaAtual() === numero) return;

        // Caso de uma única página: não existe botão de paginação e isso é normal.
        if (total === 1 && numero === 1) return;

        const antes = fingerprintTabela();
        const pvm = acharPaginationVM();
        let metodo = null;

        if (pvm) {
            pvm.$emit('input', numero);
            await nextTick(pvm);
            metodo = 'Vue pagination';
        } else {
            const botoes = botoesPaginacao();
            let btn = botoes.find(b => clean(b.textContent) === String(numero));

            if (!btn && numero === 1) {
                btn = botoes.find(b => {
                    const aria = normalizar(b.getAttribute('aria-label') || '');
                    return aria.includes('first') || aria.includes('primeira') || aria.includes('pagina 1') || aria.includes('page 1');
                });
            }

            if (btn) {
                btn.click();
                metodo = 'botão da paginação da fila';
            } else if (await mudarPaginaViaCollection(numero)) {
                metodo = 'collectionWithSearch';
            } else if (numero === 1) {
                // Se a fila foi reduzida durante a limpeza, o BootstrapVue pode remover
                // a paginação antes de atualizar a referência da página atual. Nesse caso
                // página 1 é a única página restante e não há nada para clicar.
                if (totalPaginas() === 1) {
                    log('DEBUG', 'Paginação não renderizada; fila possui apenas a página 1.');
                    return;
                }
                throw new Error('Não consegui reposicionar a fila na página 1 internamente.');
            } else {
                throw new Error(`Não consegui acessar internamente a página ${numero}.`);
            }
        }

        log('DEBUG', `Mudando fila para página ${numero} via ${metodo}.`);

        const inicio = Date.now();
        while (Date.now() - inicio < CONFIG.timeoutAtualizacao) {
            const atual = paginaAtual();
            const mudouTabela = fingerprintTabela() !== antes;

            if (atual === numero && (mudouTabela || Date.now() - inicio > 900)) {
                await sleep(250);
                return;
            }
            await sleep(100);
        }

        throw new Error(`Timeout aguardando a página ${numero}. Página detectada: ${paginaAtual()}.`);
    }

    async function voltarPrimeiraPaginaInterna() {
        const total = totalPaginas();
        if (total <= 1) return;
        if (paginaAtual() !== 1) await irPaginaInterna(1);
    }

    async function lerTodasPaginasFiltradas() {
        // IMPORTANTÍSSIMO: a paginação agora é lida somente dentro da fila certa.
        await voltarPrimeiraPaginaInterna();
        const total = totalPaginas();

        if (total > CONFIG.limitePaginasSeguranca) {
            throw new Error(`Listagem ainda possui ${total} páginas após o filtro. Execução bloqueada.`);
        }

        const encontrados = [];
        for (let p = 1; p <= total; p++) {
            if (p !== paginaAtual()) await irPaginaInterna(p);
            const itens = lerPagina();
            encontrados.push(...itens);
            log('INFO', `Página filtrada ${p}/${total}: ${itens.length} candidato(s).`);
        }

        // Não falha mais no fim se a própria fila tiver encolhido para uma página.
        try {
            await voltarPrimeiraPaginaInterna();
        } catch (erro) {
            log('AVISO', 'Não foi necessário reposicionar a fila ao final da prévia.', sanitizarErro(erro));
        }

        return { encontrados, paginas: total };
    }

    // =========================================================
    // REQUEST SAME-ORIGIN
    // =========================================================

    async function requestSameOrigin(url, { method = 'GET', params = null, body = null } = {}) {
        const destino = new URL(url, location.origin);
        if (params) {
            for (const [k, v] of Object.entries(params)) {
                if (v !== undefined && v !== null) destino.searchParams.set(k, String(v));
            }
        }

        const headers = {
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'X-Requested-With': 'XMLHttpRequest'
        };

        const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
        if (csrf) headers['X-CSRF-Token'] = csrf;

        const options = {
            method,
            credentials: 'same-origin',
            headers,
            cache: 'no-store'
        };

        if (body !== null && method !== 'GET') {
            headers['Content-Type'] = 'application/json; charset=UTF-8';
            options.body = JSON.stringify(body);
        }

        const response = await fetch(destino.toString(), options);
        const texto = await response.text();
        let data = texto;
        try { data = texto ? JSON.parse(texto) : null; } catch {}

        if (!response.ok) {
            const erro = new Error(`${method} ${destino.pathname} retornou HTTP ${response.status}`);
            erro.status = response.status;
            erro.resposta = String(texto || '').slice(0, 1500);
            throw erro;
        }

        return { status: response.status, data };
    }

    // =========================================================
    // CHAMADA INTERNA
    // =========================================================

    async function chamarPaciente(item) {
        const params = {
            atendimento_id: item.atendimentoId,
            atendimento_type: item.atendimentoType
        };

        log('DEBUG', `Chamando ${item.senha} internamente.`, params);

        // Mesmo GET usado pelo primeiro bonequinho.
        const chamada = await requestSameOrigin('/aplicacoes_medicamentos/chamar_paciente', {
            method: 'GET',
            params
        });

        if (
            !chamada.data ||
            (typeof chamada.data === 'object' && !Array.isArray(chamada.data) && Object.keys(chamada.data).length === 0)
        ) {
            throw new Error('chamar_paciente retornou vazio.');
        }

        // O PUT passa pelo método do próprio componente da página.
        // Assim usamos exatamente o saudeSimplesProxy interno do sistema,
        // mesmo ele não ficando exposto em window para o Tampermonkey.
        const controle = acharControleSalaVM();
        const fila = controle.$refs?.filaChamarProximo;

        if (!fila || typeof fila.chamarAtendimentoSelecionado !== 'function') {
            throw new Error('Método interno chamarAtendimentoSelecionado() não encontrado.');
        }

        fila.prontuariavelId = item.atendimentoId;
        fila.prontuariavelType = item.atendimentoType;

        const retorno = fila.chamarAtendimentoSelecionado();
        if (retorno && typeof retorno.then === 'function') await retorno;

        log('DEBUG', `${item.senha}: chamada registrada pelo método interno do sistema.`);
    }

    // =========================================================
    // FICHA SEM NAVEGAR
    // =========================================================

    function erroFichaIndisponivel(item, mensagem, extras = {}) {
        const erro = new Error(mensagem);
        erro.codigo = 'FICHA_INDISPONIVEL';
        erro.status = extras.status ?? null;
        erro.ficha = {
            senha: item?.senha || null,
            encaminhamentoId: item?.encaminhamentoId || null,
            finalUrl: extras.finalUrl || null,
            motivo: mensagem
        };
        return erro;
    }

    async function carregarFicha(item) {
        const url = `/aplicacoes_medicamentos/new?encaminhamento_medicacao_id=${encodeURIComponent(item.encaminhamentoId)}`;
        const response = await fetch(url, {
            credentials: 'same-origin',
            cache: 'no-store',
            redirect: 'follow',
            headers: { 'Accept': 'text/html,application/xhtml+xml' }
        });

        if (!response.ok) {
            if ([404, 410, 422].includes(response.status)) {
                throw erroFichaIndisponivel(
                    item,
                    `Ficha indisponível para edição. HTTP ${response.status}.`,
                    { status: response.status, finalUrl: response.url }
                );
            }

            const erro = new Error(`Erro carregando ficha. HTTP ${response.status}`);
            erro.status = response.status;
            throw erro;
        }

        const html = await response.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const form =
            [...doc.querySelectorAll('form')].find(f =>
                /^edit_encaminhamento_medicacao_\d+$/.test(f.id || '') &&
                f.querySelector('input[name="encaminhamento_medicacao[id]"]')
            ) ||
            doc.querySelector('form[id^="edit_encaminhamento_medicacao_"]') ||
            doc.querySelector('form.encaminhamento_medicacao');

        if (!form) {
            // Algumas senhas da fila apontam para um encaminhamento que já não possui
            // ficha editável. Não chamamos/cancelamos esse registro: ele será ignorado
            // e os demais continuam normalmente.
            throw erroFichaIndisponivel(
                item,
                'Ficha não encontrada ou não está mais editável.',
                { status: response.status, finalUrl: response.url }
            );
        }

        const idFicha = form.querySelector('input[name="encaminhamento_medicacao[id]"]')?.value || '';
        if (idFicha && String(idFicha) !== String(item.encaminhamentoId)) {
            throw erroFichaIndisponivel(
                item,
                `A ficha retornada pertence ao encaminhamento ${idFicha}, não ao ${item.encaminhamentoId}.`,
                { status: response.status, finalUrl: response.url }
            );
        }

        return { form, doc, finalUrl: response.url };
    }

    function formatarDataHoraCancelamento() {
        return new Date().toLocaleString('pt-BR', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });
    }

    function prepararCancelamento(form) {
        const itens = [...form.querySelectorAll('.item-encaminhamento-controle-salas')];
        if (!itens.length) throw new Error('Nenhum item de medicação encontrado na ficha.');

        // No cancelamento manual o sistema preenche profissional_cancelamento_id
        // com o valor do hidden #current_profissional, que é disabled e por isso
        // não entra sozinho no FormData.
        const profissionalAtual = form.querySelector('#current_profissional')?.value || '';
        if (!profissionalAtual) {
            throw new Error('Não foi possível identificar current_profissional na ficha.');
        }

        let quantidade = 0;
        const detalhes = [];

        for (const item of itens) {
            const pendente = item.querySelector('input[id$="_pendente"]');
            const cancelada = item.querySelector('input[id$="_cancelada"]');
            const paraAtendimento = item.querySelector('input[id$="_para_atendimento"]');
            const paraCancelamento = item.querySelector('input[id$="_para_cancelamento"]');
            const canceledAt = item.querySelector('input[id$="_canceled_at"]');
            const profissionalCancelamento = item.querySelector('input[id$="_profissional_cancelamento_id"]');
            const justificativa = item.querySelector(
                'input[id$="_justificativa_cancelamento"], textarea[id$="_justificativa_cancelamento"]'
            );

            if (!pendente || !cancelada) continue;
            if (String(pendente.value) !== 'true' || String(cancelada.value) === 'true') continue;
            if (!justificativa) throw new Error('Campo justificativa_cancelamento não encontrado.');
            if (!canceledAt) throw new Error('Campo canceled_at não encontrado.');
            if (!profissionalCancelamento) throw new Error('Campo profissional_cancelamento_id não encontrado.');

            const momentoCancelamento = formatarDataHoraCancelamento();

            // Mesmo estado observado no POST manual do Saúde Simples.
            pendente.value = 'false';
            cancelada.value = 'true';
            if (paraAtendimento) paraAtendimento.value = 'false';
            if (paraCancelamento) paraCancelamento.value = 'true';
            canceledAt.value = momentoCancelamento;
            profissionalCancelamento.value = profissionalAtual;
            justificativa.value = CONFIG.justificativa;

            quantidade++;
            detalhes.push({
                id: item.querySelector('input[id$="_id"]')?.value || null,
                pendente: pendente.value,
                cancelada: cancelada.value,
                paraAtendimento: paraAtendimento?.value ?? null,
                paraCancelamento: paraCancelamento?.value ?? null,
                canceledAt: momentoCancelamento,
                profissionalCancelamentoPreenchido: true,
                justificativa: CONFIG.justificativa
            });
        }

        if (!quantidade) {
            throw new Error('Nenhum item PENDENTE encontrado para cancelamento.');
        }

        return { quantidade, detalhes };
    }

    function extrairConclusaoDaResposta(texto) {
        const source = String(texto || '');
        const match = source.match(
            /concluirSenhaOpcional\(\s*["']([^"']+)["']\s*,\s*\{[\s\S]*?atendimento_id\s*:\s*(\d+)\s*,[\s\S]*?atendimento_type\s*:\s*["']([^"']+)["'][\s\S]*?\}\s*\)/i
        );

        if (!match) return null;

        return {
            tipoParametrizacao: match[1],
            atendimentoId: match[2],
            atendimentoType: match[3]
        };
    }

    async function concluirSenhaAposSalvar(conclusao, item) {
        if (!conclusao) {
            throw new Error('A resposta do salvamento não trouxe concluirSenhaOpcional().');
        }

        if (conclusao.tipoParametrizacao !== 'controle_de_salas_medicacao') {
            throw new Error(`Tipo inesperado na conclusão da senha: ${conclusao.tipoParametrizacao}`);
        }

        log('DEBUG', `${item.senha}: concluindo senha pelo mesmo helper retornado pelo Rails.`, {
            tipoParametrizacao: conclusao.tipoParametrizacao,
            atendimentoId: conclusao.atendimentoId,
            atendimentoType: conclusao.atendimentoType
        });

        let fn = null;

        try {
            if (typeof window.concluirSenhaOpcional === 'function') {
                fn = window.concluirSenhaOpcional;
            }
        } catch {}

        // Fallback para casos em que o helper exista no contexto global da página,
        // mas não esteja enumerável diretamente no objeto window do userscript.
        if (!fn) {
            try {
                fn = window.eval(
                    'typeof concluirSenhaOpcional === "function" ? concluirSenhaOpcional : null'
                );
            } catch {}
        }

        if (typeof fn !== 'function') {
            throw new Error('Helper concluirSenhaOpcional() não encontrado na página.');
        }

        const retorno = fn(
            conclusao.tipoParametrizacao,
            {
                atendimento_id: Number(conclusao.atendimentoId),
                atendimento_type: conclusao.atendimentoType
            }
        );

        const resultado = retorno && typeof retorno.then === 'function'
            ? await retorno
            : retorno;

        log('DEBUG', `${item.senha}: concluirSenhaOpcional() finalizado.`, {
            resultado: resultado === undefined ? null : resultado
        });

        return resultado;
    }

    async function salvarFicha(form) {
        const fd = new FormData(form);
        const body = new URLSearchParams();

        for (const [k, v] of fd.entries()) {
            if (typeof v === 'string') body.append(k, v);
        }

        // O POST manual do Rails envia também o submit button vazio.
        if (!body.has('button')) body.append('button', '');

        const action = form.getAttribute('action') || '/aplicacoes_medicamentos';
        const method = (form.getAttribute('method') || 'post').toUpperCase();
        const csrf = document.querySelector('meta[name="csrf-token"]')?.content;

        const headers = {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Accept': '*/*;q=0.5, text/javascript, application/javascript, application/ecmascript, application/x-ecmascript',
            'X-Requested-With': 'XMLHttpRequest'
        };
        if (csrf) headers['X-CSRF-Token'] = csrf;

        const response = await fetch(action, {
            method,
            credentials: 'same-origin',
            headers,
            body: body.toString(),
            cache: 'no-store',
            redirect: 'follow'
        });

        const texto = await response.text();
        if (!response.ok) {
            const erro = new Error(`Falha ao salvar ficha. HTTP ${response.status}`);
            erro.status = response.status;
            erro.resposta = texto.slice(0, 1500);
            throw erro;
        }

        // O Rails retorna JavaScript e, no fluxo manual, rails-ujs executa esse JS.
        // Como aqui usamos fetch, fazemos somente a parte necessária e conhecida:
        // concluirSenhaOpcional(...). Não executamos a resposta inteira via eval.
        const conclusao = extrairConclusaoDaResposta(texto);

        if (!/Encaminhamento atualizado com sucesso/i.test(texto)) {
            log('AVISO', 'POST retornou HTTP 200, mas a mensagem de sucesso esperada não apareceu.', {
                resposta: texto.slice(0, 700)
            });
        }

        return {
            status: response.status,
            finalUrl: response.url,
            resposta: texto.slice(0, 1200),
            conclusao
        };
    }

    async function verificarCancelamento(item) {
        const url = `/aplicacoes_medicamentos/new?encaminhamento_medicacao_id=${encodeURIComponent(item.encaminhamentoId)}`;
        const response = await fetch(url, {
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'Accept': 'text/html,application/xhtml+xml' }
        });

        if (!response.ok) {
            if ([404, 410].includes(response.status)) return true;
            throw new Error(`Falha verificando cancelamento. HTTP ${response.status}`);
        }

        const html = await response.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const form = doc.querySelector('form.encaminhamento_medicacao');

        // Se após salvar o sistema já não devolve mais a ficha editável,
        // a operação saiu do estado pendente.
        if (!form) {
            log('DEBUG', `${item.senha}: ficha não voltou editável após salvar; considerado encerrado.`);
            return true;
        }

        const itens = [...form.querySelectorAll('.item-encaminhamento-controle-salas')];
        const aindaPendentes = itens.filter(el => {
            const p = el.querySelector('input[id$="_pendente"]');
            const c = el.querySelector('input[id$="_cancelada"]');
            return p?.value === 'true' && c?.value !== 'true';
        });

        if (aindaPendentes.length) {
            throw new Error(`Após salvar ainda existem ${aindaPendentes.length} item(ns) pendente(s).`);
        }
        return true;
    }

    // =========================================================
    // PRÉVIA
    // =========================================================

    async function preview() {
        if (STATE.executando || STATE.previewExecutando) return;

        const data = isoParaBR(document.querySelector('#om30-limpeza-data')?.value);
        const hora = document.querySelector('#om30-limpeza-hora')?.value;

        if (!data) return mostrarStatus('Informe uma data válida.', 'erro');
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hora || '')) {
            return mostrarStatus('Informe um horário válido.', 'erro');
        }

        STATE.previewExecutando = true;
        STATE.candidatos = [];
        STATE.dataPreview = null;
        STATE.horaPreview = null;
        limparResultados();
        limparPreview();
        atualizarResumo();
        atualizarBotoes();

        log('INFO', `Iniciando prévia. Data: ${data} | Até: ${hora}`);
        mostrarStatus('Aplicando filtro interno do Saúde Simples...', 'carregando');

        try {
            const filtro = await aplicarFiltroInterno();
            mostrarStatus(`Filtro aplicado. Lendo ${filtro.paginas} página(s) filtrada(s)...`, 'carregando');

            const { encontrados, paginas } = await lerTodasPaginasFiltradas();
            log('INFO', `Leitura finalizada em ${paginas} página(s) filtrada(s).`);

            const unicos = new Map();
            for (const item of encontrados) {
                const chave = item.encaminhamentoId || `${item.data}|${item.hora}|${item.senha}|${item.nome}`;
                if (!unicos.has(chave)) unicos.set(chave, item);
            }

            STATE.candidatos = [...unicos.values()];
            STATE.dataPreview = data;
            STATE.horaPreview = hora;

            renderizarPreview();
            atualizarResumo();

            console.table(STATE.candidatos.map((item, i) => ({
                '#': i + 1,
                Hora: item.hora,
                Senha: item.senha,
                Munícipe: item.nome,
                Sala: item.sala,
                Atendimento: `${item.atendimentoType}#${item.atendimentoId}`,
                Encaminhamento: item.encaminhamentoId,
                Mapeado: item.valido ? 'SIM' : 'NÃO'
            })));

            const invalidos = STATE.candidatos.filter(x => !x.valido);
            if (!STATE.candidatos.length) {
                mostrarStatus(`Nenhum registro de 00:00 até ${hora}.`, 'aviso');
                log('AVISO', 'Nenhum atendimento encontrado dentro dos critérios.');
            } else if (invalidos.length) {
                mostrarStatus(`${invalidos.length} registro(s) sem IDs internos. Execução bloqueada.`, 'erro');
                log('ERRO', 'Há candidatos sem IDs internos.', invalidos.map(x => ({
                    hora: x.hora, senha: x.senha, nome: x.nome
                })));
            } else {
                mostrarStatus(`${STATE.candidatos.length} atendimento(s) encontrado(s). Confira e execute.`, 'sucesso');
                log('INFO', `Prévia concluída: ${STATE.candidatos.length} atendimento(s).`);
            }
        } catch (erro) {
            const info = sanitizarErro(erro);
            mostrarStatus(`Erro na prévia: ${info.message}`, 'erro');
            log('ERRO', 'Erro durante a prévia.', info);
        } finally {
            STATE.previewExecutando = false;
            atualizarBotoes();
        }
    }

    // =========================================================
    // EXECUÇÃO
    // =========================================================

    async function executar() {
        if (STATE.executando) return;
        if (!STATE.candidatos.length) return mostrarStatus('Faça a prévia primeiro.', 'erro');

        const dataAtual = isoParaBR(document.querySelector('#om30-limpeza-data')?.value);
        const horaAtual = document.querySelector('#om30-limpeza-hora')?.value;

        if (dataAtual !== STATE.dataPreview || horaAtual !== STATE.horaPreview) {
            return mostrarStatus('Data ou horário foram alterados. Faça uma nova prévia.', 'erro');
        }
        if (STATE.candidatos.some(x => !x.valido)) {
            return mostrarStatus('Existem registros não mapeados. Execução bloqueada.', 'erro');
        }

        const confirmar = confirm(
            'CONFIRMAR LIMPEZA\n\n' +
            `Data: ${STATE.dataPreview}\n` +
            `Período: 00:00 até ${STATE.horaPreview}\n` +
            `Status: ${CONFIG.statusLabel}\n` +
            'Sala: Medicação\n' +
            `Atendimentos: ${STATE.candidatos.length}\n\n` +
            `Justificativa:\n"${CONFIG.justificativa}"\n\n` +
            'Fichas que não estiverem mais disponíveis serão IGNORADAS sem interromper as demais.\n\n' +
            'Continuar?'
        );
        if (!confirmar) return;

        STATE.executando = true;
        STATE.abortar = false;
        limparResultados();
        atualizarBotoes();
        log('INFO', '===== INÍCIO DA EXECUÇÃO =====');
        log('INFO', `Data ${STATE.dataPreview} | 00:00 até ${STATE.horaPreview} | ${STATE.candidatos.length} atendimento(s).`);

        let sucessos = 0;
        let ignorados = 0;
        let falhou = false;

        for (let i = 0; i < STATE.candidatos.length; i++) {
            if (STATE.abortar) {
                log('AVISO', 'Processamento interrompido manualmente.');
                break;
            }

            const item = STATE.candidatos[i];
            mostrarStatus(`Processando ${i + 1}/${STATE.candidatos.length}: ${item.senha} - ${item.nome}`, 'carregando');
            log('INFO', `PROCESSANDO ${i + 1}/${STATE.candidatos.length} | ${item.hora} | ${item.senha} | ${item.nome}`, {
                atendimentoId: item.atendimentoId,
                atendimentoType: item.atendimentoType,
                encaminhamentoId: item.encaminhamentoId
            });

            try {
                // 0) PRE-FLIGHT: confirma que a ficha realmente existe ANTES de chamar a senha.
                // Assim uma ficha inexistente não sofre nenhuma alteração de estado.
                let ficha;
                try {
                    ficha = await carregarFicha(item);
                } catch (erro) {
                    if (erro?.codigo === 'FICHA_INDISPONIVEL') {
                        ignorados++;
                        registrarResultado('ignorados', item, {
                            motivo: erro?.ficha?.motivo || erro?.message || 'Ficha indisponível'
                        });
                        log('AVISO', `IGNORADO ${item.senha} - ${item.nome}: ficha indisponível.`, erro.ficha || sanitizarErro(erro));
                        mostrarStatus(
                            `Ignorando ${item.senha}: ficha não disponível. Continuando...`,
                            'aviso'
                        );
                        await sleep(250);
                        continue;
                    }
                    throw erro;
                }

                // 1) Mesmo fluxo interno do primeiro bonequinho + chamada.
                await chamarPaciente(item);

                // 2) Usa a ficha já validada no pre-flight.
                const { form } = ficha;

                // 3) Marca todos os itens ainda pendentes como cancelados e justifica.
                const preparado = prepararCancelamento(form);
                log('DEBUG', `${preparado.quantidade} item(ns) preparado(s) para cancelamento.`, preparado.detalhes);

                // 4) Salva a própria ficha com o mesmo payload do cancelamento manual.
                const salvo = await salvarFicha(form);
                log('DEBUG', `Ficha salva. HTTP ${salvo.status}.`, {
                    finalUrl: salvo.finalUrl,
                    conclusaoDetectada: salvo.conclusao
                });

                // 5) O POST manual devolve JS chamando concluirSenhaOpcional().
                await concluirSenhaAposSalvar(salvo.conclusao, item);

                // 6) Confere se não restou item pendente.
                await sleep(500);
                await verificarCancelamento(item);

                sucessos++;
                registrarResultado('sucessos', item, {
                    quantidade: preparado.quantidade
                });
                log('SUCESSO', `${item.senha} - ${item.nome} concluído. ${preparado.quantidade} item(ns) cancelado(s).`);
            } catch (erro) {
                falhou = true;
                const info = sanitizarErro(erro);
                registrarResultado('falhas', item, {
                    erro: info.message || 'Erro não informado'
                });
                log('ERRO', `FALHA EM ${item.senha} - ${item.nome}.`, {
                    hora: item.hora,
                    senha: item.senha,
                    nome: item.nome,
                    atendimentoId: item.atendimentoId,
                    atendimentoType: item.atendimentoType,
                    encaminhamentoId: item.encaminhamentoId,
                    erro: info
                });
                mostrarStatus(`Erro em ${item.senha}. Processo interrompido. Clique em “Copiar log”.`, 'erro');
                break;
            }

            await sleep(CONFIG.pausaEntreAtendimentos);
        }

        STATE.executando = false;
        atualizarBotoes();
        log('INFO', `===== FIM | SUCESSOS: ${sucessos} | IGNORADOS: ${ignorados} =====`);

        if (STATE.resultados.sucessos.length) {
            log('INFO', '===== REALIZADOS COM SUCESSO =====', STATE.resultados.sucessos.map((x, i) => ({
                ordem: i + 1,
                hora: x.hora,
                senha: x.senha,
                nome: x.nome,
                itensCancelados: x.quantidade,
                encaminhamentoId: x.encaminhamentoId
            })));
        }
        if (STATE.resultados.ignorados.length) {
            log('AVISO', '===== IGNORADOS =====', STATE.resultados.ignorados.map((x, i) => ({
                ordem: i + 1,
                hora: x.hora,
                senha: x.senha,
                nome: x.nome,
                motivo: x.motivo,
                encaminhamentoId: x.encaminhamentoId
            })));
        }
        if (STATE.resultados.falhas.length) {
            log('ERRO', '===== FALHAS =====', STATE.resultados.falhas.map((x, i) => ({
                ordem: i + 1,
                hora: x.hora,
                senha: x.senha,
                nome: x.nome,
                erro: x.erro,
                encaminhamentoId: x.encaminhamentoId
            })));
        }

        // Atualiza a fila mantendo o mesmo filtro interno.
        try {
            await aplicarFiltroInterno();
            log('INFO', 'Fila atualizada novamente com o filtro interno.');
        } catch (erro) {
            log('AVISO', 'Limpeza terminou, mas não consegui atualizar novamente a listagem filtrada.', sanitizarErro(erro));
        }

        if (!falhou && !STATE.abortar) {
            if (ignorados > 0) {
                mostrarStatus(
                    `Concluídos: ${sucessos}. Ignorados por ficha indisponível: ${ignorados}.`,
                    'sucesso'
                );
            } else if (sucessos === STATE.candidatos.length) {
                mostrarStatus(`${sucessos} atendimento(s) concluído(s) com sucesso.`, 'sucesso');
            }
        } else if (STATE.abortar) {
            mostrarStatus(
                `Execução parada. Concluídos: ${sucessos} | Ignorados: ${ignorados} | Total: ${STATE.candidatos.length}.`,
                'aviso'
            );
        }
    }

    // =========================================================
    // UI
    // =========================================================

    function detectarDataInicial() {
        return hojeBR();
    }

    function mostrarStatus(texto, tipo = '') {
        const el = document.querySelector('#om30-status');
        if (!el) return;
        el.className = `om30-message ${tipo}`;
        el.textContent = texto;
    }

    function limparResultados() {
        STATE.resultados = {
            sucessos: [],
            ignorados: [],
            falhas: []
        };
        renderizarResultados();
    }

    function registrarResultado(tipo, item, extra = {}) {
        if (!STATE.resultados?.[tipo]) return;
        STATE.resultados[tipo].push({
            hora: item.hora || '',
            senha: item.senha || '',
            nome: item.nome || '',
            atendimentoId: item.atendimentoId || '',
            encaminhamentoId: item.encaminhamentoId || '',
            registradoEm: agora(),
            ...extra
        });
        renderizarResultados();
    }

    function renderizarResultados() {
        const box = document.querySelector('#om30-resultados');
        if (!box) return;

        const sucessos = STATE.resultados?.sucessos || [];
        const ignorados = STATE.resultados?.ignorados || [];
        const falhas = STATE.resultados?.falhas || [];
        const total = sucessos.length + ignorados.length + falhas.length;

        if (!total) {
            box.style.display = 'none';
            box.innerHTML = '';
            return;
        }

        const linhas = (lista, classe, detalheFn) => lista.map(item => `
            <div class="om30-resultado-item ${classe}">
                <div class="om30-resultado-principal">
                    <span class="hora">${escapeHtml(item.hora)}</span>
                    <span class="senha">${escapeHtml(item.senha)}</span>
                    <span class="nome" title="${escapeHtml(item.nome)}">${escapeHtml(item.nome)}</span>
                </div>
                <div class="om30-resultado-detalhe">${escapeHtml(detalheFn(item))}</div>
            </div>
        `).join('');

        box.style.display = '';
        box.innerHTML = `
            <div class="om30-resultados-titulo">Resultado da execução</div>
            <div class="om30-resultados-contadores">
                <span class="ok"><b>${sucessos.length}</b> realizados</span>
                <span class="skip"><b>${ignorados.length}</b> ignorados</span>
                <span class="fail"><b>${falhas.length}</b> falhas</span>
            </div>
            ${sucessos.length ? `
                <details class="om30-resultado-grupo" open>
                    <summary>Realizados com sucesso (${sucessos.length})</summary>
                    <div>${linhas(sucessos, 'sucesso', item => `${item.quantidade || 0} item(ns) cancelado(s)`)}</div>
                </details>
            ` : ''}
            ${ignorados.length ? `
                <details class="om30-resultado-grupo">
                    <summary>Ignorados (${ignorados.length})</summary>
                    <div>${linhas(ignorados, 'ignorado', item => item.motivo || 'Ficha indisponível')}</div>
                </details>
            ` : ''}
            ${falhas.length ? `
                <details class="om30-resultado-grupo" open>
                    <summary>Falhas (${falhas.length})</summary>
                    <div>${linhas(falhas, 'falha', item => item.erro || 'Erro não informado')}</div>
                </details>
            ` : ''}
        `;
    }

    function limparPreview() {
        const el = document.querySelector('#om30-lista');
        if (el) el.innerHTML = '';
    }

    function atualizarResumo() {
        const el = document.querySelector('#om30-resumo');
        if (!el) return;
        const total = STATE.candidatos.length;
        const validos = STATE.candidatos.filter(x => x.valido).length;
        el.innerHTML = `
            <div class="om30-summary-card"><b>${total}</b><span>Encontrados</span></div>
            <div class="om30-summary-card"><b>${validos}</b><span>Mapeados</span></div>
            <div class="om30-summary-card"><b>${total - validos}</b><span>Com erro</span></div>
        `;
    }

    function renderizarPreview() {
        const el = document.querySelector('#om30-lista');
        if (!el) return;
        el.innerHTML = STATE.candidatos.map(item => `
            <div class="om30-item">
                <span class="hora">${escapeHtml(item.hora)}</span>
                <span class="senha">${escapeHtml(item.senha)}</span>
                <span class="nome" title="${escapeHtml(item.nome)}">${escapeHtml(item.nome)}</span>
            </div>
        `).join('');
    }

    function atualizarBotoes() {
        const previewBtn = document.querySelector('#om30-preview');
        const executarBtn = document.querySelector('#om30-executar');
        const data = document.querySelector('#om30-limpeza-data');
        const hora = document.querySelector('#om30-limpeza-hora');
        const ocupado = STATE.executando || STATE.previewExecutando;

        if (previewBtn) {
            previewBtn.disabled = ocupado;
            previewBtn.textContent = STATE.previewExecutando ? 'Analisando...' : 'Prévia';
        }
        if (executarBtn) {
            executarBtn.disabled = ocupado || !STATE.candidatos.length || STATE.candidatos.some(x => !x.valido);
            executarBtn.textContent = STATE.executando ? 'Executando...' : 'Executar limpeza';
        }
        if (data) data.disabled = ocupado;
        if (hora) hora.disabled = ocupado;
    }

    function atualizarLogVisual() {
        const el = document.querySelector('#om30-log');
        if (!el) return;
        el.textContent = STATE.logs.slice(-400).join('\n');
        el.scrollTop = el.scrollHeight;
    }

    function invalidarPreview() {
        STATE.candidatos = [];
        STATE.dataPreview = null;
        STATE.horaPreview = null;
        limparPreview();
        atualizarResumo();
        atualizarBotoes();
        mostrarStatus('Data ou horário alterado. Faça uma nova prévia.', 'aviso');
    }

    async function copiarLog() {
        const texto = [
            '===== OM30 - LIMPEZA CONTROLE DE SALAS =====',
            `Versão: ${CONFIG.versao}`,
            `URL: ${location.href}`,
            `Data do log: ${agora()}`,
            `Data selecionada: ${document.querySelector('#om30-limpeza-data')?.value || ''}`,
            `Horário limite: ${document.querySelector('#om30-limpeza-hora')?.value || ''}`,
            `Candidatos: ${STATE.candidatos.length}`,
            `Justificativa: ${CONFIG.justificativa}`,
            `Filtro interno: ${STATE.filtroDiagnostico ? JSON.stringify(STATE.filtroDiagnostico) : 'não mapeado'}`,
            '============================================',
            '',
            '===== REALIZADOS COM SUCESSO =====',
            ...(STATE.resultados?.sucessos?.length
                ? STATE.resultados.sucessos.map((x, i) => `${i + 1}. ${x.hora} | ${x.senha} | ${x.nome} | ${x.quantidade || 0} item(ns) | encaminhamento ${x.encaminhamentoId || '-'}`)
                : ['Nenhum.']),
            '',
            '===== IGNORADOS =====',
            ...(STATE.resultados?.ignorados?.length
                ? STATE.resultados.ignorados.map((x, i) => `${i + 1}. ${x.hora} | ${x.senha} | ${x.nome} | ${x.motivo || 'Ficha indisponível'}`)
                : ['Nenhum.']),
            '',
            '===== FALHAS =====',
            ...(STATE.resultados?.falhas?.length
                ? STATE.resultados.falhas.map((x, i) => `${i + 1}. ${x.hora} | ${x.senha} | ${x.nome} | ${x.erro || 'Erro não informado'}`)
                : ['Nenhuma.']),
            '',
            '===== LOG TÉCNICO =====',
            ...STATE.logs
        ].join('\n');

        try {
            await navigator.clipboard.writeText(texto);
        } catch {
            const area = document.createElement('textarea');
            area.value = texto;
            document.body.appendChild(area);
            area.select();
            document.execCommand('copy');
            area.remove();
        }
        mostrarStatus('Log copiado. Pode me enviar.', 'sucesso');
    }

    function adicionarCSS() {
        const style = document.createElement('style');
        style.textContent = `
            #om30-cleaner{position:fixed;right:22px;top:92px;width:420px;max-height:calc(100vh - 115px);background:#fff;border:1px solid #dce3eb;border-radius:12px;box-shadow:0 12px 35px rgba(20,35,50,.20);overflow:hidden;z-index:9999999;font-family:Arial,sans-serif;color:#29384a}
            #om30-cleaner *{box-sizing:border-box}
            .om30-header{height:58px;background:#223b5b;color:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 15px}
            .om30-header strong{display:block;font-size:14px}.om30-header small{opacity:.72;font-size:10px}
            #om30-minimizar{border:0;background:transparent;color:#fff;font-size:22px;cursor:pointer}
            #om30-body{padding:14px;max-height:calc(100vh - 175px);overflow-y:auto}
            .om30-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}
            .om30-field label{display:block;font-size:10px;font-weight:bold;text-transform:uppercase;color:#728096;margin-bottom:4px}
            .om30-field input{width:100%;height:38px;border:1px solid #ccd5df;border-radius:7px;padding:0 9px;background:#fff}
            .om30-rule{margin-top:10px;padding:9px 10px;border-radius:7px;background:#f5f7fa;border:1px solid #e1e6ec;font-size:11px;line-height:1.55}
            .om30-rule .interno{font-weight:700;color:#315b43}
            .om30-message{margin-top:10px;min-height:39px;padding:9px 10px;border-radius:7px;border:1px solid #e0e5eb;background:#f8f9fb;font-size:11px;line-height:1.45}
            .om30-message.sucesso{background:#eef7f0;border-color:#bfd9c3}.om30-message.erro{background:#fff0f0;border-color:#e3bbbb}.om30-message.aviso{background:#fff8e9;border-color:#dfcfa5}.om30-message.carregando{background:#eef4fa;border-color:#bfd1e5}
            .om30-actions{display:grid;grid-template-columns:1fr 1.35fr;gap:8px;margin-top:9px}.om30-actions button{height:38px;border-radius:7px;cursor:pointer;font-size:11px;font-weight:bold}
            #om30-preview{border:1px solid #91a4bb;background:#fff;color:#304b69}#om30-executar{border:1px solid #304f74;background:#304f74;color:#fff}.om30-actions button:disabled{opacity:.45;cursor:not-allowed}
            #om30-resumo{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:9px}.om30-summary-card{padding:7px;text-align:center;background:#f5f7fa;border:1px solid #e2e7ec;border-radius:7px}.om30-summary-card b{display:block;font-size:17px}.om30-summary-card span{display:block;font-size:9px;color:#788493}
            #om30-lista{margin-top:8px;max-height:220px;overflow:auto}.om30-item{display:grid;grid-template-columns:48px 62px 1fr;align-items:center;gap:7px;min-height:34px;border-bottom:1px solid #edf0f3;font-size:10px}.om30-item .hora{font-weight:bold}.om30-item .senha{background:#edf1f5;text-align:center;border-radius:4px;padding:3px;font-weight:bold}.om30-item .nome{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
            #om30-resultados{margin-top:10px;border:1px solid #dfe5eb;border-radius:8px;background:#fff;overflow:hidden}.om30-resultados-titulo{padding:8px 10px;font-size:11px;font-weight:700;background:#f4f6f8;border-bottom:1px solid #e1e6ec}.om30-resultados-contadores{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;padding:7px}.om30-resultados-contadores span{padding:6px 4px;border-radius:6px;text-align:center;font-size:9px}.om30-resultados-contadores .ok{background:#edf7ef;color:#376342}.om30-resultados-contadores .skip{background:#fff7e6;color:#755d24}.om30-resultados-contadores .fail{background:#fff0f0;color:#864444}.om30-resultado-grupo{border-top:1px solid #edf0f3;padding:0 8px}.om30-resultado-grupo summary{padding:7px 0;cursor:pointer;font-size:10px;font-weight:700}.om30-resultado-item{padding:7px 0;border-top:1px solid #f0f2f4}.om30-resultado-principal{display:grid;grid-template-columns:44px 60px 1fr;gap:6px;align-items:center;font-size:10px}.om30-resultado-principal .hora{font-weight:700}.om30-resultado-principal .senha{font-weight:700}.om30-resultado-principal .nome{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.om30-resultado-detalhe{padding:3px 0 0 110px;font-size:9px;color:#738092}.om30-resultado-item.sucesso .senha{color:#2f7041}.om30-resultado-item.ignorado .senha{color:#82671f}.om30-resultado-item.falha .senha{color:#9b3d3d}
            .om30-details{border-top:1px solid #e1e6ec;margin-top:10px;padding-top:9px}.om30-details summary{cursor:pointer;font-size:10px;font-weight:bold;color:#68778a}#om30-log{height:170px;overflow:auto;padding:8px;border-radius:6px;background:#151b22;color:#dde5ed;white-space:pre-wrap;word-break:break-word;font-size:9px;line-height:1.45}
            .om30-log-actions{display:flex;gap:6px}.om30-log-actions button{flex:1;height:29px;border:1px solid #ccd5df;border-radius:6px;background:#fff;font-size:10px;cursor:pointer}
        `;
        document.head.appendChild(style);
    }

    function criarPainel() {
        if (document.querySelector('#om30-cleaner')) return;
        const dataInicial = detectarDataInicial();

        const painel = document.createElement('div');
        painel.id = 'om30-cleaner';
        painel.innerHTML = `
            <div class="om30-header">
                <div><strong>OM30 · Limpeza de Fila</strong><small>Controle de Salas · Medicação</small></div>
                <button id="om30-minimizar">−</button>
            </div>
            <div id="om30-body">
                <div class="om30-grid">
                    <div class="om30-field"><label>Data</label><input id="om30-limpeza-data" type="date" value="${brParaISO(dataInicial)}"></div>
                    <div class="om30-field"><label>Limpar até</label><input id="om30-limpeza-hora" type="time" value="04:00"></div>
                </div>
                <div class="om30-rule">
                    <span class="interno">Filtro interno:</span> Data Inicial + Data Final + Em Espera<br>
                    Sem abrir modal/calendário · somente Medicação · 00:00 até o horário escolhido<br>
                    Justificativa: “${escapeHtml(CONFIG.justificativa)}”
                </div>
                <div id="om30-status" class="om30-message">Informe o horário e clique em Prévia.</div>
                <div class="om30-actions">
                    <button id="om30-preview">Prévia</button>
                    <button id="om30-executar" disabled>Executar limpeza</button>
                </div>
                <div id="om30-resumo"></div>
                <div id="om30-lista"></div>
                <div id="om30-resultados" style="display:none"></div>
                <details class="om30-details">
                    <summary>Log técnico</summary>
                    <pre id="om30-log"></pre>
                    <div class="om30-log-actions">
                        <button id="om30-copiar-log">Copiar log</button>
                        <button id="om30-parar">Parar</button>
                    </div>
                </details>
            </div>
        `;

        document.body.appendChild(painel);
        adicionarCSS();

        document.querySelector('#om30-preview').onclick = preview;
        document.querySelector('#om30-executar').onclick = executar;
        document.querySelector('#om30-copiar-log').onclick = copiarLog;
        document.querySelector('#om30-parar').onclick = () => {
            STATE.abortar = true;
            log('AVISO', 'Parada solicitada. O próximo atendimento não será iniciado.');
        };
        document.querySelector('#om30-minimizar').onclick = () => {
            const body = document.querySelector('#om30-body');
            const fechado = body.style.display === 'none';
            body.style.display = fechado ? '' : 'none';
            document.querySelector('#om30-minimizar').textContent = fechado ? '−' : '+';
        };
        document.querySelector('#om30-limpeza-data').onchange = invalidarPreview;
        document.querySelector('#om30-limpeza-hora').onchange = invalidarPreview;

        atualizarResumo();
        renderizarResultados();
        log('INFO', `Script v${CONFIG.versao} carregado.`);
        log('INFO', `Data inicial: ${dataInicial}`);
    }

    // =========================================================
    // DEBUG NO CONSOLE
    // =========================================================

    window.OM30LimpezaSala = {
        preview,
        executar,
        copiarLog,
        aplicarFiltroInterno,
        acharControleSalaVM,
        parar() { STATE.abortar = true; },
        diagnostico() {
            const controle = acharControleSalaVM();
            const filtro = controle.$refs.filtroMunicipe;
            const cond = acharObjetoCondicoesOpcional(filtro);
            return {
                versao: CONFIG.versao,
                controle: controle.$options?.name || null,
                sala: controle.salaValorSelecionado || null,
                dataSource: controle.dataSource || null,
                filtro: filtro.$options?.name || null,
                condicoesOrigem: cond?.origem || null,
                condicoes: cond?.obj || null,
                condicoesChaves: Object.keys(cond?.obj || {}),
                paginas: totalPaginas(),
                state: STATE
            };
        },
        CONFIG,
        STATE
    };

    setTimeout(criarPainel, 900);
})();