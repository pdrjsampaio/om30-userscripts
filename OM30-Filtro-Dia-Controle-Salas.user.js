// ==UserScript==
// @name         OM30 - Filtro de Dia Controle de Salas
// @namespace    https://om30.com.br/
// @version      1.1.0
// @description  Mantém somente a Data Inicial/Data Final escolhida no filtro nativo do Controle de Salas - Medicação, inclusive após voltar da ficha.
// @author       OM30
// @match        https://guaruja.saudesimples.net/aplicacoes_medicamentos*
// @updateURL    https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Filtro-Dia-Controle-Salas.user.js
// @downloadURL  https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Filtro-Dia-Controle-Salas.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = {
        storageKey: 'om30_controle_salas_filtro_dia_v2',
        timeoutInicial: 30000,
        intervaloBusca: 250,
        atrasoAplicacao: 500,
        monitorMs: 2000,
        debug: true
    };

    const STATE = {
        aplicando: false,
        controle: null,
        fetchVM: null,
        assinaturaAplicada: ''
    };

    function log(...args) {
        if (CONFIG.debug) console.log('[OM30 FILTRO DIA]', ...args);
    }

    function warn(...args) {
        console.warn('[OM30 FILTRO DIA]', ...args);
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function nextTick(vm) {
        return new Promise(resolve => {
            if (vm && typeof vm.$nextTick === 'function') vm.$nextTick(resolve);
            else requestAnimationFrame(resolve);
        });
    }

    function normalizarChave(valor) {
        return String(valor ?? '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]/gi, '')
            .toLowerCase();
    }

    function isoValido(valor) {
        const texto = String(valor || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(texto)) return false;
        const [y, m, d] = texto.split('-').map(Number);
        const data = new Date(y, m - 1, d);
        return data.getFullYear() === y && data.getMonth() === m - 1 && data.getDate() === d;
    }

    function paraISO(valor) {
        if (!valor) return '';

        if (valor instanceof Date && !Number.isNaN(valor.getTime())) {
            const y = valor.getFullYear();
            const m = String(valor.getMonth() + 1).padStart(2, '0');
            const d = String(valor.getDate()).padStart(2, '0');
            return `${y}-${m}-${d}`;
        }

        const texto = String(valor).trim();
        if (isoValido(texto)) return texto;

        const br = texto.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        if (br) {
            const iso = `${br[3]}-${br[2]}-${br[1]}`;
            return isoValido(iso) ? iso : '';
        }

        return '';
    }

    function isoParaBR(iso) {
        if (!isoValido(iso)) return String(iso || '');
        const [y, m, d] = iso.split('-');
        return `${d}/${m}/${y}`;
    }

    function dataComo(valorAtual, iso) {
        if (valorAtual instanceof Date) return new Date(`${iso}T00:00:00`);
        return iso;
    }

    // O Saúde Simples volta para /aplicacoes_medicamentos/:id depois de salvar/cancelar.
    // Essa rota também exibe novamente o Controle de Salas.
    function paginaDaFila() {
        return /^\/aplicacoes_medicamentos(?:\/\d+)?\/?$/.test(location.pathname);
    }

    function carregarDatas() {
        try {
            const bruto = localStorage.getItem(CONFIG.storageKey);
            if (!bruto) return null;

            const obj = JSON.parse(bruto);
            const dataInicial = paraISO(obj?.dataInicial);
            const dataFinal = paraISO(obj?.dataFinal);

            if (!dataInicial || !dataFinal) return null;
            return { dataInicial, dataFinal };
        } catch {
            return null;
        }
    }

    function salvarDatas(dataInicial, dataFinal) {
        const inicial = paraISO(dataInicial);
        const final = paraISO(dataFinal);

        if (!inicial || !final) return false;

        localStorage.setItem(CONFIG.storageKey, JSON.stringify({
            dataInicial: inicial,
            dataFinal: final,
            salvoEm: new Date().toISOString()
        }));

        log(`Data salva pelo filtro nativo: ${isoParaBR(inicial)} até ${isoParaBR(final)}.`);
        return true;
    }

    function limparDatasSalvas() {
        localStorage.removeItem(CONFIG.storageKey);
        STATE.assinaturaAplicada = '';
        log('Filtro de data salvo removido.');
    }

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

    function coletarArvoreVue(raiz, limite = 250) {
        const saida = [];
        const fila = [raiz];
        const vistos = new Set();

        while (fila.length && saida.length < limite) {
            const vm = fila.shift();
            if (!vm || vistos.has(vm)) continue;

            vistos.add(vm);
            saida.push(vm);

            if (Array.isArray(vm.$children)) fila.push(...vm.$children);
        }

        return saida;
    }

    function acharControleSalaVM() {
        const seeds = [
            ...document.querySelectorAll('.atualizar-listagem, #btn_filtro_modal, .botao-chamar, .botao-atender')
        ];

        const candidatos = [];
        const vistos = new Set();

        function testar(vm) {
            if (!vm || vistos.has(vm)) return;
            vistos.add(vm);

            if (
                vm.$refs?.filtroMunicipe &&
                vm.$refs?.listagemFila &&
                typeof vm.atualizarListagemFila === 'function'
            ) {
                candidatos.push(vm);
            }
        }

        for (const seed of seeds) {
            let node = seed;
            for (let i = 0; node && i < 15; i++, node = node.parentElement) {
                const vm = node.__vue__;
                if (!vm) continue;
                subirVms(vm).forEach(testar);
            }
        }

        if (!candidatos.length) {
            for (const el of document.querySelectorAll('body *')) {
                const vm = el.__vue__;
                if (!vm) continue;
                subirVms(vm).forEach(testar);
            }
        }

        return candidatos.find(vm =>
            String(vm.salaValorSelecionado || '').includes('medicacao') ||
            String(vm.dataSource || '').includes('/aplicacoes_medicamentos')
        ) || candidatos[0] || null;
    }

    async function aguardarControleSala() {
        const inicio = Date.now();

        while (Date.now() - inicio < CONFIG.timeoutInicial) {
            if (!paginaDaFila()) return null;

            const controle = acharControleSalaVM();
            if (controle?.$refs?.filtroMunicipe && controle?.$refs?.listagemFila) {
                return controle;
            }

            await sleep(CONFIG.intervaloBusca);
        }

        return null;
    }

    function scoreCondicoes(obj) {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return -1;

        const keys = Object.keys(obj).map(normalizarChave);
        let score = 0;

        if (keys.some(k => k.includes('datainicial') || k.includes('datainicio'))) score += 10;
        if (keys.some(k => k.includes('datafinal') || k.includes('datafim'))) score += 10;

        return score;
    }

    function acharObjetoCondicoes(filtroVM) {
        const candidatos = [];
        const vistos = new Set();

        function adicionar(vm, obj) {
            if (!obj || typeof obj !== 'object' || Array.isArray(obj) || vistos.has(obj)) return;
            vistos.add(obj);
            candidatos.push({ vm, obj, score: scoreCondicoes(obj) });
        }

        for (const vm of coletarArvoreVue(filtroVM, 120)) {
            try { adicionar(vm, vm.conditions); } catch {}
            try { adicionar(vm, vm.$data?.conditions); } catch {}
            try { adicionar(vm, vm.$props?.conditions); } catch {}

            for (const container of [vm.$data, vm.$props]) {
                if (!container || typeof container !== 'object') continue;
                for (const [chave, valor] of Object.entries(container)) {
                    if (/cond|filter|filtro/i.test(chave)) adicionar(vm, valor);
                }
            }
        }

        candidatos.sort((a, b) => b.score - a.score);
        return candidatos[0] || null;
    }

    function acharChaveData(obj, tipo) {
        return Object.keys(obj || {}).find(chave => {
            const n = normalizarChave(chave);
            return tipo === 'inicial'
                ? n.includes('datainicial') || n.includes('datainicio')
                : n.includes('datafinal') || n.includes('datafim');
        }) || null;
    }

    function acharFetchVM(filtroVM) {
        return coletarArvoreVue(filtroVM, 120)
            .find(vm => typeof vm.fetchFilter === 'function') || null;
    }

    function extrairDatasAtuais(filtroVM) {
        let dataInicial = '';
        let dataFinal = '';

        const cond = acharObjetoCondicoes(filtroVM);
        if (cond && cond.score >= 20) {
            const keyInicial = acharChaveData(cond.obj, 'inicial');
            const keyFinal = acharChaveData(cond.obj, 'final');

            if (keyInicial) dataInicial = paraISO(cond.obj[keyInicial]);
            if (keyFinal) dataFinal = paraISO(cond.obj[keyFinal]);
        }

        if (dataInicial && dataFinal) return { dataInicial, dataFinal };

        for (const vm of coletarArvoreVue(filtroVM, 120)) {
            for (const container of [vm.$data, vm.$props]) {
                if (!container || typeof container !== 'object') continue;

                for (const [chave, valor] of Object.entries(container)) {
                    const n = normalizarChave(chave);

                    if (!dataInicial && (n.includes('datainicial') || n.includes('datainicio'))) {
                        dataInicial = paraISO(valor);
                    }

                    if (!dataFinal && (n.includes('datafinal') || n.includes('datafim'))) {
                        dataFinal = paraISO(valor);
                    }
                }
            }

            if (dataInicial && dataFinal) break;
        }

        return { dataInicial, dataFinal };
    }

    function setarCampo(vm, container, chave, valor) {
        try {
            if (container === vm.$data && typeof vm.$set === 'function') {
                vm.$set(container, chave, valor);
            } else {
                container[chave] = valor;
            }
            return true;
        } catch {
            return false;
        }
    }

    function aplicarDatasNosEstados(filtroVM, dataInicial, dataFinal) {
        let alterados = 0;
        const vms = coletarArvoreVue(filtroVM, 120);

        for (const vm of vms) {
            for (const container of [vm.$data, vm.$props]) {
                if (!container || typeof container !== 'object') continue;

                for (const chave of Object.keys(container)) {
                    const n = normalizarChave(chave);

                    if (n.includes('datainicial') || n.includes('datainicio')) {
                        const valor = dataComo(container[chave], dataInicial);
                        if (setarCampo(vm, container, chave, valor)) alterados++;
                    } else if (n.includes('datafinal') || n.includes('datafim')) {
                        const valor = dataComo(container[chave], dataFinal);
                        if (setarCampo(vm, container, chave, valor)) alterados++;
                    }
                }
            }
        }

        const cond = acharObjetoCondicoes(filtroVM);
        if (cond && cond.score >= 20) {
            const keyInicial = acharChaveData(cond.obj, 'inicial');
            const keyFinal = acharChaveData(cond.obj, 'final');

            if (keyInicial) {
                cond.obj[keyInicial] = dataComo(cond.obj[keyInicial], dataInicial);
                alterados++;
            }

            if (keyFinal) {
                cond.obj[keyFinal] = dataComo(cond.obj[keyFinal], dataFinal);
                alterados++;
            }
        }

        return { vms, alterados };
    }

    function instalarCapturaDoFiltro(filtroVM) {
        const fetchVM = acharFetchVM(filtroVM);
        if (!fetchVM) return null;
        if (fetchVM.__om30FiltroDiaV110) return fetchVM;

        const original = fetchVM.fetchFilter;

        fetchVM.fetchFilter = function (...args) {
            const retorno = original.apply(this, args);

            const capturarDepois = () => {
                setTimeout(() => {
                    try {
                        if (STATE.aplicando) return;

                        const datas = extrairDatasAtuais(filtroVM);

                        if (datas.dataInicial && datas.dataFinal) {
                            salvarDatas(datas.dataInicial, datas.dataFinal);
                            STATE.assinaturaAplicada = `${datas.dataInicial}|${datas.dataFinal}|${fetchVM._uid ?? ''}`;
                        } else if (!datas.dataInicial && !datas.dataFinal) {
                            limparDatasSalvas();
                        }
                    } catch (erro) {
                        warn('Não foi possível guardar a data escolhida no filtro.', erro);
                    }
                }, 80);
            };

            if (retorno && typeof retorno.then === 'function') {
                return retorno.then(
                    resultado => {
                        capturarDepois();
                        return resultado;
                    },
                    erro => Promise.reject(erro)
                );
            }

            capturarDepois();
            return retorno;
        };

        fetchVM.__om30FiltroDiaV110 = true;
        fetchVM.__om30FiltroDiaOriginal = original;

        log('Captura instalada no filtro nativo do Saúde Simples.');
        return fetchVM;
    }

    async function reaplicarDatasSalvas(controle, forcar = false) {
        if (STATE.aplicando) return;

        const salvo = carregarDatas();
        if (!salvo) {
            log('Nenhuma data salva ainda. Selecione normalmente pelo filtro do sistema.');
            return;
        }

        const filtroVM = controle?.$refs?.filtroMunicipe;
        if (!filtroVM) return;

        const fetchVM = instalarCapturaDoFiltro(filtroVM);
        if (!fetchVM) {
            warn('fetchFilter() ainda não disponível.');
            return;
        }

        const assinatura = `${salvo.dataInicial}|${salvo.dataFinal}|${fetchVM._uid ?? ''}`;
        if (!forcar && STATE.assinaturaAplicada === assinatura) return;

        STATE.aplicando = true;

        try {
            const preparado = aplicarDatasNosEstados(filtroVM, salvo.dataInicial, salvo.dataFinal);
            if (!preparado.alterados) {
                throw new Error('Campos internos de Data Inicial/Data Final não encontrados.');
            }

            for (const vm of preparado.vms) await nextTick(vm);
            await sleep(CONFIG.atrasoAplicacao);

            const retorno = fetchVM.fetchFilter();
            if (retorno && typeof retorno.then === 'function') await retorno;

            STATE.assinaturaAplicada = assinatura;
            STATE.controle = controle;
            STATE.fetchVM = fetchVM;

            log(`Data restaurada automaticamente: ${isoParaBR(salvo.dataInicial)} até ${isoParaBR(salvo.dataFinal)}.`);
        } catch (erro) {
            warn('Falha ao restaurar o filtro de data.', erro);
        } finally {
            STATE.aplicando = false;
        }
    }

    async function iniciar() {
        if (!paginaDaFila()) return;

        const controle = await aguardarControleSala();
        if (!controle) {
            warn('Controle de Salas não ficou disponível dentro do tempo esperado.');
            return;
        }

        const filtroVM = controle.$refs.filtroMunicipe;
        const fetchVM = instalarCapturaDoFiltro(filtroVM);

        STATE.controle = controle;
        STATE.fetchVM = fetchVM;

        // Só restaura se já houver uma data escolhida anteriormente pelo usuário.
        // Na primeira utilização não define data nenhuma automaticamente.
        await reaplicarDatasSalvas(controle, true);

        setInterval(async () => {
            if (!paginaDaFila() || STATE.aplicando) return;

            const atual = acharControleSalaVM();
            const filtroAtual = atual?.$refs?.filtroMunicipe;
            if (!atual || !filtroAtual) return;

            const fetchAtual = acharFetchVM(filtroAtual);
            if (!fetchAtual) return;

            if (fetchAtual !== STATE.fetchVM || !fetchAtual.__om30FiltroDiaV110) {
                STATE.assinaturaAplicada = '';
                STATE.controle = atual;
                STATE.fetchVM = instalarCapturaDoFiltro(filtroAtual);
                await reaplicarDatasSalvas(atual, true);
            }
        }, CONFIG.monitorMs);
    }

    window.OM30FiltroDia = {
        get salvo() {
            return carregarDatas();
        },
        limpar() {
            limparDatasSalvas();
        },
        reaplicar() {
            const controle = acharControleSalaVM();
            if (controle) return reaplicarDatasSalvas(controle, true);
        }
    };

    iniciar();
})();
