// ==UserScript==
// @name         OM30 - WhatsApp → GLPI
// @namespace    om30
// @version      0.8.8
// @updateURL    https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-WhatsApp-GLPI.user.js
// @downloadURL  https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-WhatsApp-GLPI.user.js
// @description  WhatsApp → GLPI: Guarujá padrão, operação salva, unidades direcionadas por município, fila e motor silencioso
// @match        https://web.whatsapp.com/*
// @match        https://suporte.om30.cloud/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        unsafeWindow
// @connect      suporte.om30.cloud
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';


    // ============================================================
    // INTEGRAÇÃO GLPI - MODO TESTE (NUNCA PUBLICA)
    // ============================================================

    const GLPI_TEST = {
        base: 'https://suporte.om30.cloud',
        jobKey: 'OM30_GLPI_JOB_V0800',
        resultKey: 'OM30_GLPI_LAST_RESULT_V0714',
        queueKey: 'OM30_GLPI_QUEUE_V0800'
    };

    const GLPI_BACKGROUND_WINDOW_NAME = 'OM30_GLPI_BACKGROUND';
    const GLPI_LOGIN_WINDOW_NAME = 'OM30_GLPI_LOGIN';
    let glpiBackgroundTabHandle = null;
    let glpiLoginWindowHandle = null;

    // Quando a aba inativa nasce com ?om30_bg=1, grava um nome persistente.
    // window.name sobrevive às navegações internas ticket.form.php?id=..., então
    // conseguimos reconhecer o motor de background até o fim do fluxo.
    try {
        if (
            location.hostname === 'suporte.om30.cloud' &&
            new URL(location.href).searchParams.get('om30_bg') === '1'
        ) {
            window.name = GLPI_BACKGROUND_WINDOW_NAME;
        }
    } catch {}

    function isGlpiBackgroundContext() {
        try {
            if (location.hostname !== 'suporte.om30.cloud') return false;
            const byUrl = new URL(location.href).searchParams.get('om30_bg') === '1';
            return window.name === GLPI_BACKGROUND_WINDOW_NAME || byUrl;
        } catch {
            return false;
        }
    }

    function isGlpiLoginHelperContext() {
        try {
            const helperByUrl =
                new URL(location.href).searchParams.get('om30_login_helper') === '1';

            return (
                location.hostname === 'suporte.om30.cloud' &&
                window.self === window.top &&
                (window.name === GLPI_LOGIN_WINDOW_NAME || helperByUrl)
            );
        } catch {
            return false;
        }
    }

    function closeGlpiBackgroundTab() {
        const handle = glpiBackgroundTabHandle;
        glpiBackgroundTabHandle = null;

        if (!handle) return;

        try {
            if (typeof handle.close === 'function') {
                handle.close();
                console.log('OM30: aba GLPI de background fechada.');
            }
        } catch (error) {
            console.warn('OM30: não consegui fechar a aba GLPI de background', error);
        }
    }

    function startGlpiBackgroundTab(forceReload = false) {
        // v0.8.0: DESATIVADO de propósito.
        // O motor real roda por GM_xmlhttpRequest a partir do WhatsApp.
        // GLPI só abre de forma visível quando o usuário pede login ou consulta.
        console.warn('OM30 v0.8.0: abertura automática de aba GLPI bloqueada.');
        return false;
    }

    function openGlpiLoginWindow(url) {
        const target = url || glpiLoginUrl();

        try {
            const win = window.open(target, GLPI_LOGIN_WINDOW_NAME);
            if (win) {
                glpiLoginWindowHandle = win;
                try { win.focus(); } catch {}
                return { opened: true, mode: 'window.open', handle: win };
            }
        } catch (error) {
            console.warn('OM30: window.open do login falhou', error);
        }

        try {
            const tab = GM_openInTab(target, {
                active: true,
                insert: true,
                setParent: true
            });
            glpiLoginWindowHandle = tab || null;
            return { opened: true, mode: 'GM_openInTab', handle: tab || null };
        } catch (error) {
            console.error('OM30: não consegui abrir o login do GLPI', error);
            return { opened: false, mode: 'failed', handle: null };
        }
    }

    const glpiSleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const glpiNormalize = value => String(value || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toUpperCase().replace(/[^A-Z0-9]+/g, ' ')
        .replace(/\s+/g, ' ').trim();

    function readGlpiJob() {
        try {
            const raw = GM_getValue(GLPI_TEST.jobKey, '');
            return raw ? JSON.parse(raw) : null;
        } catch (error) {
            console.error('OM30: erro lendo job GLPI', error);
            return null;
        }
    }

    function saveGlpiJob(job) {
        GM_setValue(GLPI_TEST.jobKey, JSON.stringify(job));
    }


    // ============================================================
    // FILA DE CHAMADOS
    //
    // O WhatsApp pode montar/enfileirar novos chamados enquanto o
    // primeiro ainda está sendo enviado. O motor GLPI processa um por
    // vez para evitar colisão de CSRF/upload, mas a interface nunca fica
    // bloqueada esperando o chamado anterior terminar.
    // ============================================================

    function readGlpiQueue() {
        try {
            const raw = GM_getValue(GLPI_TEST.queueKey, '[]');
            const parsed = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            console.error('OM30: erro lendo fila GLPI', error);
            return [];
        }
    }

    function saveGlpiQueue(queue) {
        GM_setValue(GLPI_TEST.queueKey, JSON.stringify(Array.isArray(queue) ? queue : []));
    }

    function enqueueGlpiJob(job) {
        const active = readGlpiJob();
        if (!active) {
            saveGlpiJob(job);
            return { started: true, position: 0, queued: 0 };
        }

        const queue = readGlpiQueue();
        queue.push(job);
        saveGlpiQueue(queue);
        return { started: false, position: queue.length, queued: queue.length };
    }

    function activateNextGlpiQueuedJob() {
        if (readGlpiJob()) return null;
        const queue = readGlpiQueue();
        if (!queue.length) return null;

        const next = queue.shift();
        saveGlpiQueue(queue);
        saveGlpiJob(next);
        return next;
    }

    function glpiHasPendingWork() {
        return !!readGlpiJob() || readGlpiQueue().length > 0;
    }

    function readGlpiResult() {
        try {
            const raw = GM_getValue(GLPI_TEST.resultKey, '');
            return raw ? JSON.parse(raw) : null;
        } catch (error) {
            console.error('OM30: erro lendo resultado GLPI', error);
            return null;
        }
    }

    function saveGlpiResult(result) {
        GM_setValue(GLPI_TEST.resultKey, JSON.stringify(result));
    }

    function pageWindow() {
        try {
            return typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        } catch {
            return window;
        }
    }

    function ensureGlpiBanner(text, kind = 'info') {
        let box = document.getElementById('om30-glpi-test-banner');
        if (!box) {
            box = document.createElement('div');
            box.id = 'om30-glpi-test-banner';
            box.style.cssText = [
                'position:fixed','top:12px','left:50%','transform:translateX(-50%)',
                'z-index:2147483647','width:min(760px,calc(100vw - 30px))',
                'padding:13px 16px','border-radius:12px','font:14px Segoe UI,Arial,sans-serif',
                'box-shadow:0 12px 36px rgba(0,0,0,.24)','color:#fff','font-weight:600'
            ].join(';');
            document.documentElement.appendChild(box);
        }
        const colors = {
            info: '#004080', success: '#176B47', warning: '#9A5D00', error: '#9B1C1C'
        };
        box.style.background = colors[kind] || colors.info;
        const activeJob = readGlpiJob();
        const publishMode = activeJob?.mode === 'publish';
        box.innerHTML = `<b>${publishMode ? 'OM30 • GLPI — PUBLICAÇÃO DE TESTE' : 'OM30 • TESTE GLPI — NÃO PUBLICAR'}</b><br><span style="font-weight:400">${text}</span>`;
        return box;
    }

    function blockGlpiPublish() {
        const form = document.querySelector('#itil-form');
        const add = document.querySelector('#itil-form button[type="submit"][name="add"]');

        if (add) {
            add.disabled = true;
            add.setAttribute('aria-disabled', 'true');
            add.title = 'Bloqueado pelo modo teste OM30. Nenhum chamado será publicado.';
            add.style.opacity = '.45';
            add.style.cursor = 'not-allowed';
        }

        if (form && !form.dataset.om30DryRunBlocked) {
            form.dataset.om30DryRunBlocked = '1';
            form.addEventListener('submit', event => {
                const job = readGlpiJob();
                if (!job || job.mode !== 'dry-run') return;
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();
                ensureGlpiBanner('Publicação bloqueada. Este teste serve somente para conferir o preenchimento.', 'warning');
                alert('OM30: publicação bloqueada porque estamos no MODO TESTE.');
            }, true);
        }
    }

    function unblockGlpiPublish() {
        const form = document.querySelector('#itil-form');
        const add = document.querySelector('#itil-form button[type="submit"][name="add"]');

        if (form) {
            delete form.dataset.om30DryRunBlocked;
        }

        if (add) {
            add.disabled = false;
            add.removeAttribute('aria-disabled');
            add.title = 'Publicar chamado de teste';
            add.style.opacity = '';
            add.style.cursor = '';
        }

        return { form, add };
    }

    function currentTicketEditId() {
        // Esta função responde SOMENTE:
        // "estou realmente na tela de edição ticket.form.php?id=XXXXX?"
        try {
            const url = new URL(location.href);

            if (!url.pathname.endsWith('/front/ticket.form.php')) {
                return null;
            }

            const id = url.searchParams.get('id');

            if (id && /^\d+$/.test(id) && Number(id) > 0) {
                return Number(id);
            }
        } catch {}

        return null;
    }

    function extractTicketIdFromUrl(value) {
        try {
            const url = new URL(value, location.origin);
            const id = url.searchParams.get('id');

            if (
                url.pathname.endsWith('/front/ticket.form.php') &&
                id &&
                /^\d+$/.test(id) &&
                Number(id) > 0
            ) {
                return Number(id);
            }
        } catch {}

        return null;
    }

    function detectCreatedTicketId() {
        // 1) Caso o GLPI tenha ido direto para a edição.
        const current = currentTicketEditId();

        if (current) {
            console.log('OM30: ID criado encontrado na URL de edição:', current);
            return current;
        }

        // 2) Prioriza mensagens/alertas de sucesso da página intermediária.
        const successAreas = [
            ...document.querySelectorAll(
                '.alert-success, .alert.alert-success, [role="alert"], .toast, .notification'
            )
        ];

        for (const area of successAreas) {
            const links = [
                ...area.querySelectorAll('a[href*="ticket.form.php?id="]')
            ];

            for (const link of links) {
                const id = extractTicketIdFromUrl(link.href);

                if (id) {
                    console.log(
                        'OM30: ID criado encontrado no aviso de sucesso:',
                        id,
                        link.href
                    );
                    return id;
                }
            }

            const text = String(area.textContent || '').replace(/\s+/g, ' ').trim();

            // Fallback textual conservador: só usa número quando o texto
            // fala explicitamente de chamado/ticket.
            if (/\b(chamado|ticket)\b/i.test(text)) {
                const matches = [...text.matchAll(/\b(\d{4,})\b/g)];

                if (matches.length === 1) {
                    const id = Number(matches[0][1]);

                    if (id > 0) {
                        console.log(
                            'OM30: ID criado encontrado no texto de sucesso:',
                            id,
                            text
                        );
                        return id;
                    }
                }
            }
        }

        // 3) Fallback: links da página intermediária apontando para ticket.form.php?id=...
        const links = [
            ...document.querySelectorAll('a[href*="ticket.form.php?id="]')
        ];

        const ids = [];

        for (const link of links) {
            const id = extractTicketIdFromUrl(link.href);

            if (id) {
                ids.push({
                    id,
                    href: link.href,
                    text: String(link.textContent || '').trim()
                });
            }
        }

        if (ids.length === 1) {
            console.log('OM30: ID criado encontrado em link único:', ids[0]);
            return ids[0].id;
        }

        if (ids.length > 1) {
            // Dá preferência a link cujo texto indique criação/visualização do chamado.
            const contextual = ids.find(item =>
                /\b(chamado|ticket|visualizar|ver|abrir)\b/i.test(item.text)
            );

            if (contextual) {
                console.log(
                    'OM30: ID criado encontrado em link contextual:',
                    contextual
                );
                return contextual.id;
            }

            console.warn(
                'OM30: encontrei vários IDs de chamado e não vou adivinhar:',
                ids
            );
        }

        return null;
    }

    function isGlpiLoginPage() {
        try {
            const path = String(location.pathname || '').toLowerCase();

            if (
                path.includes('/front/login.php') ||
                path.endsWith('/login.php')
            ) {
                return true;
            }
        } catch {}

        return !!(
            document.querySelector('input[type="password"]') &&
            !document.querySelector('#itil-form')
        );
    }

    function glpiLoginUrl() {
        const target =
            `${GLPI_TEST.base}/front/ticket.form.php?om30_login_helper=1`;

        try {
            const url = new URL(`${GLPI_TEST.base}/front/login.php`);
            url.searchParams.set('redirect', target);
            return url.href;
        } catch {
            return GLPI_TEST.base;
        }
    }

    function saveGlpiLoginRequired(job, reason = '') {
        const loginUrl = glpiLoginUrl();

        saveGlpiResult({
            kind: 'login-required',
            status: 'login-required',
            login_url: loginUrl,
            title: 'Login no GLPI necessário',
            message:
                reason ||
                'Entre no GLPI para continuar a criação do chamado.',
            job_id: job?.id || '',
            at: new Date().toISOString()
        });

        return loginUrl;
    }

    function saveGlpiBackgroundFailure(job, step, error) {
        if (!isGlpiBackgroundContext()) return;

        saveGlpiResult({
            kind: 'background-error',
            status: 'error',
            title: 'Erro durante a criação no GLPI',
            message: String(error?.message || error || 'Erro desconhecido'),
            step: String(step || 'GLPI'),
            job_id: job?.id || '',
            ticket_id: job?.ticket_id || null,
            ticket_url: job?.ticket_url || '',
            at: new Date().toISOString()
        });
    }

    function looksLikeGlpiLoginHtml(html, responseUrl = '') {
        const source = String(html || '');
        const url = String(responseUrl || '').toLowerCase();

        if (
            url.includes('/front/login.php') ||
            url.endsWith('/login.php')
        ) {
            return true;
        }

        return (
            /type=["']password["']/i.test(source) &&
            !/id=["']itil-form["']/i.test(source)
        );
    }

    function detectCreatedTicketIdFromHtml(html, responseUrl = '') {
        const fromResponseUrl = extractTicketIdFromUrl(responseUrl);
        if (fromResponseUrl) return fromResponseUrl;

        const source = String(html || '');
        let doc = null;

        try {
            doc = new DOMParser().parseFromString(source, 'text/html');
        } catch {}

        if (doc) {
            const areas = [
                ...doc.querySelectorAll(
                    '.alert-success, .alert.alert-success, [role="alert"], .toast, .notification, .message_after_redirect'
                )
            ];

            for (const area of areas) {
                const links = [
                    ...area.querySelectorAll('a[href*="ticket.form.php"]')
                ];

                for (const link of links) {
                    const id = extractTicketIdFromUrl(
                        link.getAttribute('href') || link.href || ''
                    );
                    if (id) return id;
                }

                const txt = String(area.textContent || '')
                    .replace(/\s+/g, ' ')
                    .trim();

                if (/\b(chamado|ticket)\b/i.test(txt)) {
                    const ids = [...txt.matchAll(/\b(\d{4,})\b/g)]
                        .map(m => Number(m[1]))
                        .filter(x => x > 0);

                    if (ids.length === 1) return ids[0];
                }
            }

            const allLinks = [
                ...doc.querySelectorAll('a[href*="ticket.form.php"]')
            ];

            const ids = [];
            for (const link of allLinks) {
                const id = extractTicketIdFromUrl(
                    link.getAttribute('href') || link.href || ''
                );
                if (id) ids.push(id);
            }

            const unique = [...new Set(ids)];
            if (unique.length === 1) return unique[0];
        }

        const patterns = [
            /ticket\.form\.php\?[^"'<>\s]*?\bid=(\d+)/gi,
            /ticket\.form\.php\?id=(\d+)/gi,
            /ticket\.form\.php\?[^"'<>\s]*?\bid%3D(\d+)/gi
        ];

        const found = [];
        for (const regex of patterns) {
            let match;
            while ((match = regex.exec(source))) {
                const id = Number(match[1]);
                if (id > 0) found.push(id);
            }
        }

        const unique = [...new Set(found)];
        return unique.length === 1 ? unique[0] : null;
    }

    function glpiUploadMetadataSnapshot() {
        const values = selector => [
            ...document.querySelectorAll(selector)
        ].map(el => String(el.value || '').trim()).filter(Boolean);

        return {
            filenames: values('input[name^="_filename["], textarea[name^="_filename["]'),
            prefixes: values('input[name^="_prefix_filename["], textarea[name^="_prefix_filename["]'),
            tags: values('input[name^="_tag_filename["], textarea[name^="_tag_filename["]')
        };
    }

    async function waitForGlpiPrintUploadMetadata(job, timeout = 7000) {
        if (!job?.printDataUrl) {
            return {
                ready: true,
                skipped: true,
                reason: 'sem print'
            };
        }

        const started = Date.now();

        while (Date.now() - started < timeout) {
            const meta = glpiUploadMetadataSnapshot();

            if (
                meta.filenames.length &&
                meta.prefixes.length &&
                meta.tags.length
            ) {
                console.log('✅ OM30 GLPI: upload do print preparado', {
                    arquivos: meta.filenames.length,
                    tags: meta.tags.length
                });

                return {
                    ready: true,
                    filenames: meta.filenames.length,
                    prefixes: meta.prefixes.length,
                    tags: meta.tags.length
                };
            }

            await glpiSleep(100);
        }

        const finalMeta = glpiUploadMetadataSnapshot();

        throw new Error(
            'O print apareceu na descrição, mas o GLPI não terminou de gerar ' +
            '_filename/_prefix_filename/_tag_filename. Publicação interrompida para não perder a evidência.'
        );
    }

    async function publishGlpiTicket(job) {
        // TRAVA ANTIDUPLICIDADE:
        // esta função só pode sair do estágio "publish" UMA vez.
        // Antes do POST, gravamos "publishing-direct".
        if (job.stage !== 'publish') {
            return false;
        }

        const form = await waitForGlpi('#itil-form');
        const add = await waitForGlpi(
            '#itil-form button[type="submit"][name="add"], #itil-form input[type="submit"][name="add"]'
        );

        // Garante que o TinyMCE sincronizou o HTML com textarea[name=content].
        try {
            const w = pageWindow();
            const textarea = document.querySelector('textarea[name="content"]');
            const editor = textarea?.id && w.tinymce?.get?.(textarea.id);
            if (editor) editor.save();
        } catch (error) {
            console.warn('OM30: não consegui forçar editor.save() antes do POST', error);
        }

        // Confere os campos essenciais imediatamente antes de publicar.
        const title = document.querySelector('input[name="name"]')?.value?.trim();
        const content = document.querySelector('textarea[name="content"]')?.value?.trim();
        const status = document.querySelector('select[name="status"]')?.value;
        const type = document.querySelector('select[name="type"]')?.value;
        const category = document.querySelector('select[name="itilcategories_id"]')?.value;

        validateGlpiCategorySelection(
            job.data,
            job.category_expected_id || null
        );

        const unit = document.querySelector('select[name="locations_id"]')?.value;
        const solvedate = document.querySelector('input[name="solvedate"]')?.value;

        const missing = [];
        if (!title) missing.push('Título');
        if (!content) missing.push('Descrição');
        if (String(status) !== '5') missing.push('Status Solucionado');
        if (!type) missing.push('Tipo');
        if (!category) missing.push('Categoria');
        if (!unit) missing.push('Unidade');
        if (!solvedate) missing.push('Data da solução');

        if (missing.length) {
            throw new Error(
                `Publicação cancelada. Campos não confirmados: ${missing.join(', ')}`
            );
        }

        // Se existe print, só publica depois que o fluxo real do GLPI terminou:
        // fileupload.php -> getFileTag.php -> _filename/_prefix/_tag.
        const printUpload = await waitForGlpiPrintUploadMetadata(job);

        const fd = new FormData(form);

        // FormData(form) não inclui o botão que seria clicado.
        if (add?.name) {
            fd.set(add.name, add.value || 'Adicionar');
        } else {
            fd.set('add', 'Adicionar');
        }

        job.stage = 'publishing-direct';
        job.publish_attempted_at = new Date().toISOString();
        job.publish_attempts = Number(job.publish_attempts || 0) + 1;
        job.publish_method = 'POST direto ticket.form.php';
        saveGlpiJob(job);

        ensureGlpiBanner(
            'Todos os campos e o print foram conferidos. Enviando por <b>POST direto</b> uma única vez...',
            'warning'
        );

        console.log('🚀 OM30 GLPI: POST direto do chamado', {
            jobId: job.id,
            attempt: job.publish_attempts,
            title,
            status,
            type,
            category,
            unit,
            solvedate,
            printUpload,
            print: job.completed?.['Print na descrição'] || null
        });

        let response;
        try {
            response = await fetch(
                form.action || `${GLPI_TEST.base}/front/ticket.form.php`,
                {
                    method: 'POST',
                    credentials: 'include',
                    body: fd,
                    redirect: 'follow'
                }
            );
        } catch (error) {
            throw new Error(
                `Falha de rede durante o POST direto. A OM30 NÃO vai repetir automaticamente: ${error?.message || error}`
            );
        }

        const html = await response.text();

        job.direct_publish_http = response.status;
        job.direct_publish_response_url = response.url || '';
        job.direct_publish_finished_at = new Date().toISOString();
        saveGlpiJob(job);

        if (looksLikeGlpiLoginHtml(html, response.url)) {
            job.resume_stage = 'publish';
            job.stage = 'waiting-login';
            job.login_required_at = new Date().toISOString();
            saveGlpiJob(job);

            const loginUrl = saveGlpiLoginRequired(
                job,
                'Sua sessão do GLPI expirou antes da publicação. Faça login para continuar.'
            );

            ensureGlpiBanner(
                '⚠ Sua sessão do GLPI expirou. Faça login; depois a OM30 continuará.',
                'warning'
            );

            location.href = loginUrl;
            return false;
        }

        if (!response.ok) {
            throw new Error(
                `GLPI respondeu HTTP ${response.status}. O POST NÃO será repetido automaticamente.`
            );
        }

        const ticketId = detectCreatedTicketIdFromHtml(
            html,
            response.url
        );

        if (!ticketId) {
            job.direct_publish_unknown_result = true;
            saveGlpiJob(job);

            throw new Error(
                'O GLPI aceitou o POST, mas a OM30 não conseguiu identificar com segurança o ID criado. ' +
                'Por proteção contra duplicidade, NÃO haverá segunda tentativa.'
            );
        }

        const ticketUrl =
            `${GLPI_TEST.base}/front/ticket.form.php?id=${ticketId}`;

        job.ticket_id = ticketId;
        job.ticket_url = ticketUrl;
        job.published_at = new Date().toISOString();
        job.stage = 'postfix-open-ticket';
        saveGlpiJob(job);

        ensureGlpiBanner(
            `✓ Chamado <b>#${ticketId}</b> criado por POST direto. Abrindo para corrigir o <b>Atribuído</b>...`,
            'warning'
        );

        // A criação é direta, mas a correção pós-criação continua usando
        // a rotina já validada da v0.7.23: abre pelo ID, preserva usuário,
        // remove Service Desk, adiciona Sistemas <operação>, salva e valida.
        location.href = ticketUrl;
        return true;
    }

    async function waitForGlpi(selector, timeout = 20000) {
        const started = Date.now();
        while (Date.now() - started < timeout) {
            const el = document.querySelector(selector);
            if (el) return el;
            await glpiSleep(80);
        }
        throw new Error(`Campo GLPI não encontrado: ${selector}`);
    }

    function toGlpiDate(value) {
        if (!value) return '';
        const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
        if (!match) return String(value);
        return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}:${match[6] || '00'}`;
    }

    function fromInputDate(value) {
        if (!value) return null;
        const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
        if (!match) return null;
        const dt = new Date(
            Number(match[1]), Number(match[2]) - 1, Number(match[3]),
            Number(match[4]), Number(match[5]), Number(match[6] || 0)
        );
        return Number.isNaN(dt.getTime()) ? null : dt;
    }

    async function setGlpiNativeSelect(name, wanted) {
        const select = await waitForGlpi(`select[name="${name}"]`);
        const value = String(wanted);
        if (String(select.value) === value) return true;

        const option = [...select.options].find(x => String(x.value) === value);
        if (!option) throw new Error(`Valor ${wanted} não existe em ${name}`);

        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await glpiSleep(80);
        return true;
    }

    async function setGlpiSolvedStatus() {
        const status = await waitForGlpi('select[name="status"]');
        const wanted = '5';

        if (String(status.value) !== wanted) {
            const option = [...status.options].find(x => String(x.value) === wanted);
            if (!option) throw new Error('Status Solucionado (5) não existe no GLPI');

            status.value = wanted;
            status.dispatchEvent(new Event('change', { bubbles: true }));

            // Dá tempo apenas para o GLPI processar o status.
            // NÃO exigimos solvedate aqui: no fluxo real ele será procurado
            // somente depois de Tipo e Categoria.
            await glpiSleep(250);
        }

        if (String(status.value) !== wanted) {
            throw new Error('O GLPI não manteve o status Solucionado');
        }

        return true;
    }

    async function setGlpiTypeKeepingSolved(typeId) {
        await setGlpiNativeSelect('type', typeId);

        // O Tipo pode reconstruir partes do formulário.
        // Garantimos que Solucionado permaneça selecionado,
        // mas ainda não exigimos o campo Data da solução.
        const status = await waitForGlpi('select[name="status"]');

        if (String(status.value) !== '5') {
            const option = [...status.options].find(x => String(x.value) === '5');
            if (!option) throw new Error('Status Solucionado (5) não existe após selecionar o Tipo');

            status.value = '5';
            status.dispatchEvent(new Event('change', { bubbles: true }));
            await glpiSleep(250);
        }

        return true;
    }

    function flattenSelect2Results(results, parents = []) {
        const out = [];
        for (const item of results || []) {
            if (!item) continue;
            const text = String(item.text || '').trim();
            const path = [...parents, text].filter(Boolean);
            if (Array.isArray(item.children) && item.children.length) {
                out.push(...flattenSelect2Results(item.children, path));
            } else if (item.id !== undefined && item.id !== null && String(item.id) !== '') {
                out.push({
                    id: item.id,
                    text,
                    fullText: path.join(' > '),
                    raw: item
                });
            }
        }
        return out;
    }

    async function querySelect2(select, term) {
        const w = pageWindow();
        const $ = w.jQuery || w.$;
        if (!$) throw new Error('jQuery do GLPI não encontrada');

        const instance = $(select).data('select2');
        if (!instance?.dataAdapter?.query) {
            // Fallback para options já carregadas.
            return [...select.options].filter(o => o.value).map(o => ({
                id: o.value,
                text: o.textContent.trim(),
                fullText: o.textContent.trim(),
                raw: null
            }));
        }

        return await new Promise((resolve, reject) => {
            let finished = false;
            const timer = setTimeout(() => {
                if (finished) return;
                finished = true;
                reject(new Error(`Tempo esgotado consultando Select2: ${term}`));
            }, 12000);

            try {
                instance.dataAdapter.query({ term: String(term || ''), page: 1 }, data => {
                    if (finished) return;
                    finished = true;
                    clearTimeout(timer);
                    resolve(flattenSelect2Results(data?.results || []));
                });
            } catch (error) {
                clearTimeout(timer);
                reject(error);
            }
        });
    }

    function tokenOverlapScore(candidate, target) {
        const a = new Set(glpiNormalize(candidate).split(' ').filter(Boolean));
        const b = new Set(glpiNormalize(target).split(' ').filter(Boolean));
        if (!a.size || !b.size) return 0;
        let common = 0;
        for (const token of b) if (a.has(token)) common++;
        return Math.round((common / b.size) * 100);
    }

    function categoryAreaForSystem(system) {
        const s = glpiNormalize(system);

        // Estrutura real do GLPI observada nos testes.
        if (s === 'SAUDE SIMPLES') return 'SISTEMAS';

        if (
            s === 'PAINEL DE SENHA' ||
            s === 'TOTEM' ||
            s === 'IMPRESSORA'
        ) {
            return 'EQUIPAMENTOS';
        }

        return '';
    }

    function cleanCategoryText(text) {
        return glpiNormalize(
            String(text || '')
                .replace(/^[\s»›>·\-]+/g, '')
                .trim()
        );
    }

    function categoryTextMatchesExpected(text, expected) {
        const actual = cleanCategoryText(text);
        const wanted = glpiNormalize(expected);

        if (!actual || !wanted) return false;

        // Caso normal: "Erro", "Touch", "Cadastro" etc.
        if (actual === wanted) return true;

        // Alguns Select2 devolvem caminho completo no texto da option.
        // Ex.: "OM30 > TI > Equipamentos > Painel de Senha > Erro".
        const parts = actual
            .split(/\s*(?:>|»|›)\s*/)
            .map(x => x.trim())
            .filter(Boolean);

        if (parts.length && parts[parts.length - 1] === wanted) {
            return true;
        }

        // Último fallback somente para caminhos concatenados.
        return actual.endsWith(` ${wanted}`);
    }

    function annotateCategoryCandidates(items, sourceTerm, sourcePriority) {
        return (items || []).map((item, index) => ({
            ...item,
            _sourceTerm: sourceTerm,
            _sourcePriority: sourcePriority,
            _sourceIndex: index
        }));
    }

    function chooseCategoryCandidate(candidates, data) {
        const system = glpiNormalize(data.system);
        const category = glpiNormalize(data.category);
        const area = categoryAreaForSystem(data.system);

        // Só considera itens cuja própria opção seja a categoria esperada.
        // Assim "Painel de Senha" nunca pode ganhar quando queremos "Erro".
        const exact = candidates.filter(item =>
            categoryTextMatchesExpected(item.text, data.category)
        );

        const scored = exact.map(item => {
            const text = cleanCategoryText(item.text);
            const full = glpiNormalize(item.fullText || item.text || '');
            const source = glpiNormalize(item._sourceTerm || '');

            let score = 1000; // opção exata "Erro"/"Touch"/"Cadastro"

            // A busca feita pelo SISTEMA é a pista mais forte.
            // Se "Painel de Senha" devolveu "Erro", esse é o Erro que queremos.
            if (source === system) score += 500;

            // Segunda melhor pista: busca combinada.
            if (source.includes(system) && source.includes(category)) score += 350;

            // Caminho completo, quando o GLPI fornece.
            if (full.includes(system)) score += 250;
            if (area && full.includes(area)) score += 120;
            if (full.includes('OM30')) score += 30;
            if (full.includes('TI')) score += 30;

            // Evita a árvore antiga.
            if (full.includes('SENHA SIMPLES')) score -= 1000;

            // Se o caminho disser explicitamente uma área errada, penaliza.
            if (area === 'EQUIPAMENTOS' && full.includes('SISTEMAS')) score -= 250;
            if (area === 'SISTEMAS' && full.includes('EQUIPAMENTOS')) score -= 250;

            // Conserva a ordem original como desempate.
            score -= Number(item._sourceIndex || 0) / 1000;

            return {
                item,
                score,
                text,
                full,
                source
            };
        }).sort((a, b) => b.score - a.score);

        console.log('OM30 categoria: opções exatas encontradas', {
            sistema: data.system,
            categoria: data.category,
            area,
            scored
        });

        if (!scored.length) return null;

        // Segurança contra ambiguidade:
        // se existem IDs diferentes para a mesma palavra (ex.: vários "Erro"),
        // só aceita automaticamente quando a melhor opção veio da pesquisa
        // pelo sistema ou tem o sistema no caminho.
        const uniqueIds = [...new Set(
            scored.map(x => String(x.item.id))
        )];

        const best = scored[0];

        if (uniqueIds.length > 1) {
            const safelyContextualized =
                best.source === system ||
                best.source.includes(system) ||
                best.full.includes(system);

            if (!safelyContextualized) {
                console.warn(
                    'OM30: categoria ambígua, não vou escolher apenas pela palavra',
                    scored
                );
                return null;
            }
        }

        return best.item;
    }

    function chooseUnitCandidate(candidates, unit, operation) {
        const target = glpiNormalize(unit);
        const op = glpiNormalize(operation);

        const scored = candidates.map(item => {
            const text = glpiNormalize(item.fullText || item.text);
            if (/\bSISTEMAS\b/.test(text) && !target.includes('SISTEMAS')) return { item, score: -999 };

            let score = tokenOverlapScore(text, target);
            if (text === target) score += 100;
            if (text.endsWith(target)) score += 85;
            else if (text.includes(target)) score += 65;
            if (op && text.includes(op)) score += 15;

            return { item, score };
        }).sort((a, b) => b.score - a.score);

        return scored[0]?.score >= 85 ? scored[0].item : null;
    }

    function applySelect2Result(select, result, preserveExisting = false) {
        const w = pageWindow();
        const $ = w.jQuery || w.$;
        if (!result) throw new Error('Resultado Select2 vazio');

        let option = [...select.options].find(o => String(o.value) === String(result.id));
        if (!option) {
            option = new Option(result.text || result.fullText || String(result.id), result.id, true, true);
            select.appendChild(option);
        }

        if (!preserveExisting && !select.multiple) {
            for (const o of select.options) o.selected = false;
        }
        option.selected = true;

        if ($) $(select).trigger('change');
        else select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // MODO TESTE:
    // Atualiza o valor e a interface do Select2 sem disparar os handlers gerais
    // de "change" do GLPI. Algumas categorias recarregam a página inteira quando
    // recebem change normal; isso fazia o job reiniciar eternamente em "Categoria".
    function applySelect2ResultQuiet(select, result, preserveExisting = false) {
        const w = pageWindow();
        const $ = w.jQuery || w.$;
        if (!result) throw new Error('Resultado Select2 vazio');

        let option = [...select.options].find(o => String(o.value) === String(result.id));
        if (!option) {
            option = new Option(
                result.text || result.fullText || String(result.id),
                result.id,
                true,
                true
            );
            select.appendChild(option);
        }

        if (!preserveExisting) {
            if (!select.multiple) {
                for (const o of select.options) o.selected = false;
            }

            option.selected = true;
            select.value = String(result.id);
        } else {
            // IMPORTANTE:
            // Em "Atribuído" não podemos usar select.value = grupo,
            // porque num select simples isso remove visualmente o usuário já atribuído.
            // Só marcamos a option adicional quando o componente realmente for múltiplo.
            if (select.multiple) {
                option.selected = true;
            }
        }

        // Atualiza apenas a interface Select2, sem disparar os handlers gerais do GLPI.
        if ($) {
            $(select).trigger('change.select2');
        }
    }

    async function setGlpiEntity(data) {
        const select = await waitForGlpi('select[name="entities_id"]');
        const wantedId = String(data.operation_id || '');

        if (!wantedId) throw new Error('ID da operação não informado');

        if (String(select.value) === wantedId) {
            return {
                id: wantedId,
                text: select.selectedOptions?.[0]?.textContent?.trim() || data.operation,
                alreadySelected: true
            };
        }

        // Primeiro tenta a option nativa, que é o caminho mais rápido.
        const native = [...select.options].find(o => String(o.value) === wantedId);
        if (native) {
            select.value = wantedId;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            await glpiSleep(250);
            return { id: wantedId, text: native.textContent.trim(), native: true };
        }

        // Fallback Select2 caso a entidade não esteja pré-carregada.
        const candidates = await querySelect2(select, data.operation || '');
        const exact = candidates.find(x => String(x.id) === wantedId)
            || candidates.find(x => glpiNormalize(x.fullText || x.text) === glpiNormalize(data.operation))
            || candidates.find(x => glpiNormalize(x.fullText || x.text).includes(glpiNormalize(data.operation)));

        if (!exact) throw new Error(`Operação não localizada no GLPI: ${data.operation}`);

        applySelect2Result(select, exact, false);
        await glpiSleep(250);
        return exact;
    }

    async function resolveGlpiCategory(data) {
        const select = await waitForGlpi(
            'select[name="itilcategories_id"]'
        );

        let candidates = [];

        // ORDEM IMPORTANTE:
        //
        // 1. Pesquisa pelo SISTEMA.
        //    Ex.: "Painel de Senha".
        //    Dentro desse resultado procuramos "Erro".
        //
        // Isso imita o que você faz manualmente:
        // Painel de Senha -> Erro.
        try {
            const bySystem = await querySelect2(
                select,
                data.system
            );

            candidates.push(
                ...annotateCategoryCandidates(
                    bySystem,
                    data.system,
                    3
                )
            );
        } catch (error) {
            console.warn(
                'OM30 categoria: busca por sistema falhou',
                error
            );
        }

        // 2. Pesquisa combinada.
        const combinedTerm =
            `${data.system} ${data.category}`;

        try {
            const byCombined = await querySelect2(
                select,
                combinedTerm
            );

            candidates.push(
                ...annotateCategoryCandidates(
                    byCombined,
                    combinedTerm,
                    2
                )
            );
        } catch (error) {
            console.warn(
                'OM30 categoria: busca combinada falhou',
                error
            );
        }

        // 3. Busca só pela categoria, como fallback.
        // Pode retornar vários "Erro", então só usamos quando
        // conseguimos contextualizar com segurança.
        try {
            const byCategory = await querySelect2(
                select,
                data.category
            );

            candidates.push(
                ...annotateCategoryCandidates(
                    byCategory,
                    data.category,
                    1
                )
            );
        } catch (error) {
            console.warn(
                'OM30 categoria: busca por categoria falhou',
                error
            );
        }

        // Deduplica sem perder a melhor fonte.
        const dedupMap = new Map();

        for (const item of candidates) {
            const key =
                `${String(item.id)}|` +
                `${cleanCategoryText(item.text)}|` +
                `${glpiNormalize(item.fullText || '')}`;

            const previous = dedupMap.get(key);

            if (
                !previous ||
                Number(item._sourcePriority || 0) >
                Number(previous._sourcePriority || 0)
            ) {
                dedupMap.set(key, item);
            }
        }

        const dedup = [...dedupMap.values()];
        const result = chooseCategoryCandidate(
            dedup,
            data
        );

        console.log(
            'OM30 GLPI categoria',
            {
                sistema: data.system,
                categoria: data.category,
                candidatos: dedup,
                escolhida: result
            }
        );

        if (!result) {
            throw new Error(
                `Categoria não localizada no GLPI: ` +
                `${data.system} > ${data.category}`
            );
        }

        // Trava adicional: o resultado jamais pode ser o pai.
        if (
            cleanCategoryText(result.text) ===
            glpiNormalize(data.system)
        ) {
            throw new Error(
                `O GLPI retornou apenas "${data.system}", ` +
                `mas era necessário selecionar "${data.category}".`
            );
        }

        if (
            !categoryTextMatchesExpected(
                result.text,
                data.category
            )
        ) {
            throw new Error(
                `A opção localizada não corresponde à categoria ` +
                `"${data.category}": ${result.text}`
            );
        }

        return {
            select,
            result
        };
    }

    function selectedCategoryDisplayText(select) {
        if (!select) return '';

        const native =
            select.selectedOptions?.[0]?.textContent ||
            select.selectedOptions?.[0]?.text ||
            '';

        if (
            categoryTextMatchesExpected(
                native,
                native
            ) &&
            String(native).trim()
        ) {
            return String(native).trim();
        }

        // O Select2 às vezes mostra o texto correto mesmo quando
        // a option nativa tem uma descrição diferente.
        const containerId =
            select.getAttribute('aria-labelledby') ||
            '';

        if (containerId) {
            const rendered =
                document.getElementById(containerId);

            if (rendered?.textContent?.trim()) {
                return rendered.textContent.trim();
            }
        }

        const rendered =
            select.nextElementSibling
                ?.querySelector?.(
                    '.select2-selection__rendered'
                );

        return (
            rendered?.textContent?.trim() ||
            String(native).trim()
        );
    }

    function validateGlpiCategorySelection(
        data,
        expectedId = null
    ) {
        const select = document.querySelector(
            'select[name="itilcategories_id"]'
        );

        if (!select) {
            throw new Error(
                'Campo Categoria não encontrado para validação'
            );
        }

        const selectedId =
            String(select.value || '');

        const selectedText =
            selectedCategoryDisplayText(select);

        if (!selectedId) {
            throw new Error(
                `Categoria vazia. Era esperado: ` +
                `${data.system} > ${data.category}`
            );
        }

        if (
            expectedId &&
            selectedId !== String(expectedId)
        ) {
            throw new Error(
                `Categoria diferente da opção localizada. ` +
                `Esperado ID ${expectedId}, atual ${selectedId}.`
            );
        }

        if (
            !categoryTextMatchesExpected(
                selectedText,
                data.category
            )
        ) {
            throw new Error(
                `Categoria incorreta no GLPI: ` +
                `"${selectedText || '(sem texto)'}". ` +
                `Era esperado "${data.category}" ` +
                `em ${data.system}.`
            );
        }

        return {
            id: selectedId,
            text: selectedText
        };
    }

    async function applyGlpiCategoryReal(data, resolved) {
        const { select, result } = resolved;

        let option = [...select.options].find(
            o => String(o.value) === String(result.id)
        );

        if (!option) {
            option = new Option(
                result.text || data.category,
                result.id,
                true,
                true
            );
            select.appendChild(option);
        }

        for (const o of select.options) {
            o.selected = false;
        }

        option.selected = true;
        select.value = String(result.id);

        const w = pageWindow();
        const $ = w.jQuery || w.$;

        // Aqui usamos CHANGE REAL de propósito.
        // A categoria precisa ser efetivamente aplicada pelo GLPI,
        // não apenas desenhada no Select2.
        if ($) {
            $(select).trigger('change');
        } else {
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }

        await glpiSleep(250);

        return {
            id: String(result.id),
            category: cleanCategoryText(result.text),
            fullText: result.fullText || result.text
        };
    }

    async function setGlpiDate(name, inputValue, required = false) {
        let input = document.querySelector(`input[name="${name}"]`);

        if (!input && required) {
            // Neste ponto Status + Tipo + Categoria já foram configurados.
            // Agora sim esperamos o GLPI montar a Data da solução.
            try {
                input = await waitForGlpi(`input[name="${name}"]`, 5000);
            } catch {
                // Último fallback seguro: reafirma Solucionado UMA vez.
                if (name === 'solvedate') {
                    const status = document.querySelector('select[name="status"]');

                    if (status) {
                        status.value = '5';
                        status.dispatchEvent(new Event('change', { bubbles: true }));
                        await glpiSleep(400);
                    }

                    input = await waitForGlpi(`input[name="${name}"]`, 7000);
                } else {
                    throw new Error(`Campo de data ${name} não encontrado`);
                }
            }
        }

        if (!input) {
            if (required) throw new Error(`Campo de data ${name} não encontrado`);
            return false;
        }

        if (!inputValue) {
            input.value = '';
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return false;
        }

        const date = fromInputDate(inputValue);
        const wrapper = input.closest('.flatpickr');
        const fp = wrapper?._flatpickr || input._flatpickr;

        if (fp && date) {
            fp.setDate(date, false);
        } else {
            input.value = toGlpiDate(inputValue);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }

        await glpiSleep(80);
        return true;
    }

    async function setGlpiUnit(data) {
        const select = await waitForGlpi('select[name="locations_id"]');
        if (!data.unit) throw new Error('Unidade está vazia no WhatsApp');

        const terms = [data.unit];
        const normalized = glpiNormalize(data.unit).split(' ').filter(x => x.length >= 4);
        if (normalized.length >= 2) terms.push(normalized.slice(-2).join(' '));
        if (normalized.length) terms.push(normalized[normalized.length - 1]);

        let candidates = [];
        for (const term of [...new Set(terms)]) {
            try {
                candidates.push(...await querySelect2(select, term));
            } catch (error) {
                console.warn('OM30 unidade query:', term, error);
            }
        }

        const dedup = [...new Map(candidates.map(x => [String(x.id), x])).values()];
        const result = chooseUnitCandidate(dedup, data.unit, data.operation);
        console.log('OM30 GLPI unidades candidatas:', dedup, 'ESCOLHIDA:', result);
        if (!result) throw new Error(`Unidade não localizada no GLPI: ${data.unit}`);

        if (String(select.value) !== String(result.id)) {
            applySelect2ResultQuiet(select, result, false);
            await glpiSleep(80);
        }

        if (String(select.value) !== String(result.id)) {
            throw new Error(`Unidade não permaneceu selecionada: ${result.fullText || result.text}`);
        }

        return result;
    }

    function assignSelectCandidates() {
        const found = new Set();

        for (const select of document.querySelectorAll('select')) {
            const name = String(select.name || '');
            const id = String(select.id || '');
            const signature = `${name} ${id}`;

            if (
                /_actors.*assign|assign.*_actors|_itil_assign|users?_id.*assign|groups?_id.*assign|assign.*users?_id|assign.*groups?_id/i.test(signature)
            ) {
                found.add(select);
            }
        }

        const labels = [...document.querySelectorAll('label,legend,span,div,strong')].filter(el => {
            const t = glpiNormalize(el.textContent || '');
            return (
                t === 'ATRIBUIDO' ||
                t === 'ATRIBUIDO A' ||
                t === 'ASSIGNED TO' ||
                t === 'TECNICO' ||
                t === 'TECNICO ATRIBUIDO'
            );
        });

        for (const label of labels) {
            let box = label;
            for (let i = 0; i < 5 && box; i++, box = box.parentElement) {
                const selects = box?.querySelectorAll?.('select') || [];
                for (const select of selects) found.add(select);
            }
        }

        return [...found];
    }

    function getGlpiActorsInput() {
        return document.querySelector(
            'input[name="_actors"], textarea[name="_actors"], input[name="_actors_json"], textarea[name="_actors_json"]'
        );
    }

    function readGlpiActors() {
        const input = getGlpiActorsInput();
        if (!input) return { input: null, actors: null };

        try {
            const actors = JSON.parse(input.value || '{}');
            if (!Array.isArray(actors.requester)) actors.requester = [];
            if (!Array.isArray(actors.observer)) actors.observer = [];
            if (!Array.isArray(actors.assign)) actors.assign = [];
            return { input, actors };
        } catch (error) {
            console.warn('OM30: não consegui interpretar _actors', error, input.value);
            return { input, actors: { requester: [], observer: [], assign: [] } };
        }
    }

    function writeGlpiActors(input, actors) {
        if (!input) return false;

        input.value = JSON.stringify(actors);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    }

    function confirmedGroupIdForOperation(operation) {
        const known = {
            'GUARUJA': 9,
            'JALES': 18
        };

        return known[glpiNormalize(operation)] || null;
    }

    function actorGroupAlreadyAssigned(actors, groupId) {
        return (actors?.assign || []).some(actor =>
            glpiNormalize(actor?.itemtype) === 'GROUP' &&
            String(actor?.items_id) === String(groupId)
        );
    }

    function addGroupToHiddenActors(data, explicitGroupId = null) {
        const { input, actors } = readGlpiActors();
        if (!input || !actors) return null;

        const groupId = explicitGroupId || confirmedGroupIdForOperation(data.operation);
        if (!groupId) return null;

        // Faz uma cópia da lista atual para garantir que nenhum usuário/grupo existente
        // seja perdido por referência ou reconstrução acidental.
        const existingAssign = Array.isArray(actors.assign)
            ? actors.assign.map(actor => ({ ...actor }))
            : [];

        if (!actorGroupAlreadyAssigned({ assign: existingAssign }, groupId)) {
            existingAssign.push({
                itemtype: 'Group',
                items_id: String(groupId),
                use_notification: 1,
                alternative_email: ''
            });
        }

        actors.assign = existingAssign;
        writeGlpiActors(input, actors);

        return {
            id: String(groupId),
            text: `Sistemas ${data.operation}`,
            fullText: `Group - Sistemas ${data.operation}`,
            source: '_actors'
        };
    }

    function showAssignedDryRunBadge(data, source = '') {
        const badgeId = 'om30-assigned-dryrun-badge';
        document.getElementById(badgeId)?.remove();

        const badge = document.createElement('div');
        badge.id = badgeId;
        badge.innerHTML = `✓ <b>Sistemas ${data.operation}</b>`;
        badge.title = source
            ? `OM30 adicionou o grupo ao formulário (${source})`
            : 'OM30 adicionou o grupo ao formulário';

        Object.assign(badge.style, {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '5px',
            margin: '5px 0 5px 8px',
            padding: '5px 9px',
            borderRadius: '999px',
            background: '#EAF4FF',
            border: '1px solid #8CC8FF',
            color: '#004080',
            fontSize: '11px',
            fontWeight: '700',
            verticalAlign: 'middle'
        });

        const labels = [...document.querySelectorAll('label,legend,span,div,strong')];
        const label = labels.find(el => {
            const t = glpiNormalize(el.textContent || '');
            return t === 'ATRIBUIDO' || t === 'ATRIBUIDO A' || t === 'ASSIGNED TO';
        });

        if (label?.parentElement) {
            label.parentElement.appendChild(badge);
        } else {
            document.querySelector('#itil-form')?.prepend(badge);
        }
    }

    async function addGlpiGroup(data) {
        const target = `Sistemas ${data.operation}`;
        const targetN = glpiNormalize(target);

        // ========================================================
        // REGRA PRINCIPAL:
        // A OM30 NUNCA substitui o usuário já atribuído.
        // Ela apenas ACRESCENTA o grupo Sistemas <operação>.
        // ========================================================

        // 1) Caminho preferencial: estado interno de atores do GLPI.
        // Preserva integralmente requester/observer/assign já existentes.
        const hiddenBefore = readGlpiActors();

        if (hiddenBefore.input && hiddenBefore.actors) {
            const beforeAssign = JSON.parse(JSON.stringify(hiddenBefore.actors.assign || []));
            const hiddenResult = addGroupToHiddenActors(data);

            if (hiddenResult) {
                const after = readGlpiActors();

                console.log('OM30 GLPI Atribuído preservado:', {
                    antes: beforeAssign,
                    depois: after.actors?.assign || [],
                    grupoAdicionado: hiddenResult
                });

                showAssignedDryRunBadge(data, '_actors · usuário preservado');
                return hiddenResult;
            }
        }

        // 2) Fallback visual:
        // SOMENTE mexe em Select2 se o campo aceitar múltiplos valores.
        // Select simples é ignorado para não remover o técnico/usuário atual.
        const selects = assignSelectCandidates();

        console.log('OM30 GLPI: candidatos de campo Atribuído:', selects);

        for (const select of selects) {
            if (!select.multiple) {
                console.log(
                    'OM30 GLPI: ignorando select simples de Atribuído para preservar usuário:',
                    select
                );
                continue;
            }

            let candidates = [];

            try {
                candidates = await querySelect2(select, target);
            } catch (error) {
                console.warn('OM30 GLPI: falha consultando Atribuído', select, error);
                continue;
            }

            const scored = candidates.map(item => {
                const text = glpiNormalize(item.fullText || item.text);
                const id = glpiNormalize(item.id);
                let score = tokenOverlapScore(text, targetN);

                if (text.includes(targetN)) score += 100;
                if (text.includes('GRUPO') || text.includes('GROUP') || id.includes('GROUP')) score += 55;
                if (text.includes('USUARIO') || text.includes('USER')) score -= 45;

                return { item, score };
            }).sort((a, b) => b.score - a.score);

            const result = scored[0]?.score >= 100 ? scored[0].item : null;
            if (!result) continue;

            const selectedBefore = [...select.options]
                .filter(o => o.selected)
                .map(o => ({ value: o.value, text: o.textContent }));

            const already = selectedBefore.some(
                o => String(o.value) === String(result.id)
            );

            if (!already) {
                applySelect2ResultQuiet(select, result, true);
                await glpiSleep(80);
            }

            const selectedAfter = [...select.options]
                .filter(o => o.selected)
                .map(o => ({ value: o.value, text: o.textContent }));

            console.log('OM30 GLPI Atribuído via select múltiplo:', {
                antes: selectedBefore,
                depois: selectedAfter,
                grupo: result
            });

            showAssignedDryRunBadge(data, 'Select2 múltiplo · usuário preservado');
            return result;
        }

        // 3) Não encontrou um caminho seguro.
        // Continua o formulário, mas NÃO toca no usuário atribuído.
        console.warn(
            `OM30: não encontrei forma segura de adicionar ${target} sem substituir o usuário atual. ` +
            'O usuário atribuído foi preservado e o restante do formulário continuará.'
        );

        return {
            skipped: true,
            preservedCurrentAssignee: true,
            warning: `Usuário atual preservado; grupo não adicionado automaticamente: ${target}`
        };
    }


    // ============================================================
    // CORREÇÃO PÓS-CRIAÇÃO DO ATRIBUÍDO
    //
    // Bug atual do GLPI:
    // ao publicar, ele pode trocar o grupo Sistemas <operação>
    // por "Operação > Service Desk".
    //
    // Até o GLPI ser corrigido, a OM30 faz uma segunda gravação:
    // mantém o usuário atribuído, remove Service Desk,
    // adiciona Sistemas <operação> e salva o chamado.
    // ============================================================

    function selectedAssignedOptions() {
        const rows = [];

        for (const select of assignSelectCandidates()) {
            for (const option of [...select.options]) {
                if (!option.selected) continue;

                rows.push({
                    select,
                    option,
                    id: String(option.value || ''),
                    text: String(option.textContent || option.text || '').trim(),
                    normalized: glpiNormalize(option.textContent || option.text || '')
                });
            }
        }

        return rows;
    }

    function assignedVisualTexts() {
        const texts = new Set();

        for (const row of selectedAssignedOptions()) {
            if (row.text) texts.add(row.text);
        }

        // Select2 normalmente desenha os atores selecionados como chips.
        for (const el of document.querySelectorAll(
            '.select2-selection__choice, .select2-selection__rendered, [data-itemtype="Group"], [data-itemtype="User"]'
        )) {
            const text = String(el.textContent || '').trim();
            if (text) texts.add(text);
        }

        return [...texts];
    }

    async function resolveServiceDeskGroupIds() {
        const ids = new Set();

        // 1) IDs visíveis já selecionados.
        for (const row of selectedAssignedOptions()) {
            if (
                row.normalized.includes('SERVICE DESK') &&
                /^\d+$/.test(row.id)
            ) {
                ids.add(row.id);
            }
        }

        // 2) Consulta os Select2 de Atribuído.
        for (const select of assignSelectCandidates()) {
            try {
                const candidates = await querySelect2(select, 'Service Desk');

                for (const item of candidates) {
                    const text = glpiNormalize(item.fullText || item.text);
                    const id = String(item.id || '').match(/\d+/)?.[0] || '';

                    if (
                        id &&
                        text.includes('SERVICE DESK') &&
                        (
                            text.includes('GRUPO') ||
                            text.includes('GROUP') ||
                            text.includes('OPERACAO') ||
                            text.includes('OPERAÇÃO')
                        )
                    ) {
                        ids.add(id);
                    }
                }
            } catch (error) {
                console.warn('OM30: falha consultando Service Desk em Atribuído', error);
            }
        }

        return [...ids];
    }

    function removeActorGroupIdsFromHiddenActors(groupIds) {
        const ids = new Set((groupIds || []).map(String));
        if (!ids.size) return false;

        const { input, actors } = readGlpiActors();
        if (!input || !actors || !Array.isArray(actors.assign)) return false;

        const before = actors.assign.map(actor => ({ ...actor }));

        actors.assign = actors.assign.filter(actor => {
            const isGroup = glpiNormalize(actor?.itemtype) === 'GROUP';
            const id = String(actor?.items_id || '');
            return !(isGroup && ids.has(id));
        });

        const changed = actors.assign.length !== before.length;

        if (changed) {
            writeGlpiActors(input, actors);

            console.log('OM30 pós-criação: Service Desk removido de _actors', {
                ids: [...ids],
                antes: before,
                depois: actors.assign
            });
        }

        return changed;
    }

    function removeServiceDeskFromVisualSelects(groupIds = []) {
        const ids = new Set((groupIds || []).map(String));
        let changed = false;

        for (const row of selectedAssignedOptions()) {
            const isServiceDesk =
                row.normalized.includes('SERVICE DESK') ||
                ids.has(row.id);

            if (!isServiceDesk) continue;

            row.option.selected = false;

            // Option temporária criada pelo Select2 pode ser removida.
            if (
                row.normalized.includes('SERVICE DESK') &&
                row.option.dataset?.select2Tag === 'true'
            ) {
                row.option.remove();
            }

            const w = pageWindow();
            const $ = w.jQuery || w.$;

            if ($) {
                $(row.select).trigger('change.select2');
            }

            changed = true;
        }

        return changed;
    }

    async function removeServiceDeskAssignment(job) {
        const ids = await resolveServiceDeskGroupIds();

        job.service_desk_group_ids = ids;
        saveGlpiJob(job);

        const hiddenChanged = removeActorGroupIdsFromHiddenActors(ids);
        const visualChanged = removeServiceDeskFromVisualSelects(ids);

        console.log('OM30 pós-criação: remoção Service Desk', {
            ids,
            hiddenChanged,
            visualChanged,
            visualAtual: assignedVisualTexts()
        });

        return {
            ids,
            hiddenChanged,
            visualChanged
        };
    }

    function verifyTargetGroupInHiddenActors(data) {
        const groupId = confirmedGroupIdForOperation(data.operation);
        if (!groupId) return null;

        const { actors } = readGlpiActors();
        if (!actors) return null;

        return actorGroupAlreadyAssigned(actors, groupId);
    }

    function verifyServiceDeskRemoved(job) {
        const ids = new Set(
            (job.service_desk_group_ids || []).map(String)
        );

        const { actors } = readGlpiActors();

        if (actors && Array.isArray(actors.assign) && ids.size) {
            const stillInHidden = actors.assign.some(actor =>
                glpiNormalize(actor?.itemtype) === 'GROUP' &&
                ids.has(String(actor?.items_id || ''))
            );

            if (stillInHidden) return false;
        }

        const visual = assignedVisualTexts()
            .map(glpiNormalize)
            .join(' | ');

        if (visual.includes('SERVICE DESK')) return false;

        return true;
    }

    function verifyCurrentUserStillAssigned() {
        // A regra absoluta é não apagar o usuário já atribuído.
        // No _actors, basta existir pelo menos um User em assign.
        const { actors } = readGlpiActors();

        if (actors && Array.isArray(actors.assign)) {
            return actors.assign.some(actor =>
                glpiNormalize(actor?.itemtype) === 'USER'
            );
        }

        // Fallback visual: procura ao menos um item de atribuição
        // que não seja grupo/Service Desk.
        const texts = assignedVisualTexts()
            .map(glpiNormalize);

        return texts.some(text =>
            text &&
            !text.includes('SERVICE DESK') &&
            !text.includes('SISTEMAS ')
        );
    }

    function isVisibleGlpiAction(el) {
        if (!el) return false;

        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();

        return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity || 1) > 0 &&
            rect.width > 0 &&
            rect.height > 0
        );
    }

    function glpiActionText(el) {
        return glpiNormalize(
            el?.textContent ||
            el?.value ||
            el?.getAttribute?.('aria-label') ||
            el?.title ||
            ''
        );
    }

    function isSafeSaveAction(el) {
        if (!el) return false;

        const text = glpiActionText(el);
        const name = glpiNormalize(el.getAttribute?.('name') || '');
        const id = glpiNormalize(el.id || '');
        const title = glpiNormalize(el.title || '');
        const signature = `${text} ${name} ${id} ${title}`;

        // Só aceita ações cujo rótulo seja explicitamente de gravação.
        const isSave =
            text === 'SALVAR' ||
            text === 'ATUALIZAR' ||
            text === 'SALVAR ALTERACOES' ||
            text === 'SAVE' ||
            name === 'UPDATE' ||
            id === 'UPDATE';

        if (!isSave) return false;

        // Trava absoluta contra qualquer ação destrutiva ou de criação.
        const forbidden = [
            'EXCLUIR',
            'DELETE',
            'PURGE',
            'REMOVER',
            'RESTAURAR',
            'RESTORE',
            'ADICIONAR',
            'ADD',
            'CRIAR',
            'CREATE'
        ];

        if (forbidden.some(word => signature.includes(word))) {
            return false;
        }

        if (el.disabled || el.getAttribute?.('aria-disabled') === 'true') {
            return false;
        }

        return isVisibleGlpiAction(el);
    }

    function describeGlpiAction(el) {
        return {
            tag: el?.tagName || '',
            text: (el?.textContent || el?.value || '').trim(),
            name: el?.getAttribute?.('name') || '',
            id: el?.id || '',
            type: el?.getAttribute?.('type') || '',
            form: el?.getAttribute?.('form') || '',
            className: String(el?.className || '').slice(0, 180)
        };
    }

    function findGlpiUpdateButton() {
        // 1) Seletores semânticos conhecidos do GLPI.
        // Não exigimos que o botão esteja fisicamente dentro do #itil-form,
        // porque o GLPI pode renderizar o rodapé fixo fora do formulário.
        const selectors = [
            'button[type="submit"][name="update"]',
            'input[type="submit"][name="update"]',
            'button[name="update"]',
            'input[name="update"]',
            'button[form="itil-form"]',
            'input[type="submit"][form="itil-form"]'
        ];

        for (const selector of selectors) {
            for (const el of document.querySelectorAll(selector)) {
                if (isSafeSaveAction(el)) {
                    console.log(
                        'OM30: botão Salvar localizado por seletor',
                        selector,
                        describeGlpiAction(el)
                    );
                    return el;
                }
            }
        }

        // 2) Fallback principal observado na sua tela:
        // botão preto "Salvar" no rodapé fixo do GLPI.
        // Pesquisa a página inteira, mas aceita SOMENTE texto exato de Salvar/Atualizar.
        const globalCandidates = [
            ...document.querySelectorAll(
                'button, input[type="submit"], input[type="button"]'
            )
        ];

        const exact = globalCandidates.find(isSafeSaveAction);

        if (exact) {
            console.log(
                'OM30: botão Salvar localizado pelo rodapé global',
                describeGlpiAction(exact)
            );
            return exact;
        }

        // 3) Diagnóstico útil caso o HTML do GLPI mude novamente.
        const diagnostics = globalCandidates
            .filter(isVisibleGlpiAction)
            .map(describeGlpiAction)
            .filter(x =>
                /SALV|ATUAL|UPDATE|SAVE|EXCL|REST|ADIC/i.test(
                    `${x.text} ${x.name} ${x.id}`
                )
            );

        console.warn(
            'OM30: não encontrei botão seguro de Salvar. Candidatos visíveis:',
            diagnostics
        );

        return null;
    }

    async function savePostCreationAssignmentFix(job) {
        const ticketId = currentTicketEditId();

        if (!ticketId || String(ticketId) !== String(job.ticket_id)) {
            throw new Error(
                `Chamado criado não está aberto para correção do Atribuído. Esperado #${job.ticket_id}.`
            );
        }

        ensureGlpiBanner(
            `Chamado #${ticketId} criado. Corrigindo <b>Atribuído</b>: removendo Service Desk e colocando <b>Sistemas ${job.data.operation}</b>...`,
            'warning'
        );

        // 1) Remove Service Desk.
        await removeServiceDeskAssignment(job);

        // 2) Mantém usuário e adiciona Sistemas <operação>.
        await addGlpiGroup(job.data);

        // 3) Travas antes de salvar.
        const userPreserved = verifyCurrentUserStillAssigned();
        const targetGroup = verifyTargetGroupInHiddenActors(job.data);

        if (!userPreserved) {
            throw new Error(
                'Correção pós-criação cancelada: o usuário atribuído não foi preservado.'
            );
        }

        if (targetGroup === false) {
            throw new Error(
                `Correção pós-criação cancelada: Sistemas ${job.data.operation} não ficou em Atribuído.`
            );
        }

        const update = findGlpiUpdateButton();

        if (!update) {
            throw new Error(
                'Botão Salvar/Atualizar do rodapé do chamado não foi encontrado. Nenhum outro botão foi clicado.'
            );
        }

        // TRAVA: salva esta correção apenas uma vez.
        job.stage = 'postfix-saving';
        job.postfix_save_attempted_at = new Date().toISOString();
        job.postfix_save_attempts = Number(job.postfix_save_attempts || 0) + 1;
        saveGlpiJob(job);

        ensureGlpiBanner(
            `Salvando correção do Atribuído no chamado #${ticketId}...`,
            'warning'
        );

        console.log('OM30 pós-criação: salvando Atribuído corrigido por POST direto', {
            ticketId,
            serviceDeskIds: job.service_desk_group_ids || [],
            target: `Sistemas ${job.data.operation}`,
            visual: assignedVisualTexts()
        });

        const form = document.querySelector('#itil-form');
        if (!form) {
            throw new Error('Formulário do chamado não encontrado para o POST de correção.');
        }

        const fd = new FormData(form);

        if (update?.name) {
            fd.set(update.name, update.value || 'Salvar');
        } else {
            fd.set('update', 'Salvar');
        }

        let response;
        try {
            response = await fetch(
                form.action || `${GLPI_TEST.base}/front/ticket.form.php?id=${ticketId}`,
                {
                    method: 'POST',
                    credentials: 'include',
                    body: fd,
                    redirect: 'follow'
                }
            );
        } catch (error) {
            throw new Error(
                `Falha de rede no POST da correção do Atribuído: ${error?.message || error}`
            );
        }

        const html = await response.text();

        job.postfix_direct_http = response.status;
        job.postfix_direct_response_url = response.url || '';
        job.postfix_direct_finished_at = new Date().toISOString();
        job.postfix_save_method = 'POST direto ticket.form.php';
        saveGlpiJob(job);

        if (looksLikeGlpiLoginHtml(html, response.url)) {
            job.resume_stage = 'postfix-assign';
            job.stage = 'waiting-login';
            job.login_required_at = new Date().toISOString();
            saveGlpiJob(job);

            saveGlpiLoginRequired(
                job,
                'Sua sessão do GLPI expirou ao salvar a correção do Atribuído. Faça login para continuar.'
            );
            return false;
        }

        if (!response.ok) {
            throw new Error(
                `GLPI respondeu HTTP ${response.status} ao salvar a correção do Atribuído.`
            );
        }

        // Reabre o próprio chamado APENAS no motor oculto para conferir o resultado.
        // Não existe segundo POST e não existe clique em Salvar.
        location.replace(
            job.ticket_url ||
            `${GLPI_TEST.base}/front/ticket.form.php?id=${ticketId}`
        );

        return true;
    }

    function verifyPostCreationAssignmentFix(job) {
        const serviceDeskRemoved = verifyServiceDeskRemoved(job);
        const userPreserved = verifyCurrentUserStillAssigned();
        const targetGroup = verifyTargetGroupInHiddenActors(job.data);

        const visual = assignedVisualTexts()
            .map(glpiNormalize)
            .join(' | ');

        const targetText = glpiNormalize(`Sistemas ${job.data.operation}`);

        const targetVisual =
            visual.includes(targetText) ||
            targetGroup === true;

        return {
            ok:
                serviceDeskRemoved &&
                userPreserved &&
                targetVisual,
            serviceDeskRemoved,
            userPreserved,
            targetGroup: targetVisual,
            visual
        };
    }

    function finalizePublishedTicket(job) {
        const ticketId = Number(job.ticket_id);
        const ticketUrl =
            job.ticket_url ||
            `${GLPI_TEST.base}/front/ticket.form.php?id=${ticketId}`;

        const publishedAt =
            job.published_at ||
            new Date().toISOString();

        job.stage = 'published';
        job.postfix_completed_at = new Date().toISOString();
        saveGlpiJob(job);

        saveGlpiResult({
            job_id: job.id,
            ticket_id: ticketId,
            ticket_url: ticketUrl,
            title: job.data?.title || `Chamado #${ticketId}`,
            unit: job.data?.unit || '',
            operation: job.data?.operation || '',
            published_at: publishedAt,
            assignment_fixed: true
        });

        // Só encerra o job DEPOIS da correção pós-criação.
        GM_deleteValue(GLPI_TEST.jobKey);

        const nextJob = activateNextGlpiQueuedJob();

        ensureGlpiBanner(
            nextJob
                ? `✅ Chamado <b>#${ticketId}</b> concluído. Iniciando o próximo chamado da fila sem bloquear o WhatsApp...`
                : `✅ Chamado <b>#${ticketId}</b> criado e Atribuído corrigido para <b>Sistemas ${job.data.operation}</b>.`,
            'success'
        );

        console.log(`✅ OM30 GLPI: chamado #${ticketId} finalizado`, job);

        if (nextJob) {
            setTimeout(() => {
                location.replace(`${GLPI_TEST.base}/front/ticket.form.php?om30_bg=1&t=${Date.now()}`);
            }, 180);
        } else {
            setTimeout(() => {
                closeGlpiAutomationTab();
            }, 650);
        }
    }

    async function setGlpiTitle(title) {
        const input = await waitForGlpi('input[name="name"]');
        const value = title || '';

        input.value = value;
        input.defaultValue = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));

        if (input.value !== value) {
            input.value = value;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }

        console.log('OM30 GLPI título preenchido:', value);
        return value;
    }

    async function setGlpiDescription(description) {
        const textarea = await waitForGlpi('textarea[name="content"]');
        const raw = String(description || '');

        const escaped = raw
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#039;')
            .replace(/\r?\n/g, '<br>');

        const html = `<p>${escaped}</p>`;
        const w = pageWindow();

        let editor = null;
        for (let i = 0; i < 12; i++) {
            editor = w.tinymce?.get?.(textarea.id) || null;
            if (editor) break;
            await glpiSleep(80);
        }

        if (editor) {
            editor.setContent(html);
            editor.save();

            if (!textarea.value) {
                textarea.value = raw;
            }
        } else {
            textarea.value = raw;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));
        }

        console.log('OM30 GLPI descrição preenchida:', {
            chars: raw.length,
            tinyMCE: !!editor,
            preview: raw.slice(0, 180)
        });

        return {
            chars: raw.length,
            tinyMCE: !!editor
        };
    }

    async function glpiPrintFile(job) {
        const response = await fetch(job.printDataUrl);
        const blob = await response.blob();

        const file = new File(
            [blob],
            `WhatsApp-OM30-${job.id}.png`,
            {
                type: blob.type || 'image/png',
                lastModified: Date.now()
            }
        );

        return { blob, file };
    }

    async function getGlpiTinyMceEditor() {
        const textarea = await waitForGlpi(
            'textarea[name="content"]'
        );

        const w = pageWindow();

        for (let i = 0; i < 20; i++) {
            const editor =
                w.tinymce?.get?.(textarea.id) ||
                null;

            if (editor?.getBody?.()) {
                return {
                    textarea,
                    editor
                };
            }

            await glpiSleep(80);
        }

        return {
            textarea,
            editor: null
        };
    }

    function glpiEditorImageSnapshot(editor) {
        if (!editor?.getBody?.()) return [];

        return [
            ...editor.getBody().querySelectorAll('img')
        ].map(img => ({
            src: String(img.getAttribute('src') || ''),
            alt: String(img.getAttribute('alt') || ''),
            html: img.outerHTML.slice(0, 500)
        }));
    }

    function newEditorImageAppeared(before, after) {
        if (after.length > before.length) {
            return true;
        }

        const oldSources = new Set(
            before.map(x => x.src)
        );

        return after.some(x =>
            x.src &&
            !oldSources.has(x.src)
        );
    }

    async function pasteGlpiPrintInline(job) {
        if (!job.printDataUrl) {
            return {
                pasted: false,
                reason: 'sem print'
            };
        }

        const { blob, file } =
            await glpiPrintFile(job);

        const { textarea, editor } =
            await getGlpiTinyMceEditor();

        if (!editor) {
            return {
                pasted: false,
                reason: 'TinyMCE não disponível',
                blob,
                file
            };
        }

        const body = editor.getBody();
        const before =
            glpiEditorImageSnapshot(editor);

        // Coloca o cursor no final da descrição para o print
        // aparecer abaixo das mensagens/texto.
        try {
            editor.focus();
            editor.selection.select(
                body,
                true
            );
            editor.selection.collapse(false);

            // Pequeno espaço antes da imagem, igual um Ctrl+V
            // após o texto da conversa.
            editor.insertContent('<p><br></p>');
        } catch (error) {
            console.warn(
                'OM30: não consegui posicionar cursor do TinyMCE',
                error
            );
        }

        let pasteEventDispatched = false;

        try {
            const transfer =
                new DataTransfer();

            transfer.items.add(file);

            const pasteEvent =
                new ClipboardEvent(
                    'paste',
                    {
                        bubbles: true,
                        cancelable: true,
                        composed: true,
                        clipboardData: transfer
                    }
                );

            pasteEventDispatched =
                body.dispatchEvent(pasteEvent);

            console.log(
                'OM30 GLPI: evento de colagem do print disparado',
                {
                    pasteEventDispatched,
                    bytes: blob.size,
                    type: file.type
                }
            );
        } catch (error) {
            console.warn(
                'OM30: colagem sintética do print falhou',
                error
            );
        }

        // TinyMCE pode processar/uploadar a imagem de forma assíncrona.
        for (let i = 0; i < 20; i++) {
            await glpiSleep(120);

            const after =
                glpiEditorImageSnapshot(editor);

            if (
                newEditorImageAppeared(
                    before,
                    after
                )
            ) {
                editor.save();

                // Confirma que o conteúdo HTML subjacente também contém imagem.
                const content =
                    String(editor.getContent() || '');

                if (/<img\b/i.test(content)) {
                    console.log(
                        '✅ OM30 GLPI: print colado dentro da descrição',
                        {
                            antes: before.length,
                            depois: after.length,
                            images: after
                        }
                    );

                    return {
                        pasted: true,
                        attached: false,
                        bytes: blob.size,
                        name: file.name,
                        method: 'TinyMCE paste'
                    };
                }
            }
        }

        // A colagem não entrou. Remove apenas o parágrafo vazio
        // que inserimos se ele tiver ficado como último elemento.
        try {
            const children =
                [...body.children];

            const last =
                children[children.length - 1];

            if (
                last &&
                last.tagName === 'P' &&
                !last.textContent.trim() &&
                !last.querySelector('img')
            ) {
                last.remove();
                editor.save();
            }
        } catch {}

        return {
            pasted: false,
            attached: false,
            reason: 'GLPI/TinyMCE não aceitou a colagem inline',
            blob,
            file
        };
    }

    async function attachGlpiPrintFallback(
        job,
        prepared = null
    ) {
        if (!job.printDataUrl) {
            return {
                attached: false,
                reason: 'sem print'
            };
        }

        const input = await waitForGlpi(
            'input[name="_uploader_filename[]"]'
        );

        const preparedFile =
            prepared?.file
                ? prepared
                : await glpiPrintFile(job);

        const { blob, file } =
            preparedFile;

        const transfer =
            new DataTransfer();

        transfer.items.add(file);

        input.files =
            transfer.files;

        input.dispatchEvent(
            new Event(
                'change',
                {
                    bubbles: true
                }
            )
        );

        await glpiSleep(500);

        console.warn(
            'OM30 GLPI: colagem inline falhou; print enviado como anexo',
            {
                bytes: blob.size,
                name: file.name
            }
        );

        return {
            pasted: false,
            attached: true,
            fallback: true,
            bytes: blob.size,
            name: file.name
        };
    }

    async function pasteOrAttachGlpiPrint(job) {
        if (!job.printDataUrl) {
            return {
                pasted: false,
                attached: false,
                reason: 'sem print'
            };
        }

        ensureGlpiBanner(
            'Colando o print dentro da <b>Descrição</b>...',
            'info'
        );

        let inlineResult = null;

        try {
            inlineResult =
                await pasteGlpiPrintInline(job);
        } catch (error) {
            inlineResult = {
                pasted: false,
                attached: false,
                reason: String(
                    error?.message ||
                    error
                )
            };

            console.warn(
                'OM30: erro tentando colar print inline',
                error
            );
        }

        if (inlineResult?.pasted) {
            const uploadMetadata =
                await waitForGlpiPrintUploadMetadata(job);

            return {
                ...inlineResult,
                uploadMetadata
            };
        }

        ensureGlpiBanner(
            'A colagem do print não foi aceita pelo editor. Usando <b>anexo como fallback</b>...',
            'warning'
        );

        const fallbackResult =
            await attachGlpiPrintFallback(
                job,
                inlineResult
            );

        const uploadMetadata =
            await waitForGlpiPrintUploadMetadata(job);

        return {
            ...fallbackResult,
            uploadMetadata
        };
    }


    // ============================================================
    // MOTOR DIRETO v0.7.30
    //
    // Diferente das versões anteriores, este caminho NÃO seleciona
    // Status -> Tipo -> Categoria -> Unidade -> etc. na tela.
    // A página do GLPI serve somente como contexto autenticado para obter
    // formulário/CSRF/Select2. Os valores finais são montados em FormData
    // e enviados em um único POST, igual ao teste de Console que criou
    // "TESTE OM30 POST DIRETO".
    // ============================================================

    function directEscapeHtml(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function directDescriptionHtml(job, imageTag = '') {
        const body = directEscapeHtml(job.data?.description || '')
            .replace(/\r?\n/g, '<br>');
        const image = job.printDataUrl
            ? `<p><img${imageTag ? ` id="${directEscapeHtml(imageTag)}"` : ''} src="${job.printDataUrl}"></p>`
            : '';
        return `<p>${body}</p>${image}`;
    }

    function directDataUrlToFile(dataUrl, filename) {
        const match = String(dataUrl || '').match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
        if (!match) throw new Error('Print inválido: Data URL não reconhecida.');
        const mime = match[1] || 'image/png';
        const binary = match[2] ? atob(match[3]) : decodeURIComponent(match[3]);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new File([bytes], filename, { type: mime });
    }

    function directRandomUploadName(originalName = 'image.png') {
        const cleanName = String(originalName || 'image.png').replace(/[^a-zA-Z0-9._-]+/g, '_');
        return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}${cleanName}`;
    }

    async function directResolveUnit(data) {
        const select = await waitForGlpi('select[name="locations_id"]');
        if (!data.unit) throw new Error('Unidade está vazia no WhatsApp.');

        const terms = [data.unit];
        const normalized = glpiNormalize(data.unit).split(' ').filter(x => x.length >= 4);
        if (normalized.length >= 2) terms.push(normalized.slice(-2).join(' '));
        if (normalized.length) terms.push(normalized[normalized.length - 1]);

        let candidates = [];
        for (const term of [...new Set(terms)]) {
            try { candidates.push(...await querySelect2(select, term)); }
            catch (error) { console.warn('OM30 direto: busca de unidade falhou', term, error); }
        }

        const dedup = [...new Map(candidates.map(x => [String(x.id), x])).values()];
        const result = chooseUnitCandidate(dedup, data.unit, data.operation);
        if (!result) {
            throw new Error(`Unidade não localizada diretamente no GLPI: ${data.unit}. Nenhum campo será preenchido manualmente.`);
        }
        return result;
    }

    async function directResolveCategory(data) {
        const resolved = await resolveGlpiCategory(data);
        return resolved.result;
    }

    function directCurrentActors(form) {
        const fd = new FormData(form);
        const raw = fd.get('_actors');
        if (!raw || typeof raw !== 'string') return null;
        try {
            const actors = JSON.parse(raw);
            if (!Array.isArray(actors.requester)) actors.requester = [];
            if (!Array.isArray(actors.observer)) actors.observer = [];
            if (!Array.isArray(actors.assign)) actors.assign = [];
            return actors;
        } catch {
            return null;
        }
    }

    async function directUploadPrint(job, form) {
        if (!job.printDataUrl) return null;

        const csrf = form.querySelector('[name="_glpi_csrf_token"]')?.value || '';
        if (!csrf) throw new Error('CSRF não encontrado para upload do print.');

        const ext = (String(job.printDataUrl).match(/^data:image\/([a-z0-9.+-]+)/i)?.[1] || 'png').replace('jpeg', 'jpg');
        const original = `image_paste${Math.floor(Math.random() * 9000000 + 1000000)}.${ext}`;
        const uploadName = directRandomUploadName(original);
        const file = directDataUrlToFile(job.printDataUrl, uploadName);

        const uploadFd = new FormData();
        uploadFd.append('name', '_uploader_filename');
        uploadFd.append('showfilesize', '1');
        uploadFd.append('_uploader_filename[]', file, uploadName);

        const uploadResponse = await fetch(`${GLPI_TEST.base}/ajax/fileupload.php`, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'X-Requested-With': 'XMLHttpRequest',
                'X-Glpi-Csrf-Token': csrf
            },
            body: uploadFd
        });

        const uploadText = await uploadResponse.text();
        if (looksLikeGlpiLoginHtml(uploadText, uploadResponse.url)) {
            throw Object.assign(new Error('LOGIN_REQUIRED'), { om30LoginRequired: true });
        }
        if (!uploadResponse.ok) throw new Error(`Upload do print falhou: HTTP ${uploadResponse.status}`);

        let uploadJson;
        try { uploadJson = JSON.parse(uploadText); }
        catch { throw new Error('GLPI não devolveu JSON válido no fileupload.php.'); }

        const files = uploadJson?._uploader_filename || uploadJson?.files || [];
        const fileData = Array.isArray(files) ? files[0] : null;
        if (!fileData?.name) throw new Error('GLPI recebeu o print, mas não devolveu o nome temporário.');
        if (fileData.error) throw new Error(`GLPI recusou o print: ${fileData.error}`);

        const tagBody = new URLSearchParams();
        // getFileTag.php só precisa da existência de data[0], mas enviamos os
        // mesmos metadados do frontend real do GLPI para manter o fluxo idêntico.
        for (const [key, value] of Object.entries(fileData)) {
            if (value === undefined || value === null || typeof value === 'object') continue;
            tagBody.set(`data[0][${key}]`, String(value));
        }
        if (![...tagBody.keys()].length) tagBody.set('data[0][name]', String(fileData.name));

        const tagResponse = await fetch(`${GLPI_TEST.base}/ajax/getFileTag.php`, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'X-Requested-With': 'XMLHttpRequest',
                'X-Glpi-Csrf-Token': csrf
            },
            body: tagBody.toString()
        });

        const tagText = await tagResponse.text();
        if (!tagResponse.ok) throw new Error(`getFileTag.php falhou: HTTP ${tagResponse.status}`);
        let tagJson;
        try { tagJson = JSON.parse(tagText); }
        catch { throw new Error('GLPI não devolveu JSON válido no getFileTag.php.'); }

        const tagData = Array.isArray(tagJson) ? tagJson[0] : tagJson?.[0];
        if (!tagData?.name || !tagData?.tag) throw new Error('Tag do print não foi gerada pelo GLPI.');

        return {
            file: fileData,
            tag: tagData,
            imageId: String(tagData.tag).replace(/#/g, '')
        };
    }

    function directPrepareCreateFormData(form, job, category, unit, upload) {
        const fd = new FormData(form);
        const data = job.data;

        fd.set('entities_id', String(data.operation_id));
        fd.set('type', String(data.type_id));
        fd.set('itilcategories_id', String(category.id));
        fd.set('status', '5');
        fd.set('date', toGlpiDate(data.initial_date));
        fd.set('solvedate', toGlpiDate(data.solution_date));
        fd.set('locations_id', String(unit.id));
        fd.set('name', data.title || 'Chamado OM30');
        fd.set('urgency', fd.get('urgency') || '3');
        fd.set('impact', fd.get('impact') || '3');
        fd.set('priority', fd.get('priority') || '3');

        // Mantém requester/usuário atribuído do formulário da sessão atual.
        const actors = directCurrentActors(form);
        if (actors) fd.set('_actors', JSON.stringify(actors));

        if (upload) {
            fd.set('content', directDescriptionHtml(job, upload.imageId));
            fd.set('_filename[0]', String(upload.file.name));
            fd.set('_prefix_filename[0]', String(upload.file.prefix || ''));
            fd.set('_tag_filename[0]', String(upload.tag.name));
        } else {
            fd.set('content', directDescriptionHtml(job));
        }

        const add = form.querySelector('button[type="submit"][name="add"], input[type="submit"][name="add"]');
        fd.set(add?.name || 'add', add?.value || 'Adicionar');
        return fd;
    }

    async function directResolveAssignmentGroup(target) {
        const targetN = glpiNormalize(target);
        let all = [];
        for (const select of assignSelectCandidates()) {
            try { all.push(...await querySelect2(select, target)); }
            catch (error) { console.warn('OM30 direto: busca de grupo falhou', target, error); }
        }
        const dedup = [...new Map(all.map(x => [`${x.id}|${x.fullText || x.text}`, x])).values()];
        const scored = dedup.map(item => {
            const t = glpiNormalize(item.fullText || item.text || '');
            let score = tokenOverlapScore(t, targetN);
            if (t.includes(targetN)) score += 120;
            if (t.includes('GROUP') || t.includes('GRUPO')) score += 35;
            if (t.includes('USER') || t.includes('USUARIO')) score -= 80;
            return { item, score, text: t };
        }).sort((a, b) => b.score - a.score);
        return scored[0]?.score >= 100 ? scored[0].item : null;
    }

    async function directPostfixAssignment(job) {
        const form = await waitForGlpi('#itil-form');
        const currentId = currentTicketEditId();
        if (String(currentId || '') !== String(job.ticket_id || '')) {
            throw new Error(`Pós-correção abriu chamado diferente. Esperado #${job.ticket_id}, atual #${currentId || '?'}.`);
        }

        const fd = new FormData(form);
        const raw = fd.get('_actors');
        if (!raw || typeof raw !== 'string') throw new Error('Campo _actors não encontrado no chamado criado.');

        let actors;
        try { actors = JSON.parse(raw); }
        catch { throw new Error('Não consegui interpretar _actors no pós-processamento.'); }
        if (!Array.isArray(actors.assign)) actors.assign = [];

        const hasUser = actors.assign.some(a => glpiNormalize(a?.itemtype) === 'USER');
        if (!hasUser) throw new Error('Pós-correção bloqueada: usuário atribuído não encontrado; não vou sobrescrever Atribuído.');

        const serviceDesk = await directResolveAssignmentGroup('Service Desk');
        const targetName = `Sistemas ${job.data.operation}`;
        let target = null;
        const confirmed = confirmedGroupIdForOperation(job.data.operation);
        if (confirmed) {
            target = { id: String(confirmed), text: targetName };
        } else {
            target = await directResolveAssignmentGroup(targetName);
        }
        if (!target?.id) throw new Error(`Grupo ${targetName} não localizado para pós-correção.`);

        const serviceDeskId = String(serviceDesk?.id || '').match(/\d+/)?.[0] || '';
        if (serviceDeskId) {
            actors.assign = actors.assign.filter(a => !(
                glpiNormalize(a?.itemtype) === 'GROUP' &&
                String(a?.items_id || '') === serviceDeskId
            ));
        } else {
            // Não remove grupos desconhecidos. Apenas registra que não achou o Service Desk.
            console.warn('OM30 direto: Service Desk não foi resolvido por ID; nenhum grupo desconhecido será removido.');
        }

        const targetId = String(target.id).match(/\d+/)?.[0] || String(target.id);
        const already = actors.assign.some(a =>
            glpiNormalize(a?.itemtype) === 'GROUP' && String(a?.items_id || '') === targetId
        );
        if (!already) {
            actors.assign.push({
                itemtype: 'Group',
                items_id: targetId,
                use_notification: 1,
                alternative_email: ''
            });
        }

        fd.set('_actors', JSON.stringify(actors));

        // Descobre o submitter de atualização sem clicar nele.
        const buttons = [...document.querySelectorAll('button[name="update"], input[name="update"], button[type="submit"], input[type="submit"]')];
        const save = buttons.find(el => {
            const t = glpiNormalize(el.innerText || el.value || '');
            return el.name === 'update' || ['SALVAR','ATUALIZAR','SAVE','UPDATE'].includes(t);
        });
        fd.set(save?.name || 'update', save?.value || 'Salvar');

        const response = await fetch(form.action || job.ticket_url, {
            method: 'POST',
            credentials: 'include',
            body: fd,
            redirect: 'follow'
        });
        const html = await response.text();
        if (looksLikeGlpiLoginHtml(html, response.url)) {
            throw Object.assign(new Error('LOGIN_REQUIRED'), { om30LoginRequired: true });
        }
        if (!response.ok) throw new Error(`Pós-correção respondeu HTTP ${response.status}.`);

        job.assignment_direct = {
            service_desk_id: serviceDeskId || null,
            target_group_id: targetId,
            target_group: targetName,
            user_preserved: true,
            http: response.status
        };
        saveGlpiJob(job);
        return true;
    }

    async function runGlpiDirectEngine(job) {
        // LOGIN sempre antes de qualquer POST.
        if (isGlpiLoginPage()) {
            if (job.stage !== 'waiting-login') {
                job.resume_stage = job.stage || 'direct-create';
                job.stage = 'waiting-login';
                job.login_required_at = new Date().toISOString();
                saveGlpiJob(job);
            }
            saveGlpiLoginRequired(job, 'Você não está logado no GLPI. Entre na sua conta para continuar.');
            return true;
        }

        if (job.stage === 'waiting-login') {
            job.stage = job.resume_stage || 'direct-create';
            delete job.resume_stage;
            delete job.login_required_at;
            saveGlpiJob(job);
        }

        if (job.stage === 'direct-create') {
            try {
                const form = await waitForGlpi('#itil-form');

                // Ajusta apenas o valor interno da entidade, sem disparar change/rebuild.
                // A publicação usa o ID diretamente no FormData.
                const entity = document.querySelector('select[name="entities_id"]');
                if (entity && [...entity.options].some(o => String(o.value) === String(job.data.operation_id))) {
                    entity.value = String(job.data.operation_id);
                }

                const [category, unit] = await Promise.all([
                    directResolveCategory(job.data),
                    directResolveUnit(job.data)
                ]);

                const upload = await directUploadPrint(job, form);
                const fd = directPrepareCreateFormData(form, job, category, unit, upload);

                // Anti-duplicidade: marca ANTES do POST.
                job.stage = 'direct-publishing';
                job.direct_resolved = {
                    category_id: String(category.id),
                    category: category.fullText || category.text,
                    location_id: String(unit.id),
                    location: unit.fullText || unit.text,
                    print: !!upload
                };
                job.publish_attempted_at = new Date().toISOString();
                saveGlpiJob(job);

                const response = await fetch(form.action || `${GLPI_TEST.base}/front/ticket.form.php`, {
                    method: 'POST',
                    credentials: 'include',
                    body: fd,
                    redirect: 'follow'
                });
                const html = await response.text();

                if (looksLikeGlpiLoginHtml(html, response.url)) {
                    job.resume_stage = 'direct-create';
                    job.stage = 'waiting-login';
                    saveGlpiJob(job);
                    saveGlpiLoginRequired(job, 'Sua sessão do GLPI expirou antes da publicação. Faça login para continuar.');
                    return true;
                }
                if (!response.ok) throw new Error(`Criação direta respondeu HTTP ${response.status}.`);

                const ticketId = detectCreatedTicketIdFromHtml(html, response.url);
                if (!ticketId) {
                    job.direct_publish_unknown_result = true;
                    saveGlpiJob(job);
                    throw new Error('POST aceito, mas o ID do chamado não foi identificado. Por segurança, a OM30 não repetirá o POST.');
                }

                job.ticket_id = Number(ticketId);
                job.ticket_url = `${GLPI_TEST.base}/front/ticket.form.php?id=${ticketId}`;
                job.published_at = new Date().toISOString();
                job.stage = 'direct-postfix';
                saveGlpiJob(job);

                // Uma única navegação para a edição é necessária só para obter o
                // _actors atual e fazer a correção Service Desk -> Sistemas por POST.
                location.replace(job.ticket_url);
                return true;
            } catch (error) {
                if (error?.om30LoginRequired || error?.message === 'LOGIN_REQUIRED') {
                    job.resume_stage = 'direct-create';
                    job.stage = 'waiting-login';
                    saveGlpiJob(job);
                    saveGlpiLoginRequired(job, 'Sua sessão do GLPI expirou. Faça login para continuar.');
                    return true;
                }
                job.error = { step: 'POST direto', message: String(error?.message || error), at: new Date().toISOString() };
                saveGlpiJob(job);
                saveGlpiBackgroundFailure(job, 'POST direto', error);
                return true;
            }
        }

        if (job.stage === 'direct-publishing') {
            // Nunca repete um POST cujo resultado ficou desconhecido.
            return true;
        }

        if (job.stage === 'direct-postfix') {
            try {
                await directPostfixAssignment(job);
                finalizePublishedTicket(job);
            } catch (error) {
                if (error?.om30LoginRequired || error?.message === 'LOGIN_REQUIRED') {
                    job.resume_stage = 'direct-postfix';
                    job.stage = 'waiting-login';
                    saveGlpiJob(job);
                    saveGlpiLoginRequired(job, 'Sua sessão do GLPI expirou durante a correção final. Faça login para continuar.');
                    return true;
                }
                job.error = { step: 'Correção direta do Atribuído', message: String(error?.message || error), at: new Date().toISOString() };
                saveGlpiJob(job);
                saveGlpiBackgroundFailure(job, 'Correção direta do Atribuído', error);
            }
            return true;
        }

        return false;
    }

    async function executeGlpiStep(job, step, fn, next) {
        ensureGlpiBanner(`Preenchendo: ${step}...`, 'info');

        if (job.mode === 'dry-run') {
            blockGlpiPublish();
        } else {
            unblockGlpiPublish();
        }

        try {
            const detail = await fn();
            job.completed = job.completed || {};
            job.completed[step] = detail === undefined ? true : detail;
            job.stage = next;
            saveGlpiJob(job);
            console.log(`✅ OM30 GLPI: ${step}`, detail || 'OK');
            await glpiSleep(100);
            return true;
        } catch (error) {
            job.error = { step, message: String(error?.message || error), at: new Date().toISOString() };
            saveGlpiJob(job);
            saveGlpiBackgroundFailure(job, step, error);
            console.error(`❌ OM30 GLPI: ${step}`, error);
            ensureGlpiBanner(`Erro em <b>${step}</b>: ${String(error?.message || error)}. Nada foi publicado. Veja o Console (F12).`, 'error');
            return false;
        }
    }

    async function runGlpiDryRun() {
        const job = readGlpiJob();

        // Aba aberta EXCLUSIVAMENTE para login. Ela nunca executa a automação.
        // Assim que a sessão passa a estar válida, sinaliza o WhatsApp e fecha.
        if (isGlpiLoginHelperContext()) {
            if (!job) {
                setTimeout(() => { try { window.close(); } catch {} }, 400);
                return;
            }

            if (isGlpiLoginPage()) {
                ensureGlpiBanner(
                    '🔐 Faça login normalmente. Assim que o GLPI confirmar a sessão, esta aba fechará sozinha.',
                    'warning'
                );
                return;
            }

            if (job.stage === 'waiting-login') {
                job.stage = job.resume_stage || 'entity';
                delete job.resume_stage;
                delete job.login_required_at;
                job.login_confirmed_at = new Date().toISOString();
                saveGlpiJob(job);
            }

            saveGlpiResult({
                kind: 'login-confirmed',
                status: 'login-confirmed',
                job_id: job.id || '',
                at: new Date().toISOString()
            });

            ensureGlpiBanner(
                '✅ Login confirmado. Fechando esta aba e continuando o chamado em background...',
                'success'
            );

            setTimeout(() => {
                try { window.close(); } catch {}
            }, 450);
            return;
        }

        if (job && location.hostname === 'suporte.om30.cloud') {
            try {
                if (window.opener) {
                    console.log('OM30 GLPI: aba possui opener; fechamento automático disponível.');
                } else {
                    console.log('OM30 GLPI: aba sem opener; será usado fallback de fechamento.');
                }
            } catch {}
        }
        if (!job || !['dry-run', 'publish'].includes(job.mode)) return;

        // v0.7.30: o job novo usa o motor direto. Não passa pelo preenchimento
        // etapa por etapa das versões antigas.
        if (job.mode === 'publish' && job.direct_engine === true) {
            const handled = await runGlpiDirectEngine(job);
            if (handled) return;
        }

        if (job.mode === 'dry-run') {
            setInterval(blockGlpiPublish, 500);
            blockGlpiPublish();
        } else {
            unblockGlpiPublish();
        }

        // LOGIN: precisa ser tratado ANTES de qualquer estágio, inclusive pós-criação.
        // Assim não entramos em loop tentando abrir ticket.form.php enquanto a sessão expirou.
        if (isGlpiLoginPage()) {
            if (job.stage !== 'waiting-login') {
                job.resume_stage = job.stage || 'entity';
                job.stage = 'waiting-login';
                job.login_required_at = new Date().toISOString();
                saveGlpiJob(job);
            }

            saveGlpiLoginRequired(
                job,
                'Você não está logado no GLPI. Entre na sua conta para a OM30 continuar.'
            );

            ensureGlpiBanner(
                '⚠ <b>Login no GLPI necessário.</b> O WhatsApp mostrará o botão ENTRAR NO GLPI. Após o login, a aba de login fecha e o processo continua oculto.',
                'warning'
            );
            return;
        }

        // Voltou do login: retoma exatamente o estágio que estava pendente.
        if (job.stage === 'waiting-login') {
            job.stage = job.resume_stage || 'entity';
            delete job.resume_stage;
            delete job.login_required_at;
            saveGlpiJob(job);
            GM_deleteValue(GLPI_TEST.resultKey);

            ensureGlpiBanner(
                '✓ Login confirmado. Retomando o processo...',
                'success'
            );
        }

        // O POST direto já foi disparado. NUNCA repete automaticamente.
        if (job.mode === 'publish' && job.stage === 'publishing-direct') {
            ensureGlpiBanner(
                '⏳ O POST direto já foi enviado uma vez. A OM30 <b>não fará uma segunda publicação</b>. ' +
                'Se o ID não foi identificado, confira o Console antes de qualquer nova tentativa.',
                'warning'
            );
            return;
        }

        // Depois do clique, NUNCA tenta publicar novamente.
        if (job.mode === 'publish' && job.stage === 'publishing') {
            const ticketId = detectCreatedTicketId();

            if (ticketId) {
                const ticketUrl =
                    `${GLPI_TEST.base}/front/ticket.form.php?id=${ticketId}`;

                const publishedAt = new Date().toISOString();

                // O chamado foi criado, mas a página atual pode ser apenas
                // uma tela intermediária do GLPI.
                //
                // Portanto NÃO corrigimos Atribuído aqui.
                // Primeiro abrimos explicitamente a tela de edição pelo ID.
                job.stage = 'postfix-open-ticket';
                job.ticket_id = ticketId;
                job.ticket_url = ticketUrl;
                job.published_at = publishedAt;
                saveGlpiJob(job);

                ensureGlpiBanner(
                    `✓ Chamado <b>#${ticketId}</b> criado. Abrindo o chamado para corrigir o <b>Atribuído</b>...`,
                    'warning'
                );

                console.log(
                    'OM30: chamado criado; abrindo edição explícita:',
                    ticketUrl
                );

                // Navega deliberadamente para:
                // /front/ticket.form.php?id=XXXXX
                location.href = ticketUrl;
                return;
            }

            ensureGlpiBanner(
                '⏳ O envio já foi disparado. A OM30 <b>não clicará novamente</b>. Aguardando o GLPI confirmar/redirecionar...',
                'warning'
            );
            return;
        }

        if (job.mode === 'publish' && job.stage === 'postfix-open-ticket') {
            const expectedUrl =
                job.ticket_url ||
                `${GLPI_TEST.base}/front/ticket.form.php?id=${job.ticket_id}`;

            const currentId = currentTicketEditId();

            if (String(currentId || '') !== String(job.ticket_id || '')) {
                ensureGlpiBanner(
                    `Abrindo chamado <b>#${job.ticket_id}</b> para correção do Atribuído...`,
                    'warning'
                );

                location.replace(expectedUrl);
                return;
            }

            // Agora temos certeza de que é a tela de edição real.
            await waitForGlpi('#itil-form');

            job.stage = 'postfix-assign';
            saveGlpiJob(job);

            console.log(
                `OM30: tela de edição do chamado #${job.ticket_id} confirmada.`
            );

            // Continua no mesmo ciclo; o próximo IF executará postfix-assign.
        }

        if (job.mode === 'publish' && job.stage === 'postfix-assign') {
            try {
                // Permite retomar uma correção que falhou numa versão anterior
                // (ex.: chamado #154032) sem criar/publicar outro chamado.
                if (job.error) {
                    delete job.error;
                    saveGlpiJob(job);
                }

                const currentId = currentTicketEditId();

                if (String(currentId || '') !== String(job.ticket_id || '')) {
                    job.stage = 'postfix-open-ticket';
                    saveGlpiJob(job);

                    location.replace(
                        job.ticket_url ||
                        `${GLPI_TEST.base}/front/ticket.form.php?id=${job.ticket_id}`
                    );
                    return;
                }

                await waitForGlpi('#itil-form');
                await savePostCreationAssignmentFix(job);
            } catch (error) {
                job.error = {
                    step: 'Correção pós-criação do Atribuído',
                    message: String(error?.message || error),
                    at: new Date().toISOString()
                };
                saveGlpiJob(job);

                console.error(
                    '❌ OM30 pós-criação Atribuído:',
                    error
                );

                ensureGlpiBanner(
                    `❌ Chamado #${job.ticket_id} foi criado, mas a correção do <b>Atribuído</b> falhou: ` +
                    `${String(error?.message || error)}. ` +
                    `<b>A aba ficará aberta e a OM30 NÃO considerará o processo concluído.</b>`,
                    'error'
                );
            }

            return;
        }

        if (job.mode === 'publish' && job.stage === 'postfix-saving') {
            // O clique em Salvar já aconteceu.
            // NUNCA clica de novo automaticamente.
            const currentId = currentTicketEditId();

            if (String(currentId || '') !== String(job.ticket_id || '')) {
                ensureGlpiBanner(
                    `✓ Correção do Atribuído já foi salva uma vez. Reabrindo chamado <b>#${job.ticket_id}</b> somente para validar...`,
                    'warning'
                );

                // NÃO salva de novo. Apenas reabre a edição para conferência.
                location.replace(
                    job.ticket_url ||
                    `${GLPI_TEST.base}/front/ticket.form.php?id=${job.ticket_id}`
                );
                return;
            }

            try {
                await waitForGlpi('#itil-form');
                await glpiSleep(300);

                const verification =
                    verifyPostCreationAssignmentFix(job);

                console.log(
                    'OM30 pós-criação: validação final do Atribuído',
                    verification
                );

                if (!verification.ok) {
                    throw new Error(
                        `Validação final falhou. ` +
                        `Service Desk removido=${verification.serviceDeskRemoved}; ` +
                        `usuário preservado=${verification.userPreserved}; ` +
                        `Sistemas ${job.data.operation} presente=${verification.targetGroup}.`
                    );
                }

                finalizePublishedTicket(job);
            } catch (error) {
                job.error = {
                    step: 'Validação pós-criação do Atribuído',
                    message: String(error?.message || error),
                    at: new Date().toISOString()
                };
                saveGlpiJob(job);

                console.error(
                    '❌ OM30 validação pós-criação:',
                    error
                );

                ensureGlpiBanner(
                    `❌ Chamado #${job.ticket_id} foi criado, mas o <b>Atribuído</b> ainda não ficou correto: ` +
                    `${String(error?.message || error)}. ` +
                    `<b>Não vou fechar esta aba.</b>`,
                    'error'
                );
            }

            return;
        }

        if (job.mode === 'publish' && job.stage === 'published') {
            ensureGlpiBanner(
                `✅ Chamado <b>#${job.ticket_id || '?'}</b> criado e Atribuído corrigido. Publicação encerrada.`,
                'success'
            );
            return;
        }

        if (job.stage === 'done') {
            if (job.mode === 'publish') {
                job.stage = 'publish';
                saveGlpiJob(job);
            } else {
                ensureGlpiBanner('✅ Preenchimento concluído. Confira os campos abaixo. <b>Nenhum chamado foi publicado</b> e o botão Adicionar está bloqueado.', 'success');
                return;
            }
        }

        // Abre SEMPRE diretamente a tela de criação de chamado.
        // A operação/entidade é selecionada no próprio formulário pelo campo entities_id.
        if (!location.pathname.includes('/front/ticket.form.php')) {
            location.replace(`${GLPI_TEST.base}/front/ticket.form.php`);
            return;
        }

        await waitForGlpi('#itil-form');

        if (job.mode === 'dry-run') blockGlpiPublish();
        else unblockGlpiPublish();

        // Compatibilidade com jobs iniciados por versões anteriores.
        if (job.stage === 'open-form') {
            job.stage = 'entity';
            saveGlpiJob(job);
        }

        while (true) {
            const data = job.data;

            if (!job.stage || job.stage === 'entity') {
                // A entidade precisa estar correta antes de mexer no formulário,
                // pois trocar a operação pode reconstruir todos os campos.
                if (!await executeGlpiStep(job, 'Operação', () => setGlpiEntity(data), 'status')) return;
                continue;
            }

            if (job.stage === 'status') {
                // PRIMEIRO: Solucionado.
                // Não exigimos Data da solução ainda.
                if (!await executeGlpiStep(job, 'Status Solucionado', () => setGlpiSolvedStatus(), 'type')) return;
                continue;
            }

            if (job.stage === 'type') {
                // SEGUNDO: Tipo, preservando Solucionado e o campo solvedate.
                if (!await executeGlpiStep(job, 'Tipo', () => setGlpiTypeKeepingSolved(data.type_id), 'category')) return;
                continue;
            }

            if (job.stage === 'category') {
                ensureGlpiBanner(
                    `Selecionando categoria: <b>${data.system} › ${data.category}</b>...`,
                    'info'
                );

                try {
                    const resolved = await resolveGlpiCategory(data);

                    // Guarda exatamente qual categoria/ID foi resolvida.
                    job.category_expected_id = String(resolved.result.id);
                    job.category_expected_leaf = data.category;

                    // IMPORTANTE:
                    // salva uma etapa intermediária ANTES do "change" real.
                    // Se o GLPI recarregar o formulário, não voltamos para Categoria
                    // e não criamos o loop antigo.
                    job.stage = 'category-validate';
                    saveGlpiJob(job);

                    await applyGlpiCategoryReal(data, resolved);

                    // Se não houve reload, valida imediatamente.
                    validateGlpiCategorySelection(
                        data,
                        job.category_expected_id
                    );

                    job.stage = 'solution-date';
                    saveGlpiJob(job);
                    continue;
                } catch (error) {
                    job.error = {
                        step: 'Categoria',
                        message: String(error?.message || error),
                        at: new Date().toISOString()
                    };
                    saveGlpiJob(job);

                    console.error('❌ OM30 GLPI Categoria:', error);

                    ensureGlpiBanner(
                        `Erro em <b>Categoria</b>: ${String(error?.message || error)}. ` +
                        `Nada foi publicado.`,
                        'error'
                    );
                    return;
                }
            }

            if (job.stage === 'category-validate') {
                // Se o GLPI recarregou por causa do change da categoria,
                // chegamos aqui. Valida que ficou no categoria correto.
                try {
                    validateGlpiCategorySelection(
                        data,
                        job.category_expected_id
                    );

                    ensureGlpiBanner(
                        `✓ Categoria confirmada: <b>${data.system} › ${data.category}</b>`,
                        'success'
                    );

                    job.stage = 'solution-date';
                    saveGlpiJob(job);
                    continue;
                } catch (error) {
                    job.error = {
                        step: 'Categoria',
                        message: String(error?.message || error),
                        at: new Date().toISOString()
                    };
                    saveGlpiJob(job);

                    ensureGlpiBanner(
                        `Erro em <b>Categoria</b>: ${String(error?.message || error)}. ` +
                        `O chamado NÃO será publicado.`,
                        'error'
                    );
                    return;
                }
            }

            if (job.stage === 'solution-date') {
                // Antes da Data da solução, valida NOVAMENTE a categoria.
                // Isso impede publicar "Painel de Senha" quando o correto era "Erro".
                validateGlpiCategorySelection(
                    data,
                    job.category_expected_id || null
                );

                if (!await executeGlpiStep(
                    job,
                    'Data da solução',
                    () => setGlpiDate('solvedate', data.solution_date, true),
                    'initial-date'
                )) return;

                continue;
            }

            if (job.stage === 'initial-date') {
                if (!await executeGlpiStep(job, 'Data inicial', () => setGlpiDate('date', data.initial_date, false), 'unit')) return;
                continue;
            }
            if (job.stage === 'unit') {
                if (!await executeGlpiStep(job, 'Unidade', () => setGlpiUnit(data), 'assign')) return;
                continue;
            }
            if (job.stage === 'assign') {
                if (!await executeGlpiStep(job, 'Atribuído', () => addGlpiGroup(data), 'title')) return;
                continue;
            }
            if (job.stage === 'title') {
                if (!await executeGlpiStep(job, 'Título', () => setGlpiTitle(data.title), 'description')) return;
                continue;
            }
            if (job.stage === 'description') {
                if (!await executeGlpiStep(job, 'Descrição', () => setGlpiDescription(data.description), 'attachment')) return;
                continue;
            }
            if (job.stage === 'attachment') {
                const nextStage =
                    job.mode === 'publish'
                        ? 'publish'
                        : 'done';

                if (!await executeGlpiStep(
                    job,
                    'Print na descrição',
                    () => pasteOrAttachGlpiPrint(job),
                    nextStage
                )) return;

                continue;
            }

            if (job.stage === 'publish') {
                try {
                    await publishGlpiTicket(job);
                } catch (error) {
                    job.error = {
                        step: 'Publicar',
                        message: String(error?.message || error),
                        at: new Date().toISOString()
                    };
                    saveGlpiJob(job);

                    console.error('❌ OM30 GLPI: publicação cancelada', error);
                    ensureGlpiBanner(
                        `❌ Publicação interrompida: ${String(error?.message || error)}. O POST direto não será repetido automaticamente.`,
                        'error'
                    );
                }
                return;
            }

            if (job.stage === 'done') {
                job.finished_at = new Date().toISOString();
                saveGlpiJob(job);
                blockGlpiPublish();
                ensureGlpiBanner('✅ Teste concluído: Solucionado → Tipo → Categoria → Data da solução → demais campos preenchidos para conferência. <b>NÃO PUBLICAR</b>: o botão Adicionar continua bloqueado.', 'success');
                window.scrollTo({ top: 0, behavior: 'smooth' });
                return;
            }

            throw new Error(`Etapa GLPI desconhecida: ${job.stage}`);
        }
    }

    // v0.8.0:
    // Em páginas normais do GLPI não existe mais automação de chamado.
    // A única exceção é a janela/aba VISÍVEL aberta pelo próprio usuário para login.
    if (location.hostname === 'suporte.om30.cloud') {
        if (isGlpiLoginHelperContext()) {
            runGlpiDryRun().catch(error => {
                console.error('OM30 login helper:', error);
                saveGlpiResult({
                    kind: 'background-error',
                    status: 'error',
                    title: 'Erro ao confirmar login no GLPI',
                    message: String(error?.message || error),
                    step: 'Login',
                    job_id: readGlpiJob()?.id || '',
                    at: new Date().toISOString()
                });
            });
        }
        return;
    }

    const ID = {
        panel: 'om30-panel',
        launcher: 'om30-launcher',
        camera: 'om30-camera',
        reader: 'om30-read-messages',
        selectionBar: 'om30-selection-bar',
        ticketResult: 'om30-ticket-result',
        settingsMenu: 'om30-settings-menu',
        historyOverlay: 'om30-history-overlay',
        style: 'om30-style',
        crop: 'om30-crop-overlay',
        mode: 'om30-mode-overlay'
    };
    const CLS_SELECTED = 'om30-selected-message';
    const KEY = {
        mode: 'OM30_MODE_V063',
        units: 'OM30_UNIT_MAP_V063',
        senders: 'OM30_SENDERS_V063',
        position: 'OM30_POSITION_V063',
        operation: 'OM30_OPERATION_V063',
        dismissedTicket: 'OM30_DISMISSED_TICKET_V0714',
        ticketHistory: 'OM30_TICKET_HISTORY_V0728'
    };

    const selected = new Map();
    let printMessages = [];
    let printBlob = null;
    let printURL = null;
    let previousChat = '';
    let panelOpened = false;

    let unitManual = false;
    let classificationManual = false;
    let initialManual = false;
    let solutionManual = false;
    let titleManual = false;
    let descriptionManual = false;

    // ============================================================
    // POSIÇÃO SEGURA DA JANELA OM30
    // Evita a ficha ficar quase toda fora da tela após captura de print,
    // mudança de resolução, zoom ou posição antiga salva no navegador.
    // ============================================================

    function safePanelPosition(left, top) {
        const width = Math.min(455, Math.max(260, innerWidth - 10));
        const maxLeft = Math.max(5, innerWidth - width - 5);
        const maxTop = Math.max(5, innerHeight - 70);

        const parsedLeft = Number(left);
        const parsedTop = Number(top);

        return {
            left: Number.isFinite(parsedLeft) ? Math.max(5, Math.min(parsedLeft, maxLeft)) : maxLeft,
            top: Number.isFinite(parsedTop) ? Math.max(5, Math.min(parsedTop, maxTop)) : 64
        };
    }

    function ensurePanelInViewport(panel, save = true) {
        if (!panel) return;

        const rect = panel.getBoundingClientRect();
        const width = rect.width || 455;
        const height = rect.height || 64;

        let left = rect.left;
        let top = rect.top;

        // Se a posição salva veio de outra resolução/zoom, pode sobrar só um
        // pedacinho azul no canto. Nessa situação, reposiciona no topo direito.
        const visibleWidth = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
        const visibleHeight = Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));

        if (visibleWidth < Math.min(120, width * 0.35) || visibleHeight < 45) {
            left = Math.max(5, innerWidth - Math.min(width, 455) - 18);
            top = 64;
        }

        const maxLeft = Math.max(5, innerWidth - Math.min(width, innerWidth - 10) - 5);
        const maxTop = Math.max(5, innerHeight - Math.min(height, innerHeight - 10));

        left = Math.max(5, Math.min(left, maxLeft));
        top = Math.max(5, Math.min(top, Math.max(5, maxTop)));

        panel.style.left = `${Math.round(left)}px`;
        panel.style.top = `${Math.round(top)}px`;
        panel.style.right = 'auto';

        if (save) {
            saveJSON(KEY.position, {
                left: Math.round(left),
                top: Math.round(top)
            });
        }
    }

    function showPanelSafely(panel) {
        if (!panel) return;
        panelOpened = true;
        panel.style.display = '';

        requestAnimationFrame(() => {
            ensurePanelInViewport(panel);
            updateFloating();
        });
    }

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const clean = v => String(v || '').replace(/\u200e|\u200f/g, '').replace(/\s+/g, ' ').trim();
    const normalize = v => String(v || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toUpperCase().replace(/[^\p{L}\p{N}+]+/gu, ' ')
        .replace(/\s+/g, ' ').trim();

    function loadJSON(key, fallback = {}) {
        try {
            const value = localStorage.getItem(key);
            return value ? JSON.parse(value) : fallback;
        } catch {
            return fallback;
        }
    }
    function saveJSON(key, value) {
        localStorage.setItem(key, JSON.stringify(value));
    }
    function uniqueById(items) {
        return [...new Map(items.map(x => [x.id, x])).values()];
    }
    function looksLikePhone(v) {
        return String(v || '').replace(/\D/g, '').length >= 10;
    }
    function escapeHTML(v) {
        const el = document.createElement('div');
        el.textContent = String(v || '');
        return el.innerHTML;
    }

    // ============================================================
    // ÚLTIMO CHAMADO CRIADO
    // ============================================================

    function dismissedTicketId() {
        return String(localStorage.getItem(KEY.dismissedTicket) || '');
    }

    function dismissTicketResult(ticketId) {
        localStorage.setItem(KEY.dismissedTicket, String(ticketId || ''));
        const box = document.getElementById(ID.ticketResult);
        if (box) box.style.display = 'none';
    }

    // ============================================================
    // HISTÓRICO LOCAL DE CHAMADOS
    // Excluir daqui NÃO exclui o chamado no GLPI.
    // ============================================================

    function getTicketHistory() {
        const list = loadJSON(KEY.ticketHistory, []);
        return Array.isArray(list) ? list : [];
    }

    function saveTicketHistory(list) {
        saveJSON(KEY.ticketHistory, (Array.isArray(list) ? list : []).slice(0, 100));
    }

    function addTicketToHistory(result) {
        if (!result?.ticket_id || !result?.ticket_url) return;
        const id = String(result.ticket_id);
        const list = getTicketHistory().filter(item => String(item.ticket_id) !== id);
        list.unshift({
            ticket_id: id,
            ticket_url: result.ticket_url,
            title: result.title || `Chamado #${id}`,
            unit: result.unit || '',
            operation: result.operation || '',
            published_at: result.published_at || new Date().toISOString()
        });
        saveTicketHistory(list);
        renderSettingsMenu();
        renderHistoryShortcut();
        renderLastTicketMain();
    }

    function removeTicketFromHistory(ticketId) {
        const id = String(ticketId || '');
        saveTicketHistory(getTicketHistory().filter(item => String(item.ticket_id) !== id));
        renderSettingsMenu();
        renderHistoryShortcut();
        renderLastTicketMain();
        renderTicketHistory();
    }

    function formatHistoryDate(value) {
        try {
            const dt = new Date(value);
            if (!Number.isNaN(dt.getTime())) return dt.toLocaleString('pt-BR');
        } catch {}
        return '';
    }

    function renderSettingsMenu() {
        const menu = document.getElementById(ID.settingsMenu);
        if (!menu) return;
        const mode = menu.querySelector('#om30-settings-mode-label');
        if (mode) mode.textContent = modeLabel();
    }

    function renderHistoryShortcut() {
        const button = document.getElementById('om30-history');
        if (!button) return;
        const count = getTicketHistory().length;
        button.title = count
            ? `Histórico de chamados (${count})`
            : 'Histórico de chamados';
        button.dataset.count = String(count);
    }

    // O último chamado fica permanentemente visível na ficha principal.
    // Criar um novo chamado NÃO depende de fechar/ocultar este cartão.
    function renderLastTicketMain() {
        const box = document.getElementById(ID.ticketResult);
        if (!box) return;

        // Enquanto existe uma mensagem operacional do GLPI (login/erro),
        // ela tem prioridade sobre o cartão do último chamado.
        if (box.classList.contains('om30-result-login')) return;

        const last = getTicketHistory()[0];
        const number = box.querySelector('.om30-result-number');
        const title = box.querySelector('.om30-result-title');
        const view = box.querySelector('.om30-result-view');
        const close = box.querySelector('.om30-result-close');
        const check = box.querySelector('.om30-result-check');

        if (!last?.ticket_id || !last?.ticket_url) {
            box.style.display = 'none';
            return;
        }

        box.classList.remove(
            'om30-result-login',
            'om30-result-progress'
        );
        delete box.dataset.successToast;
        box.dataset.successTicketId = String(last.ticket_id);
        box.style.display = 'flex';

        if (check) check.textContent = '✓';
        if (number) number.textContent = `Chamado #${last.ticket_id} criado`;
        if (title) title.textContent = last.title || last.unit || 'Chamado criado no GLPI';
        if (view) {
            view.textContent = 'VER CHAMADO';
            view.disabled = false;
            view.onclick = () => openCreatedTicket(last.ticket_url);
        }
        // O último chamado deve permanecer na tela. Não há necessidade de fechar.
        if (close) close.style.display = 'none';
    }

    function openTicketHistory() {
        document.getElementById(ID.historyOverlay)?.remove();
        const overlay = document.createElement('div');
        overlay.id = ID.historyOverlay;
        overlay.innerHTML = `
            <div class="om30-history-modal">
                <div class="om30-history-head">
                    <b>Chamados criados pela OM30</b>
                    <button type="button" id="om30-history-close">×</button>
                </div>
                <div id="om30-history-list" class="om30-history-list"></div>
                <div class="om30-history-footer">
                    <button type="button" id="om30-history-clear">Limpar histórico deste navegador</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        overlay.querySelector('#om30-history-close').onclick = () => overlay.remove();
        overlay.addEventListener('click', event => { if (event.target === overlay) overlay.remove(); });
        overlay.querySelector('#om30-history-clear').onclick = () => {
            if (!getTicketHistory().length) return;
            if (!confirm('Limpar o histórico local de chamados? Isso NÃO exclui nenhum chamado do GLPI.')) return;
            saveTicketHistory([]);
            renderSettingsMenu();
            renderHistoryShortcut();
            renderLastTicketMain();
            renderTicketHistory();
        };
        renderTicketHistory();
    }

    function renderTicketHistory() {
        const listBox = document.querySelector(`#${ID.historyOverlay} #om30-history-list`);
        if (!listBox) return;
        const list = getTicketHistory();
        if (!list.length) {
            listBox.innerHTML = '<div class="om30-history-empty">Nenhum chamado registrado neste navegador.</div>';
            return;
        }

        listBox.innerHTML = list.map(item => `
            <div class="om30-history-item" data-ticket-id="${escapeHTML(item.ticket_id)}">
                <div>
                    <b>Chamado #${escapeHTML(item.ticket_id)}</b>
                    <span>${escapeHTML(item.title || 'Chamado criado')}</span>
                    <small>${[item.unit, formatHistoryDate(item.published_at)].filter(Boolean).map(escapeHTML).join(' • ')}</small>
                </div>
                <div class="om30-history-actions">
                    <button type="button" class="om30-history-view">VER</button>
                    <button type="button" class="om30-history-delete" title="Excluir somente do histórico local">EXCLUIR</button>
                </div>
            </div>`).join('');

        listBox.querySelectorAll('.om30-history-item').forEach(row => {
            const id = row.dataset.ticketId;
            const item = getTicketHistory().find(entry => String(entry.ticket_id) === String(id));
            row.querySelector('.om30-history-view').onclick = () => { if (item?.ticket_url) openCreatedTicket(item.ticket_url); };
            row.querySelector('.om30-history-delete').onclick = () => removeTicketFromHistory(id);
        });
    }

    function openGlpiAutomationTab(url) {
        // Para a automação, usamos window.open em vez de GM_openInTab.
        // Assim a guia é criada pelo próprio JavaScript e pode executar
        // window.close() ao terminar o processo.
        //
        // Este método é chamado diretamente a partir do clique do usuário,
        // então normalmente não é bloqueado como popup.
        let tab = null;

        try {
            tab = window.open(url, '_blank');
        } catch (error) {
            console.warn('OM30: window.open falhou', error);
        }

        if (tab) {
            try {
                tab.name = 'OM30_GLPI_AUTOMATION';
            } catch {}

            return {
                mode: 'window.open',
                opened: true
            };
        }

        // Fallback Tampermonkey caso o navegador bloqueie window.open.
        try {
            GM_openInTab(
                url,
                {
                    active: true,
                    insert: true,
                    setParent: true
                }
            );

            return {
                mode: 'GM_openInTab',
                opened: true
            };
        } catch (error) {
            console.error('OM30: não consegui abrir GLPI', error);

            return {
                mode: 'failed',
                opened: false
            };
        }
    }

    function closeGlpiAutomationTab() {
        // No modo novo, o GLPI roda em uma aba top-level inativa.
        // O resultado já foi salvo; o WhatsApp fechará essa aba pelo handle do GM_openInTab.
        if (isGlpiBackgroundContext()) {
            console.log('OM30: fluxo GLPI de background concluído; aguardando o WhatsApp fechar a aba inativa.');
            return;
        }

        // Só é executado depois que:
        // 1. chamado foi criado;
        // 2. Atribuído foi corrigido;
        // 3. alteração foi salva;
        // 4. validação final passou.

        console.log('OM30: tentando fechar aba GLPI e retornar ao WhatsApp...');

        // Método principal.
        try {
            window.close();
        } catch (error) {
            console.warn('OM30: window.close() falhou', error);
        }

        // Alguns navegadores só permitem após navegar a própria janela.
        setTimeout(() => {
            try {
                if (!window.closed) {
                    window.open('', '_self');
                    window.close();
                }
            } catch (error) {
                console.warn('OM30: fallback _self close falhou', error);
            }
        }, 250);

        // Último fallback. Se o navegador bloquear fechamento,
        // deixa uma mensagem clara para não parecer que a automação travou.
        setTimeout(() => {
            try {
                if (!window.closed) {
                    ensureGlpiBanner(
                        '✅ Processo concluído. O navegador bloqueou o fechamento automático desta guia. ' +
                        'O resultado já está salvo no WhatsApp; esta guia pode ser fechada.',
                        'success'
                    );
                }
            } catch {}
        }, 900);
    }

    function openCreatedTicket(url) {
        if (!url) return;

        // Abre apenas para consulta. Como o job de automação já foi apagado
        // depois da criação, esta página NÃO será preenchida nem fechada sozinha.
        GM_openInTab(url, {
            active: true,
            insert: true,
            setParent: true
        });
    }

    function silentFriendlyStage(stage) {
        const labels = {
            'silent-create':
                'Preparando chamado',
            'silent-form':
                'Conectando ao GLPI',
            'silent-user':
                'Confirmando usuário',
            'silent-resolve':
                'Localizando categoria e unidade',
            'silent-upload':
                'Enviando evidência',
            'silent-ready':
                'Preparando envio',
            'silent-publishing':
                'Criando chamado',
            'silent-identify':
                'Confirmando número do chamado',
            'silent-postfix':
                'Ajustando atribuição',
            'silent-validate':
                'Conferindo chamado',
            'waiting-login':
                'Aguardando login',
            'silent-publish-unknown':
                'Conferindo publicação'
        };

        return (
            labels[String(stage || '')] ||
            'Processando chamado'
        );
    }

    function silentFriendlyErrorMessage(message) {
        let text =
            String(
                message ||
                'Não foi possível concluir o chamado.'
            )
                .replace(
                    /^silent-[a-z-]+\s*:\s*/i,
                    ''
                )
                .replace(
                    /\bGM_xmlhttpRequest\b/gi,
                    'comunicação'
                )
                .trim();

        if (
            /Unidade não localizada no GLPI/i.test(
                text
            )
        ) {
            text =
                text.replace(
                    /Unidade não localizada no GLPI:\s*/i,
                    'Não encontrei a unidade no GLPI: '
                );
        }

        return text;
    }

    function renderSilentProgress(job, queueCount = 0) {
        const box =
            document.getElementById(
                ID.ticketResult
            );

        if (!box || !job) {
            return false;
        }

        const number =
            box.querySelector(
                '.om30-result-number'
            );

        const title =
            box.querySelector(
                '.om30-result-title'
            );

        const view =
            box.querySelector(
                '.om30-result-view'
            );

        const close =
            box.querySelector(
                '.om30-result-close'
            );

        const check =
            box.querySelector(
                '.om30-result-check'
            );

        box.classList.remove(
            'om30-result-login'
        );

        box.classList.add(
            'om30-result-progress'
        );

        box.style.display =
            'flex';

        if (check) {
            check.textContent =
                '•••';
        }

        if (number) {
            number.textContent =
                silentFriendlyStage(
                    job.stage
                );
        }

        if (title) {
            const titleText =
                job.data?.title ||
                job.data?.unit ||
                'Chamado OM30';

            title.textContent =
                queueCount > 0
                    ? `${titleText} · ${queueCount} na fila`
                    : titleText;
        }

        if (view) {
            view.textContent =
                'PROCESSANDO';

            view.disabled =
                true;

            view.onclick =
                null;
        }

        if (close) {
            close.style.display =
                'none';
        }

        return true;
    }

    function resetTicketResultVisualState() {
        const box =
            document.getElementById(
                ID.ticketResult
            );

        if (!box) return;

        box.classList.remove(
            'om30-result-login',
            'om30-result-progress'
        );

        const view =
            box.querySelector(
                '.om30-result-view'
            );

        if (view) {
            view.disabled =
                false;
        }
    }

    function clearStaleResultBeforeNewJob() {
        const result =
            readGlpiResult();

        if (!result) {
            return;
        }

        const isError =
            result.kind ===
                'background-error' ||
            result.status ===
                'error';

        if (isError) {
            try {
                localStorage.setItem(
                    SILENT_GLPI.lastErrorKey,
                    JSON.stringify(
                        result
                    )
                );
            } catch {}

            GM_deleteValue(
                GLPI_TEST.resultKey
            );

            resetTicketResultVisualState();

            return;
        }

        // Resultado de sucesso pendente: joga no histórico antes do novo job.
        if (
            result.ticket_id &&
            result.ticket_url
        ) {
            syncGlpiResult();
        }
    }

    function setCreateButtonFeedback(
        button,
        queued
    ) {
        if (!button) {
            return;
        }

        clearTimeout(
            button.__om30FeedbackTimer
        );

        button.disabled =
            true;

        button.classList.remove(
            'om30-creating'
        );

        button.classList.add(
            'om30-enqueued'
        );

        button.textContent =
            queued.started
                ? '✓ CRIAÇÃO INICIADA'
                : `✓ NA FILA (${queued.position})`;

        button.__om30FeedbackTimer =
            setTimeout(
                () => {
                    button.classList.remove(
                        'om30-enqueued',
                        'om30-creating'
                    );

                    button.textContent =
                        'CRIAR CHAMADO';

                    button.disabled =
                        false;
                },
                1100
            );
    }

    function syncGlpiResult() {
        const result = readGlpiResult();
        const box = document.getElementById(ID.ticketResult);

        if (!box) return;

        const number = box.querySelector('.om30-result-number');
        const title = box.querySelector('.om30-result-title');
        const view = box.querySelector('.om30-result-view');
        const close = box.querySelector('.om30-result-close');
        const check = box.querySelector('.om30-result-check');

        // Sem resultado final, mas com job ativo: mostra progresso real.
        if (!result) {
            const active =
                readGlpiJob();

            if (
                active &&
                active.stage !==
                    'waiting-login'
            ) {
                renderSilentProgress(
                    active,
                    readGlpiQueue().length
                );

                return;
            }

            resetTicketResultVisualState();
            renderLastTicketMain();
            return;
        }

        // Resultado final/login/erro substitui o cartão de progresso.
        box.classList.remove(
            'om30-result-progress'
        );

        if (result?.kind === 'background-error' || result?.status === 'error' ||
            result?.kind === 'login-required' || result?.status === 'login-required' ||
            result?.kind === 'login-confirmed' || result?.status === 'login-confirmed') {
            delete box.dataset.successToast;
            if (close) close.style.display = '';
        }

        // ========================================================
        // ERRO DO MOTOR OCULTO
        // ========================================================
        if (result?.kind === 'background-error' || result?.status === 'error') {
            closeGlpiBackgroundTab();
            box.style.display = 'flex';
            box.classList.add('om30-result-login');

            if (check) check.textContent = '×';
            if (number) number.textContent = result.title || 'Erro no GLPI';
            if (title) {
                const friendlyStep =
                    silentFriendlyStage(
                        result.raw_step ||
                        result.step
                    );

                const friendlyMessage =
                    silentFriendlyErrorMessage(
                        result.message
                    );

                title.textContent =
                    `${friendlyStep}: ${friendlyMessage}`;
            }

            if (view) {
                if (result.ticket_url) {
                    view.textContent = 'ABRIR CHAMADO';
                    view.onclick = () => openCreatedTicket(result.ticket_url);
                } else {
                    view.textContent = 'ABRIR GLPI';
                    view.onclick = () => openGlpiLoginWindow(`${GLPI_TEST.base}/front/ticket.form.php`);
                }
            }

            if (close) {
                close.onclick = () => {
                    GM_deleteValue(GLPI_TEST.resultKey);
                    closeGlpiBackgroundTab();
                    box.classList.remove('om30-result-login');
                    renderLastTicketMain();
                    setTimeout(kickSilentGlpiQueue, 0);
                };
            }

            if (!panelOpened) {
                const panel = document.getElementById(ID.panel);
                if (panel) showPanelSafely(panel);
            }
            return;
        }

        // ========================================================
        // LOGIN CONFIRMADO: recarrega o motor oculto e continua.
        // ========================================================
        if (result?.kind === 'login-confirmed' || result?.status === 'login-confirmed') {
            GM_deleteValue(GLPI_TEST.resultKey);

            // Retoma o job no próprio WhatsApp via GM_xmlhttpRequest.
            const waitingJob = readGlpiJob();
            if (waitingJob?.stage === 'waiting-login') {
                waitingJob.stage =
                    waitingJob.resume_stage ||
                    'silent-create';
                delete waitingJob.resume_stage;
                delete waitingJob.login_required_at;
                waitingJob.login_confirmed_at =
                    new Date().toISOString();
                saveGlpiJob(waitingJob);
            }

            kickSilentGlpiQueue();

            box.style.display = 'flex';
            box.classList.add('om30-result-login');
            if (check) check.textContent = '✓';
            if (number) number.textContent = 'Login confirmado';
            if (title) title.textContent = 'Continuando o chamado...';
            if (view) {
                view.textContent = 'AGUARDE';
                view.onclick = null;
            }

            setTimeout(() => {
                const current = readGlpiResult();
                if (!current) {
                    box.classList.remove('om30-result-login');
                    renderLastTicketMain();
                }
            }, 1800);
            return;
        }

        // ========================================================
        // LOGIN NECESSÁRIO
        // ========================================================
        if (result?.kind === 'login-required' || result?.status === 'login-required') {
            // A aba de background já confirmou que não há sessão válida.
            // Fecha ela e só abre uma aba VISÍVEL quando o usuário clicar ENTRAR NO GLPI.
            closeGlpiBackgroundTab();
            box.style.display = 'flex';
            box.classList.add('om30-result-login');

            if (check) check.textContent = '!';
            if (number) number.textContent = 'Login no GLPI necessário';
            if (title) {
                title.textContent =
                    result.message ||
                    'Entre no GLPI para continuar a criação do chamado.';
            }

            if (view) {
                view.textContent = 'ENTRAR NO GLPI';
                view.onclick = () => {
                    const url = result.login_url || GLPI_TEST.base;
                    const opened = openGlpiLoginWindow(url);

                    if (!opened.opened) {
                        alert('❌ Não consegui abrir a página de login do GLPI.');
                    }
                };
            }

            if (close) {
                close.onclick = () => {
                    GM_deleteValue(GLPI_TEST.resultKey);
                    box.classList.remove('om30-result-login');
                    renderLastTicketMain();
                };
            }

            if (!panelOpened) {
                const panel = document.getElementById(ID.panel);
                if (panel) showPanelSafely(panel);
            } else {
                ensurePanelInViewport(document.getElementById(ID.panel));
            }

            return;
        }

        box.classList.remove('om30-result-login');
        if (check) check.textContent = '✓';
        if (view) view.textContent = 'VER CHAMADO';

        if (!result?.ticket_id || !result?.ticket_url) {
            renderLastTicketMain();
            return;
        }

        if (!glpiHasPendingWork()) closeGlpiBackgroundTab();

        const successResult = { ...result };
        addTicketToHistory(successResult);
        GM_deleteValue(GLPI_TEST.resultKey);
        localStorage.removeItem(KEY.dismissedTicket);

        // O cartão da ficha principal representa sempre o ÚLTIMO chamado criado.
        // Ele permanece visível e não bloqueia a criação dos próximos jobs.
        renderLastTicketMain();

        if (!panelOpened) {
            const panel = document.getElementById(ID.panel);
            if (panel) showPanelSafely(panel);
        }

        try {
            window.focus();
        } catch {}

        // Agora que o resultado foi salvo no histórico/cartão,
        // libera o próximo chamado da fila.
        setTimeout(
            kickSilentGlpiQueue,
            0
        );
    }

    // ============================================================
    // PREFERÊNCIA
    // ============================================================

    function getMode() {
        return localStorage.getItem(KEY.mode) || '';
    }

    function setMode(mode) {
        localStorage.setItem(KEY.mode, mode);
        document.getElementById(ID.mode)?.remove();

        // Trocar o modo começa uma evidência nova.
        // Um print anterior nunca pode sobreviver e ser misturado
        // com mensagens escolhidas depois.
        resetDraftFormForNextTicket();

        const panel = document.getElementById(ID.panel);
        const chip = panel?.querySelector('#om30-mode-chip');
        if (chip) chip.textContent = modeLabel();

        // Escolher o modo de evidência nunca abre a ficha automaticamente.
        if (!panelOpened && panel) panel.style.display = 'none';

        updateFloating();
        renderSettingsMenu();
    }

    function chooseMode(force = false) {
        if (getMode() && !force) return;

        document.getElementById(ID.mode)?.remove();

        const overlay = document.createElement('div');
        overlay.id = ID.mode;
        overlay.innerHTML = `
            <div class="om30-mode-modal">
                <div class="om30-mode-logo">OM30</div>
                <h2>Como prefere registrar a evidência?</h2>
                <p>A escolha fica salva neste navegador e pode ser alterada depois.</p>

                <button type="button" data-mode="mensagens">
                    <span class="om30-mode-icon">💬</span>
                    <span><b>Selecionar mensagens</b><small>Use Ctrl + clique nas mensagens</small></span>
                </button>

                <button type="button" data-mode="print">
                    <span class="om30-mode-icon">📷</span>
                    <span><b>Print</b><small>Recorte somente o trecho necessário</small></span>
                </button>

                <button type="button" data-mode="ambos">
                    <span class="om30-mode-icon">✨</span>
                    <span><b>Mensagens + Print</b><small>Use as duas evidências</small></span>
                </button>
            </div>`;

        document.body.appendChild(overlay);
        overlay.querySelectorAll('[data-mode]').forEach(btn => {
            btn.onclick = () => setMode(btn.dataset.mode);
        });
    }

    // ============================================================
    // CHAT
    // ============================================================

    const INVALID_TITLES = [
        'DADOS DO PERFIL', 'ADICIONAR A LISTA', 'ADICIONAR À LISTA',
        'PESQUISAR', 'SEARCH', 'MENU', 'VIDEO', 'VÍDEO', 'CHAMADA',
        'SILENCIAR', 'CLIQUE PARA DADOS DO PERFIL',
        'CLIQUE PARA DADOS DO CONTATO', 'CLIQUE PARA DADOS DO GRUPO'
    ];

    function visible(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    }

    function validTitle(text) {
        text = clean(text);
        if (!text || text.length < 2) return false;
        const n = normalize(text);
        return !INVALID_TITLES.some(x => n === normalize(x));
    }

    function getChatName() {
        const header = document.querySelector('#main header');
        if (!header) return '';

        const selectors = [
            'span[dir="auto"][title]',
            'span[dir="auto"]',
            'div[dir="auto"]',
            'span[title]'
        ];

        for (const selector of selectors) {
            for (const el of header.querySelectorAll(selector)) {
                if (!visible(el)) continue;
                const text = clean(el.getAttribute('title') || el.textContent);
                if (validTitle(text)) return text;
            }
        }
        return '';
    }

    // ============================================================
    // UNIDADES
    // ============================================================

    const GUARUJA_UNITS = [
        "ALMOXARIFADO CENTRAL DA SAUDE",
        "AMB. REF. EM ESPECIALIDADES - ARE",
        "CAPS AD II",
        "CAPS II - DR JOSE FORSTHER JUNIOR",
        "CAPS III",
        "CAPS INFANTIL",
        "CASA SER",
        "CENTRO DE ESPECIALIDADE ODONTOLOGICA - CEO",
        "CENTRO DE ESPECIALIDADES DE VICENTE DE CARVALHO",
        "CENTRO DE RECUPERACAO E FISIOTERAPIA DE GUARUJÁ",
        "CENTRO DE RECUPERACAO E FISIOTERAPIA DE VICENTE DE CARVALHO",
        "CENTRO DE REFERÊNCIA EM OTORRINO, OFTALMO E FONOAUDIOLOGIA",
        "CONSULTORIO NA RUA",
        "FARMACIA DO CIDADAO - JAYRO GRACIOLA",
        "FARMACIA DO CIDADAO - VICENTE DE CARVALHO",
        "FARMACIA DO CIDADAO - VILA JULIA",
        "INSTITUTO DA MULHER - CASA ROSA",
        "PRONTO SOCORRO DE VICENTE DE CARVALHO",
        "PRONTO SOCORRO PEREQUE - ANIBAL ARDEN DOS REIS",
        "PRONTO SOCORRO PROFº DR. MATHEUS SANTAMARIA – PAM RODOVIÁRIA",
        "PRONTO SOCORRO SANTA CRUZ DOS NAVEGANTES",
        "RESIDÊNCIA TERAPÊUTICA",
        "SAMU",
        "SECRETARIA DE SAUDE / CENTRAL DE REGULAÇÃO",
        "SERVICO DE TRANSPORTE SANITARIO DO GUARUJA",
        "SERVIÇO DE VIGILÂNCIA SANITARIA E EPIDEMIOLÓGICA",
        "SIAD - SERVICO DE INTERNAÇÃO E ASSISTÊNCIA DOMICILIAR",
        "UBS MORRINHOS",
        "UBS PAE CARA",
        "UBS PERNAMBUCO",
        "UBS PRAINHA VICENTE DE CARVALHO",
        "UBS VILA ALICE",
        "UBS VILA BAIANA",
        "UNAERP",
        "UNIDADE BÁSICA DE SAUDE SANTA ROSA",
        "UNIDADE DE ESPECIALIDADE EM DIABETES, OBESIDADE E INFARTO JUVENIL - DOCINHOS",
        "UNIDADE DE INFECTOLOGIA - WILLIAN ROCHA",
        "UNIDADE DE VIGILANCIA EM ZOONOSES DE GUARUJA",
        "UPA ENSEADA - PAULO FLAVIO AFONSO PIASENTI",
        "USAFA CIDADE ATLÂNTICA",
        "USAFA JARDIM BOA ESPERANÇA",
        "USAFA JARDIM BRASIL",
        "USAFA JARDIM BRASIL - GUSTAVO COELHO DE ALMEIDA",
        "USAFA JARDIM CONCEIÇÃOZINHA",
        "USAFA JARDIM CONCEICAOZINHA - GENTIL NUNES NETO",
        "USAFA JARDIM DOS PÁSSAROS",
        "USAFA JARDIM LAS PALMAS",
        "USAFA JARDIM LAS PALMAS - JANDUI DE SOUZA MOREIRA",
        "USAFA JARDIM PROGRESSO",
        "USAFA PEREQUÊ",
        "USAFA SANTA CRUZ DOS NAVEGANTES",
        "USAFA SÍTIO CONCEIÇÃOZINHA",
        "USAFA VILA ÁUREA",
        "USAFA VILA EDNA",
        "USAFA VILA EDNA - MARCO ANTONIO GONZALEZ",
        "USAFA VILA RÃ",
        "USAFA VILA ZILDA",
        "USAFA VILA ZILDA DR DAVID CAPISTRANO"
    ];

    const JALES_UNITS = [
        "Almoxarifado de Saúde",
        "Ambulatório de Saúde Mental de Jales",
        "APS/ESF Dr Antonio Queda (antigo Núcleo)",
        "ARE (Ambulatório Regional de Especialidades), CMR (Centro Municipal de Reabilitação) e Setor de Combate a Endemias, endereço: Rua 17, nº 2.957, Centro",
        "Centro de Distribuição Farmacêutica (Alto custo e Ação Judicial) e Setor de Imunização",
        "CIACA (Centro Integrado de Atendimento em Saúde Mental à Criança e ao Adolescente)",
        "ESF Dr José Cícero Fontes Xavier (Rural)",
        "ESF Francisco Xavier Rego (Jd. Paraíso)",
        "ESF Getúlio de Carvalho (Jd. Arapuã)",
        "ESF Honorio Amadeu ( Uni - America)",
        "ESF Leonisio Gambero (Jd. Oiti)",
        "ESF Luis Ernesto Sandi Mori (Jd. JACB)",
        "ESF Ozil Joaquim Resende (Jd. Municipal)",
        "ESF Setuo Setugo (Jd. São Jorge)",
        "ESF Shiguero Kitayama (Jd. Roque Viola)",
        "ESF Virgílio Ribeiro Franco São Gabriel (Jd. São Gabriel)",
        "ESF Zilda Arns Meumann (Jd. Novo Mundo)",
        "Laboratório de Saúde Pública do SUS",
        "SAE/CTA (Serviço de Assistência e Especializada / Centro de Testagem e Aconselhamento)",
        "SECRETARIA MUNICIPAL DE SAÚDE"
    ];

    const UNITS_BY_OPERATION_ID = {
        '567': GUARUJA_UNITS,
        '588': JALES_UNITS
    };

    // Lista completa apenas para compatibilidade, datalist e diagnósticos.
    // A detecção/canonicalização usa a lista da operação selecionada.
    const UNITS = [
        ...new Set([
            ...GUARUJA_UNITS,
            ...JALES_UNITS
        ])
    ];

    function currentOperationId() {
        const select =
            document.getElementById(
                'om30-operation'
            );

        return normalizeSavedOperationId(
            select?.value ||
            localStorage.getItem(
                KEY.operation
            ) ||
            DEFAULT_OPERATION_ID
        );
    }

    function unitsForOperation(
        operationId =
            currentOperationId()
    ) {
        const safeId =
            normalizeSavedOperationId(
                operationId
            );

        return (
            UNITS_BY_OPERATION_ID[
                safeId
            ] ||
            GUARUJA_UNITS
        );
    }

    const UNIT_ALIASES = {
        "AMB. REF. EM ESPECIALIDADES - ARE": ["ARE", "AMBULATORIO ARE", "AMBULATORIO DE REFERENCIA"],
        "UBS PAE CARA": ["PAE CARA", "UBS PAE CARA"],
        "UNIDADE BÁSICA DE SAUDE SANTA ROSA": [
            "SANTA ROSA",
            "UBS SANTA ROSA",
            "UNIDADE SANTA ROSA",
            "UNIDADE DE SAUDE SANTA ROSA",
            "UNIDADE DE SAÚDE SANTA ROSA",
            "UNIDADE BASICA SANTA ROSA",
            "UNIDADE BÁSICA SANTA ROSA"
        ],
        "UBS PERNAMBUCO": ["UBS PERNAMBUCO"],
        "UBS MORRINHOS": ["UBS MORRINHOS"],
        "UBS VILA BAIANA": ["UBS VILA BAIANA"],
        "INSTITUTO DA MULHER - CASA ROSA": ["CASA ROSA", "INSTITUTO DA MULHER"],
        "CENTRO DE ESPECIALIDADE ODONTOLOGICA - CEO": ["CEO"],
        "PRONTO SOCORRO PEREQUE - ANIBAL ARDEN DOS REIS": [
            "PS PEREQUE", "PS PEREQUÊ", "PRONTO SOCORRO PEREQUE", "PRONTO SOCORRO PEREQUÊ",
            "UPA PEREQUE", "UPA PEREQUÊ", "PRONTO ATENDIMENTO PEREQUE",
            "PRONTO ATENDIMENTO PEREQUÊ", "EMERGENCIA PEREQUE", "EMERGÊNCIA PEREQUÊ",
            "PA PEREQUE", "PA PEREQUÊ"
        ],
        "UPA ENSEADA - PAULO FLAVIO AFONSO PIASENTI": [
            "UPA ENSEADA", "PS ENSEADA", "PRONTO ATENDIMENTO ENSEADA",
            "EMERGENCIA ENSEADA", "EMERGÊNCIA ENSEADA"
        ],
        "PRONTO SOCORRO PROFº DR. MATHEUS SANTAMARIA – PAM RODOVIÁRIA": [
            "PS RODOVIARIA", "PS RODOVIÁRIA", "UPA RODOVIARIA", "UPA RODOVIÁRIA",
            "PAM RODOVIARIA", "PAM RODOVIÁRIA", "PRONTO ATENDIMENTO RODOVIARIA",
            "PRONTO ATENDIMENTO RODOVIÁRIA", "RODOVIARIA", "RODOVIÁRIA"
        ],
        "PRONTO SOCORRO DE VICENTE DE CARVALHO": [
            "PS VICENTE", "PS VICENTE DE CARVALHO", "PSVC", "UPA VICENTE",
            "UPA VICENTE DE CARVALHO", "PRONTO ATENDIMENTO VICENTE DE CARVALHO"
        ],
        "PRONTO SOCORRO SANTA CRUZ DOS NAVEGANTES": [
            "PS SANTA CRUZ", "UPA SANTA CRUZ", "PRONTO SOCORRO SANTA CRUZ"
        ],
        "USAFA PEREQUÊ": ["USAFA PEREQUE", "USAFA PEREQUÊ"],
        "USAFA CIDADE ATLÂNTICA": ["USAFA CIDADE ATLANTICA", "USAFA CIDADE ATLÂNTICA"],
        "CASA SER": ["CASA SER"],
        "SAMU": ["SAMU"],
        "UNAERP": ["UNAERP"],
        "Almoxarifado de Saúde": ["ALMOXARIFADO SAUDE", "ALMOXARIFADO DE SAUDE"],
        "Ambulatório de Saúde Mental de Jales": ["AMBULATORIO SAUDE MENTAL", "AMBULATORIO DE SAUDE MENTAL", "SAUDE MENTAL JALES"],
        "APS/ESF Dr Antonio Queda (antigo Núcleo)": ["ANTONIO QUEDA", "DR ANTONIO QUEDA", "APS ANTONIO QUEDA", "ESF ANTONIO QUEDA", "ANTIGO NUCLEO", "NÚCLEO", "NUCLEO"],
        "ARE (Ambulatório Regional de Especialidades), CMR (Centro Municipal de Reabilitação) e Setor de Combate a Endemias, endereço: Rua 17, nº 2.957, Centro": ["ARE JALES", "ARE", "CMR", "CENTRO MUNICIPAL DE REABILITACAO", "ENDEMIAS"],
        "Centro de Distribuição Farmacêutica (Alto custo e Ação Judicial) e Setor de Imunização": ["CENTRO DE DISTRIBUICAO FARMACEUTICA", "ALTO CUSTO", "ACAO JUDICIAL", "AÇÃO JUDICIAL", "SETOR DE IMUNIZACAO", "SETOR DE IMUNIZAÇÃO", "IMUNIZACAO", "IMUNIZAÇÃO"],
        "CIACA (Centro Integrado de Atendimento em Saúde Mental à Criança e ao Adolescente)": ["CIACA", "CENTRO INTEGRADO DE ATENDIMENTO EM SAUDE MENTAL"],
        "ESF Dr José Cícero Fontes Xavier (Rural)": ["JOSE CICERO", "JOSÉ CÍCERO", "DR JOSE CICERO", "DR JOSÉ CÍCERO", "ESF RURAL", "RURAL"],
        "ESF Francisco Xavier Rego (Jd. Paraíso)": ["FRANCISCO XAVIER REGO", "JARDIM PARAISO", "JD PARAISO", "PARAISO"],
        "ESF Getúlio de Carvalho (Jd. Arapuã)": ["GETULIO DE CARVALHO", "GETÚLIO DE CARVALHO", "JARDIM ARAPUA", "JD ARAPUA", "ARAPUA"],
        "ESF Honorio Amadeu ( Uni - America)": ["HONORIO AMADEU", "HONÓRIO AMADEU", "UNI AMERICA", "UNIAMERICA", "UNIAMÉRICA"],
        "ESF Leonisio Gambero (Jd. Oiti)": ["LEONISIO", "LEONÍSIO", "LEONISIO GAMBERO", "JARDIM OITI", "JD OITI", "OITI"],
        "ESF Luis Ernesto Sandi Mori (Jd. JACB)": ["LUIS ERNESTO", "LUIS ERNESTO SANDI MORI", "JACB", "JD JACB"],
        "ESF Ozil Joaquim Resende (Jd. Municipal)": ["OZIL", "OZIL JOAQUIM RESENDE", "JARDIM MUNICIPAL", "JD MUNICIPAL"],
        "ESF Setuo Setugo (Jd. São Jorge)": ["SETUO", "SETUO SETUGO", "SAO JORGE", "SÃO JORGE", "JARDIM SAO JORGE", "JD SAO JORGE"],
        "ESF Shiguero Kitayama (Jd. Roque Viola)": ["SHIGUERO", "SHIGUERO KITAYAMA", "ROQUE VIOLA", "JARDIM ROQUE VIOLA", "JD ROQUE VIOLA"],
        "ESF Virgílio Ribeiro Franco São Gabriel (Jd. São Gabriel)": ["VIRGILIO", "VIRGÍLIO", "VIRGILIO RIBEIRO", "SAO GABRIEL", "SÃO GABRIEL", "JARDIM SAO GABRIEL", "JD SAO GABRIEL"],
        "ESF Zilda Arns Meumann (Jd. Novo Mundo)": ["ZILDA ARNS", "ZILDA ARNS MEUMANN", "NOVO MUNDO", "JARDIM NOVO MUNDO", "JD NOVO MUNDO"],
        "Laboratório de Saúde Pública do SUS": ["LABORATORIO DE SAUDE PUBLICA", "LABORATORIO SAUDE PUBLICA", "LABORATORIO SUS"],
        "SAE/CTA (Serviço de Assistência e Especializada / Centro de Testagem e Aconselhamento)": ["SAE", "CTA", "SAE CTA", "SAE/CTA", "CENTRO DE TESTAGEM E ACONSELHAMENTO"],
        "SECRETARIA MUNICIPAL DE SAÚDE": ["SECRETARIA MUNICIPAL DE SAUDE", "SMS JALES", "SECRETARIA DE SAUDE JALES"]
    };

    function chatKey(name) {
        if (looksLikePhone(name)) return 'TEL:' + String(name).replace(/\D/g, '');
        return 'CHAT:' + normalize(name);
    }

    // ------------------------------------------------------------
    // UNIDADE CANÔNICA
    // Nunca salva "PEREQUE", "PAE CARA" etc. como unidade solta.
    // Tudo que for persistido precisa virar uma unidade REAL da lista UNITS.
    // ------------------------------------------------------------

    function canonicalUnitExact(
        value,
        operationId =
            currentOperationId()
    ) {
        const n = normalize(value);
        if (!n) return '';

        const activeUnits =
            unitsForOperation(
                operationId
            );

        const exact = activeUnits.find(unit => normalize(unit) === n);
        if (exact) return exact;

        const aliasMatches = [];
        for (const unit of activeUnits) {
            for (const alias of (UNIT_ALIASES[unit] || [])) {
                if (normalize(alias) === n) aliasMatches.push(unit);
            }
        }

        return [...new Set(aliasMatches)].length === 1
            ? [...new Set(aliasMatches)][0]
            : '';
    }

    function unitCandidatesFromInput(
        value,
        operationId =
            currentOperationId()
    ) {
        const n = normalize(value);
        if (!n) return [];

        const scored = [];

        const activeUnits =
            unitsForOperation(
                operationId
            );

        for (const unit of activeUnits) {
            const un = normalize(unit);
            let score = 0;

            if (un === n) score = 100;
            else if (un.includes(n)) score = 88;
            else if (n.includes(un)) score = 84;

            for (const alias of (UNIT_ALIASES[unit] || [])) {
                const an = normalize(alias);
                if (an === n) score = Math.max(score, 100);
                else if (an.includes(n)) score = Math.max(score, 92);
                else if (n.includes(an)) score = Math.max(score, 90);
            }

            if (score) scored.push({ unit, score });
        }

        scored.sort((a, b) => b.score - a.score || a.unit.localeCompare(b.unit, 'pt-BR'));
        return [...new Map(scored.map(item => [item.unit, item])).values()];
    }

    function chooseCanonicalUnit(value, contextText = '') {
        const raw = clean(value);
        if (!raw) return '';

        // Unidade/alias exato já resolve sem perguntar.
        const exact = canonicalUnitExact(raw);
        if (exact) return exact;

        // Se o próprio texto trouxer contexto explícito (UPA/PS/USAFA), usa esse contexto.
        const contextual = detectUnitInText(`${contextText} ${raw}`.trim(), 'unidade informada', 99);
        if (contextual?.unit) {
            const explicit = /\b(USAFA|UBS|UPA|PS|PRONTO SOCORRO|PRONTO ATENDIMENTO|PA|EMERGENCIA|EMERGÊNCIA)\b/i
                .test(`${contextText} ${raw}`);
            if (explicit) return contextual.unit;
        }

        const candidates = unitCandidatesFromInput(raw);
        if (!candidates.length) {
            alert(
                `A unidade “${raw}” não corresponde a nenhuma unidade cadastrada.\n\n` +
                `Escolha uma unidade existente na lista da OM30.`
            );
            return '';
        }

        if (candidates.length === 1) return candidates[0].unit;

        // Não adivinha bairro ambíguo. Ex.: PEREQUÊ pode ser PS ou USAFA.
        const top = candidates.slice(0, Math.min(8, candidates.length));
        const answer = prompt(
            `“${raw}” pode representar mais de uma unidade cadastrada.\n\n` +
            top.map((item, index) => `${index + 1} - ${item.unit}`).join('\n') +
            `\n\nDigite o número da unidade correta:`,
            ''
        );

        if (answer === null) return '';
        const index = Number(String(answer).trim()) - 1;
        if (!Number.isInteger(index) || index < 0 || index >= top.length) {
            alert('Opção de unidade inválida. Nada foi salvo.');
            return '';
        }

        return top[index].unit;
    }

    function canonicalStoredUnit(value) {
        // Para dados antigos, só aceita se conseguir convertê-los sem ambiguidade.
        // "PAE CARA" pode virar UBS PAE CARA automaticamente.
        // "PEREQUE" NÃO vira PS/USAFA sozinho.
        return canonicalUnitExact(value);
    }

    function getSavedUnit() {
        const chat = getChatName();
        if (!chat) return null;

        const map = loadJSON(KEY.units);
        const saved = map[chatKey(chat)] || null;
        if (!saved?.unit) return saved;

        const activeOperation =
            currentOperationId();

        if (
            saved.operation_id &&
            String(saved.operation_id) !==
                String(activeOperation)
        ) {
            return null;
        }

        const canonical = canonicalStoredUnit(saved.unit);
        if (!canonical) return null;

        // Migra automaticamente um alias antigo não ambíguo para o nome real
        // e passa a registrar também a operação do vínculo salvo.
        if (
            canonical !== saved.unit ||
            !saved.operation_id
        ) {
            saved.unit = canonical;
            saved.operation_id =
                currentOperationId();
            saved.updated_at = new Date().toISOString();
            map[chatKey(chat)] = saved;
            saveJSON(KEY.units, map);
        }

        return saved;
    }

    function saveUnitForChat(unit) {
        const chat = getChatName();
        if (!chat || !unit) return '';

        const canonical = chooseCanonicalUnit(unit, chat);
        if (!canonical) return '';

        const map = loadJSON(KEY.units);
        map[chatKey(chat)] = {
            chat,
            unit: canonical,
            operation_id:
                currentOperationId(),
            updated_at: new Date().toISOString()
        };
        saveJSON(KEY.units, map);
        return canonical;
    }

    function isUrgencyText(text) {
        return /\b(PS|PRONTO SOCORRO|PRONTO ATENDIMENTO|UPA|EMERGENCIA|EMERGÊNCIA|PA)\b/i.test(text);
    }

    function isUrgencyUnit(unit) {
        const n = normalize(unit);
        return n.startsWith('PRONTO SOCORRO') || n.startsWith('UPA ');
    }

    function isPlantaoGroup(name = getChatName()) {
        return /(^|\s)PLANT[AÃ]O(\s|$)/i.test(String(name || ''));
    }

    function detectUnitInText(text, source = 'texto', baseScore = 92) {
        text = clean(text);
        if (!text) return null;

        const n = normalize(text);
        const urgency = isUrgencyText(text);
        const explicitUsafa = /\bUSAFA\b/i.test(text);
        const results = [];

        const activeUnits =
            unitsForOperation();

        for (const unit of activeUnits) {
            // Em contexto de PS/UPA/PA/Emergência, não cai em UBS/USAFA só pelo bairro.
            if (urgency && !explicitUsafa && !isUrgencyUnit(unit)) continue;

            let score = 0;

            if (n.includes(normalize(unit))) {
                score = Math.min(100, baseScore + 4);
            }

            for (const alias of (UNIT_ALIASES[unit] || [])) {
                if (n.includes(normalize(alias))) {
                    score = Math.max(score, Math.min(100, baseScore));
                }
            }

            if (unit === "PRONTO SOCORRO PEREQUE - ANIBAL ARDEN DOS REIS" &&
                urgency && /PEREQU[EÊ]/i.test(text)) {
                score = Math.max(score, Math.min(100, baseScore + 5));
            }

            if (unit === "UPA ENSEADA - PAULO FLAVIO AFONSO PIASENTI" &&
                urgency && /ENSEADA/i.test(text)) {
                score = Math.max(score, Math.min(100, baseScore + 5));
            }

            if (unit === "PRONTO SOCORRO PROFº DR. MATHEUS SANTAMARIA – PAM RODOVIÁRIA" &&
                urgency && /RODOVI[AÁ]RIA/i.test(text)) {
                score = Math.max(score, Math.min(100, baseScore + 5));
            }

            if (unit === "PRONTO SOCORRO DE VICENTE DE CARVALHO" &&
                (/(^|\s)PSVC(\s|$)/i.test(text) ||
                 (urgency && /VICENTE\s+DE\s+CARVALHO/i.test(text)))) {
                score = Math.max(score, Math.min(100, baseScore + 5));
            }

            if (unit === "PRONTO SOCORRO SANTA CRUZ DOS NAVEGANTES" &&
                urgency && /SANTA\s+CRUZ/i.test(text)) {
                score = Math.max(score, Math.min(100, baseScore + 5));
            }

            if (unit === "UBS PAE CARA" && /\bPAE\s+CARA\b/i.test(text)) {
                score = Math.max(score, Math.min(100, baseScore + 3));
            }

            // SANTA ROSA:
            // A antiga USAFA Santa Rosa foi descontinuada.
            // Qualquer referência a "Santa Rosa" aponta para a UBS atual.
            if (unit === "UNIDADE BÁSICA DE SAUDE SANTA ROSA" &&
                /\bSANTA\s+ROSA\b/i.test(text)) {
                score = Math.max(score, 100);
            }

            if (unit === "AMB. REF. EM ESPECIALIDADES - ARE" && /\bARE\b/i.test(text)) {
                score = Math.max(score, Math.min(100, baseScore));
            }

            if (score) results.push({ unit, score, source });
        }

        results.sort((a, b) => b.score - a.score);
        return results[0] || null;
    }

    function detectPlantaoUnit() {
        const chat = getChatName();
        if (!isPlantaoGroup(chat)) return null;

        const text = String(chat || '')
            .replace(/(^|\s)PLANT[AÃ]O(\s|$)/ig, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        const found = detectUnitInText(text, 'nome do grupo de plantão', 98);
        if (found) return found;

        if (/(^|\s)PSVC(\s|$)/i.test(text)) {
            return {
                unit: "PRONTO SOCORRO DE VICENTE DE CARVALHO",
                score: 100,
                source: 'nome do grupo de plantão'
            };
        }

        return null;
    }

    function detectUnit() {
        // 1) Unidade salva manualmente para esta conversa sempre vence.
        const saved = getSavedUnit();
        if (saved?.unit) {
            return { unit: saved.unit, score: 100, source: 'salva para este chat' };
        }

        const chat = getChatName();
        const senders = loadJSON(KEY.senders);
        const ordered = orderedEvidence();
        const current = currentProblem();

        // Contexto curto ao redor do problema mais novo.
        // Evita uma unidade antiga, capturada sem querer no print, contaminar o chamado atual.
        let context = [];

        if (current.classification?.msg) {
            const issueIndex = ordered.findIndex(msg => msg.id === current.classification.msg.id);
            let contextStart = Math.max(0, issueIndex - 3);

            for (let i = issueIndex - 1; i >= 0; i--) {
                if (solutionTextScore(ordered[i].text) >= 72) {
                    contextStart = i + 1;
                    break;
                }
            }

            context = ordered.slice(contextStart, Math.min(ordered.length, issueIndex + 3));
        } else {
            context = ordered.slice(-4);
        }

        // 2) Unidade escrita nas mensagens mais recentes.
        // Ex.: grupo de Perequê, mas "hoje estou na UPA Enseada" -> Enseada vence.
        for (let i = context.length - 1; i >= 0; i--) {
            const found = detectUnitInText(context[i].text, 'mensagem recente', 96);
            if (found) return found;
        }

        // 3) Grupo de plantão reconhecido já define a unidade deste atendimento.
        const plantao = detectPlantaoUnit();
        if (plantao) return plantao;

        // 4) Conversa direta com número previamente identificado.
        if (looksLikePhone(chat)) {
            const savedSender = senders[senderKey(chat)];
            const canonical = canonicalStoredUnit(savedSender?.unit);
            if (canonical) {
                if (savedSender.unit !== canonical) {
                    savedSender.unit = canonical;
                    senders[senderKey(chat)] = savedSender;
                    saveJSON(KEY.senders, senders);
                }
                return {
                    unit: canonical,
                    score: 100,
                    source: `número ${chat} identificado`
                };
            }
        }

        // 5) Número que relatou o problema atual já identificado.
        const currentSender = current.classification?.msg?.sender;
        if (currentSender && looksLikePhone(currentSender)) {
            const savedSender = senders[senderKey(currentSender)];
            const canonical = canonicalStoredUnit(savedSender?.unit);
            if (canonical) {
                if (savedSender.unit !== canonical) {
                    savedSender.unit = canonical;
                    senders[senderKey(currentSender)] = savedSender;
                    saveJSON(KEY.senders, senders);
                }
                return {
                    unit: canonical,
                    score: 99,
                    source: `número ${currentSender} identificado`
                };
            }
        }

        for (let i = context.length - 1; i >= 0; i--) {
            const sender = context[i].sender;
            if (!looksLikePhone(sender)) continue;

            const savedSender = senders[senderKey(sender)];
            const canonical = canonicalStoredUnit(savedSender?.unit);
            if (canonical) {
                if (savedSender.unit !== canonical) {
                    savedSender.unit = canonical;
                    senders[senderKey(sender)] = savedSender;
                    saveJSON(KEY.senders, senders);
                }
                return {
                    unit: canonical,
                    score: 97,
                    source: `remetente ${sender} identificado`
                };
            }
        }

        // 6) Nome da conversa normal.
        const byChat = detectUnitInText(chat, 'nome da conversa', 92);
        if (byChat) return byChat;

        // 7) Fallback somente no bloco do atendimento atual.
        const blockText = descriptionFromMessages(current.block?.length ? current.block : ordered);
        const fallback = detectUnitInText(blockText, 'bloco atual', 86);

        return fallback || { unit: '', score: 0, source: '' };
    }

    // ============================================================
    // MENSAGENS E REMETENTES
    // ============================================================

    function parseMeta(meta) {
        const out = { time: '', date: '', sender: '' };
        const m = String(meta || '').match(/^\[([^\],]+)(?:,\s*([^\]]+))?\]\s*(.*?):\s*$/);
        if (m) {
            out.time = clean(m[1]);
            out.date = clean(m[2]);
            out.sender = clean(m[3]);
        }
        return out;
    }

    function messageHighlightElement(content, bubble) {
        if (!content) return bubble;

        // O [data-id] do WhatsApp costuma ocupar a largura quase inteira da conversa.
        // Para a seleção visual, procuramos o menor ancestral que represente a bolha
        // e não a linha completa. Isso evita aquele retângulo azul gigante atravessando a tela.
        const main = document.querySelector('#main');
        const maxWidth = (main?.getBoundingClientRect().width || window.innerWidth) * 0.72;

        let current = content;
        let best = content;

        while (current && current !== bubble && main?.contains(current)) {
            const rect = current.getBoundingClientRect();

            if (rect.width > 20 && rect.height > 12 && rect.width <= maxWidth) {
                best = current;
            }

            current = current.parentElement;
        }

        return best || content || bubble;
    }

    function infoMessage(content) {
        if (!content) return null;
        const bubble = content.closest('[data-id]') || content.parentElement;
        if (!bubble) return null;

        const highlightElement = messageHighlightElement(content, bubble);
        const meta = clean(content.getAttribute('data-pre-plain-text'));
        const parts = [...content.querySelectorAll('span.selectable-text')]
            .map(x => clean(x.innerText))
            .filter(Boolean);

        let text = [...new Set(parts)].join('\n').trim();
        if (!text) text = clean(content.innerText || content.textContent);
        if (!text) return null;

        const parsed = parseMeta(meta);
        return {
            id: bubble.getAttribute('data-id') || `${meta}|${text}`,
            element: bubble,
            highlightElement,
            time: parsed.time,
            date: parsed.date,
            sender: parsed.sender,
            text
        };
    }

    function findMessage(target) {
        const main = document.querySelector('#main');
        if (!main || !target || !main.contains(target)) return null;

        let content = target.closest('[data-pre-plain-text]');
        if (!content) content = target.closest('[data-id]')?.querySelector('[data-pre-plain-text]');
        return infoMessage(content);
    }

    function senderKey(sender) {
        if (looksLikePhone(sender)) return 'TEL:' + String(sender).replace(/\D/g, '');
        return 'NOME:' + normalize(sender);
    }

    function senderInfo(sender) {
        const saved = loadJSON(KEY.senders)[senderKey(sender)];
        return {
            original: sender,
            name: saved?.name || sender,
            unit: saved?.unit || '',
            saved: !!saved
        };
    }

    function unknownNumbers() {
        const map = loadJSON(KEY.senders);
        const set = new Set();
        const chat = getChatName();
        const plantao = detectPlantaoUnit();

        // Conversa direta: número sem cadastro OU com unidade antiga/inválida precisa ser corrigido.
        if (looksLikePhone(chat)) {
            const saved = map[senderKey(chat)];
            if (!saved || !canonicalStoredUnit(saved.unit)) {
                set.add(chat);
            }
        }

        // Em grupo de plantão reconhecido, a unidade já vem do grupo.
        // O número sem nome não é pendência de unidade.
        if (!plantao) {
            for (const msg of evidenceMessages()) {
                if (!looksLikePhone(msg.sender)) continue;
                const saved = map[senderKey(msg.sender)];
                if (!saved || !canonicalStoredUnit(saved.unit)) {
                    set.add(msg.sender);
                }
            }
        }

        return [...set];
    }

    function unidentifiedPeopleInPlantao() {
        const plantao = detectPlantaoUnit();
        if (!plantao) return [];

        const map = loadJSON(KEY.senders);
        const set = new Set();

        for (const msg of evidenceMessages()) {
            if (looksLikePhone(msg.sender) && !map[senderKey(msg.sender)]) {
                set.add(msg.sender);
            }
        }

        return [...set];
    }

    function identifyNumbers() {
        const plantao = detectPlantaoUnit();
        const numbers = plantao ? unidentifiedPeopleInPlantao() : unknownNumbers();
        if (!numbers.length) return;

        const map = loadJSON(KEY.senders);

        for (const number of numbers) {
            if (plantao) {
                const name = prompt(
                    `Quem é este número?\n\n${number}\n\n` +
                    `A unidade deste atendimento já foi identificada pelo grupo como:\n${plantao.unit}`,
                    ''
                );

                if (!name) continue;

                const fixedUnit = prompt(
                    `Unidade fixa deste número (opcional).\n\n` +
                    `Deixe em branco para NÃO criar vínculo permanente.\n` +
                    `Neste chamado será usada a unidade do grupo: ${plantao.unit}`,
                    ''
                );

                let canonicalFixedUnit = '';
                if (clean(fixedUnit)) {
                    canonicalFixedUnit = chooseCanonicalUnit(fixedUnit, plantao.unit);
                    if (!canonicalFixedUnit) {
                        alert(`O nome da pessoa foi mantido, mas nenhuma unidade fixa inválida será salva para ${number}.`);
                    }
                }

                map[senderKey(number)] = {
                    number,
                    name: clean(name),
                    unit: canonicalFixedUnit,
                    updated_at: new Date().toISOString()
                };
            } else {
                const name = prompt(`Quem é este número?\n\n${number}`, '');
                if (name === null) continue;

                const unit = prompt(
                    `De qual unidade é ${clean(name) || number}?\n\n` +
                    `Digite o nome/bairro e eu vou converter para uma unidade cadastrada.\n` +
                    `Ex.: PAE CARA, UPA ENSEADA, USAFA PEREQUÊ.`,
                    ''
                );

                if (!clean(unit)) {
                    alert(`O número ${number} não foi salvo porque a unidade ficou vazia.`);
                    continue;
                }

                const canonical = chooseCanonicalUnit(unit, getChatName());
                if (!canonical) {
                    alert(`O número ${number} não foi salvo porque não foi escolhida uma unidade cadastrada.`);
                    continue;
                }

                map[senderKey(number)] = {
                    number,
                    name: clean(name) || number,
                    unit: canonical,
                    updated_at: new Date().toISOString()
                };
            }
        }

        saveJSON(KEY.senders, map);
        unitManual = false;
        updateAll();
    }

    function evidenceMessages() {
        const mode = getMode();

        if (mode === 'mensagens') {
            return uniqueById([...selected.values()]);
        }

        if (mode === 'print') {
            return uniqueById([...printMessages]);
        }

        if (mode === 'ambos') {
            // Mensagens escolhidas manualmente são a fonte textual principal.
            // O print continua sendo enviado como imagem, mas não injeta
            // mensagens extras na descrição/classificação quando há seleção.
            return uniqueById(
                selected.size
                    ? [...selected.values()]
                    : [...printMessages]
            );
        }

        return uniqueById([...selected.values()]);
    }

    function parseMessageDateTime(msg) {
        if (!msg?.time) return null;

        let date = clean(msg.date);
        if (!date) {
            const now = new Date();
            date = `${String(now.getDate()).padStart(2,'0')}/${String(now.getMonth()+1).padStart(2,'0')}/${now.getFullYear()}`;
        }

        const dm = date.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
        const tm = clean(msg.time).match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
        if (!dm || !tm) return null;

        let year = Number(dm[3]);
        if (year < 100) year += 2000;

        const dt = new Date(
            year, Number(dm[2])-1, Number(dm[1]),
            Number(tm[1]), Number(tm[2]), Number(tm[3] || 0)
        );
        return Number.isNaN(dt.getTime()) ? null : dt;
    }

    function orderedEvidence() {
        const list = evidenceMessages().map((msg, index) => ({
            msg,
            index,
            dt: parseMessageDateTime(msg)
        }));

        list.sort((a, b) => {
            if (a.dt && b.dt) return a.dt - b.dt;
            if (a.dt) return -1;
            if (b.dt) return 1;

            const ea = a.msg.element;
            const eb = b.msg.element;
            if (ea && eb && ea !== eb) {
                const pos = ea.compareDocumentPosition(eb);
                if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
                if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
            }
            return a.index - b.index;
        });

        return list.map(x => x.msg);
    }

    function clearMessageSelectionVisual(info) {
        const el = info?.highlightElement || info?.element;
        if (!el) return;

        el.classList.remove(CLS_SELECTED);
        el.removeAttribute('data-om30-order');
    }

    function refreshMessageSelectionVisuals() {
        let order = 1;

        for (const info of selected.values()) {
            const el = info?.highlightElement || info?.element;
            if (!el) continue;

            el.classList.add(CLS_SELECTED);
            el.setAttribute('data-om30-order', String(order++));
        }
    }

    function toggleMessage(info) {
        if (selected.has(info.id)) {
            clearMessageSelectionVisual(selected.get(info.id));
            selected.delete(info.id);
        } else {
            selected.set(info.id, info);
        }

        refreshMessageSelectionVisuals();

        // Ctrl + clique serve SOMENTE para marcar/desmarcar.
        // A leitura/classificação acontece quando o usuário clicar em
        // "LER X MENSAGENS", evitando montar o chamado enquanto ainda
        // está escolhendo quais mensagens realmente pertencem ao atendimento.
        classificationManual = false;
        unitManual = false;
        initialManual = false;
        solutionManual = false;
        titleManual = false;
        descriptionManual = false;

        updateFloating();

        // Se a ficha já estiver aberta, atualiza apenas a visualização
        // da evidência. Não refaz classificação/datas automaticamente.
        if (panelOpened) {
            renderEvidence();
            const hint = document.getElementById('om30-evidence-hint');
            if (hint) {
                hint.innerHTML = `🟦 ${selected.size} mensagem(ns) marcada(s). Clique em <b>LER CHAMADO</b> na barra de seleção para analisar.`;
            }
        }
    }

    document.addEventListener('keydown', event => {
        if (event.key === 'Control') {
            document.body?.classList.add('om30-ctrl-selecting');
        }
    }, true);

    document.addEventListener('keyup', event => {
        if (event.key === 'Control') {
            document.body?.classList.remove('om30-ctrl-selecting');
        }
    }, true);

    window.addEventListener('blur', () => {
        document.body?.classList.remove('om30-ctrl-selecting');
    });

    document.addEventListener('click', event => {
        if (!event.ctrlKey) return;
        if (event.target.closest(`#${ID.panel}, #${ID.launcher}, #${ID.camera}, #${ID.reader}, #${ID.selectionBar}`)) return;

        const info = findMessage(event.target);
        if (!info) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        toggleMessage(info);
    }, true);

    // ============================================================
    // DESCRIÇÃO
    // ============================================================

    function descriptionFromMessages(messages) {
        // Uma linha por mensagem. Evita a descrição ficar visualmente pesada
        // com cabeçalho em uma linha, texto em outra e espaços extras entre tudo.
        return (messages || []).map(msg => {
            const person = senderInfo(msg.sender);
            let head = '';
            if (msg.time) head += `[${msg.time}]`;
            if (person.name) head += `${head ? ' ' : ''}${person.name}:`;

            const text = String(msg.text || '')
                .replace(/\s*\n+\s*/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

            return [head, text].filter(Boolean).join(' ');
        }).filter(Boolean).join('\n');
    }

    function descriptionFromEvidence() {
        return descriptionFromMessages(orderedEvidence());
    }

    // ============================================================
    // CLASSIFICAÇÃO
    // ============================================================

    const CATEGORIES = {
        "Saúde Simples": {
            1: ["Configuração de Agenda","Consolidação de Munícipe","Munícipes","Profissionais","Instabilidade no Sistema","Tele Saúde"],
            2: ["Agendamento","Ambulatorial","Aplicativo","Configurações","Atenção Primária","Atestado e Declaração","Cadastro","Configuração de Agenda","Consolidação de Munícipe","Munícipes","Profissionais","Consulta em banco","Estoque","Ferramentas","Implantação de novos processos","Nova unidade/módulo/funcionalidade","Odontológico","Ouvidoria","Produção BPA","Produção e-SUS","Produção RAAS","Pronto Atendimento","Prontuário Eletrônico","Regulação","Relatórios","Tele Saúde","Terapia","Transporte","Treinamento","Urgência e Emergência","Vacinação","Vigilância em Saúde"]
        },
        "Totem": { 1: ["Touch"], 2: ["Touch"] },
        "Painel de Senha": { 1: ["Erro"], 2: ["Erro"] },
        "Impressora": { 1: ["Impressora"], 2: ["Impressora"] }
    };

    const STRONG_SOLUTION = /\b(DEU CERTO|FUNCIONOU|VOLTOU|NORMALIZOU|RESOLVIDO|RESOLVEU|AGORA FOI|PODE FECHAR|ESTA FUNCIONANDO|TA FUNCIONANDO|TUDO CERTO|OK AGORA|ARRUMOU)\b/;
    const MEDIUM_SOLUTION = /\b(OBRIGADO|OBRIGADA|VALEU|PERFEITO)\b/;
    const TECH_ACTION = /\b(ATUALIZADO|ATUALIZADA|CORRIGIDO|CORRIGIDA|REALIZADO|REALIZADA|AJUSTADO|AJUSTADA|PODE TESTAR|VERIFICA AGORA|TESTA AGORA)\b/;
    const PROBLEM_CUE = /\b(NAO|ERRO|PROBLEMA|TRAVOU|TRAVADO|PAROU|ARRUMA|ARRUMAR|CORRIGE|CORRIGIR|ATUALIZA|ATUALIZAR|DUPLICADO|DUPLICADA|DUPLICADOS|DUPLICADAS|IGUAIS|DOIS|DUAS|SEM)\b/;

    function solutionTextScore(text) {
        const t = normalize(text);
        if (STRONG_SOLUTION.test(t)) return 100;
        if (MEDIUM_SOLUTION.test(t)) return 72;
        if (TECH_ACTION.test(t)) return 55;
        return 0;
    }

    function isPureResolution(text) {
        const t = normalize(text);
        return solutionTextScore(t) > 0 && !PROBLEM_CUE.test(t);
    }

    function classifyText(text) {
        const t = normalize(text);
        if (!t || isPureResolution(t)) return null;

        // Som/áudio é Painel de Senha, inclusive "totem sem som".
        if (/\b(SOM|AUDIO|VOZ)\b/.test(t) ||
            /\b(SEM SOM|NAO FALA|NAO ESTA FALANDO|PAROU DE FALAR|NAO TOCA|NAO CHAMA COM VOZ)\b/.test(t)) {
            return {
                system: "Painel de Senha",
                category: "Erro",
                title: "Problema no som do painel de senhas",
                score: 99,
                reason: "som/áudio pertence ao painel de senhas"
            };
        }

        // PEDIDO DE ACESSO / CADASTRO DE USUÁRIO
        // Para o fluxo atual, pedidos como "libera acesso", "dar acesso",
        // "criar acesso" etc. entram em Saúde Simples > Cadastro.
        // A categoria específica "Liberação de acesso" é outra coisa no GLPI
        // e não deve ser usada para esse tipo de mensagem.
        const accessRequest =
            /\b(LIBERACAO|LIBERAR|LIBERA|LIBERE|CONCEDER|CONCEDA|DAR|DA|CRIAR|CADASTRAR)\b.{0,45}\bACESSO\b/.test(t) ||
            /\bACESSO\b.{0,45}\b(LIBERAR|LIBERA|LIBERE|CONCEDER|CONCEDA|CRIAR|CADASTRAR)\b/.test(t) ||
            /\b(PERMISSAO|PERMISSOES|SOLICITACAO)\b.{0,30}\b(DE )?ACESSO\b/.test(t);

        if (accessRequest) {
            return {
                system: "Saúde Simples",
                category: "Cadastro",
                type: 2,
                title: "Liberação de acesso",
                score: 100,
                reason: "pedido de acesso classificado em Cadastro"
            };
        }

        // Dois munícipes/pacientes iguais ou duplicados = consolidação.
        if (/\b(MUNICIPE|MUNICIPES|PACIENTE|PACIENTES)\b/.test(t) &&
            /\b(DOIS|DUAS|DUPLICADO|DUPLICADA|DUPLICADOS|DUPLICADAS|IGUAIS|REPETIDO|REPETIDA|REPETIDOS|REPETIDAS)\b/.test(t)) {
            return {
                system: "Saúde Simples",
                category: "Consolidação de Munícipe",
                title: "Consolidação de munícipe",
                score: 99,
                reason: "cadastros/munícipes duplicados"
            };
        }

        if (/\b(CONSOLIDAR|CONSOLIDACAO)\b/.test(t) &&
            /\b(MUNICIPE|MUNICIPES|PACIENTE|PACIENTES)\b/.test(t)) {
            return {
                system: "Saúde Simples",
                category: "Consolidação de Munícipe",
                title: "Consolidação de munícipe",
                score: 99,
                reason: "solicitação de consolidação"
            };
        }

        // Totem = Touch por padrão.
        if (/\bTOTEM\b/.test(t)) {
            const explicitTouch = /\b(TOUCH|TOQUE|TELA|CLICA|CLIQUE|CLICAR|RESPONDE|TRAVOU)\b/.test(t);
            return {
                system: "Totem",
                category: "Touch",
                title: "Problema no touch do totem",
                score: explicitTouch ? 99 : 90,
                reason: explicitTouch ? "problema de touch/tela do totem" : "totem identificado; padrão operacional é Touch"
            };
        }

        if (/\b(PAINEL|SENHA|TV)\b/.test(t) ||
            /\b(CHAMAR SENHA|CHAMADA DE SENHA|ARRUMA O PAINEL|ATUALIZA O PAINEL)\b/.test(t)) {
            return {
                system: "Painel de Senha",
                category: "Erro",
                title: "Erro no painel de senhas",
                score: 98,
                reason: "problema relacionado ao painel/chamada de senha"
            };
        }

        if (/\b(IMPRESSORA|IMPRIMIR|IMPRESSAO)\b/.test(t)) {
            return {
                system: "Impressora",
                category: "Impressora",
                title: "Problema na impressora",
                score: 99,
                reason: "problema de impressão identificado"
            };
        }

        const healthRules = [
            [/AGENDA|AGENDAMENTO/, "Configuração de Agenda"],
            [/PROFISSIONAL|CBO/, "Profissionais"],
            [/MUNICIPE|PACIENTE/, "Munícipes"],
            [/PRONTUARIO/, "Prontuário Eletrônico"],
            [/REGULACAO/, "Regulação"],
            [/RELATORIO/, "Relatórios"],
            [/VACINA/, "Vacinação"],
            [/RAAS/, "Produção RAAS"],
            [/BPA/, "Produção BPA"],
            [/E\s*SUS|ESUS/, "Produção e-SUS"],
            [/ESTOQUE/, "Estoque"]
        ];

        for (const [regex, category] of healthRules) {
            if (regex.test(t)) {
                return {
                    system: "Saúde Simples",
                    category,
                    title: category,
                    score: 74,
                    reason: "conteúdo do Saúde Simples identificado"
                };
            }
        }

        return null;
    }

    function currentProblem() {
        const list = orderedEvidence();
        let chosen = null;
        let issueIndex = -1;

        // Em ordem cronológica, cada novo problema substitui o anterior.
        // Portanto, um problema velho capturado no print não ganha do problema atual.
        for (let i = 0; i < list.length; i++) {
            const result = classifyText(list[i].text);
            if (!result) continue;

            chosen = {
                ...result,
                msg: list[i]
            };
            issueIndex = i;
        }

        if (!chosen) {
            return {
                classification: null,
                block: list,
                start: null,
                issueIndex: -1
            };
        }

        // Fecha o bloco anterior quando houve confirmação de solução.
        let blockStart = 0;
        for (let i = 0; i < issueIndex; i++) {
            if (solutionTextScore(list[i].text) >= 72) {
                blockStart = i + 1;
            }
        }

        return {
            classification: chosen,
            block: list.slice(blockStart),
            start: parseMessageDateTime(chosen.msg),
            issueIndex
        };
    }

    function classify() {
        const current = currentProblem();
        if (current.classification) return current.classification;

        return classifyText(`${getChatName()}\n${descriptionFromMessages(current.block)}`);
    }

    function updateCategories(select = '') {
        const system = document.getElementById('om30-system');
        const type = document.getElementById('om30-type');
        const category = document.getElementById('om30-category');
        if (!system || !type || !category) return;

        const list = CATEGORIES[system.value]?.[Number(type.value)] || [];
        category.innerHTML = '';
        category.add(new Option('— Selecione —', ''));
        list.forEach(x => category.add(new Option(x, x)));
        if (select && list.includes(select)) category.value = select;
    }

    function applyClassification() {
        if (classificationManual) return;

        const result = classify();
        const type = document.getElementById('om30-type');
        const system = document.getElementById('om30-system');
        const category = document.getElementById('om30-category');
        const title = document.getElementById('om30-title');
        const info = document.getElementById('om30-ai');
        if (!type || !system || !category || !title || !info) return;

        if (!result) {
            info.className = 'om30-analysis om30-analysis-neutral';
            info.innerHTML = `🤖 Não consegui identificar automaticamente. Você pode alterar Sistema e Categoria manualmente.`;
            return;
        }

        if (result.type) type.value = String(result.type);
        system.value = result.system;
        updateCategories(result.category);
        category.value = result.category;

        if (!titleManual) title.value = result.title;

        info.className = 'om30-analysis';
        info.innerHTML = `🤖 <b>${result.system} › ${result.category}</b><br>Confiança: <b>${result.score}%</b> • ${result.reason}<br><small>Prioridade dada ao problema mais recente.</small>`;
    }

    // ============================================================
    // DATA INICIAL E SOLUÇÃO
    // ============================================================

    function formatInputDate(dt) {
        const p = n => String(n).padStart(2, '0');
        return `${dt.getFullYear()}-${p(dt.getMonth()+1)}-${p(dt.getDate())}T${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`;
    }

    function detectInitialDate() {
        const current = currentProblem();

        if (current.start && current.classification?.msg) {
            return {
                dt: current.start,
                msg: current.classification.msg,
                score: 100,
                reason: 'início do problema atual (problema mais recente)'
            };
        }

        return null;
    }

    function detectSolutionDate() {
        // REGRA DO FLUXO OM30:
        // Data da solução = horário da ÚLTIMA mensagem que entrou na evidência.
        //
        // - Seleção por Ctrl+clique: usa a mensagem cronologicamente mais recente
        //   entre as mensagens selecionadas.
        // - Print: usa a última mensagem reconhecida dentro do recorte.
        // - Mensagens + Print: usa a mais recente entre as duas fontes.
        //
        // Não é necessário existir "deu certo", "resolvido", "obrigado" etc.
        // A própria seleção/recorte feita pelo atendente define o intervalo do chamado.
        const list = orderedEvidence();

        for (let i = list.length - 1; i >= 0; i--) {
            const msg = list[i];
            const dt = parseMessageDateTime(msg);

            if (!dt) continue;

            return {
                dt,
                msg,
                score: 100,
                reason: 'última mensagem da evidência'
            };
        }

        return null;
    }

    function applyDates() {
        const initial = document.getElementById('om30-initial-date');
        const initialInfo = document.getElementById('om30-initial-info');
        const solution = document.getElementById('om30-solution-date');
        const solutionInfo = document.getElementById('om30-solution-info');
        if (!initial || !initialInfo || !solution || !solutionInfo) return;

        if (!initialManual) {
            const found = detectInitialDate();
            if (found) {
                initial.value = formatInputDate(found.dt);
                initialInfo.className = 'om30-analysis';
                initialInfo.innerHTML = `🟦 Início detectado: <b>${found.dt.toLocaleString('pt-BR')}</b> • ${found.reason}`;
            } else {
                initial.value = '';
                initialInfo.className = 'om30-analysis om30-analysis-neutral';
                initialInfo.innerHTML = `Data inicial não identificada. Você pode usar <b>AGORA</b> ou preencher manualmente.`;
            }
        }

        if (!solutionManual) {
            const found = detectSolutionDate();
            if (found) {
                solution.value = formatInputDate(found.dt);
                solutionInfo.className = 'om30-analysis';
                solutionInfo.innerHTML = `✅ Data final da evidência: <b>${found.dt.toLocaleString('pt-BR')}</b> • última mensagem: “${escapeHTML(found.msg.text.slice(0,90))}”`;
            } else {
                solution.value = '';
                solutionInfo.className = 'om30-analysis om30-analysis-warning';
                solutionInfo.innerHTML = `⚠ Não consegui ler data/hora da última mensagem selecionada ou presente no print. Use <b>AGORA</b> ou preencha manualmente.`;
            }
        }
    }

    // ============================================================
    // UNIDADE NA TELA
    // ============================================================

    function applyUnit() {
        if (unitManual) return;

        const found = detectUnit();
        const input = document.getElementById('om30-unit');
        const info = document.getElementById('om30-unit-info');
        if (!input || !info) return;

        if (!found.unit) {
            input.value = '';
            info.className = 'om30-analysis om30-analysis-warning';
            info.innerHTML = `⚠ Unidade não identificada. Digite ou escolha manualmente.`;
            return;
        }

        input.value = found.unit;
        info.className = 'om30-analysis';
        info.innerHTML = `📍 <b>${found.unit}</b> • ${found.score}% • ${found.source}`;
    }

    // ============================================================
    // DESCRIÇÃO / EVIDÊNCIA
    // ============================================================

    function updateDescription() {
        if (descriptionManual) return;

        const textarea = document.getElementById('om30-description');
        if (!textarea) return;

        const mode = getMode();
        const text = descriptionFromEvidence();

        if (mode === 'mensagens') {
            textarea.value = text;
        } else if (mode === 'print') {
            textarea.value = printBlob
                ? 'Evidência registrada por print da conversa do WhatsApp.'
                : '';
        } else {
            // Mensagens + Print:
            // a seleção manual forma o texto; o print entra visualmente no GLPI.
            textarea.value = text || (
                printBlob
                    ? 'Evidência registrada por print da conversa do WhatsApp.'
                    : ''
            );
        }
    }

    function renderEvidence() {
        const box = document.getElementById('om30-evidence');
        const hint = document.getElementById('om30-evidence-hint');
        if (!box || !hint) return;

        const mode = getMode();
        const hasMessages = mode !== 'print';
        const hasPrint = mode !== 'mensagens';

        if (hasMessages && !selected.size && (!hasPrint || !printBlob)) {
            hint.textContent = mode === 'ambos'
                ? 'Selecione mensagens com Ctrl + clique e/ou capture um print.'
                : 'Selecione as mensagens com Ctrl + clique.';
        } else if (hasPrint && !printBlob && (!hasMessages || selected.size)) {
            hint.textContent = 'Capture um print se quiser acrescentar evidência visual.';
        } else {
            hint.textContent = 'Evidências prontas para este chamado.';
        }

        const rows = [];

        if (hasMessages) {
            rows.push(`
                <div class="om30-evidence-compact-row">
                    <div class="om30-evidence-compact-copy">
                        <b>💬 ${selected.size} mensagem(ns)</b>
                        <small>${selected.size ? 'Incluídas na descrição' : 'Nenhuma selecionada'}</small>
                    </div>
                    ${selected.size ? '<button type="button" id="om30-clear-selection">Limpar</button>' : ''}
                </div>`);
        }

        if (hasPrint) {
            rows.push(`
                <div class="om30-evidence-compact-row">
                    <div class="om30-evidence-compact-copy">
                        <b>📷 ${printBlob ? 'Print pronto' : 'Sem print'}</b>
                        <small>${printBlob ? `${Math.max(1, Math.round(printBlob.size / 1024))} KB` : 'Capture somente o trecho necessário'}</small>
                    </div>
                    <div class="om30-evidence-mini-actions">
                        <button type="button" id="om30-inline-camera">${printBlob ? 'Trocar' : 'Capturar'}</button>
                        ${printBlob ? '<button type="button" id="om30-remove-print">Remover</button>' : ''}
                    </div>
                </div>`);
        }

        box.innerHTML = `<div class="om30-evidence-card om30-evidence-compact">${rows.join('')}</div>`;

        box.querySelector('#om30-inline-camera')?.addEventListener('click', capturePrint);
        box.querySelector('#om30-remove-print')?.addEventListener('click', removePrint);
        box.querySelector('#om30-clear-selection')?.addEventListener('click', () => {
            for (const msg of selected.values()) clearMessageSelectionVisual(msg);
            selected.clear();
            classificationManual = false;
            unitManual = false;
            initialManual = false;
            solutionManual = false;
            titleManual = false;
            descriptionManual = false;
            updateAll();
        });
    }

    // ============================================================
    // PRINT
    // ============================================================

    function messagesInsideCrop(crop) {
        const main = document.querySelector('#main');
        if (!main) return [];

        const results = [];
        for (const content of main.querySelectorAll('[data-pre-plain-text]')) {
            const msg = infoMessage(content);
            if (!msg?.element) continue;

            const r = msg.element.getBoundingClientRect();
            const left = Math.max(r.left, crop.x);
            const top = Math.max(r.top, crop.y);
            const right = Math.min(r.right, crop.x + crop.width);
            const bottom = Math.min(r.bottom, crop.y + crop.height);
            const inter = Math.max(0, right-left) * Math.max(0, bottom-top);
            const area = Math.max(1, r.width * r.height);

            if (inter / area >= 0.18) results.push(msg);
        }
        return uniqueById(results);
    }

    async function capturePrint() {
        const panel = document.getElementById(ID.panel);
        const launcher = document.getElementById(ID.launcher);
        const camera = document.getElementById(ID.camera);
        const wasPanelOpen = !!panel && panelOpened && panel.style.display !== 'none';

        if (panel) panel.style.display = 'none';
        if (launcher) launcher.style.display = 'none';
        if (camera) camera.style.display = 'none';

        const overlay = document.createElement('div');
        overlay.id = ID.crop;
        overlay.innerHTML = `
            <div class="om30-crop-help">
                <b>Arraste sobre o trecho que deve entrar no chamado</b><br>
                As mensagens dentro da área também serão analisadas.<br>
                <small>ESC para cancelar</small>
            </div>`;
        document.body.appendChild(overlay);

        let startX = 0, startY = 0, rect = null;

        const restore = () => {
            overlay.remove();
            if (panel) panel.style.display = wasPanelOpen ? '' : 'none';
            updateFloating();
        };

        const onKey = e => {
            if (e.key === 'Escape') {
                document.removeEventListener('keydown', onKey);
                restore();
            }
        };
        document.addEventListener('keydown', onKey);

        overlay.onpointerdown = e => {
            if (e.target.closest('.om30-crop-help')) return;
            startX = e.clientX;
            startY = e.clientY;
            rect = document.createElement('div');
            rect.className = 'om30-crop-rect';
            overlay.appendChild(rect);
            overlay.setPointerCapture(e.pointerId);
        };

        overlay.onpointermove = e => {
            if (!rect) return;
            const x = Math.min(startX, e.clientX);
            const y = Math.min(startY, e.clientY);
            const width = Math.abs(e.clientX - startX);
            const height = Math.abs(e.clientY - startY);
            Object.assign(rect.style, {
                left: `${x}px`, top: `${y}px`,
                width: `${width}px`, height: `${height}px`
            });
        };

        overlay.onpointerup = async e => {
            if (!rect) return;

            const crop = {
                x: Math.min(startX, e.clientX),
                y: Math.min(startY, e.clientY),
                width: Math.abs(e.clientX - startX),
                height: Math.abs(e.clientY - startY)
            };

            if (crop.width < 40 || crop.height < 40) {
                rect.remove();
                rect = null;
                return;
            }

            document.removeEventListener('keydown', onKey);
            printMessages = messagesInsideCrop(crop);

            try {
                const stream = await navigator.mediaDevices.getDisplayMedia({
                    video: true,
                    audio: false,
                    preferCurrentTab: true
                });

                overlay.remove();
                await sleep(250);

                const video = document.createElement('video');
                video.srcObject = stream;
                video.muted = true;
                video.playsInline = true;
                await video.play();
                await sleep(300);

                const scaleX = video.videoWidth / innerWidth;
                const scaleY = video.videoHeight / innerHeight;

                const canvas = document.createElement('canvas');
                canvas.width = Math.round(crop.width * scaleX);
                canvas.height = Math.round(crop.height * scaleY);

                canvas.getContext('2d').drawImage(
                    video,
                    Math.round(crop.x * scaleX),
                    Math.round(crop.y * scaleY),
                    canvas.width,
                    canvas.height,
                    0, 0,
                    canvas.width,
                    canvas.height
                );

                printBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png', 0.95));
                stream.getTracks().forEach(t => t.stop());

                if (printURL) URL.revokeObjectURL(printURL);
                printURL = URL.createObjectURL(printBlob);
                window.__OM30_PRINT = printBlob;

                classificationManual = false;
                unitManual = false;
                initialManual = false;
                solutionManual = false;
                titleManual = false;
                descriptionManual = false;
            } catch (err) {
                console.error('OM30 print:', err);

                // Se a captura for cancelada ou falhar, volta exatamente ao estado anterior.
                panelOpened = wasPanelOpen;
                if (panel) panel.style.display = wasPanelOpen ? '' : 'none';
            } finally {
                overlay.remove();

                // Print concluído: abre a ficha SOMENTE depois que o recorte já foi capturado.
                // Assim a janela OM30 não atrapalha a seleção nem aparece dentro do print.
                if (printBlob) {
                    // O print terminou. Reabre a ficha e garante que ela esteja
                    // realmente dentro da área visível da tela.
                    showPanelSafely(panel);
                }

                updateAll();
                updateFloating();
            }
        };
    }

    function removePrint() {
        printBlob = null;
        printMessages = [];
        if (printURL) URL.revokeObjectURL(printURL);
        printURL = null;
        window.__OM30_PRINT = null;

        classificationManual = false;
        unitManual = false;
        initialManual = false;
        solutionManual = false;
        descriptionManual = false;
        updateAll();
    }

    // ============================================================
    // OPERAÇÕES
    // ============================================================

    const DEFAULT_OPERATION_ID = '567';

    // Operações homologadas no motor silencioso.
    // Outras entram aqui depois de mapear entidade + unidades + grupo Sistemas.
    const OPERATIONS = [
        [567, "Guarujá"],
        [588, "Jales"]
    ];

    const SUPPORTED_OPERATION_IDS =
        new Set(
            OPERATIONS.map(
                item => String(item[0])
            )
        );

    function normalizeSavedOperationId(value) {
        const id =
            String(
                value || ''
            );

        return SUPPORTED_OPERATION_IDS.has(id)
            ? id
            : DEFAULT_OPERATION_ID;
    }

    function operationNameById(operationId) {
        const id =
            normalizeSavedOperationId(
                operationId
            );

        return (
            OPERATIONS.find(
                item =>
                    String(item[0]) === id
            )?.[1] ||
            'Guarujá'
        );
    }

    // ============================================================
    // CSS - PADRÃO OM30
    // Primária #0080FF / Secundária #004080
    // ============================================================

    function createCSS() {
        if (document.getElementById(ID.style)) return;

        const style = document.createElement('style');
        style.id = ID.style;
        style.textContent = `
            :root{
                --om30-primary:#0080FF;
                --om30-secondary:#004080;
                --om30-primary-soft:#EAF4FF;
                --om30-border:#D6E3F2;
                --om30-text:#17324D;
                --om30-muted:#66788A;
                --om30-bg:#F7FAFD;
                --om30-success:#2E5E50;
                --om30-success-soft:#EAF5F1;
                --om30-warning:#9A5D00;
                --om30-warning-soft:#FFF4DF;
            }

            #${ID.panel}{
                position:fixed; top:64px; right:18px;
                width:455px; max-height:calc(100vh - 82px);
                z-index:2147483000;
                background:#fff; color:var(--om30-text);
                border:1px solid var(--om30-border); border-radius:18px;
                box-shadow:0 22px 70px rgba(0,40,80,.28);
                font-family:"Segoe UI",Arial,sans-serif;
                overflow:hidden;
            }
            #${ID.panel} *{box-sizing:border-box}

            .om30-head{
                height:64px; padding:0 15px;
                background:linear-gradient(135deg,var(--om30-secondary),#0059B3);
                color:#fff; display:flex; align-items:center; justify-content:space-between;
                cursor:move; user-select:none;
            }
            .om30-brand{display:flex;align-items:center;gap:10px}
            .om30-logo{
                width:38px;height:38px;border-radius:11px;
                background:#fff;color:var(--om30-secondary);
                display:flex;align-items:center;justify-content:center;
                font-size:10px;font-weight:900;letter-spacing:-.3px;
            }
            .om30-brand b{display:block;font-size:14px}
            .om30-brand small{display:block;margin-top:2px;font-size:9px;opacity:.8}
            .om30-window{display:flex;gap:5px}
            .om30-window button{
                width:31px;height:31px;border:0;border-radius:9px;
                background:rgba(255,255,255,.13);color:#fff;cursor:pointer;font-size:15px;
            }

            .om30-body{
                padding:13px; max-height:calc(100vh - 146px); overflow-y:auto;
                background:#fff;
            }
            .om30-chat-card{
                display:flex;align-items:center;justify-content:space-between;gap:10px;
                padding:10px 11px;border:1px solid var(--om30-border);
                background:var(--om30-bg);border-radius:11px;
            }
            .om30-chat-title{font-size:12px;font-weight:800}
            .om30-chat-sub{font-size:9px;color:var(--om30-muted);margin-top:2px}
            .om30-mode-chip{
                flex:0 0 auto;border:1px solid #B7D8FF;border-radius:999px;
                padding:5px 8px;background:var(--om30-primary-soft);
                color:var(--om30-secondary);font-size:8px;font-weight:800;
            }

            .om30-label,#${ID.panel} label{
                display:block;margin:10px 0 4px;color:var(--om30-muted);
                font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.25px;
            }
            #${ID.panel} input,#${ID.panel} select,#${ID.panel} textarea{
                width:100%;padding:9px;border:1px solid #C8D9EA;border-radius:8px;
                background:#fff;color:var(--om30-text);font-size:11px;outline:none;
            }
            #${ID.panel} input:focus,#${ID.panel} select:focus,#${ID.panel} textarea:focus{
                border-color:var(--om30-primary);
                box-shadow:0 0 0 3px rgba(0,128,255,.10);
            }
            #${ID.panel} textarea{min-height:96px;resize:vertical}

            .om30-analysis{
                margin-top:6px;padding:8px 9px;border-radius:8px;
                background:var(--om30-success-soft);color:var(--om30-success);
                font-size:9px;line-height:1.45;
            }
            .om30-analysis-neutral{background:var(--om30-primary-soft);color:var(--om30-secondary)}
            .om30-analysis-warning{background:var(--om30-warning-soft);color:var(--om30-warning)}

            .om30-actions-2{display:grid;grid-template-columns:1fr 150px;gap:7px;margin-top:6px}
            .om30-btn,.om30-date-row button{
                border:1px solid #C8D9EA;border-radius:8px;background:#fff;
                color:var(--om30-secondary);cursor:pointer;font-size:9px;font-weight:800;
            }
            .om30-btn{min-height:33px;padding:7px 9px}
            .om30-btn:hover,.om30-date-row button:hover{background:var(--om30-primary-soft)}

            .om30-date-row{display:grid;grid-template-columns:1fr auto;gap:7px}
            .om30-date-row button{padding:0 11px}

            .om30-evidence-title{
                display:flex;align-items:center;justify-content:space-between;
                margin:12px 0 5px;
            }
            .om30-evidence-title b{
                color:var(--om30-muted);font-size:9px;text-transform:uppercase;
            }
            .om30-evidence-title button{
                border:0;background:none;color:var(--om30-primary);
                cursor:pointer;text-decoration:underline;font-size:9px;
            }
            #om30-evidence-hint{font-size:8px;color:var(--om30-muted);margin-bottom:6px}

            #om30-evidence{display:grid;gap:7px}
            .om30-evidence-card{
                padding:8px;border:1px solid var(--om30-border);
                border-radius:9px;background:var(--om30-bg);
            }
            .om30-evidence-head{
                display:flex;align-items:center;justify-content:space-between;
                margin-bottom:5px;font-size:9px;color:var(--om30-secondary);
            }
            .om30-evidence-head button{
                border:0;background:none;color:var(--om30-primary);
                cursor:pointer;text-decoration:underline;font-size:8px;
            }
            .om30-evidence-list{max-height:150px;overflow:auto}
            .om30-msg{padding:6px 0;border-top:1px solid #E3ECF5;font-size:10px}
            .om30-msg:first-child{border-top:0}
            .om30-msg small{display:block;color:var(--om30-muted);font-size:8px;margin-bottom:2px}
            .om30-empty{padding:8px;text-align:center;color:#7B8B9B;font-size:9px}
            .om30-print-img{
                display:block;width:100%;max-height:180px;object-fit:contain;border-radius:7px;
                border:1px solid #DDE8F3;
            }
            .om30-print-meta{text-align:center;color:var(--om30-muted);font-size:8px;margin-top:5px}
            .om30-remove{
                display:block;margin:5px auto 0;border:0;background:none;color:#A33434;
                cursor:pointer;text-decoration:underline;font-size:8px;
            }

            .om30-evidence-compact{padding:5px 8px}
            .om30-evidence-compact-row{
                min-height:42px;display:flex;align-items:center;justify-content:space-between;gap:8px;
                padding:6px 0;border-top:1px solid #E3ECF5;
            }
            .om30-evidence-compact-row:first-child{border-top:0}
            .om30-evidence-compact-copy{min-width:0;flex:1}
            .om30-evidence-compact-copy b{display:block;color:var(--om30-text);font-size:9px}
            .om30-evidence-compact-copy small{display:block;margin-top:2px;color:var(--om30-muted);font-size:8px}
            .om30-evidence-compact-row button{
                border:0;background:none;color:var(--om30-primary);cursor:pointer;font-size:8px;font-weight:800;padding:4px;
            }
            .om30-evidence-mini-actions{display:flex;align-items:center;gap:4px}

            .om30-settings-menu{
                position:absolute;top:56px;right:12px;z-index:2147483646;width:285px;display:none;padding:12px;
                border:1px solid var(--om30-border);border-radius:13px;background:#fff;color:var(--om30-text);
                box-shadow:0 18px 45px rgba(0,40,80,.28);font-family:"Segoe UI",Arial,sans-serif;
            }
            .om30-settings-title{font-size:11px;font-weight:900;color:var(--om30-secondary);margin-bottom:9px}
            .om30-settings-line{display:flex;justify-content:space-between;gap:8px;font-size:9px;color:var(--om30-muted)}
            .om30-settings-line b{color:var(--om30-text);font-size:9px;text-align:right}
            .om30-settings-menu>button,.om30-settings-actions button{
                min-height:31px;border:1px solid #C8D9EA;border-radius:8px;background:#fff;color:var(--om30-secondary);
                cursor:pointer;font-size:8px;font-weight:900;
            }
            .om30-settings-menu>button{width:100%;margin-top:7px}
            .om30-settings-divider{height:1px;background:#E1EAF2;margin:10px 0}
            .om30-settings-label{font-size:8px;font-weight:800;text-transform:uppercase;color:var(--om30-muted);margin-bottom:5px}
            .om30-settings-last-ticket{min-height:38px;padding:7px;border-radius:8px;background:var(--om30-bg);color:var(--om30-text);font-size:8.5px;line-height:1.35}
            .om30-settings-actions{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:7px}
            .om30-settings-menu button:hover{background:var(--om30-primary-soft)}

            #${ID.historyOverlay}{
                position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;
                padding:18px;background:rgba(0,32,64,.66);font-family:"Segoe UI",Arial,sans-serif;
            }
            .om30-history-modal{
                width:min(620px,calc(100vw - 36px));max-height:min(720px,calc(100vh - 36px));display:flex;
                flex-direction:column;overflow:hidden;background:#fff;border-radius:16px;border:1px solid #CFE0F2;
                box-shadow:0 25px 80px rgba(0,0,0,.34);
            }
            .om30-history-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:13px 15px;background:linear-gradient(135deg,var(--om30-secondary),#0059B3);color:#fff}
            .om30-history-head b{font-size:13px}
            .om30-history-head button{width:31px;height:31px;border:0;border-radius:9px;background:rgba(255,255,255,.15);color:#fff;cursor:pointer;font-size:16px}
            .om30-history-list{padding:10px;overflow:auto;display:grid;gap:7px}
            .om30-history-empty{padding:28px;text-align:center;color:var(--om30-muted);font-size:10px}
            .om30-history-item{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;padding:10px;border:1px solid var(--om30-border);border-radius:10px;background:var(--om30-bg)}
            .om30-history-item b{display:block;color:var(--om30-secondary);font-size:10px}
            .om30-history-item span{display:block;margin-top:3px;color:var(--om30-text);font-size:9px}
            .om30-history-item small{display:block;margin-top:3px;color:var(--om30-muted);font-size:8px}
            .om30-history-actions{display:flex;gap:5px}
            .om30-history-actions button{min-height:30px;padding:0 9px;border:1px solid #C8D9EA;border-radius:8px;background:#fff;color:var(--om30-secondary);cursor:pointer;font-size:8px;font-weight:900}
            .om30-history-actions .om30-history-delete{color:#A33434;border-color:#F0CACA}
            .om30-history-footer{padding:10px;border-top:1px solid #E3ECF5;text-align:right}
            .om30-history-footer button{border:0;background:none;color:#A33434;cursor:pointer;font-size:8px;text-decoration:underline}

            .om30-submit{
                width:100%;margin-top:12px;padding:11px;border:0;border-radius:9px;
                background:var(--om30-primary);color:#fff;cursor:pointer;
                font-size:10px;font-weight:900;box-shadow:0 7px 18px rgba(0,128,255,.22);
            }
            .om30-submit:hover{background:#0072E6}
            .om30-submit:disabled{
                cursor:default;
                opacity:.92;
            }
            .om30-submit.om30-enqueued{
                background:#176B47;
                box-shadow:0 7px 18px rgba(23,107,71,.22);
            }
            .om30-submit.om30-creating{
                position:relative;
                background:#0069D9;
            }

            .om30-operation-row{
                display:flex;
                gap:7px;
                align-items:center;
            }
            .om30-operation-row select{
                flex:1;
                min-width:0;
            }
            .om30-operation-save{
                flex:0 0 auto;
                width:auto !important;
                min-width:58px;
                height:34px;
                margin:0 !important;
                border:1px solid var(--om30-secondary);
                border-radius:8px;
                padding:0 11px;
                background:#fff;
                color:var(--om30-secondary);
                font-size:11px;
                font-weight:800;
                cursor:pointer;
                white-space:nowrap;
            }
            .om30-operation-save:hover{
                background:#F1F7FF;
            }
            .om30-operation-save.om30-saved{
                border-color:#176B47;
                background:#176B47;
                color:#fff;
            }

            #om30-number-warning{
                display:none;margin-top:7px;padding:7px 8px;border-radius:8px;
                background:var(--om30-warning-soft);color:var(--om30-warning);font-size:9px;
            }
            #om30-number-warning.om30-analysis-neutral{
                background:var(--om30-primary-soft);color:var(--om30-secondary);
            }
            #om30-number-warning button{
                margin-left:6px;border:0;background:none;color:var(--om30-secondary);
                cursor:pointer;text-decoration:underline;font-size:9px;
            }

            #${ID.launcher},#${ID.camera},#${ID.reader}{
                position:fixed;right:18px;z-index:2147482999;border:0;
                box-shadow:0 8px 25px rgba(0,40,80,.25);cursor:pointer;
            }
            #${ID.launcher}{
                top:96px;width:50px;height:42px;border-radius:13px;
                background:var(--om30-secondary);color:#fff;font-size:9px;font-weight:900;
            }
            #${ID.camera}{
                top:144px;width:50px;height:42px;border-radius:13px;
                background:#fff;color:var(--om30-secondary);
                border:1px solid #BFD6EC;font-size:17px;
            }
            #${ID.reader}{
                top:192px;min-width:124px;height:42px;padding:0 12px;border-radius:13px;
                background:var(--om30-primary);color:#fff;
                font-size:9px;font-weight:900;letter-spacing:.1px;
                display:none;
            }
            #${ID.reader}:hover{background:#0072E6}

            /* ======================================================
               SELEÇÃO DE MENSAGENS
               ====================================================== */

            body.om30-ctrl-selecting #main [data-pre-plain-text]{
                cursor:pointer!important;
            }

            body.om30-ctrl-selecting #main [data-pre-plain-text]:hover{
                outline:1.5px dashed rgba(0,128,255,.72)!important;
                outline-offset:5px!important;
                border-radius:9px!important;
            }

            .${CLS_SELECTED}{
                position:relative!important;
                border-radius:10px!important;
                outline:none!important;
                box-shadow:
                    0 0 0 2px var(--om30-primary),
                    0 7px 20px rgba(0,64,128,.24)!important;
                transition:box-shadow .12s ease, transform .12s ease!important;
            }

            .${CLS_SELECTED}::after{
                content:"✓ " attr(data-om30-order);
                position:absolute;
                top:-11px;
                right:-11px;
                min-width:23px;
                height:23px;
                padding:0 6px;
                box-sizing:border-box;
                border-radius:999px;
                display:flex;
                align-items:center;
                justify-content:center;
                background:var(--om30-primary);
                color:#fff;
                border:2px solid #fff;
                box-shadow:0 4px 12px rgba(0,64,128,.28);
                font:800 10px/1 "Segoe UI",Arial,sans-serif;
                z-index:30;
                pointer-events:none;
            }

            #${ID.ticketResult}{
                display:none;
                align-items:center;
                gap:9px;
                margin:0 0 12px 0;
                padding:10px;
                border:1px solid #A8DCC6;
                border-radius:13px;
                background:#F1FBF7;
                box-shadow:0 5px 16px rgba(0,64,128,.08);
                font-family:"Segoe UI",Arial,sans-serif;
            }

            .om30-result-check{
                width:34px;
                height:34px;
                flex:0 0 34px;
                display:flex;
                align-items:center;
                justify-content:center;
                border-radius:10px;
                background:#176B47;
                color:#fff;
                font-size:17px;
                font-weight:900;
            }

            .om30-result-copy{
                flex:1;
                min-width:0;
                line-height:1.15;
            }

            #${ID.ticketResult}.om30-result-progress{
                border-color:#A9D2FF;
                background:#F1F7FF;
            }
            #${ID.ticketResult}.om30-result-progress .om30-result-check{
                background:var(--om30-primary);
                animation:om30-progress-pulse 1.05s ease-in-out infinite;
            }
            #${ID.ticketResult}.om30-result-progress .om30-result-number{
                color:var(--om30-secondary);
            }
            #${ID.ticketResult}.om30-result-progress .om30-result-view{
                background:#DCEBFA;
                color:#45647F;
                cursor:default;
            }
            @keyframes om30-progress-pulse{
                0%,100%{transform:scale(1);opacity:1}
                50%{transform:scale(.92);opacity:.72}
            }

            #${ID.ticketResult}.om30-result-login{
                border-color:#F2B84B;
                background:#FFF8E8;
            }
            #${ID.ticketResult}.om30-result-login .om30-result-check{
                background:#D88700;
            }
            #${ID.ticketResult}.om30-result-login .om30-result-number{
                color:#8B5200;
            }
            #${ID.ticketResult}.om30-result-login .om30-result-view{
                background:#D88700;
            }

            .om30-result-number{
                display:block;
                color:#176B47;
                font-size:11px;
                font-weight:900;
            }

            .om30-result-title{
                display:block;
                overflow:hidden;
                margin-top:3px;
                color:#52697E;
                font-size:8.5px;
                white-space:nowrap;
                text-overflow:ellipsis;
            }

            .om30-result-view{
                height:32px;
                padding:0 10px;
                border:0;
                border-radius:9px;
                background:var(--om30-primary);
                color:#fff;
                cursor:pointer;
                font-size:8.5px;
                font-weight:900;
                white-space:nowrap;
            }

            .om30-result-view:hover{
                background:#0072E6;
            }

            .om30-result-close{
                width:30px;
                height:30px;
                padding:0;
                border:1px solid #D5E2EC;
                border-radius:9px;
                background:#fff;
                color:#6D8194;
                cursor:pointer;
                font-size:15px;
                font-weight:700;
            }

            .om30-result-close:hover{
                background:#FFF5F5;
                border-color:#FFC3C3;
                color:#B42318;
            }

            #${ID.selectionBar}{
                position:fixed;
                top:94px;
                right:76px;
                z-index:2147483000;
                min-width:315px;
                max-width:380px;
                height:54px;
                padding:7px 8px 7px 10px;
                box-sizing:border-box;
                display:none;
                align-items:center;
                gap:9px;
                border:1px solid rgba(0,128,255,.28);
                border-radius:15px;
                background:rgba(255,255,255,.97);
                box-shadow:0 10px 30px rgba(0,40,80,.20);
                backdrop-filter:blur(10px);
                font-family:"Segoe UI",Arial,sans-serif;
            }

            .om30-selection-icon{
                width:34px;
                height:34px;
                flex:0 0 34px;
                border-radius:10px;
                display:flex;
                align-items:center;
                justify-content:center;
                background:var(--om30-primary-soft);
                color:var(--om30-primary);
                font-size:16px;
                font-weight:900;
            }

            .om30-selection-copy{
                min-width:92px;
                flex:1;
                line-height:1.1;
            }

            .om30-selection-copy b{
                display:block;
                color:var(--om30-secondary);
                font-size:10px;
                white-space:nowrap;
            }

            .om30-selection-copy small{
                display:block;
                margin-top:3px;
                color:var(--om30-muted);
                font-size:8px;
                white-space:nowrap;
            }

            .om30-selection-clear,
            .om30-selection-read{
                height:34px;
                border-radius:10px;
                font-family:"Segoe UI",Arial,sans-serif;
                font-weight:800;
                cursor:pointer;
            }

            .om30-selection-clear{
                width:34px;
                flex:0 0 34px;
                border:1px solid #D6E3EF;
                background:#fff;
                color:#60758A;
                font-size:14px;
            }

            .om30-selection-clear:hover{
                border-color:#FFB4B4;
                color:#C62828;
                background:#FFF6F6;
            }

            .om30-selection-read{
                padding:0 13px;
                border:0;
                background:var(--om30-primary);
                color:#fff;
                font-size:9px;
                letter-spacing:.15px;
                box-shadow:0 5px 14px rgba(0,128,255,.20);
            }

            .om30-selection-read:hover{
                background:#0072E6;
            }

            #${ID.mode}{
                position:fixed;inset:0;z-index:2147483647;
                display:flex;align-items:center;justify-content:center;
                background:rgba(0,32,64,.74);font-family:"Segoe UI",Arial,sans-serif;
            }
            .om30-mode-modal{
                width:395px;padding:22px;border-radius:18px;background:#fff;
                box-shadow:0 25px 80px rgba(0,0,0,.4);text-align:center;
                border-top:5px solid var(--om30-primary);
            }
            .om30-mode-logo{
                width:48px;height:48px;margin:0 auto 10px;border-radius:14px;
                background:var(--om30-secondary);color:#fff;display:flex;
                align-items:center;justify-content:center;font-size:11px;font-weight:900;
            }
            .om30-mode-modal h2{margin:6px 0;color:var(--om30-secondary);font-size:16px}
            .om30-mode-modal p{margin:0 0 14px;color:var(--om30-muted);font-size:10px}
            .om30-mode-modal button{
                width:100%;display:grid;grid-template-columns:38px 1fr;gap:4px;
                margin-top:8px;padding:11px;text-align:left;border:1px solid #CFE0F2;
                border-radius:10px;background:#fff;cursor:pointer;
            }
            .om30-mode-modal button:hover{border-color:var(--om30-primary);background:var(--om30-primary-soft)}
            .om30-mode-icon{font-size:19px;display:flex;align-items:center;justify-content:center}
            .om30-mode-modal b{display:block;color:var(--om30-secondary);font-size:11px}
            .om30-mode-modal small{display:block;margin-top:2px;color:var(--om30-muted);font-size:9px}

            #${ID.crop}{
                position:fixed;inset:0;z-index:2147483647;
                background:rgba(0,0,0,.20);cursor:crosshair;
            }
            .om30-crop-help{
                position:fixed;top:18px;left:50%;transform:translateX(-50%);
                padding:9px 16px;border-radius:10px;background:var(--om30-secondary);
                color:#fff;text-align:center;font:10px/1.4 "Segoe UI",Arial;
            }
            .om30-crop-rect{
                position:fixed;border:3px solid var(--om30-primary);
                background:rgba(0,128,255,.08);
                box-shadow:0 0 0 9999px rgba(0,0,0,.36);
            }
        `;
        document.head.appendChild(style);
    }

    // ============================================================
    // UI
    // ============================================================

    function modeLabel() {
        return ({
            mensagens: 'MENSAGENS',
            print: 'PRINT',
            ambos: 'MENSAGENS + PRINT'
        })[getMode()] || 'EVIDÊNCIA';
    }

    function createUI() {
        if (!document.querySelector('#main')) return;
        createCSS();

        let launcher = document.getElementById(ID.launcher);
        if (!launcher) {
            launcher = document.createElement('button');
            launcher.id = ID.launcher;
            launcher.textContent = 'OM30';
            document.body.appendChild(launcher);
        }

        let camera = document.getElementById(ID.camera);
        if (!camera) {
            camera = document.createElement('button');
            camera.id = ID.camera;
            camera.innerHTML = '📷';
            camera.title = 'Capturar print OM30';
            camera.onclick = capturePrint;
            document.body.appendChild(camera);
        }

        const readSelectedMessages = () => {
            if (!selected.size) return;

            unitManual = false;
            classificationManual = false;
            initialManual = false;
            solutionManual = false;
            titleManual = false;
            descriptionManual = false;

            panelOpened = true;
            const panel = document.getElementById(ID.panel);
            if (panel) panel.style.display = '';

            updateAll();
            updateFloating();
        };

        let reader = document.getElementById(ID.reader);
        if (!reader) {
            reader = document.createElement('button');
            reader.id = ID.reader;
            reader.type = 'button';
            reader.textContent = 'LER MENSAGENS';
            reader.title = 'Ler as mensagens selecionadas e montar o chamado';
            reader.onclick = readSelectedMessages;
            document.body.appendChild(reader);
        }

        let selectionBar = document.getElementById(ID.selectionBar);
        if (!selectionBar) {
            selectionBar = document.createElement('div');
            selectionBar.id = ID.selectionBar;
            selectionBar.innerHTML = `
                <div class="om30-selection-icon">✓</div>
                <div class="om30-selection-copy">
                    <b id="om30-selection-count">0 mensagens</b>
                    <small>Ctrl + clique para ajustar</small>
                </div>
                <button class="om30-selection-clear" type="button" title="Limpar seleção">×</button>
                <button class="om30-selection-read" type="button">LER CHAMADO</button>
            `;

            selectionBar.querySelector('.om30-selection-read').onclick = readSelectedMessages;

            selectionBar.querySelector('.om30-selection-clear').onclick = () => {
                for (const msg of selected.values()) clearMessageSelectionVisual(msg);
                selected.clear();
                updateFloating();
            };

            document.body.appendChild(selectionBar);
        }

        if (document.getElementById(ID.panel)) {
            updateFloating();
            return;
        }

        const panel = document.createElement('div');
        panel.id = ID.panel;
        panel.innerHTML = `
            <div class="om30-head">
                <div class="om30-brand">
                    <div class="om30-logo">OM30</div>
                    <div><b>Abrir chamado</b><small>WhatsApp → GLPI</small></div>
                </div>
                <div class="om30-window">
                    <button type="button" id="om30-history" title="Histórico de chamados">↺</button>
                    <button type="button" id="om30-settings" title="Configurações">⚙</button>
                    <button type="button" id="om30-min">−</button>
                    <button type="button" id="om30-close">×</button>
                </div>
            </div>

            <div id="${ID.settingsMenu}" class="om30-settings-menu">
                <div class="om30-settings-title">Configurações</div>
                <div class="om30-settings-line">
                    <span>Modo de evidência</span>
                    <b id="om30-settings-mode-label"></b>
                </div>
                <button type="button" id="om30-settings-change-mode">ALTERAR MODO</button>
            </div>

            <div class="om30-body">
                <div class="om30-chat-card">
                    <div>
                        <div id="om30-chat" class="om30-chat-title"></div>
                        <div class="om30-chat-sub">Conversa atual do WhatsApp</div>
                    </div>
                    <div id="om30-mode-chip" class="om30-mode-chip"></div>
                </div>

                <div id="${ID.ticketResult}">
                    <div class="om30-result-check">✓</div>
                    <div class="om30-result-copy">
                        <span class="om30-result-number">Chamado criado</span>
                        <span class="om30-result-title"></span>
                    </div>
                    <button class="om30-result-view" type="button">VER CHAMADO</button>
                    <button class="om30-result-close" type="button" title="Ocultar este link">×</button>
                </div>

                <div id="om30-number-warning"></div>

                <label>Operação</label>
                <div class="om30-operation-row">
                    <select id="om30-operation">
                        ${OPERATIONS.map(x => `<option value="${x[0]}">${x[1]}</option>`).join('')}
                    </select>
                    <button id="om30-save-operation" class="om30-operation-save" type="button" title="Salvar esta operação como padrão">
                        Salvar
                    </button>
                </div>

                <label>Unidade</label>
                <input id="om30-unit" list="om30-unit-list" placeholder="Digite ou escolha a unidade">
                <datalist id="om30-unit-list">
                    ${UNITS.map(x => `<option value="${escapeHTML(x)}"></option>`).join('')}
                </datalist>
                <div id="om30-unit-info" class="om30-analysis om30-analysis-neutral"></div>
                <div class="om30-actions-2">
                    <button class="om30-btn" type="button" id="om30-detect-unit">🔎 DETECTAR NOVAMENTE</button>
                    <button class="om30-btn" type="button" id="om30-save-unit">💾 SALVAR PARA O CHAT</button>
                </div>

                <label>Tipo</label>
                <select id="om30-type">
                    <option value="1">Incidente</option>
                    <option value="2">Requisição</option>
                </select>

                <label>Sistema</label>
                <select id="om30-system">
                    <option value="Saúde Simples">Saúde Simples</option>
                    <option value="Totem">Totem</option>
                    <option value="Painel de Senha">Painel de Senha</option>
                    <option value="Impressora">Impressora</option>
                </select>

                <label>Categoria</label>
                <select id="om30-category"></select>
                <div id="om30-ai" class="om30-analysis om30-analysis-neutral"></div>

                <label>Data inicial</label>
                <div class="om30-date-row">
                    <input id="om30-initial-date" type="datetime-local" step="1">
                    <button type="button" id="om30-initial-now">AGORA</button>
                </div>
                <div id="om30-initial-info" class="om30-analysis om30-analysis-neutral"></div>

                <label>Data da solução</label>
                <div class="om30-date-row">
                    <input id="om30-solution-date" type="datetime-local" step="1">
                    <button type="button" id="om30-solution-now">AGORA</button>
                </div>
                <div id="om30-solution-info" class="om30-analysis om30-analysis-warning"></div>

                <label>Título</label>
                <input id="om30-title" placeholder="Título do chamado">

                <div class="om30-evidence-title">
                    <b>Descrição</b>
                </div>
                <div id="om30-evidence-hint"></div>

                <textarea id="om30-description" placeholder="Descrição do chamado"></textarea>
                <div id="om30-evidence"></div>

                <button class="om30-submit" type="button" id="om30-validate">CRIAR CHAMADO</button>
            </div>`;

        document.body.appendChild(panel);

        // A ficha grande nunca nasce aberta. Só abre ao clicar no botão OM30.
        panelOpened = false;
        panel.style.display = 'none';

        const pos = loadJSON(KEY.position, null);
        if (pos?.left != null && pos?.top != null) {
            const safe = safePanelPosition(pos.left, pos.top);
            panel.style.left = `${safe.left}px`;
            panel.style.top = `${safe.top}px`;
            panel.style.right = 'auto';

            // Já corrige a posição antiga salva para os próximos usos.
            saveJSON(KEY.position, safe);
        }

        // Drag
        const head = panel.querySelector('.om30-head');
        let dragging = false, ox = 0, oy = 0;
        head.onpointerdown = e => {
            if (e.target.closest('button')) return;
            const r = panel.getBoundingClientRect();
            panel.style.left = `${r.left}px`;
            panel.style.top = `${r.top}px`;
            panel.style.right = 'auto';
            ox = e.clientX - r.left;
            oy = e.clientY - r.top;
            dragging = true;
            head.setPointerCapture(e.pointerId);
        };
        head.onpointermove = e => {
            if (!dragging) return;
            const r = panel.getBoundingClientRect();
            let x = Math.max(5, Math.min(e.clientX - ox, innerWidth - r.width - 5));
            let y = Math.max(5, Math.min(e.clientY - oy, innerHeight - 60));
            panel.style.left = `${x}px`;
            panel.style.top = `${y}px`;
        };
        head.onpointerup = () => {
            dragging = false;
            const r = panel.getBoundingClientRect();
            saveJSON(KEY.position, { left: Math.round(r.left), top: Math.round(r.top) });
        };

        panel.querySelector('#om30-close').onclick = () => {
            panelOpened = false;
            panel.style.display = 'none';
            updateFloating();
        };

        launcher.onclick = () => {
            showPanelSafely(panel);
            updateAll();
        };
        panel.querySelector('#om30-min').onclick = () => {
            const body = panel.querySelector('.om30-body');
            body.style.display = body.style.display === 'none' ? '' : 'none';
        };

        const operation =
            panel.querySelector(
                '#om30-operation'
            );

        const saveOperationButton =
            panel.querySelector(
                '#om30-save-operation'
            );

        const savedOperation =
            normalizeSavedOperationId(
                localStorage.getItem(
                    KEY.operation
                )
            );

        // Primeiro uso = Guarujá.
        // A operação só vira padrão persistente ao clicar em Salvar.
        operation.value =
            savedOperation;

        if (
            !localStorage.getItem(
                KEY.operation
            )
        ) {
            localStorage.setItem(
                KEY.operation,
                DEFAULT_OPERATION_ID
            );
        }

        const savedOperationId = () =>
            normalizeSavedOperationId(
                localStorage.getItem(
                    KEY.operation
                )
            );

        const refreshUnitDatalist = () => {
            const list =
                panel.querySelector(
                    '#om30-unit-list'
                );

            if (!list) return;

            const activeId =
                normalizeSavedOperationId(
                    operation.value
                );

            list.innerHTML =
                unitsForOperation(
                    activeId
                )
                    .map(
                        value =>
                            `<option value="${escapeHTML(value)}"></option>`
                    )
                    .join('');
        };

        refreshUnitDatalist();

        if (saveOperationButton) {
            saveOperationButton.onclick = () => {
                const safeOperation =
                    normalizeSavedOperationId(
                        operation.value
                    );

                localStorage.setItem(
                    KEY.operation,
                    safeOperation
                );

                saveOperationButton.classList.add(
                    'om30-saved'
                );

                saveOperationButton.textContent =
                    '✓ Salvo';

                clearTimeout(
                    saveOperationButton.__om30SavedTimer
                );

                saveOperationButton.__om30SavedTimer =
                    setTimeout(
                        () => {
                            saveOperationButton.classList.remove(
                                'om30-saved'
                            );

                            saveOperationButton.textContent =
                                'Salvar';
                        },
                        1300
                    );
            };
        }

        operation.onchange = () => {
            const safeOperation =
                normalizeSavedOperationId(
                    operation.value
                );

            operation.value =
                safeOperation;

            // Trocar operação afeta imediatamente o chamado atual,
            // mas NÃO altera o padrão salvo até o usuário clicar no botão.
            unitManual = false;

            const unitInput =
                panel.querySelector(
                    '#om30-unit'
                );

            if (unitInput) {
                unitInput.value = '';
            }

            refreshUnitDatalist();
            updateAll();
        };

        const unit = panel.querySelector('#om30-unit');
        unit.oninput = () => {
            unitManual = true;
            const info = panel.querySelector('#om30-unit-info');
            info.className = 'om30-analysis om30-analysis-neutral';
            info.innerHTML = '✏️ Unidade alterada manualmente.';
        };
        panel.querySelector('#om30-detect-unit').onclick = () => {
            unitManual = false;
            applyUnit();
        };
        panel.querySelector('#om30-save-unit').onclick = () => {
            const value = unit.value.trim();
            if (!value) return alert('Escolha uma unidade primeiro.');

            const canonical = saveUnitForChat(value);
            if (!canonical) return;

            unit.value = canonical;
            unitManual = true;
            const info = panel.querySelector('#om30-unit-info');
            info.className = 'om30-analysis';
            info.innerHTML = `✅ Unidade cadastrada salva para este chat: <b>${escapeHTML(canonical)}</b>`;
        };

        const type = panel.querySelector('#om30-type');
        const system = panel.querySelector('#om30-system');
        const category = panel.querySelector('#om30-category');

        type.onchange = () => {
            classificationManual = true;
            updateCategories();
        };
        system.onchange = () => {
            classificationManual = true;
            updateCategories();
            if (system.value === 'Totem') category.value = 'Touch';
            if (system.value === 'Painel de Senha') category.value = 'Erro';

            if (!titleManual) {
                if (system.value === 'Totem') panel.querySelector('#om30-title').value = 'Problema no touch do totem';
                if (system.value === 'Painel de Senha') panel.querySelector('#om30-title').value = 'Erro no painel de senhas';
            }
        };
        category.onchange = () => classificationManual = true;

        panel.querySelector('#om30-title').oninput = () => titleManual = true;
        panel.querySelector('#om30-description').oninput = () => descriptionManual = true;

        const initial = panel.querySelector('#om30-initial-date');
        const solution = panel.querySelector('#om30-solution-date');
        initial.oninput = () => initialManual = true;
        solution.oninput = () => solutionManual = true;

        panel.querySelector('#om30-initial-now').onclick = () => {
            initialManual = true;
            initial.value = formatInputDate(new Date());
            const info = panel.querySelector('#om30-initial-info');
            info.className = 'om30-analysis om30-analysis-neutral';
            info.innerHTML = '🕒 Data inicial definida manualmente como agora.';
        };
        panel.querySelector('#om30-solution-now').onclick = () => {
            solutionManual = true;
            solution.value = formatInputDate(new Date());
            const info = panel.querySelector('#om30-solution-info');
            info.className = 'om30-analysis';
            info.innerHTML = '🕒 Data da solução definida manualmente como agora.';
        };

        const settingsButton = panel.querySelector('#om30-settings');
        const settingsMenu = panel.querySelector(`#${ID.settingsMenu}`);

        settingsButton.onclick = event => {
            event.stopPropagation();
            const opening = settingsMenu.style.display !== 'block';
            settingsMenu.style.display = opening ? 'block' : 'none';
            if (opening) renderSettingsMenu();
        };

        panel.querySelector('#om30-settings-change-mode').onclick = () => {
            settingsMenu.style.display = 'none';
            chooseMode(true);
        };

        panel.querySelector('#om30-history').onclick = event => {
            event.stopPropagation();
            settingsMenu.style.display = 'none';
            openTicketHistory();
        };

        if (!window.__OM30_SETTINGS_OUTSIDE_BOUND) {
            window.__OM30_SETTINGS_OUTSIDE_BOUND = true;
            document.addEventListener('click', event => {
                const currentPanel = document.getElementById(ID.panel);
                const currentMenu = document.getElementById(ID.settingsMenu);
                if (!currentPanel || !currentMenu) return;
                if (event.target.closest('#om30-settings') || event.target.closest('#om30-history') || event.target.closest(`#${ID.settingsMenu}`)) return;
                currentMenu.style.display = 'none';
            }, true);
        }

        panel.querySelector('#om30-validate').onclick = validateTicket;

        updateCategories();
        updateAll();
        renderSettingsMenu();
        renderHistoryShortcut();
        renderLastTicketMain();
        syncGlpiResult();
    }

    // ============================================================
    // ATUALIZAÇÃO
    // ============================================================

    function updateFloating() {
        const panel = document.getElementById(ID.panel);
        const launcher = document.getElementById(ID.launcher);
        const camera = document.getElementById(ID.camera);
        const reader = document.getElementById(ID.reader);
        const selectionBar = document.getElementById(ID.selectionBar);

        if (!launcher || !camera || !reader || !selectionBar) return;

        const closed = !panelOpened || !panel || panel.style.display === 'none';

        launcher.style.display = closed ? 'block' : 'none';
        camera.style.display = closed && getMode() !== 'mensagens' ? 'block' : 'none';

        const canRead = closed && selected.size > 0 && getMode() !== 'print';

        // O botão antigo fica escondido. A barra de seleção é a interface principal.
        reader.style.display = 'none';

        selectionBar.style.display = canRead ? 'flex' : 'none';

        const count = selectionBar.querySelector('#om30-selection-count');
        if (count) {
            count.textContent = selected.size === 1
                ? '1 mensagem selecionada'
                : `${selected.size} mensagens selecionadas`;
        }
    }

    function updateUnknownNumbers() {
        const box = document.getElementById('om30-number-warning');
        if (!box) return;

        const plantao = detectPlantaoUnit();
        const people = unidentifiedPeopleInPlantao();
        const pending = unknownNumbers();

        if (plantao && people.length) {
            box.style.display = 'block';
            box.className = 'om30-analysis om30-analysis-neutral';
            box.innerHTML =
                `🏥 Unidade pelo grupo: <b>${escapeHTML(plantao.unit)}</b><br>` +
                `📱 <b>${escapeHTML(people[0])}</b> ainda sem nome salvo. ` +
                `<button type="button" id="om30-identify-number">Identificar pessoa</button>` +
                (people.length > 1 ? `<br><small>+${people.length - 1} outro(s) número(s) sem nome.</small>` : '');

            box.querySelector('#om30-identify-number').onclick = identifyNumbers;
            return;
        }

        if (!pending.length) {
            box.style.display = 'none';
            box.className = '';
            box.innerHTML = '';
            return;
        }

        box.style.display = 'block';
        box.className = '';
        box.innerHTML =
            `⚠ ${pending.length} número(s) sem unidade identificada. ` +
            `<button type="button" id="om30-identify-number">Identificar</button>`;
        box.querySelector('#om30-identify-number').onclick = identifyNumbers;
    }

    function clearCurrentEvidence() {
        for (const msg of selected.values()) {
            clearMessageSelectionVisual(msg);
        }

        selected.clear();
        printMessages = [];
        printBlob = null;

        if (printURL) {
            URL.revokeObjectURL(printURL);
        }

        printURL = null;
        window.__OM30_PRINT = null;
    }

    function resetDraftManualFlags() {
        unitManual = false;
        classificationManual = false;
        initialManual = false;
        solutionManual = false;
        titleManual = false;
        descriptionManual = false;
    }

    function resetDraftFormForNextTicket() {
        clearCurrentEvidence();
        resetDraftManualFlags();

        window.__OM30_CHAMADO = null;

        const unit = document.getElementById('om30-unit');
        const type = document.getElementById('om30-type');
        const system = document.getElementById('om30-system');
        const category = document.getElementById('om30-category');
        const initial = document.getElementById('om30-initial-date');
        const solution = document.getElementById('om30-solution-date');
        const title = document.getElementById('om30-title');
        const description = document.getElementById('om30-description');

        if (unit) unit.value = '';
        if (type) type.value = '1';
        if (system) system.value = 'Saúde Simples';

        updateCategories();

        if (category) category.value = '';
        if (initial) initial.value = '';
        if (solution) solution.value = '';
        if (title) title.value = '';
        if (description) description.value = '';

        const unitInfo = document.getElementById('om30-unit-info');
        if (unitInfo) {
            unitInfo.className = 'om30-analysis om30-analysis-neutral';
            unitInfo.innerHTML =
                '📍 Selecione as mensagens ou capture a evidência do próximo chamado.';
        }

        const ai = document.getElementById('om30-ai');
        if (ai) {
            ai.className = 'om30-analysis om30-analysis-neutral';
            ai.innerHTML =
                '🤖 Aguardando a evidência do próximo chamado.';
        }

        const initialInfo = document.getElementById('om30-initial-info');
        if (initialInfo) {
            initialInfo.className = 'om30-analysis om30-analysis-neutral';
            initialInfo.innerHTML =
                'Data inicial será identificada a partir da próxima evidência.';
        }

        const solutionInfo = document.getElementById('om30-solution-info');
        if (solutionInfo) {
            solutionInfo.className = 'om30-analysis om30-analysis-neutral';
            solutionInfo.innerHTML =
                'Data da solução será identificada a partir da próxima evidência.';
        }

        const warning = document.getElementById('om30-number-warning');
        if (warning) {
            warning.style.display = 'none';
            warning.className = '';
            warning.innerHTML = '';
        }

        renderEvidence();
        updateFloating();
    }

    function scrollPanelToProcess(behavior = 'smooth') {
        const panel = document.getElementById(ID.panel);
        const body = panel?.querySelector('.om30-body');

        if (!body) return;

        const scroll = () => {
            try {
                body.scrollTo({
                    top: 0,
                    behavior
                });
            } catch {
                body.scrollTop = 0;
            }
        };

        scroll();
        requestAnimationFrame(scroll);
        setTimeout(scroll, 120);
    }

    function clearChatState() {
        resetDraftFormForNextTicket();
    }

    function updateAll() {
        const panel = document.getElementById(ID.panel);
        if (!panel) return;

        const chat = getChatName();
        if (previousChat && chat && chat !== previousChat) {
            clearChatState();

            // Trocar de conversa também fecha a ficha; ela não reaparece sozinha.
            panelOpened = false;
            panel.style.display = 'none';
        }
        previousChat = chat;

        panel.querySelector('#om30-chat').textContent = chat || 'Conversa não identificada';
        panel.querySelector('#om30-mode-chip').textContent = modeLabel();

        applyUnit();
        applyClassification();
        applyDates();
        updateDescription();
        renderEvidence();
        updateUnknownNumbers();
        updateFloating();
    }


    // ============================================================
    // MOTOR SILENCIOSO GLPI v0.8.0
    //
    // Fluxo validado:
    // WhatsApp -> GM_xmlhttpRequest -> formulário/CSRF -> upload/tag ->
    // POST de criação -> identifica ID -> GET do chamado -> pós-fix
    // Service Desk -> Sistemas da operação -> validação.
    //
    // Nenhuma aba do GLPI é aberta automaticamente.
    // ============================================================

    const SILENT_GLPI = {
        lastTicketKey: 'OM30_GLPI_SILENT_LAST_TICKET_V0800',
        runnerKey: 'OM30_GLPI_SILENT_RUNNER_V0800',
        lastErrorKey: 'OM30_GLPI_SILENT_LAST_ERROR_V0802'
    };

    // Localizações obtidas do próprio Select2 do GLPI.
    // Guarujá (567) e Jales (588) já possuem mapa confirmado.
    // Isso elimina a dependência de descobrir _idor_token da Localização
    // para as unidades que já foram confirmadas no GLPI.
    const SILENT_CONFIRMED_LOCATIONS = {
        '567': [
        {
                "id": 2098,
                "text": "ALMOXARIFADO CENTRAL DA SAUDE",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > ALMOXARIFADO CENTRAL DA SAUDE"
        },
        {
                "id": 2099,
                "text": "AMB. REF. EM ESPECIALIDADES - ARE",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > AMB. REF. EM ESPECIALIDADES - ARE"
        },
        {
                "id": 2100,
                "text": "CAPS AD II",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > CAPS AD II"
        },
        {
                "id": 2101,
                "text": "CAPS II - DR JOSE FORSTHER JUNIOR",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > CAPS II - DR JOSE FORSTHER JUNIOR"
        },
        {
                "id": 2102,
                "text": "CAPS III",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > CAPS III"
        },
        {
                "id": 2103,
                "text": "CAPS INFANTIL",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > CAPS INFANTIL"
        },
        {
                "id": 2880,
                "text": "CASA SER",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > CASA SER"
        },
        {
                "id": 2104,
                "text": "CENTRO DE ESPECIALIDADE ODONTOLOGICA - CEO",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > CENTRO DE ESPECIALIDADE ODONTOLOGICA - CEO"
        },
        {
                "id": 2727,
                "text": "CENTRO DE ESPECIALIDADES DE VICENTE DE CARVALHO",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > CENTRO DE ESPECIALIDADES DE VICENTE DE CARVALHO"
        },
        {
                "id": 2105,
                "text": "CENTRO DE RECUPERACAO E FISIOTERAPIA DE GUARUJÁ",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > CENTRO DE RECUPERACAO E FISIOTERAPIA DE GUARUJÁ"
        },
        {
                "id": 2106,
                "text": "CENTRO DE RECUPERACAO E FISIOTERAPIA DE VICENTE DE CARVALHO",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > CENTRO DE RECUPERACAO E FISIOTERAPIA DE VICENTE DE CARVALHO"
        },
        {
                "id": 2107,
                "text": "CENTRO DE REFERÊNCIA EM OTORRINO, OFTALMO E FONOAUDIOLOGIA",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > CENTRO DE REFERÊNCIA EM OTORRINO, OFTALMO E FONOAUDIOLOGIA"
        },
        {
                "id": 2108,
                "text": "CONSULTORIO NA RUA",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > CONSULTORIO NA RUA"
        },
        {
                "id": 2109,
                "text": "FARMACIA DO CIDADAO - JAYRO GRACIOLA",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > FARMACIA DO CIDADAO - JAYRO GRACIOLA"
        },
        {
                "id": 2110,
                "text": "FARMACIA DO CIDADAO - VICENTE DE CARVALHO",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > FARMACIA DO CIDADAO - VICENTE DE CARVALHO"
        },
        {
                "id": 2111,
                "text": "FARMACIA DO CIDADAO - VILA JULIA",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > FARMACIA DO CIDADAO - VILA JULIA"
        },
        {
                "id": 2112,
                "text": "INSTITUTO DA MULHER - CASA ROSA",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > INSTITUTO DA MULHER - CASA ROSA"
        },
        {
                "id": 2849,
                "text": "PREFEITURA DE GUARUJÁ",
                "fullText": "CLIENTES > PREFEITURA DE GUARUJÁ"
        },
        {
                "id": 640,
                "text": "PREFEITURA DE GUARUJÁ",
                "fullText": "PREFEITURA DE GUARUJÁ"
        },
        {
                "id": 2113,
                "text": "PRONTO SOCORRO DE VICENTE DE CARVALHO",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > PRONTO SOCORRO DE VICENTE DE CARVALHO"
        },
        {
                "id": 2114,
                "text": "PRONTO SOCORRO PEREQUE - ANIBAL ARDEN DOS REIS",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > PRONTO SOCORRO PEREQUE - ANIBAL ARDEN DOS REIS"
        },
        {
                "id": 2115,
                "text": "PRONTO SOCORRO PROF. DR. MATHEUS SANTAMARIA",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > PRONTO SOCORRO PROF. DR. MATHEUS SANTAMARIA"
        },
        {
                "id": 642,
                "text": "PRONTO SOCORRO PROFº DR. MATHEUS SANTAMARIA – PAM RODOVIÁRIA",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > PRONTO SOCORRO PROFº DR. MATHEUS SANTAMARIA – PAM RODOVIÁRIA"
        },
        {
                "id": 2116,
                "text": "PRONTO SOCORRO SANTA CRUZ DOS NAVEGANTES",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > PRONTO SOCORRO SANTA CRUZ DOS NAVEGANTES"
        },
        {
                "id": 2117,
                "text": "RESIDÊNCIA TERAPÊUTICA",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > RESIDÊNCIA TERAPÊUTICA"
        },
        {
                "id": 2118,
                "text": "SAMU",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > SAMU"
        },
        {
                "id": 641,
                "text": "SECRETARIA DE SAÚDE",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE"
        },
        {
                "id": 2119,
                "text": "SECRETARIA DE SAUDE / CENTRAL DE REGULAÇÃO",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > SECRETARIA DE SAUDE / CENTRAL DE REGULAÇÃO"
        },
        {
                "id": 2120,
                "text": "SERVICO DE TRANSPORTE SANITARIO DO GUARUJA",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > SERVICO DE TRANSPORTE SANITARIO DO GUARUJA"
        },
        {
                "id": 2121,
                "text": "SERVIÇO DE VIGILÂNCIA SANITARIA E EPIDEMIOLÓGICA",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > SERVIÇO DE VIGILÂNCIA SANITARIA E EPIDEMIOLÓGICA"
        },
        {
                "id": 2122,
                "text": "SIAD - SERVICO DE INTERNAÇÃO E ASSISTÊNCIA DOMICILIAR",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > SIAD - SERVICO DE INTERNAÇÃO E ASSISTÊNCIA DOMICILIAR"
        },
        {
                "id": 2123,
                "text": "UBS MORRINHOS",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > UBS MORRINHOS"
        },
        {
                "id": 2124,
                "text": "UBS PAE CARA",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > UBS PAE CARA"
        },
        {
                "id": 2125,
                "text": "UBS PERNAMBUCO",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > UBS PERNAMBUCO"
        },
        {
                "id": 2126,
                "text": "UBS PRAINHA VICENTE DE CARVALHO",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > UBS PRAINHA VICENTE DE CARVALHO"
        },
        {
                "id": 2127,
                "text": "UBS VILA ALICE",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > UBS VILA ALICE"
        },
        {
                "id": 2128,
                "text": "UBS VILA BAIANA",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > UBS VILA BAIANA"
        },
        {
                "id": 2728,
                "text": "UNAERP",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > UNAERP"
        },
        {
                "id": 2129,
                "text": "UNIDADE BÁSICA DE SAUDE SANTA ROSA",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > UNIDADE BÁSICA DE SAUDE SANTA ROSA"
        },
        {
                "id": 2130,
                "text": "UNIDADE DE ESPECIALIDADE EM DIABETES, OBESIDADE E INFARTO JUVENIL - DOCINHOS",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > UNIDADE DE ESPECIALIDADE EM DIABETES, OBESIDADE E INFARTO JUVENIL - DOCINHOS"
        },
        {
                "id": 2131,
                "text": "UNIDADE DE INFECTOLOGIA - WILLIAN ROCHA",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > UNIDADE DE INFECTOLOGIA - WILLIAN ROCHA"
        },
        {
                "id": 2132,
                "text": "UNIDADE DE VIGILANCIA EM ZOONOSES DE GUARUJA",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > UNIDADE DE VIGILANCIA EM ZOONOSES DE GUARUJA"
        },
        {
                "id": 2133,
                "text": "UPA ENSEADA - PAULO FLAVIO AFONSO PIASENTI",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > UPA ENSEADA - PAULO FLAVIO AFONSO PIASENTI"
        },
        {
                "id": 644,
                "text": "USAFA CIDADE ATLÂNTICA",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > USAFA CIDADE ATLANTICA"
        },
        {
                "id": 646,
                "text": "USAFA JARDIM BOA ESPERANÇA",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > USAFA JARDIM BOA ESPERANCA"
        },
        {
                "id": 648,
                "text": "USAFA JARDIM BRASIL",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > USAFA JARDIM BRASIL"
        },
        {
                "id": 2134,
                "text": "USAFA JARDIM BRASIL - GUSTAVO COELHO DE ALMEIDA",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > USAFA JARDIM BRASIL - GUSTAVO COELHO DE ALMEIDA"
        },
        {
                "id": 650,
                "text": "USAFA JARDIM CONCEIÇÃOZINHA",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > USAFA JARDIM CONCEIÇÃOZINHA"
        },
        {
                "id": 2135,
                "text": "USAFA JARDIM CONCEICAOZINHA - GENTIL NUNES NETO",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > USAFA JARDIM CONCEICAOZINHA - GENTIL NUNES NETO"
        },
        {
                "id": 652,
                "text": "USAFA JARDIM DOS PÁSSAROS",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > USAFA JARDIM DOS PASSAROS"
        },
        {
                "id": 654,
                "text": "USAFA JARDIM LAS PALMAS",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > USAFA JARDIM LAS PALMAS"
        },
        {
                "id": 2136,
                "text": "USAFA JARDIM LAS PALMAS - JANDUI DE SOUZA MOREIRA",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > USAFA JARDIM LAS PALMAS - JANDUI DE SOUZA MOREIRA"
        },
        {
                "id": 656,
                "text": "USAFA JARDIM PROGRESSO",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > USAFA JARDIM PROGRESSO"
        },
        {
                "id": 658,
                "text": "USAFA PEREQUÊ",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > USAFA PEREQUE"
        },
        {
                "id": 660,
                "text": "USAFA SANTA CRUZ DOS NAVEGANTES",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > USAFA SANTA CRUZ DOS NAVEGANTES"
        },
        {
                "id": 662,
                "text": "USAFA SANTA ROSA",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > USAFA SANTA ROSA"
        },
        {
                "id": 664,
                "text": "USAFA SÍTIO CONCEIÇÃOZINHA",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > USAFA SITIO CONCEICAOZINHA"
        },
        {
                "id": 666,
                "text": "USAFA VILA ÁUREA",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > USAFA VILA AUREA"
        },
        {
                "id": 668,
                "text": "USAFA VILA EDNA",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > USAFA VILA EDNA"
        },
        {
                "id": 2137,
                "text": "USAFA VILA EDNA - MARCO ANTONIO GONZALEZ",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > USAFA VILA EDNA - MARCO ANTONIO GONZALEZ"
        },
        {
                "id": 670,
                "text": "USAFA VILA RÃ",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > USAFA VILA RA"
        },
        {
                "id": 672,
                "text": "USAFA VILA ZILDA",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > USAFA VILA ZILDA"
        },
        {
                "id": 2138,
                "text": "USAFA VILA ZILDA DR DAVID CAPISTRANO",
                "fullText": "PREFEITURA DE GUARUJÁ > SECRETARIA DE SAÚDE > USAFA VILA ZILDA DR DAVID CAPISTRANO"
        }
],
        '588': [
                {
                        "id": 2765,
                        "text": "Almoxarifado de Saúde",
                        "fullText": "PREFEITURA DE JALES > SECRETARIA MUNICIPAL DE SAÚDE > Almoxarifado de Saúde"
                },
                {
                        "id": 2763,
                        "text": "Ambulatório de Saúde Mental de Jales",
                        "fullText": "PREFEITURA DE JALES > SECRETARIA MUNICIPAL DE SAÚDE > Ambulatório de Saúde Mental de Jales"
                },
                {
                        "id": 2755,
                        "text": "APS/ESF Dr Antonio Queda (antigo Núcleo)",
                        "fullText": "PREFEITURA DE JALES > SECRETARIA MUNICIPAL DE SAÚDE > APS/ESF Dr Antonio Queda (antigo Núcleo)"
                },
                {
                        "id": 2760,
                        "text": "ARE (Ambulatório Regional de Especialidades), CMR (Centro Municipal de Reabilitação) e Setor de Combate a Endemias, endereço: Rua 17, nº 2.957, Centro",
                        "fullText": "PREFEITURA DE JALES > SECRETARIA MUNICIPAL DE SAÚDE > ARE (Ambulatório Regional de Especialidades), CMR (Centro Municipal de Reabilitação) e Setor de Combate a Endemias, endereço: Rua 17, nº 2.957, Centro"
                },
                {
                        "id": 2762,
                        "text": "Centro de Distribuição Farmacêutica (Alto custo e Ação Judicial) e Setor de Imunização",
                        "fullText": "PREFEITURA DE JALES > SECRETARIA MUNICIPAL DE SAÚDE > Centro de Distribuição Farmacêutica (Alto custo e Ação Judicial) e Setor de Imunização"
                },
                {
                        "id": 2764,
                        "text": "CIACA (Centro Integrado de Atendimento em Saúde Mental à Criança e ao Adolescente)",
                        "fullText": "PREFEITURA DE JALES > SECRETARIA MUNICIPAL DE SAÚDE > CIACA (Centro Integrado de Atendimento em Saúde Mental à Criança e ao Adolescente)"
                },
                {
                        "id": 2756,
                        "text": "ESF Dr José Cícero Fontes Xavier (Rural)",
                        "fullText": "PREFEITURA DE JALES > SECRETARIA MUNICIPAL DE SAÚDE > ESF Dr José Cícero Fontes Xavier (Rural)"
                },
                {
                        "id": 2751,
                        "text": "ESF Francisco Xavier Rego (Jd. Paraíso)",
                        "fullText": "PREFEITURA DE JALES > SECRETARIA MUNICIPAL DE SAÚDE > ESF Francisco Xavier Rego (Jd. Paraíso)"
                },
                {
                        "id": 2746,
                        "text": "ESF Getúlio de Carvalho (Jd. Arapuã)",
                        "fullText": "PREFEITURA DE JALES > SECRETARIA MUNICIPAL DE SAÚDE > ESF Getúlio de Carvalho (Jd. Arapuã)"
                },
                {
                        "id": 2754,
                        "text": "ESF Honorio Amadeu ( Uni - America)",
                        "fullText": "PREFEITURA DE JALES > SECRETARIA MUNICIPAL DE SAÚDE > ESF Honorio Amadeu ( Uni - America)"
                },
                {
                        "id": 2750,
                        "text": "ESF Leonisio Gambero (Jd. Oiti)",
                        "fullText": "PREFEITURA DE JALES > SECRETARIA MUNICIPAL DE SAÚDE > ESF Leonisio Gambero (Jd. Oiti)"
                },
                {
                        "id": 2747,
                        "text": "ESF Luis Ernesto Sandi Mori (Jd. JACB)",
                        "fullText": "PREFEITURA DE JALES > SECRETARIA MUNICIPAL DE SAÚDE > ESF Luis Ernesto Sandi Mori (Jd. JACB)"
                },
                {
                        "id": 2748,
                        "text": "ESF Ozil Joaquim Resende (Jd. Municipal)",
                        "fullText": "PREFEITURA DE JALES > SECRETARIA MUNICIPAL DE SAÚDE > ESF Ozil Joaquim Resende (Jd. Municipal)"
                },
                {
                        "id": 2753,
                        "text": "ESF Setuo Setugo (Jd. São Jorge)",
                        "fullText": "PREFEITURA DE JALES > SECRETARIA MUNICIPAL DE SAÚDE > ESF Setuo Setugo (Jd. São Jorge)"
                },
                {
                        "id": 2752,
                        "text": "ESF Shiguero Kitayama (Jd. Roque Viola)",
                        "fullText": "PREFEITURA DE JALES > SECRETARIA MUNICIPAL DE SAÚDE > ESF Shiguero Kitayama (Jd. Roque Viola)"
                },
                {
                        "id": 2757,
                        "text": "ESF Virgílio Ribeiro Franco São Gabriel (Jd. São Gabriel)",
                        "fullText": "PREFEITURA DE JALES > SECRETARIA MUNICIPAL DE SAÚDE > ESF Virgílio Ribeiro Franco São Gabriel (Jd. São Gabriel)"
                },
                {
                        "id": 2749,
                        "text": "ESF Zilda Arns Meumann (Jd. Novo Mundo)",
                        "fullText": "PREFEITURA DE JALES > SECRETARIA MUNICIPAL DE SAÚDE > ESF Zilda Arns Meumann (Jd. Novo Mundo)"
                },
                {
                        "id": 2761,
                        "text": "Laboratório de Saúde Pública do SUS",
                        "fullText": "PREFEITURA DE JALES > SECRETARIA MUNICIPAL DE SAÚDE > Laboratório de Saúde Pública do SUS"
                },
                {
                        "id": 2759,
                        "text": "SAE/CTA (Serviço de Assistência e Especializada / Centro de Testagem e Aconselhamento)",
                        "fullText": "PREFEITURA DE JALES > SECRETARIA MUNICIPAL DE SAÚDE > SAE/CTA (Serviço de Assistência e Especializada / Centro de Testagem e Aconselhamento)"
                },
                {
                        "id": 2758,
                        "text": "SECRETARIA MUNICIPAL DE SAÚDE",
                        "fullText": "PREFEITURA DE JALES > SECRETARIA MUNICIPAL DE SAÚDE"
                }
        ]
    };

    let silentGlpiRunnerPromise = null;

    function silentParseHTML(html) {
        return new DOMParser().parseFromString(String(html || ''), 'text/html');
    }

    function silentLooksLikeLogin(html, finalUrl = '') {
        const url = String(finalUrl || '').toLowerCase();

        if (
            url.includes('/front/login.php') ||
            (
                url.includes('/index.php') &&
                !url.includes('ticket.form.php')
            )
        ) {
            return true;
        }

        try {
            const doc = silentParseHTML(html);
            if (
                doc.querySelector(
                    'input[name="login_name"], input[name="login_password"], form[action*="login"]'
                )
            ) {
                return true;
            }
        } catch {}

        const text = String(html || '').toLowerCase();
        return (
            text.includes('name="login_name"') ||
            text.includes('name="login_password"')
        );
    }

    function silentRequest(details) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                ...details,
                redirect: 'follow',
                timeout: Number(details?.timeout || 30000),
                anonymous: false,
                onload: resolve,
                onerror: error => reject(
                    new Error(
                        `Falha de comunicação com o GLPI: ` +
                        `${error?.error || error?.statusText || 'erro desconhecido'}`
                    )
                ),
                ontimeout: () => reject(
                    new Error('Tempo esgotado na comunicação com o GLPI.')
                )
            });
        });
    }

    function silentFormFromHTML(html) {
        const doc = silentParseHTML(html);
        const form =
            doc.querySelector('#itil-form') ||
            [...doc.forms].find(f => {
                const action = String(f.getAttribute('action') || '');
                return (
                    action.includes('ticket.form.php') ||
                    f.id === 'itil-form'
                );
            });

        return { doc, form };
    }

    function silentMainTabUrl(ticketId = 0) {
        return (
            `${GLPI_TEST.base}/ajax/common.tabs.php` +
            `?_glpi_tab=Ticket%24main` +
            `&_target=%2Ffront%2Fticket.form.php` +
            `&_itemtype=Ticket` +
            `&id=${encodeURIComponent(ticketId)}`
        );
    }

    async function silentGetTicketForm(ticketId = 0) {
        const ticketUrl = ticketId
            ? `${GLPI_TEST.base}/front/ticket.form.php?id=${encodeURIComponent(ticketId)}`
            : `${GLPI_TEST.base}/front/ticket.form.php`;

        const shell = await silentRequest({
            method: 'GET',
            url: `${ticketUrl}${ticketUrl.includes('?') ? '&' : '?'}om30_silent=${Date.now()}`,
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        });

        const shellHtml = shell.responseText || '';
        const shellFinal = shell.finalUrl || ticketUrl;

        if (silentLooksLikeLogin(shellHtml, shellFinal)) {
            return {
                authenticated: false,
                phase: 'shell',
                status: shell.status,
                rawHtml: shellHtml
            };
        }

        let parsed = silentFormFromHTML(shellHtml);

        if (parsed.form) {
            const csrf =
                parsed.form.querySelector('[name="_glpi_csrf_token"]')?.value ||
                '';

            if (!csrf) {
                throw new Error('Formulário GLPI encontrado sem CSRF.');
            }

            return {
                authenticated: true,
                doc: parsed.doc,
                form: parsed.form,
                rawHtml: shellHtml,
                source: 'ticket.form.php',
                ticketUrl
            };
        }

        const tabUrl = silentMainTabUrl(ticketId);

        const tab = await silentRequest({
            method: 'GET',
            url: `${tabUrl}&om30_silent=${Date.now()}`,
            headers: {
                'Accept': '*/*',
                'X-Requested-With': 'XMLHttpRequest',
                'Referer': ticketUrl
            }
        });

        const tabHtml = tab.responseText || '';
        const tabFinal = tab.finalUrl || tabUrl;

        if (silentLooksLikeLogin(tabHtml, tabFinal)) {
            return {
                authenticated: false,
                phase: 'common.tabs',
                status: tab.status,
                rawHtml: tabHtml
            };
        }

        parsed = silentFormFromHTML(tabHtml);

        if (!parsed.form) {
            throw new Error(
                `Formulário #itil-form não encontrado no GLPI ` +
                `(${ticketId ? `chamado #${ticketId}` : 'novo chamado'}).`
            );
        }

        const csrf =
            parsed.form.querySelector('[name="_glpi_csrf_token"]')?.value ||
            '';

        if (!csrf) {
            throw new Error('CSRF do GLPI não encontrado.');
        }

        return {
            authenticated: true,
            doc: parsed.doc,
            form: parsed.form,
            rawHtml: tabHtml,
            source: 'common.tabs.php',
            ticketUrl
        };
    }

    function silentActorUser(userId) {
        return {
            itemtype: 'User',
            items_id: String(userId),
            use_notification: 1,
            alternative_email: ''
        };
    }

    function silentActorGroup(groupId) {
        return {
            itemtype: 'Group',
            items_id: String(groupId),
            use_notification: 1,
            alternative_email: ''
        };
    }

    function silentDedupeActors(list) {
        const map = new Map();

        for (const actor of list || []) {
            const type = glpiNormalize(actor?.itemtype);
            const id = String(actor?.items_id || '');

            if (!type || !id) continue;

            map.set(
                `${type}|${id}`,
                {
                    ...actor,
                    itemtype: type === 'GROUP' ? 'Group' : 'User',
                    items_id: id,
                    use_notification:
                        actor?.use_notification === 0 ? 0 : 1,
                    alternative_email:
                        actor?.alternative_email || ''
                }
            );
        }

        return [...map.values()];
    }

    function silentReadHiddenActors(form) {
        if (!form) return null;

        const raw =
            form.querySelector(
                'input[name="_actors"], textarea[name="_actors"]'
            )?.value ||
            '';

        if (!raw) return null;

        try {
            const actors = JSON.parse(raw);

            if (!Array.isArray(actors.requester)) actors.requester = [];
            if (!Array.isArray(actors.observer)) actors.observer = [];
            if (!Array.isArray(actors.assign)) actors.assign = [];

            return actors;
        } catch {
            return null;
        }
    }

    function silentCollectUserCandidates(ctx) {
        const candidates = new Map();

        function add(id, name, source, score) {
            id = String(id || '').match(/^\d+$/)?.[0] || '';
            if (!id) return;

            const current = candidates.get(id) || {
                id,
                name: '',
                score: 0,
                hits: []
            };

            if (name && !current.name) {
                current.name = String(name)
                    .replace(/\s+/g, ' ')
                    .trim();
            }

            current.score += Number(score || 0);
            current.hits.push(source);
            candidates.set(id, current);
        }

        const hidden = silentReadHiddenActors(ctx?.form);

        if (hidden) {
            for (const role of ['requester', 'assign']) {
                for (
                    const actor of
                    (Array.isArray(hidden?.[role]) ? hidden[role] : [])
                ) {
                    if (
                        glpiNormalize(actor?.itemtype) === 'USER' &&
                        /^\d+$/.test(String(actor?.items_id || ''))
                    ) {
                        add(
                            actor.items_id,
                            '',
                            `_actors.${role}`,
                            role === 'requester' ? 600 : 520
                        );
                    }
                }
            }
        }

        const form = ctx?.form;

        if (form) {
            for (const select of form.querySelectorAll('select')) {
                for (
                    const option of
                    [...select.options].filter(o => o.selected)
                ) {
                    const match =
                        String(option.value || '')
                            .match(/^User_(\d+)$/i);

                    if (!match) continue;

                    add(
                        match[1],
                        option.textContent || '',
                        'select ator selecionado',
                        460
                    );
                }
            }

            for (
                const option of
                form.querySelectorAll('option[value^="User_"][selected]')
            ) {
                const match =
                    String(option.value || '')
                        .match(/^User_(\d+)$/i);

                if (!match) continue;

                add(
                    match[1],
                    option.textContent || '',
                    'HTML option User selecionada',
                    420
                );
            }
        }

        const raw = String(ctx?.rawHtml || '');

        const patterns = [
            {
                re: /<option[^>]+value=["']User_(\d+)["'][^>]*(?:selected|checked)[^>]*>([^<]*)<\/option>/gi,
                score: 320,
                source: 'HTML User selecionado'
            },
            {
                re: /<option[^>]*(?:selected|checked)[^>]+value=["']User_(\d+)["'][^>]*>([^<]*)<\/option>/gi,
                score: 320,
                source: 'HTML User selecionado'
            },
            {
                re: /["']itemtype["']\s*:\s*["']User["'][\s\S]{0,180}?["']items_id["']\s*:\s*["']?(\d+)["']?/gi,
                score: 360,
                source: 'HTML _actors'
            },
            {
                re: /users_id_(?:requester|assign)=(\d+)/gi,
                score: 260,
                source: 'HTML actorinformation'
            }
        ];

        for (const spec of patterns) {
            let match;

            while ((match = spec.re.exec(raw)) !== null) {
                add(
                    match[1],
                    match[2] || '',
                    spec.source,
                    spec.score
                );
            }
        }

        return [...candidates.values()]
            .sort(
                (a, b) =>
                    b.score - a.score ||
                    b.hits.length - a.hits.length
            );
    }

    async function silentVerifyUser(userId) {
        for (const role of ['requester', 'assign']) {
            const response = await silentRequest({
                method: 'GET',
                url:
                    `${GLPI_TEST.base}/ajax/actorinformation.php` +
                    `?users_id_${role}=${encodeURIComponent(userId)}` +
                    `&only_number=true`,
                headers: {
                    'Accept': '*/*',
                    'X-Requested-With': 'XMLHttpRequest',
                    'Referer': `${GLPI_TEST.base}/front/ticket.form.php`
                }
            });

            const html = response.responseText || '';

            if (
                silentLooksLikeLogin(
                    html,
                    response.finalUrl || ''
                )
            ) {
                throw new Error('LOGIN_REQUIRED');
            }

            if (
                response.status < 200 ||
                response.status >= 400
            ) {
                return false;
            }
        }

        return true;
    }

    async function silentResolveCurrentUser(ctx) {
        const candidates =
            silentCollectUserCandidates(ctx);

        const strong =
            candidates.filter(
                candidate =>
                    candidate.score >= 300 ||
                    candidate.hits.length >= 2
            );

        if (!strong.length) {
            throw new Error(
                'Não consegui identificar o usuário logado no GLPI.'
            );
        }

        const best = strong[0];

        if (!await silentVerifyUser(best.id)) {
            throw new Error(
                'O usuário detectado no GLPI não pôde ser validado.'
            );
        }

        return {
            id: String(best.id),
            name:
                best.name ||
                `User_${best.id}`,
            source:
                [...new Set(best.hits)].join(' + ')
        };
    }

    function silentDecodeScriptText(raw) {
        return String(raw || '')
            .replace(/&quot;/gi, '"')
            .replace(/&#0*39;/gi, "'")
            .replace(/&#x27;/gi, "'")
            .replace(/&amp;/gi, '&')
            .replace(/\\\//g, '/')
            .replace(/\\u0022/gi, '"')
            .replace(/\\u0027/gi, "'");
    }

    function silentNearestMatch(text, index, regex, radius = 7000) {
        const start = Math.max(0, index - radius);
        const end = Math.min(text.length, index + radius);
        const part = text.slice(start, end);

        let best = null;
        let match;

        regex.lastIndex = 0;

        while ((match = regex.exec(part)) !== null) {
            const absolute = start + match.index;
            const distance = Math.abs(absolute - index);

            if (!best || distance < best.distance) {
                best = {
                    value: match[1],
                    distance,
                    absolute
                };
            }
        }

        return best?.value || '';
    }

    function silentExtractDropdownConfigs(rawHtml, itemtype) {
        const text =
            silentDecodeScriptText(rawHtml);

        const anchors =
            itemtype === 'ITILCategory'
                ? [
                    'dropdown_itilcategories_id',
                    'itilcategories_id',
                    'ITILCategory'
                ]
                : itemtype === 'Location'
                    ? [
                        'dropdown_locations_id',
                        'locations_id',
                        'Location'
                    ]
                    : [
                        itemtype
                    ];

        const indexes =
            new Set();

        for (const anchor of anchors) {
            if (!anchor) continue;

            const re =
                new RegExp(
                    String(anchor)
                        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
                    'ig'
                );

            let match;

            while ((match = re.exec(text)) !== null) {
                indexes.add(
                    match.index
                );
            }
        }

        // Fallback mais genérico.
        const itemtypeRegex =
            new RegExp(
                `itemtype[\\s\\S]{0,80}${itemtype}`,
                'ig'
            );

        let match;

        while ((match = itemtypeRegex.exec(text)) !== null) {
            indexes.add(
                match.index
            );
        }

        const configs = [];

        function nearestAll(index, regex, radius = 12000) {
            const start =
                Math.max(
                    0,
                    index - radius
                );

            const end =
                Math.min(
                    text.length,
                    index + radius
                );

            const part =
                text.slice(
                    start,
                    end
                );

            const found = [];
            let m;

            regex.lastIndex = 0;

            while ((m = regex.exec(part)) !== null) {
                found.push({
                    value:
                        m[1],
                    distance:
                        Math.abs(
                            start +
                            m.index -
                            index
                        )
                });
            }

            return found
                .sort(
                    (a, b) =>
                        a.distance -
                        b.distance
                );
        }

        for (const index of indexes) {
            const tokens =
                nearestAll(
                    index,
                    /_idor_token[\s\S]{0,160}?([a-f0-9]{64})/ig
                )
                    .slice(0, 4);

            const conditions =
                nearestAll(
                    index,
                    /condition[\s\S]{0,120}?([a-f0-9]{32,64})/ig,
                    9000
                )
                    .slice(0, 4);

            for (const tokenItem of tokens) {
                // 1) tenta condição mais próxima.
                if (conditions.length) {
                    for (const conditionItem of conditions.slice(0, 2)) {
                        configs.push({
                            itemtype,
                            token:
                                tokenItem.value,
                            condition:
                                conditionItem.value,
                            anchorIndex:
                                index,
                            score:
                                tokenItem.distance +
                                conditionItem.distance
                        });
                    }
                }

                // 2) MUITO IMPORTANTE:
                // categoria também é testada sem condition.
                // O GLPI aceita a busca ampla e isso evita um condition
                // de outro Select2 filtrar Touch/Erro/etc. para vazio.
                configs.push({
                    itemtype,
                    token:
                        tokenItem.value,
                    condition:
                        '',
                    anchorIndex:
                        index,
                    score:
                        tokenItem.distance +
                        2500
                });
            }
        }

        // Deduplica token + condition.
        const unique =
            new Map();

        for (const cfg of configs) {
            if (!cfg?.token) continue;

            const key =
                `${cfg.token}|${cfg.condition || ''}`;

            const previous =
                unique.get(key);

            if (
                !previous ||
                Number(cfg.score || 999999) <
                Number(previous.score || 999999)
            ) {
                unique.set(
                    key,
                    cfg
                );
            }
        }

        return [...unique.values()]
            .sort(
                (a, b) =>
                    Number(a.score || 0) -
                    Number(b.score || 0)
            )
            .slice(0, 12);
    }

    function silentExtractDropdownConfig(rawHtml, itemtype) {
        return (
            silentExtractDropdownConfigs(
                rawHtml,
                itemtype
            )[0] ||
            null
        );
    }

    function silentDropdownItems(json) {
        const source =
            Array.isArray(json)
                ? json
                : (
                    json?.results ||
                    json?.items ||
                    []
                );

        return flattenSelect2Results(
            Array.isArray(source) ? source : []
        );
    }

    async function silentQueryDropdown(
        ctx,
        itemtype,
        term,
        entityId
    ) {
        const configs =
            silentExtractDropdownConfigs(
                ctx.rawHtml,
                itemtype
            );

        if (!configs.length) {
            throw new Error(
                `Não consegui obter o token do campo ${itemtype} no GLPI.`
            );
        }

        const csrf =
            ctx.form.querySelector(
                '[name="_glpi_csrf_token"]'
            )?.value ||
            '';

        if (!csrf) {
            throw new Error(
                'CSRF do GLPI não encontrado para consulta.'
            );
        }

        const collected = [];
        const diagnostics = [];

        // Para categoria, tentamos mais combinações porque existem vários
        // Select2 no HTML e um token/condition vizinho pode pertencer a outro.
        const maxAttempts =
            itemtype === 'ITILCategory'
                ? Math.min(
                    configs.length,
                    10
                )
                : Math.min(
                    configs.length,
                    6
                );

        for (
            let attempt = 0;
            attempt < maxAttempts;
            attempt++
        ) {
            const config =
                configs[attempt];

            const body =
                new URLSearchParams();

            body.set(
                'multiple',
                '0'
            );

            body.set(
                'display_emptychoice',
                '1'
            );

            if (
                itemtype ===
                'Location'
            ) {
                body.set(
                    'specific_tags[required]',
                    'true'
                );
            }

            body.set(
                'itemtype',
                itemtype
            );

            body.set(
                'emptylabel',
                '-----'
            );

            if (
                config.condition
            ) {
                body.set(
                    'condition',
                    config.condition
                );
            }

            if (
                itemtype ===
                'Location'
            ) {
                body.append(
                    'entity_restrict[]',
                    String(entityId)
                );
            } else {
                body.set(
                    'entity_restrict',
                    String(entityId)
                );
            }

            body.set(
                'permit_select_parent',
                '0'
            );

            body.set(
                'class',
                'form-select'
            );

            body.set(
                '_idor_token',
                config.token
            );

            body.set(
                'order',
                ''
            );

            if (
                String(term || '').trim()
            ) {
                body.set(
                    'searchText',
                    String(term)
                );
            }

            body.set(
                'page_limit',
                '100'
            );

            body.set(
                'page',
                '1'
            );

            try {
                const response =
                    await silentRequest({
                        method:
                            'POST',
                        url:
                            `${GLPI_TEST.base}/ajax/getDropdownValue.php`,
                        data:
                            body.toString(),
                        headers: {
                            'Content-Type':
                                'application/x-www-form-urlencoded; charset=UTF-8',
                            'Accept':
                                'application/json, text/javascript, */*; q=0.01',
                            'X-Requested-With':
                                'XMLHttpRequest',
                            'X-Glpi-Csrf-Token':
                                csrf,
                            'Referer':
                                `${GLPI_TEST.base}/front/ticket.form.php`
                        }
                    });

                const text =
                    response.responseText ||
                    '';

                if (
                    silentLooksLikeLogin(
                        text,
                        response.finalUrl ||
                        ''
                    )
                ) {
                    throw new Error(
                        'LOGIN_REQUIRED'
                    );
                }

                if (
                    response.status < 200 ||
                    response.status >= 400
                ) {
                    diagnostics.push({
                        attempt,
                        http:
                            response.status,
                        condition:
                            !!config.condition
                    });

                    continue;
                }

                let json;

                try {
                    json =
                        JSON.parse(
                            text
                        );
                } catch {
                    diagnostics.push({
                        attempt,
                        http:
                            response.status,
                        json:
                            false,
                        preview:
                            String(text)
                                .slice(0, 120)
                    });

                    continue;
                }

                const items =
                    silentDropdownItems(
                        json
                    );

                diagnostics.push({
                    attempt,
                    condition:
                        !!config.condition,
                    items:
                        items.length
                });

                collected.push(
                    ...items
                );

                // Se encontramos o termo exato, não precisa ficar testando
                // todos os tokens candidatos.
                const wanted =
                    glpiNormalize(
                        term
                    );

                if (
                    wanted &&
                    items.some(
                        item =>
                            categoryTextMatchesExpected(
                                item.text,
                                term
                            ) ||
                            glpiNormalize(
                                item.fullText ||
                                item.text
                            ).includes(
                                wanted
                            )
                    )
                ) {
                    break;
                }

            } catch (error) {
                if (
                    error?.message ===
                    'LOGIN_REQUIRED'
                ) {
                    throw error;
                }

                diagnostics.push({
                    attempt,
                    error:
                        String(
                            error?.message ||
                            error
                        )
                });
            }
        }

        const dedup =
            [...new Map(
                collected.map(
                    item => [
                        `${item.id}|${item.fullText || item.text}`,
                        item
                    ]
                )
            ).values()];

        console.log(
            `OM30 silencioso ${itemtype}:`,
            {
                termo:
                    term,
                resultados:
                    dedup.map(
                        item => ({
                            id:
                                item.id,
                            text:
                                item.text,
                            fullText:
                                item.fullText
                        })
                    ),
                diagnostics
            }
        );

        return dedup;
    }

    async function silentResolveCategory(ctx, data) {
        const terms = [
            data.category,
            `${data.system} ${data.category}`,
            data.system
        ]
            .map(
                value =>
                    String(value || '')
                        .trim()
            )
            .filter(Boolean);

        let candidates = [];

        for (
            let index = 0;
            index < terms.length;
            index++
        ) {
            const term =
                terms[index];

            try {
                const items =
                    await silentQueryDropdown(
                        ctx,
                        'ITILCategory',
                        term,
                        data.operation_id
                    );

                candidates.push(
                    ...annotateCategoryCandidates(
                        items,
                        term,
                        index
                    )
                );
            } catch (error) {
                if (
                    error?.message ===
                    'LOGIN_REQUIRED'
                ) {
                    throw error;
                }

                console.warn(
                    'OM30 silencioso: busca de categoria falhou',
                    term,
                    error
                );
            }
        }

        const dedup =
            [...new Map(
                candidates.map(
                    item => [
                        `${item.id}|${item.fullText || item.text}|${item._sourceTerm}`,
                        item
                    ]
                )
            ).values()];

        let result =
            chooseCategoryCandidate(
                dedup,
                data
            );

        // Fallback robusto para exatamente o caso mostrado na tela:
        // TI > Equipamentos > Totem > Touch.
        // Se o Select2 devolve o caminho completo, aceitamos a folha correta
        // somente quando o caminho também contém o sistema esperado.
        if (!result?.id) {
            const wantedSystem =
                glpiNormalize(
                    data.system
                );

            const wantedCategory =
                glpiNormalize(
                    data.category
                );

            const area =
                categoryAreaForSystem(
                    data.system
                );

            const contextual =
                dedup
                    .filter(
                        item =>
                            categoryTextMatchesExpected(
                                item.text,
                                data.category
                            )
                    )
                    .map(
                        item => ({
                            item,
                            full:
                                glpiNormalize(
                                    item.fullText ||
                                    item.text ||
                                    ''
                                )
                        })
                    )
                    .filter(
                        entry =>
                            (
                                !wantedSystem ||
                                entry.full.includes(
                                    wantedSystem
                                )
                            ) &&
                            (
                                !area ||
                                entry.full.includes(
                                    area
                                )
                            ) &&
                            !entry.full.includes(
                                'SENHA SIMPLES'
                            )
                    );

            if (
                contextual.length ===
                1
            ) {
                result =
                    contextual[0].item;
            } else if (
                contextual.length > 1
            ) {
                // Se vários resultados têm o mesmo caminho lógico,
                // só aceita se todos apontarem para o mesmo ID.
                const ids =
                    [...new Set(
                        contextual.map(
                            entry =>
                                String(
                                    entry.item.id
                                )
                        )
                    )];

                if (
                    ids.length ===
                    1
                ) {
                    result =
                        contextual[0].item;
                }
            }
        }

        if (!result?.id) {
            const preview =
                dedup
                    .slice(0, 12)
                    .map(
                        item =>
                            `${item.id}: ${item.fullText || item.text}`
                    )
                    .join(' | ');

            throw new Error(
                `Categoria não localizada no GLPI: ` +
                `${data.system} > ${data.category}.` +
                (
                    preview
                        ? ` Retorno: ${preview}`
                        : ''
                )
            );
        }

        console.log(
            '✅ OM30 categoria resolvida:',
            {
                sistema:
                    data.system,
                categoria:
                    data.category,
                id:
                    result.id,
                caminho:
                    result.fullText ||
                    result.text
            }
        );

        return result;
    }

    function silentConfirmedUnitCandidates(data) {
        const items =
            SILENT_CONFIRMED_LOCATIONS[
                String(data?.operation_id || '')
            ] ||
            [];

        return items.map(
            item => ({
                id:
                    String(item.id),
                text:
                    item.text,
                fullText:
                    item.fullText,
                title:
                    item.fullText
            })
        );
    }

    function silentResolveConfirmedUnit(data) {
        const candidates =
            silentConfirmedUnitCandidates(
                data
            );

        if (!candidates.length) {
            return null;
        }

        const target =
            glpiNormalize(
                data.unit
            );

        // Primeiro: nome exato normalizado.
        const exact =
            candidates.find(
                item =>
                    glpiNormalize(
                        item.text
                    ) === target
            );

        if (exact) {
            console.log(
                '✅ OM30 unidade resolvida pelo mapa confirmado:',
                {
                    unit:
                        data.unit,
                    id:
                        exact.id,
                    path:
                        exact.fullText
                }
            );

            return exact;
        }

        // Segundo: reaproveita o mesmo algoritmo de pontuação já validado.
        const scored =
            chooseUnitCandidate(
                candidates,
                data.unit,
                data.operation
            );

        if (scored?.id) {
            console.log(
                '✅ OM30 unidade resolvida por similaridade no mapa confirmado:',
                {
                    unit:
                        data.unit,
                    id:
                        scored.id,
                    path:
                        scored.fullText
                }
            );

            return scored;
        }

        return null;
    }

    async function silentResolveUnit(ctx, data) {
        const raw =
            String(
                data.unit || ''
            ).trim();

        if (!raw) {
            throw new Error(
                'Unidade está vazia.'
            );
        }

        // GUARUJÁ / JALES: as unidades conhecidas foram cruzadas com o
        // retorno real do GLPI. Usa o ID confirmado antes de qualquer
        // tentativa por Select2 remoto.
        const confirmed =
            silentResolveConfirmedUnit(
                data
            );

        if (confirmed?.id) {
            return confirmed;
        }

        // Outras operações / unidade futura não mapeada:
        // mantém a descoberta dinâmica como fallback.
        const normalized =
            glpiNormalize(raw)
                .split(' ')
                .filter(
                    token =>
                        token.length >= 3
                );

        const terms = [
            raw,
            normalized
                .slice(-3)
                .join(' '),
            normalized
                .slice(-2)
                .join(' '),
            normalized[
                normalized.length - 1
            ]
        ]
            .map(
                value =>
                    String(value || '')
                        .trim()
            )
            .filter(Boolean);

        let candidates = [];

        for (
            const term of
            [...new Set(terms)]
        ) {
            try {
                candidates.push(
                    ...await silentQueryDropdown(
                        ctx,
                        'Location',
                        term,
                        data.operation_id
                    )
                );
            } catch (error) {
                if (
                    error?.message ===
                    'LOGIN_REQUIRED'
                ) {
                    throw error;
                }

                console.warn(
                    'OM30 silencioso: busca dinâmica de unidade falhou',
                    term,
                    error
                );
            }
        }

        const dedup =
            [...new Map(
                candidates.map(
                    item => [
                        String(item.id),
                        item
                    ]
                )
            ).values()];

        const result =
            chooseUnitCandidate(
                dedup,
                data.unit,
                data.operation
            );

        if (!result?.id) {
            throw new Error(
                `Não encontrei a unidade "${data.unit}" no GLPI.`
            );
        }

        return result;
    }

    function silentDataUrlToFile(dataUrl, filename) {
        const match =
            String(dataUrl || '')
                .match(
                    /^data:([^;,]+)?(;base64)?,(.*)$/s
                );

        if (!match) {
            throw new Error(
                'Print inválido para envio ao GLPI.'
            );
        }

        const mime =
            match[1] ||
            'image/png';

        const binary =
            match[2]
                ? atob(match[3])
                : decodeURIComponent(match[3]);

        const bytes =
            new Uint8Array(
                binary.length
            );

        for (
            let index = 0;
            index < binary.length;
            index++
        ) {
            bytes[index] =
                binary.charCodeAt(index);
        }

        return new File(
            [bytes],
            filename,
            {
                type: mime,
                lastModified: Date.now()
            }
        );
    }

    function silentUploadName(dataUrl) {
        const ext =
            (
                String(dataUrl || '')
                    .match(/^data:image\/([a-z0-9.+-]+)/i)?.[1] ||
                'png'
            )
                .replace('jpeg', 'jpg');

        return (
            `${Date.now().toString(16)}` +
            `${Math.random().toString(16).slice(2, 10)}` +
            `image_paste${Math.floor(Math.random() * 9000000 + 1000000)}.${ext}`
        );
    }

    async function silentUploadPrint(ctx, job) {
        if (!job.printDataUrl) {
            return null;
        }

        const csrf =
            ctx.form.querySelector('[name="_glpi_csrf_token"]')?.value ||
            '';

        if (!csrf) {
            throw new Error(
                'CSRF não encontrado para envio do print.'
            );
        }

        const uploadName =
            silentUploadName(
                job.printDataUrl
            );

        const file =
            silentDataUrlToFile(
                job.printDataUrl,
                uploadName
            );

        const uploadFd =
            new FormData();

        uploadFd.append(
            'name',
            '_uploader_filename'
        );
        uploadFd.append(
            'showfilesize',
            '1'
        );
        uploadFd.append(
            '_uploader_filename[]',
            file,
            uploadName
        );

        const uploadResponse =
            await silentRequest({
                method: 'POST',
                url:
                    `${GLPI_TEST.base}/ajax/fileupload.php`,
                data:
                    uploadFd,
                headers: {
                    'Accept':
                        'application/json, text/javascript, */*; q=0.01',
                    'X-Requested-With':
                        'XMLHttpRequest',
                    'X-Glpi-Csrf-Token':
                        csrf,
                    'Referer':
                        `${GLPI_TEST.base}/front/ticket.form.php`
                }
            });

        const uploadText =
            uploadResponse.responseText || '';

        if (
            silentLooksLikeLogin(
                uploadText,
                uploadResponse.finalUrl || ''
            )
        ) {
            throw new Error('LOGIN_REQUIRED');
        }

        if (
            uploadResponse.status < 200 ||
            uploadResponse.status >= 400
        ) {
            throw new Error(
                `Upload do print respondeu HTTP ${uploadResponse.status}.`
            );
        }

        let uploadJson;

        try {
            uploadJson =
                JSON.parse(
                    uploadText
                );
        } catch {
            throw new Error(
                'GLPI não devolveu JSON válido no upload do print.'
            );
        }

        const files =
            uploadJson?._uploader_filename ||
            uploadJson?.files ||
            [];

        const fileData =
            Array.isArray(files)
                ? files[0]
                : null;

        if (!fileData?.name) {
            throw new Error(
                'GLPI não devolveu o nome temporário do print.'
            );
        }

        if (fileData.error) {
            throw new Error(
                `GLPI recusou o print: ${fileData.error}`
            );
        }

        const tagBody =
            new URLSearchParams();

        for (
            const [key, value] of
            Object.entries(fileData)
        ) {
            if (
                value === undefined ||
                value === null ||
                typeof value === 'object'
            ) {
                continue;
            }

            tagBody.set(
                `data[0][${key}]`,
                String(value)
            );
        }

        if (![...tagBody.keys()].length) {
            tagBody.set(
                'data[0][name]',
                String(fileData.name)
            );
        }

        const tagResponse =
            await silentRequest({
                method: 'POST',
                url:
                    `${GLPI_TEST.base}/ajax/getFileTag.php`,
                data:
                    tagBody.toString(),
                headers: {
                    'Content-Type':
                        'application/x-www-form-urlencoded; charset=UTF-8',
                    'Accept':
                        'application/json, text/javascript, */*; q=0.01',
                    'X-Requested-With':
                        'XMLHttpRequest',
                    'X-Glpi-Csrf-Token':
                        csrf,
                    'Referer':
                        `${GLPI_TEST.base}/front/ticket.form.php`
                }
            });

        const tagText =
            tagResponse.responseText || '';

        if (
            tagResponse.status < 200 ||
            tagResponse.status >= 400
        ) {
            throw new Error(
                `Tag do print respondeu HTTP ${tagResponse.status}.`
            );
        }

        let tagJson;

        try {
            tagJson =
                JSON.parse(
                    tagText
                );
        } catch {
            throw new Error(
                'GLPI não devolveu JSON válido para a tag do print.'
            );
        }

        const tagData =
            Array.isArray(tagJson)
                ? tagJson[0]
                : tagJson?.[0];

        if (
            !tagData?.name ||
            !tagData?.tag
        ) {
            throw new Error(
                'GLPI não gerou a tag da imagem.'
            );
        }

        return {
            fileData,
            tagData,
            imageId:
                String(tagData.tag)
                    .replace(/#/g, '')
        };
    }

    function silentDescriptionHTML(job, imageId = '') {
        const text =
            directEscapeHtml(
                job.data?.description || ''
            )
                .replace(/\r?\n/g, '<br>');

        const image =
            job.printDataUrl
                ? (
                    `<p><img` +
                    `${imageId ? ` id="${directEscapeHtml(imageId)}"` : ''}` +
                    ` src="${job.printDataUrl}"></p>`
                )
                : '';

        return `<p>${text}</p>${image}`;
    }

    function silentExpectedActors(userId) {
        return {
            requester: [
                silentActorUser(userId)
            ],
            observer: [],
            assign: [
                silentActorUser(userId)
            ]
        };
    }

    function silentPrepareCreateFormData(
        ctx,
        job,
        currentUser,
        category,
        unit,
        upload
    ) {
        const fd =
            new FormData(
                ctx.form
            );

        const data =
            job.data;

        fd.set(
            'entities_id',
            String(data.operation_id)
        );
        fd.set(
            'type',
            String(data.type_id)
        );
        fd.set(
            'itilcategories_id',
            String(category.id)
        );
        fd.set(
            'status',
            '5'
        );
        fd.set(
            'date',
            toGlpiDate(
                data.initial_date
            )
        );
        fd.set(
            'solvedate',
            toGlpiDate(
                data.solution_date
            )
        );
        fd.set(
            'locations_id',
            String(unit.id)
        );
        fd.set(
            'name',
            data.title ||
            'Chamado OM30'
        );

        fd.set(
            'urgency',
            String(fd.get('urgency') || '3')
        );
        fd.set(
            'impact',
            String(fd.get('impact') || '3')
        );
        fd.set(
            'priority',
            String(fd.get('priority') || '3')
        );

        fd.set(
            '_actors',
            JSON.stringify(
                silentExpectedActors(
                    currentUser.id
                )
            )
        );

        fd.set(
            '_skip_default_actor',
            '1'
        );

        if (upload) {
            fd.set(
                'content',
                silentDescriptionHTML(
                    job,
                    upload.imageId
                )
            );

            fd.set(
                '_filename[0]',
                String(
                    upload.fileData.name
                )
            );
            fd.set(
                '_prefix_filename[0]',
                String(
                    upload.fileData.prefix || ''
                )
            );
            fd.set(
                '_tag_filename[0]',
                String(
                    upload.tagData.name
                )
            );
        } else {
            fd.set(
                'content',
                silentDescriptionHTML(
                    job
                )
            );
        }

        const add =
            ctx.form.querySelector(
                'button[type="submit"][name="add"], input[type="submit"][name="add"]'
            );

        fd.set(
            add?.name || 'add',
            add?.value || 'Adicionar'
        );

        return fd;
    }

    function silentTicketIdFromHtml(html, finalUrl = '') {
        const direct =
            detectCreatedTicketIdFromHtml(
                html,
                finalUrl
            );

        if (direct) {
            return Number(direct);
        }

        const values = [];

        try {
            const doc =
                silentParseHTML(html);

            for (
                const link of
                doc.querySelectorAll(
                    'a[href*="ticket.form.php"]'
                )
            ) {
                const href =
                    link.getAttribute('href') ||
                    '';

                const match =
                    href.match(
                        /[?&]id=(\d+)/i
                    );

                if (match) {
                    values.push(
                        Number(match[1])
                    );
                }
            }
        } catch {}

        return values.length
            ? Math.max(...values)
            : null;
    }

    function silentSavedSeed() {
        let seed = 0;

        try {
            seed =
                Math.max(
                    seed,
                    Number(
                        localStorage.getItem(
                            SILENT_GLPI.lastTicketKey
                        ) || 0
                    )
                );
        } catch {}

        try {
            const history =
                getTicketHistory();

            for (const item of history) {
                seed =
                    Math.max(
                        seed,
                        Number(
                            item?.ticket_id || 0
                        )
                    );
            }
        } catch {}

        const result =
            readGlpiResult();

        if (result?.ticket_id) {
            seed =
                Math.max(
                    seed,
                    Number(result.ticket_id)
                );
        }

        return Number.isInteger(seed) &&
            seed > 0
            ? seed
            : 0;
    }

    function silentSaveSeed(id) {
        const value =
            Number(id);

        if (
            !Number.isInteger(value) ||
            value <= 0
        ) {
            return;
        }

        try {
            localStorage.setItem(
                SILENT_GLPI.lastTicketKey,
                String(value)
            );
        } catch {}
    }

    async function silentProbeTicketTitle(ticketId) {
        const ctx =
            await silentGetTicketForm(
                ticketId
            );

        if (!ctx.authenticated) {
            throw new Error(
                'LOGIN_REQUIRED'
            );
        }

        const title =
            String(
                ctx.form.querySelector(
                    'input[name="name"]'
                )?.value ||
                ''
            ).trim();

        if (!title) {
            return null;
        }

        return {
            id: Number(ticketId),
            title
        };
    }

    async function silentFindCreatedByRange(
        seedId,
        expectedTitle
    ) {
        const seed =
            Number(seedId);

        if (
            !Number.isInteger(seed) ||
            seed <= 0
        ) {
            return null;
        }

        const expected =
            glpiNormalize(
                expectedTitle
            );

        const maxAhead =
            260;

        const concurrency =
            6;

        for (
            let offset = 1;
            offset <= maxAhead;
            offset += concurrency
        ) {
            const ids = [];

            for (
                let index = 0;
                index < concurrency &&
                offset + index <= maxAhead;
                index++
            ) {
                ids.push(
                    seed +
                    offset +
                    index
                );
            }

            const results =
                await Promise.all(
                    ids.map(
                        async id => {
                            try {
                                return await silentProbeTicketTitle(
                                    id
                                );
                            } catch (error) {
                                if (
                                    error?.message ===
                                    'LOGIN_REQUIRED'
                                ) {
                                    throw error;
                                }

                                return null;
                            }
                        }
                    )
                );

            for (const item of results) {
                if (
                    item?.title &&
                    glpiNormalize(
                        item.title
                    ) === expected
                ) {
                    return item.id;
                }
            }
        }

        return null;
    }

    async function silentResolveCreatedTicketId(
        response,
        expectedTitle,
        seedBefore
    ) {
        const direct =
            silentTicketIdFromHtml(
                response.responseText || '',
                response.finalUrl || ''
            );

        if (direct) {
            return direct;
        }

        await glpiSleep(400);

        if (seedBefore) {
            const byRange =
                await silentFindCreatedByRange(
                    seedBefore,
                    expectedTitle
                );

            if (byRange) {
                return byRange;
            }
        }

        return null;
    }

    function silentParseSelectedActorOption(option) {
        const raw =
            String(
                option?.value || ''
            ).trim();

        const match =
            raw.match(
                /^(User|Group)[_-](\d+)$/i
            );

        if (!match) {
            return null;
        }

        return {
            itemtype:
                glpiNormalize(match[1]) === 'GROUP'
                    ? 'Group'
                    : 'User',
            items_id:
                String(match[2]),
            use_notification: 1,
            alternative_email: '',
            text:
                String(
                    option?.textContent || ''
                ).trim()
        };
    }

    function silentActorsFromEditContext(
        ctx,
        currentUserId
    ) {
        const hidden =
            silentReadHiddenActors(
                ctx.form
            );

        if (hidden) {
            return {
                requester:
                    silentDedupeActors(
                        hidden.requester
                    ),
                observer:
                    silentDedupeActors(
                        hidden.observer
                    ),
                assign:
                    silentDedupeActors(
                        hidden.assign
                    )
            };
        }

        const actors = {
            requester: [],
            observer: [],
            assign: []
        };

        for (
            const option of
            ctx.doc.querySelectorAll('option')
        ) {
            if (
                !option.selected &&
                !option.hasAttribute('selected')
            ) {
                continue;
            }

            const parsed =
                silentParseSelectedActorOption(
                    option
                );

            if (!parsed) continue;

            if (
                glpiNormalize(parsed.itemtype) ===
                'GROUP'
            ) {
                actors.assign.push(
                    parsed
                );
                continue;
            }

            if (
                String(parsed.items_id) ===
                String(currentUserId)
            ) {
                actors.requester.push(
                    parsed
                );
                actors.assign.push(
                    parsed
                );
            }
        }

        // Fallback: usuário detectado dinamicamente nunca pode sumir.
        actors.requester =
            silentDedupeActors([
                ...actors.requester,
                silentActorUser(
                    currentUserId
                )
            ]);

        actors.assign =
            silentDedupeActors([
                ...actors.assign,
                silentActorUser(
                    currentUserId
                )
            ]);

        actors.observer =
            silentDedupeActors(
                actors.observer
            );

        return actors;
    }

    function silentActorSummary(actors) {
        const users = [];
        const groups = [];

        for (
            const actor of
            actors?.assign || []
        ) {
            const type =
                glpiNormalize(
                    actor?.itemtype
                );

            const id =
                String(
                    actor?.items_id || ''
                );

            if (type === 'USER') {
                users.push(id);
            }

            if (type === 'GROUP') {
                groups.push(id);
            }
        }

        return {
            users:
                [...new Set(users)],
            groups:
                [...new Set(groups)]
        };
    }

    function silentFindUpdateSubmitter(form, doc) {
        const candidates = [
            ...form.querySelectorAll(
                'button[name="update"], input[name="update"], button[type="submit"], input[type="submit"]'
            ),
            ...doc.querySelectorAll(
                'button[name="update"], input[name="update"], button[type="submit"], input[type="submit"]'
            )
        ];

        const found =
            candidates.find(
                el => {
                    const text =
                        glpiNormalize(
                            el.innerText ||
                            el.value ||
                            ''
                        );

                    return (
                        el.name === 'update' ||
                        text === 'SALVAR' ||
                        text === 'ATUALIZAR' ||
                        text === 'SAVE' ||
                        text === 'UPDATE'
                    );
                }
            );

        return {
            name:
                found?.name ||
                'update',
            value:
                found?.value ||
                'Salvar'
        };
    }

    async function silentPostfixAssignment(
        job,
        currentUser
    ) {
        const targetGroupId =
            confirmedGroupIdForOperation(
                job.data.operation
            );

        if (!targetGroupId) {
            throw new Error(
                `Grupo Sistemas ${job.data.operation} ainda não está confirmado para o motor silencioso.`
            );
        }

        const ctx =
            await silentGetTicketForm(
                job.ticket_id
            );

        if (!ctx.authenticated) {
            throw new Error(
                'LOGIN_REQUIRED'
            );
        }

        const before =
            silentActorsFromEditContext(
                ctx,
                currentUser.id
            );

        const users =
            silentDedupeActors([
                ...(before.assign || [])
                    .filter(
                        actor =>
                            glpiNormalize(
                                actor?.itemtype
                            ) === 'USER'
                    ),
                silentActorUser(
                    currentUser.id
                )
            ]);

        // Chamado recém-criado: Service Desk é o grupo padrão indesejado.
        // No segundo POST preservamos usuários e substituímos os grupos
        // pelo grupo Sistemas da operação, exatamente como no teste validado.
        const after = {
            requester:
                silentDedupeActors([
                    ...(before.requester || [])
                        .filter(
                            actor =>
                                glpiNormalize(
                                    actor?.itemtype
                                ) === 'USER'
                        ),
                    silentActorUser(
                        currentUser.id
                    )
                ]),
            observer:
                silentDedupeActors(
                    before.observer || []
                ),
            assign:
                silentDedupeActors([
                    ...users,
                    silentActorGroup(
                        targetGroupId
                    )
                ])
        };

        const fd =
            new FormData(
                ctx.form
            );

        fd.set(
            '_actors',
            JSON.stringify(
                after
            )
        );

        fd.set(
            '_skip_default_actor',
            '1'
        );

        fd.set(
            'id',
            String(
                job.ticket_id
            )
        );

        const submitter =
            silentFindUpdateSubmitter(
                ctx.form,
                ctx.doc
            );

        fd.set(
            submitter.name,
            submitter.value
        );

        const update =
            await silentRequest({
                method: 'POST',
                url:
                    `${GLPI_TEST.base}/front/ticket.form.php?id=${job.ticket_id}`,
                data:
                    fd,
                headers: {
                    'Accept':
                        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Referer':
                        `${GLPI_TEST.base}/front/ticket.form.php?id=${job.ticket_id}`
                }
            });

        const html =
            update.responseText || '';

        if (
            silentLooksLikeLogin(
                html,
                update.finalUrl || ''
            )
        ) {
            throw new Error(
                'LOGIN_REQUIRED'
            );
        }

        if (
            update.status < 200 ||
            update.status >= 400
        ) {
            throw new Error(
                `Correção do Atribuído respondeu HTTP ${update.status}.`
            );
        }

        return {
            before,
            after,
            targetGroupId:
                String(targetGroupId),
            http:
                update.status
        };
    }

    async function silentValidateFinal(
        job,
        currentUser,
        postfix
    ) {
        const ctx =
            await silentGetTicketForm(
                job.ticket_id
            );

        if (!ctx.authenticated) {
            throw new Error(
                'LOGIN_REQUIRED'
            );
        }

        const actors =
            silentActorsFromEditContext(
                ctx,
                currentUser.id
            );

        const summary =
            silentActorSummary(
                actors
            );

        const targetGroupId =
            String(
                postfix.targetGroupId
            );

        const raw =
            glpiNormalize(
                ctx.rawHtml || ''
            );

        const userOk =
            summary.users.includes(
                String(
                    currentUser.id
                )
            );

        const targetOk =
            summary.groups.includes(
                targetGroupId
            ) ||
            (
                raw.includes(
                    glpiNormalize(
                        `Sistemas ${job.data.operation}`
                    )
                ) &&
                (
                    String(ctx.rawHtml || '')
                        .includes(
                            `Group_${targetGroupId}`
                        ) ||
                    String(ctx.rawHtml || '')
                        .includes(
                            `Group-${targetGroupId}`
                        )
                )
            );

        const serviceDeskRemoved =
            !raw.includes(
                'SERVICE DESK'
            ) ||
            !(
                /(?:selected|checked)[^>]{0,300}Service\s*Desk/i.test(
                    String(ctx.rawHtml || '')
                ) ||
                /Service\s*Desk[^<]{0,300}(?:selected|checked)/i.test(
                    String(ctx.rawHtml || '')
                )
            );

        const content =
            String(
                ctx.form.querySelector(
                    '[name="content"]'
                )?.value ||
                ''
            );

        const imageOk =
            !job.printDataUrl ||
            /<img\b/i.test(content) ||
            /data:image\//i.test(content) ||
            /<img\b/i.test(
                String(ctx.rawHtml || '')
            );

        return {
            userOk,
            targetOk,
            serviceDeskRemoved,
            imageOk,
            summary
        };
    }

    function silentSaveError(
        job,
        step,
        error
    ) {
        saveGlpiResult({
            kind: 'background-error',
            status: 'error',
            title: 'Não foi possível concluir o chamado',
            message:
                silentFriendlyErrorMessage(
                    error?.message ||
                    error ||
                    'Erro desconhecido'
                ),
            raw_step:
                String(
                    step ||
                    ''
                ),
            step:
                silentFriendlyStage(
                    step
                ),
            job_id:
                job?.id ||
                '',
            ticket_id:
                job?.ticket_id ||
                null,
            ticket_url:
                job?.ticket_url ||
                '',
            at:
                new Date().toISOString()
        });
    }

    function silentRequireLogin(
        job,
        resumeStage,
        message
    ) {
        job.resume_stage =
            resumeStage ||
            job.stage ||
            'silent-create';

        job.stage =
            'waiting-login';

        job.login_required_at =
            new Date().toISOString();

        saveGlpiJob(job);

        saveGlpiLoginRequired(
            job,
            message ||
            'Entre no GLPI para continuar a criação do chamado.'
        );
    }

    async function silentCreateAndFixJob(job) {
        job.stage =
            job.stage === 'waiting-login'
                ? (
                    job.resume_stage ||
                    'silent-create'
                )
                : (
                    job.stage ||
                    'silent-create'
                );

        delete job.resume_stage;
        delete job.login_required_at;
        saveGlpiJob(job);

        if (
            !confirmedGroupIdForOperation(
                job.data.operation
            )
        ) {
            throw new Error(
                `O grupo Sistemas ${job.data.operation} ainda não está confirmado. ` +
                `O chamado não foi enviado.`
            );
        }

        job.stage =
            'silent-form';

        saveGlpiJob(job);

        const ctx =
            await silentGetTicketForm(0);

        if (!ctx.authenticated) {
            silentRequireLogin(
                job,
                'silent-form',
                'Faça login no GLPI para a OM30 continuar.'
            );

            return {
                waitingLogin: true
            };
        }

        job.stage =
            'silent-user';

        saveGlpiJob(job);

        const currentUser =
            await silentResolveCurrentUser(
                ctx
            );

        job.current_user = {
            id:
                currentUser.id,
            name:
                currentUser.name
        };

        saveGlpiJob(job);

        job.stage =
            'silent-resolve';

        saveGlpiJob(job);

        const [
            category,
            unit
        ] =
            await Promise.all([
                silentResolveCategory(
                    ctx,
                    job.data
                ),
                silentResolveUnit(
                    ctx,
                    job.data
                )
            ]);

        job.direct_resolved = {
            category_id:
                String(category.id),
            category:
                category.fullText ||
                category.text ||
                job.data.category,
            location_id:
                String(unit.id),
            location:
                unit.fullText ||
                unit.text ||
                job.data.unit
        };

        saveGlpiJob(job);

        job.stage =
            'silent-upload';

        saveGlpiJob(job);

        const upload =
            await silentUploadPrint(
                ctx,
                job
            );

        job.stage =
            'silent-ready';

        saveGlpiJob(job);

        const fd =
            silentPrepareCreateFormData(
                ctx,
                job,
                currentUser,
                category,
                unit,
                upload
            );

        const expectedTitle =
            String(
                fd.get('name') ||
                job.data.title ||
                ''
            );

        const seedBefore =
            silentSavedSeed();

        // Anti-duplicidade:
        // este estágio é persistido ANTES do POST.
        job.stage =
            'silent-publishing';

        job.publish_attempted_at =
            new Date().toISOString();

        job.publish_attempts =
            Number(
                job.publish_attempts ||
                0
            ) + 1;

        saveGlpiJob(job);

        const create =
            await silentRequest({
                method: 'POST',
                url:
                    `${GLPI_TEST.base}/front/ticket.form.php`,
                data:
                    fd,
                headers: {
                    'Accept':
                        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Referer':
                        `${GLPI_TEST.base}/front/ticket.form.php`
                }
            });

        const createHtml =
            create.responseText || '';

        if (
            silentLooksLikeLogin(
                createHtml,
                create.finalUrl ||
                `${GLPI_TEST.base}/front/ticket.form.php`
            )
        ) {
            // Como o POST já foi enviado, não repetimos cegamente.
            job.stage =
                'silent-publish-unknown';

            job.error = {
                step:
                    'Publicação',
                message:
                    'A sessão expirou depois do POST. A OM30 não repetirá a criação automaticamente.',
                at:
                    new Date().toISOString()
            };

            saveGlpiJob(job);

            throw new Error(
                'A sessão do GLPI expirou após o envio. O POST não será repetido automaticamente.'
            );
        }

        if (
            create.status < 200 ||
            create.status >= 400
        ) {
            job.stage =
                'silent-publish-unknown';

            saveGlpiJob(job);

            throw new Error(
                `Criação respondeu HTTP ${create.status}. ` +
                `O POST não será repetido automaticamente.`
            );
        }

        job.stage =
            'silent-identify';

        saveGlpiJob(job);

        const ticketId =
            await silentResolveCreatedTicketId(
                create,
                expectedTitle,
                seedBefore
            );

        if (!ticketId) {
            job.stage =
                'silent-publish-unknown';

            job.direct_publish_unknown_result =
                true;

            saveGlpiJob(job);

            throw new Error(
                'O POST foi aceito, mas não consegui identificar o número do chamado. ' +
                'O POST não será repetido.'
            );
        }

        job.ticket_id =
            Number(ticketId);

        job.ticket_url =
            `${GLPI_TEST.base}/front/ticket.form.php?id=${ticketId}`;

        job.published_at =
            new Date().toISOString();

        silentSaveSeed(
            ticketId
        );

        job.stage =
            'silent-postfix';

        saveGlpiJob(job);

        const postfix =
            await silentPostfixAssignment(
                job,
                currentUser
            );

        job.assignment_direct = {
            target_group_id:
                postfix.targetGroupId,
            target_group:
                `Sistemas ${job.data.operation}`,
            user_preserved:
                true,
            http:
                postfix.http
        };

        saveGlpiJob(job);

        job.stage =
            'silent-validate';

        saveGlpiJob(job);

        const validation =
            await silentValidateFinal(
                job,
                currentUser,
                postfix
            );

        if (
            !validation.userOk ||
            !validation.targetOk ||
            !validation.serviceDeskRemoved ||
            !validation.imageOk
        ) {
            throw new Error(
                'O chamado foi criado, mas a validação final do Atribuído/print não ficou correta.'
            );
        }

        job.stage =
            'published';

        job.postfix_completed_at =
            new Date().toISOString();

        saveGlpiJob(job);

        return {
            ticket_id:
                Number(ticketId),
            ticket_url:
                job.ticket_url,
            title:
                job.data?.title ||
                `Chamado #${ticketId}`,
            unit:
                job.data?.unit ||
                '',
            operation:
                job.data?.operation ||
                '',
            published_at:
                job.published_at,
            assignment_fixed:
                true
        };
    }

    async function processSilentGlpiQueue() {
        if (
            location.hostname !==
            'web.whatsapp.com'
        ) {
            return;
        }

        if (silentGlpiRunnerPromise) {
            return silentGlpiRunnerPromise;
        }

        // Sucesso/login ainda precisam ser consumidos antes do próximo job.
        // Um aviso de ERRO antigo, porém, não pode travar a fila inteira.
        const pendingResult =
            readGlpiResult();

        if (
            pendingResult &&
            pendingResult.kind !==
                'background-error' &&
            pendingResult.status !==
                'error'
        ) {
            return;
        }

        let job =
            readGlpiJob();

        if (!job) {
            job =
                activateNextGlpiQueuedJob();
        }

        if (!job) {
            return;
        }

        if (
            job.stage ===
            'waiting-login'
        ) {
            return;
        }

        if (
            job.stage ===
            'silent-publishing' ||
            job.stage ===
            'silent-publish-unknown'
        ) {
            silentSaveError(
                job,
                'Publicação',
                new Error(
                    'Há um POST anterior com resultado ainda não confirmado. A OM30 não repetirá a criação.'
                )
            );

            return;
        }

        silentGlpiRunnerPromise =
            (async () => {
                try {
                    const result =
                        await silentCreateAndFixJob(
                            job
                        );

                    if (
                        result?.waitingLogin
                    ) {
                        return;
                    }

                    saveGlpiResult(
                        result
                    );

                    GM_deleteValue(
                        GLPI_TEST.jobKey
                    );
                } catch (error) {
                    if (
                        error?.message ===
                        'LOGIN_REQUIRED'
                    ) {
                        silentRequireLogin(
                            job,
                            job.stage ||
                            'silent-form',
                            'Faça login no GLPI para a OM30 continuar.'
                        );

                        return;
                    }

                    job.error = {
                        step:
                            job.stage ||
                            'Motor silencioso',
                        message:
                            String(
                                error?.message ||
                                error
                            ),
                        at:
                            new Date().toISOString()
                    };

                    saveGlpiJob(
                        job
                    );

                    silentSaveError(
                        job,
                        job.stage ||
                        'Motor silencioso',
                        error
                    );

                    // Um erro deste job não pode travar os próximos chamados.
                    // O resultado do erro guarda ticket_id/ticket_url quando já
                    // houve criação; o job ativo é liberado e a fila segue depois
                    // que o cartão de erro for consumido.
                    GM_deleteValue(
                        GLPI_TEST.jobKey
                    );
                }
            })()
                .finally(
                    () => {
                        silentGlpiRunnerPromise =
                            null;
                    }
                );

        return silentGlpiRunnerPromise;
    }

    function kickSilentGlpiQueue() {
        if (
            location.hostname !==
            'web.whatsapp.com'
        ) {
            return;
        }

        processSilentGlpiQueue()
            .catch(
                error => {
                    console.error(
                        'OM30 v0.8.0 motor silencioso:',
                        error
                    );
                }
            );
    }

    // ============================================================
    // RESULTADO
    // ============================================================

    async function blobToDataURL(blob) {
        if (!blob) return '';
        return await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(reader.error || new Error('Falha convertendo print'));
            reader.readAsDataURL(blob);
        });
    }

    async function validateTicket() {
        const operation =
            document.getElementById(
                'om30-operation'
            );

        const current =
            currentProblem();

        const data = {
            operation_id:
                Number(
                    operation.value
                ),
            operation:
                operation.selectedOptions[0]?.text ||
                '',
            chat:
                getChatName(),
            unit:
                document.getElementById(
                    'om30-unit'
                ).value.trim(),
            type_id:
                Number(
                    document.getElementById(
                        'om30-type'
                    ).value
                ),
            system:
                document.getElementById(
                    'om30-system'
                ).value,
            category:
                document.getElementById(
                    'om30-category'
                ).value,
            initial_date:
                document.getElementById(
                    'om30-initial-date'
                ).value,
            solution_date:
                document.getElementById(
                    'om30-solution-date'
                ).value,
            title:
                document.getElementById(
                    'om30-title'
                ).value.trim(),
            description:
                document.getElementById(
                    'om30-description'
                ).value.trim(),
            evidence_mode:
                getMode(),

            current_problem:
                current.classification
                    ? {
                        text:
                            current.classification.msg.text,
                        system:
                            current.classification.system,
                        category:
                            current.classification.category,
                        date:
                            current.classification.msg.date,
                        time:
                            current.classification.msg.time
                    }
                    : null,

            messages:
                orderedEvidence()
                    .map(
                        msg => ({
                            time:
                                msg.time,
                            date:
                                msg.date,
                            sender:
                                senderInfo(
                                    msg.sender
                                ).name,
                            sender_original:
                                msg.sender,
                            text:
                                msg.text
                        })
                    ),

            print: {
                exists:
                    !!printBlob,
                bytes:
                    printBlob?.size ||
                    0,
                type:
                    printBlob?.type ||
                    '',
                messages_recognized:
                    printMessages.length
            }
        };

        const missing = [];

        if (!data.operation_id) {
            missing.push(
                'Operação'
            );
        }

        if (!data.unit) {
            missing.push(
                'Unidade'
            );
        }

        if (!data.type_id) {
            missing.push(
                'Tipo'
            );
        }

        if (!data.system) {
            missing.push(
                'Sistema'
            );
        }

        if (!data.category) {
            missing.push(
                'Categoria'
            );
        }

        if (!data.title) {
            missing.push(
                'Título'
            );
        }

        if (!data.description) {
            missing.push(
                'Descrição'
            );
        }

        if (missing.length) {
            alert(
                `Confira antes de criar: ` +
                `${missing.join(', ')}.`
            );
            return;
        }

        // A unidade precisa pertencer à operação selecionada.
        // Isso impede, por exemplo, uma unidade salva de Guarujá de ir para Jales.
        const canonicalUnit =
            canonicalUnitExact(
                data.unit,
                data.operation_id
            ) ||
            chooseCanonicalUnit(
                data.unit,
                `${data.operation} ${data.chat}`
            );

        if (!canonicalUnit) {
            return;
        }

        data.unit =
            canonicalUnit;

        const unitInput =
            document.getElementById(
                'om30-unit'
            );

        if (unitInput) {
            unitInput.value =
                canonicalUnit;
        }

        // Segurança: enquanto ainda não temos o ID do grupo Sistemas
        // confirmado para outra operação, não criamos um chamado incompleto.
        if (
            !confirmedGroupIdForOperation(
                data.operation
            )
        ) {
            alert(
                `O motor silencioso ainda não tem o grupo "Sistemas ${data.operation}" confirmado. ` +
                `O chamado não foi enviado.`
            );
            return;
        }

        // Criar outro chamado não depende de fechar um erro anterior.
        clearStaleResultBeforeNewJob();

        const button =
            document.getElementById(
                'om30-validate'
            );

        const oldText =
            button?.textContent ||
            'CRIAR CHAMADO';

        let enqueuedSuccessfully =
            false;

        if (button) {
            button.disabled =
                true;

            button.classList.add(
                'om30-creating'
            );

            button.textContent =
                'ADICIONANDO...';
        }

        // O botão fica no final da ficha; sobe imediatamente para o cartão
        // de processo no topo assim que o usuário clica em Criar.
        scrollPanelToProcess('smooth');

        try {
            const printDataUrl =
                await blobToDataURL(
                    printBlob
                );

            const job = {
                id:
                    `OM30-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                mode:
                    'publish',
                stage:
                    'silent-create',
                silent_engine:
                    true,
                created_at:
                    new Date().toISOString(),
                data,
                printDataUrl,
                completed: {}
            };

            window.__OM30_CHAMADO =
                data;

            window.__OM30_PRINT =
                printBlob;

            const queued =
                enqueueGlpiJob(
                    job
                );

            enqueuedSuccessfully =
                true;

            console.log(
                'OM30 WhatsApp → GLPI v0.8.8',
                {
                    job:
                        job.id,
                    queued:
                        !queued.started,
                    position:
                        queued.position,
                    operation:
                        data.operation,
                    unit:
                        data.unit
                }
            );

            setCreateButtonFeedback(
                button,
                queued
            );

            const activeJob =
                readGlpiJob();

            if (activeJob) {
                renderSilentProgress(
                    activeJob,
                    readGlpiQueue().length
                );
            }

            // A partir daqui o job já possui cópia própria dos dados,
            // mensagens e printDataUrl. Zera a ficha atual para que o
            // próximo chamado comece limpo enquanto este processa.
            resetDraftFormForNextTicket();

            scrollPanelToProcess('smooth');

            // O motor processa em silêncio; outro chamado pode ser montado
            // com uma seleção NOVA enquanto este está criando/corrigindo.
            kickSilentGlpiQueue();

        } catch (error) {
            console.error(
                'OM30: não consegui enfileirar chamado',
                error
            );

            alert(
                `Não consegui iniciar o chamado: ` +
                `${error?.message || error}`
            );
        } finally {
            if (
                button &&
                !enqueuedSuccessfully
            ) {
                button.classList.remove(
                    'om30-enqueued',
                    'om30-creating'
                );

                button.disabled =
                    false;

                button.textContent =
                    oldText;
            }
        }
    }

    // Mantém a ficha recuperável mesmo após redimensionar a janela, mudar zoom
    // ou alternar monitor durante o compartilhamento/captura.
    window.addEventListener('resize', () => {
        const panel = document.getElementById(ID.panel);
        if (panel && panelOpened && panel.style.display !== 'none') {
            requestAnimationFrame(() => ensurePanelInViewport(panel));
        }
    });

    // ============================================================
    // START
    // ============================================================

    setInterval(() => {
        if (!document.querySelector('#main')) return;
        createUI();

        // Sincroniza resultado/login e mantém o motor silencioso andando.
        syncGlpiResult();
        kickSilentGlpiQueue();

        // Com a ficha fechada, não "lê" as mensagens sozinho.
        // Só mantém os botões/contadores atualizados.
        if (panelOpened) updateAll();
        else updateFloating();
    }, 700);

    const firstUse = setInterval(() => {
        if (!document.querySelector('#main')) return;
        clearInterval(firstUse);
        createUI();
        if (!getMode()) chooseMode();
    }, 400);

    function runOm30IntegrationSelfCheck() {
        const errors = [];

        const checks = [
            {
                operationId:
                    '567',
                operation:
                    'Guarujá',
                units:
                    GUARUJA_UNITS,
                expectedGroupId:
                    '9',
                critical: {
                    'UPA ENSEADA - PAULO FLAVIO AFONSO PIASENTI':
                        '2133',
                    'UBS PAE CARA':
                        '2124',
                    'UNIDADE BÁSICA DE SAUDE SANTA ROSA':
                        '2129',
                    'PRONTO SOCORRO PEREQUE - ANIBAL ARDEN DOS REIS':
                        '2114'
                }
            },
            {
                operationId:
                    '588',
                operation:
                    'Jales',
                units:
                    JALES_UNITS,
                expectedGroupId:
                    '18',
                critical: {
                    'ESF Leonisio Gambero (Jd. Oiti)':
                        '2750',
                    'ESF Ozil Joaquim Resende (Jd. Municipal)':
                        '2748',
                    'ESF Setuo Setugo (Jd. São Jorge)':
                        '2753',
                    'SECRETARIA MUNICIPAL DE SAÚDE':
                        '2758'
                }
            }
        ];

        const summary = {};

        for (const check of checks) {
            const confirmed =
                SILENT_CONFIRMED_LOCATIONS[
                    check.operationId
                ] ||
                [];

            const normalizedConfirmed =
                new Set(
                    confirmed.map(
                        item =>
                            glpiNormalize(
                                item.text
                            )
                    )
                );

            const missingUnits =
                check.units.filter(
                    unit =>
                        !normalizedConfirmed.has(
                            glpiNormalize(
                                unit
                            )
                        )
                );

            if (missingUnits.length) {
                errors.push(
                    `${check.operation}: unidades sem ID confirmado: ${missingUnits.join(', ')}`
                );
            }

            for (
                const [name, expectedId] of
                Object.entries(
                    check.critical
                )
            ) {
                const item =
                    confirmed.find(
                        location =>
                            glpiNormalize(
                                location.text
                            ) ===
                            glpiNormalize(
                                name
                            )
                    );

                if (
                    !item ||
                    String(item.id) !==
                        String(expectedId)
                ) {
                    errors.push(
                        `${check.operation} / ${name}: esperado ${expectedId}, recebido ${item?.id || 'ausente'}`
                    );
                }
            }

            const groupId =
                confirmedGroupIdForOperation(
                    check.operation
                );

            if (
                String(groupId || '') !==
                    String(
                        check.expectedGroupId
                    )
            ) {
                errors.push(
                    `${check.operation}: grupo Sistemas esperado ${check.expectedGroupId}, recebido ${groupId || 'ausente'}`
                );
            }

            summary[
                check.operation
            ] = {
                unitsInUi:
                    check.units.length,
                confirmedLocations:
                    confirmed.length,
                sistemasGroup:
                    groupId
            };
        }

        if (errors.length) {
            console.error(
                '❌ OM30 v0.8.8 self-check:',
                errors
            );

            return false;
        }

        console.log(
            '✅ OM30 v0.8.8 self-check OK',
            {
                operations:
                    summary,
                totalUnits:
                    UNITS.length,
                automaticGlpiTabs:
                    0
            }
        );

        return true;
    }

    runOm30IntegrationSelfCheck();

    console.log('✅ OM30 WhatsApp v0.8.8 carregado · operação com botão Salvar compacto + atualização automática.');
})();
