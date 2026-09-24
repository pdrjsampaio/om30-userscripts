// ==UserScript==
// @name         OM30 - Filtro de Dia Controle de Salas
// @namespace    https://om30.com.br/
// @version      1.0.0
// @description  Mantém automaticamente o filtro de Data Inicial/Data Final no Controle de Salas - Medicação, inclusive após voltar da ficha.
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
        storageKey: 'om30_controle_salas_filtro_dia_v1',
        timeoutInicial: 30000,
        intervaloBusca: 250,
        reaplicarAposMs: 300,
        debug: true
    };

    const STATE = {
        aplicando: false,
        ultimoFiltroAplicado: '',
        fetchVMAtual: null,
        controleAtual: null
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

    function proximoTick(vm) {
        return new Promise(resolve => {
            if (vm && typeof vm.$nextTick === 'function') vm.$nextTick(resolve);
            else requestAnimationFrame(() => resolve());
        });
    }

    function normalizarChave(valor) {
        return String(valor ?? '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]/gi, '')
            .toLowerCase();
    }

    function hojeISO() {
        const d = new Date();
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    }

    function isoValido(valor) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(valor || ''))) return false;
        const [y, m, d] = String(valor).split('-').map(Number);
        const dt = new Date(y, m - 1, d);
        return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
    }

    function isoParaBR(iso) {
        if (!isoValido(iso)) return iso || '';
        const [y, m, d] = iso.split('-');
        return `${d}/${m}/${y}`;
    }

    function valorDataParaISO(valor) {
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

    function dataComo(valorAtual, iso) {
        if (valorAtual instanceof Date) return new Date(`${iso}T00:00:00`);
        return iso;
    }

    function paginaDaFila() {
        return location.pathname === '/aplicacoes_medicamentos' ||
               location.pathname === '/aplicacoes_medicamentos/';
    }

    function carregarFiltroSalvo() {
        try {
            const bruto = localStorage.getItem(CONFIG.storageKey);
            if (!bruto) return null;
            const obj = JSON.parse(bruto);
            const inicial = valorDataParaISO(obj?.dataInicial);
            const final = valorDataParaISO(obj?.dataFinal);
            if (!inicial || !final) return null;
            return { dataInicial: inicial, dataFinal: final };
        } catch {
            return null;
        }
    }

    function salvarFiltro(dataInicial, dataFinal) {
        const inicial = valorDataParaISO(dataInicial);
        const final = valorDataParaISO(dataFinal);
        if (!inicial || !final) return false;
        const novo = {
            dataInicial: inicial,
            dataFinal: final,
            salvoEm: new Date().toISOString()
        };
        localStorage.setItem(CONFIG.storageKey, JSON.stringify(novo));
        log(`Filtro salvo: ${isoParaBR(inicial)} até ${isoParaBR(final)}.`);
        return true;
    }

    function filtroPadrao() {
        const hoje = hojeISO();
        return { dataInicial: hoje, dataFinal: hoje };
    }

    function obterFiltroParaAplicar() {
        const salvo = carregarFiltroSalvo();
        if (salvo) return salvo;
        const padrao = filtroPadrao();
        salvarFiltro(padrao.dataInicial, padrao.dataFinal);
        return padrao;
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

    function coletarArvoreVue(raiz, limite = 300) {
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
                    ) candidatos.push(x);
                }
            }
        }
        if (!candidatos.length) {
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
        return candidatos.find(vm =>
            String(vm.salaValorSelecionado || '').includes('medicacao') ||
            String(vm.dataSource || '').includes('/aplicacoes_medicamentos')
        ) || candidatos[0] || null;
    }

    async function aguardarControleSala() {
        const inicio = Date.now();
        while (Date.now() - inicio < CONFIG.timeoutInicial) {
            const controle = acharControleSalaVM();
            if (controle?.$refs?.filtroMunicipe && controle?.$refs?.listagemFila) return controle;
            await sleep(CONFIG.intervaloBusca);
        }
        return null;
    }

    function scoreObjetoCondicoes(obj) {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return -1;
        const keys = Object.keys(obj).map(normalizarChave);
        let score = 0;
        if (keys.some(k => k.includes('datainicial') || k.includes('datainicio'))) score += 10;
        if (keys.some(k => k.includes('datafinal') || k.includes('datafim'))) score += 10;
        if (keys.some(k => k.includes('status'))) score += 1;
        if (keys.some(k => k.includes('profissional'))) score += 1;
        return score;
    }

    function acharObjetoCondicoes(filtroVM) {
        const candidatos = [];
        const vistos = new Set();
        function adicionar(vm, origem, obj) {
            if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
            if (vistos.has(obj)) return;
            vistos.add(obj);
            candidatos.push({ vm, origem, obj, score: scoreObjetoCondicoes(obj) });
        }
        for (const vm of coletarArvoreVue(filtroVM, 120)) {
            try { adicionar(vm, 'vm.conditions', vm.conditions); } catch {}
            try { adicionar(vm, '$data.conditions', vm.$data?.conditions); } catch {}
            try { adicionar(vm, '$props.conditions', vm.$props?.conditions); } catch {}
            for (const container of [vm.$data, vm.$props]) {
                if (!container || typeof container !== 'object') continue;
                for (const [k, v] of Object.entries(container)) {
                    if (/cond|filter|filtro/i.test(k)) adicionar(vm, k, v);
                }
            }
        }
        candidatos.sort((a, b) => b.score - a.score);
        return candidatos[0] || null;
    }

    function acharChaveData(obj, tipo) {
        const keys = Object.keys(obj || {});
        if (tipo === 'inicial') {
            return keys.find(k => {
                const n = normalizarChave(k);
                return n.includes('datainicial') || n.includes('datainicio');
            }) || null;
        }
        return keys.find(k => {
            const n = normalizarChave(k);
            return n.includes('datafinal') || n.includes('datafim');
        }) || null;
    }

    function setarCampoReativo(vm, chave, valor) {
        try {
            if (
                typeof vm.$set === 'function' &&
                vm.$data &&
                Object.prototype.hasOwnProperty.call(vm.$data, chave)
            ) vm.$set(vm.$data, chave, valor);
            vm[chave] = valor;
            return true;
        } catch {
            return false;
        }
    }

    function setarDatasNosComponentes(filtroVM, dataInicial, dataFinal) {
        const vms = coletarArvoreVue(filtroVM, 120);
        let alterados = 0;
        for (const vm of vms) {
            const data = vm.$data;
            if (!data || typeof data !== 'object') continue;
            for (const chave of Object.keys(data)) {
                const n = normalizarChave(chave);
                if (n.includes('datainicial') || n.includes('datainicio')) {
                    if (setarCampoReativo(vm, chave, dataComo(data[chave], dataInicial))) alterados++;
                } else if (n.includes('datafinal') || n.includes('datafim')) {
                    if (setarCampoReativo(vm, chave, dataComo(data[chave], dataFinal))) alterados++;
                }
            }
        }
        const cond = acharObjetoCondicoes(filtroVM);
        if (cond && cond.score >= 10) {
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

    function acharFetchVM(filtroVM) {
        return coletarArvoreVue(filtroVM, 120)
            .find(vm => typeof vm.fetchFilter === 'function') || null;
    }

    function extrairDatasAtuais(filtroVM) {
        let inicial = '';
        let final = '';
        const vms = coletarArvoreVue(filtroVM, 120).sort((a, b) => {
            const an = String(a?.$options?.name || '');
            const bn = String(b?.$options?.name || '');
            const ap = an.includes('custom-filter-with-modal') ? 1 : 0;
            const bp = bn.includes('custom-filter-with-modal') ? 1 : 0;
            return bp - ap;
        });
        for (const vm of vms) {
            const data = vm.$data;
            if (!data || typeof data !== 'object') continue;
            for (const [chave, valor] of Object.entries(data)) {
                const n = normalizarChave(chave);
                if (!inicial && (n.includes('datainicial') || n.includes('datainicio'))) {
                    inicial = valorDataParaISO(valor);
                }
                if (!final && (n.includes('datafinal') || n.includes('datafim'))) {
                    final = valorDataParaISO(valor);
                }
            }
            if (inicial && final) break;
        }
        if (!inicial || !final) {
            const cond = acharObjetoCondicoes(filtroVM);
            if (cond && cond.score >= 10) {
                const keyInicial = acharChaveData(cond.obj, 'inicial');
                const keyFinal = acharChaveData(cond.obj, 'final');
                if (!inicial && keyInicial) inicial = valorDataParaISO(cond.obj[keyInicial]);
                if (!final && keyFinal) final = valorDataParaISO(cond.obj[keyFinal]);
            }
        }
        return { dataInicial: inicial, dataFinal: final };
    }

    function instalarPersistencia(filtroVM) {
        const fetchVM = acharFetchVM(filtroVM);
        if (!fetchVM) return null;
        if (fetchVM.__om30FiltroDiaInstalado) return fetchVM;
        const original = fetchVM.fetchFilter;
        fetchVM.fetchFilter = function (...args) {
            try {
                const datas = extrairDatasAtuais(filtroVM);
                if (datas.dataInicial && datas.dataFinal) salvarFiltro(datas.dataInicial, datas.dataFinal);
            } catch (erro) {
                warn('Não foi possível salvar a data escolhida.', erro);
            }
            return original.apply(this, args);
        };
        fetchVM.__om30FiltroDiaInstalado = true;
        fetchVM.__om30FiltroDiaOriginal = original;
        log('Persistência instalada no fetchFilter() nativo.');
        return fetchVM;
    }

    async function aplicarFiltroSalvo(controle, forcar = false) {
        if (STATE.aplicando) return;
        const filtroVM = controle?.$refs?.filtroMunicipe;
        if (!filtroVM) return;
        const fetchVM = instalarPersistencia(filtroVM);
        if (!fetchVM) {
            warn('fetchFilter() ainda não disponível.');
            return;
        }
        const filtro = obterFiltroParaAplicar();
        const assinatura = `${filtro.dataInicial}|${filtro.dataFinal}|${fetchVM._uid ?? ''}`;
        if (!forcar && STATE.ultimoFiltroAplicado === assinatura) return;
        STATE.aplicando = true;
        try {
            const preparado = setarDatasNosComponentes(filtroVM, filtro.dataInicial, filtro.dataFinal);
            if (!preparado.alterados) throw new Error('Campos internos de Data Inicial/Data Final não encontrados.');
            for (const vm of preparado.vms) await proximoTick(vm);
            await sleep(CONFIG.reaplicarAposMs);
            const retorno = fetchVM.fetchFilter();
            if (retorno && typeof retorno.then === 'function') await retorno;
            STATE.ultimoFiltroAplicado = assinatura;
            STATE.fetchVMAtual = fetchVM;
            STATE.controleAtual = controle;
            log(`Filtro reaplicado automaticamente: ${isoParaBR(filtro.dataInicial)} até ${isoParaBR(filtro.dataFinal)}.`);
        } catch (erro) {
            warn('Falha ao reaplicar o filtro do dia.', erro);
        } finally {
            STATE.aplicando = false;
        }
    }

    async function iniciarNaFila() {
        if (!paginaDaFila()) return;
        const controle = await aguardarControleSala();
        if (!controle) {
            warn('Controle de Salas não ficou disponível dentro do tempo esperado.');
            return;
        }
        await aplicarFiltroSalvo(controle, true);
        setInterval(async () => {
            if (!paginaDaFila() || STATE.aplicando) return;
            const atual = acharControleSalaVM();
            const filtroVM = atual?.$refs?.filtroMunicipe;
            if (!atual || !filtroVM) return;
            const fetchVM = acharFetchVM(filtroVM);
            if (!fetchVM) return;
            if (fetchVM !== STATE.fetchVMAtual || !fetchVM.__om30FiltroDiaInstalado) {
                instalarPersistencia(filtroVM);
                STATE.ultimoFiltroAplicado = '';
                await aplicarFiltroSalvo(atual, true);
            }
        }, 2000);
    }

    window.OM30FiltroDia = {
        get salvo() {
            return carregarFiltroSalvo();
        },
        usarHoje() {
            const hoje = hojeISO();
            salvarFiltro(hoje, hoje);
            STATE.ultimoFiltroAplicado = '';
            if (paginaDaFila()) {
                const controle = acharControleSalaVM();
                if (controle) aplicarFiltroSalvo(controle, true);
            }
        },
        definir(dataInicial, dataFinal = dataInicial) {
            if (!isoValido(dataInicial) || !isoValido(dataFinal)) {
                throw new Error('Use a data no formato AAAA-MM-DD.');
            }
            salvarFiltro(dataInicial, dataFinal);
            STATE.ultimoFiltroAplicado = '';
            if (paginaDaFila()) {
                const controle = acharControleSalaVM();
                if (controle) aplicarFiltroSalvo(controle, true);
            }
        }
    };

    iniciarNaFila();
})();
