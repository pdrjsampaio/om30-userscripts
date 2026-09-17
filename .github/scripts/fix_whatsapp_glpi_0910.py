from pathlib import Path

p = Path('OM30-WhatsApp-GLPI.user.js')
s = p.read_text(encoding='utf-8')

needle = '''    function parseMeta(meta) {
        const out = { time: '', date: '', sender: '' };
        const m = String(meta || '').match(/^\\[([^\\],]+)(?:,\\s*([^\\]]+))?\\]\\s*(.*?):\\s*$/);
        if (m) {
            out.time = clean(m[1]);
            out.date = clean(m[2]);
            out.sender = clean(m[3]);
        }
        return out;
    }
'''

insert = needle + '''
    function messageDisplayedTime(bubble) {
        if (!bubble) return '';

        const preferred = [
            ...bubble.querySelectorAll(
                '[data-testid="msg-meta"], [aria-label], time, span'
            )
        ];

        for (const el of preferred) {
            const values = [
                clean(el.getAttribute?.('aria-label') || ''),
                clean(el.getAttribute?.('title') || ''),
                clean(el.textContent || '')
            ].filter(Boolean);

            for (const value of values) {
                const exact = value.match(/^(\\d{1,2}:\\d{2})(?::\\d{2})?$/);
                if (exact) return exact[1];
            }
        }

        const raw = clean(bubble.innerText || bubble.textContent || '');
        const matches = [
            ...raw.matchAll(/(?:^|\\s)(\\d{1,2}:\\d{2})(?::\\d{2})?(?=$|\\s)/g)
        ];

        return matches.length
            ? matches[matches.length - 1][1]
            : '';
    }

    function messageNeighborDate(bubble) {
        if (!bubble) return '';

        const main = document.querySelector('#main');
        if (!main) return '';

        const messages = [
            ...main.querySelectorAll('[data-id]')
        ];
        const index = messages.indexOf(bubble);
        if (index < 0) return '';

        for (let distance = 1; distance <= 20; distance++) {
            for (const pos of [index - distance, index + distance]) {
                const candidate = messages[pos];
                if (!candidate) continue;

                const meta = clean(
                    candidate
                        .querySelector('[data-pre-plain-text]')
                        ?.getAttribute('data-pre-plain-text') ||
                    ''
                );

                const date = parseMeta(meta).date;
                if (date) return date;
            }
        }

        return '';
    }
'''

if needle not in s:
    raise SystemExit('ERRO: bloco parseMeta não encontrado')
s = s.replace(needle, insert, 1)

old_parsed = '''        const parsed =
            parseMeta(
                meta
            );

        const highlightElement =
'''

new_parsed = '''        const parsed =
            parseMeta(
                meta
            );

        // Mensagens só de imagem nem sempre expõem data-pre-plain-text.
        // Nesses casos, lê a hora que o WhatsApp mostra na própria bolha
        // e usa a data da mensagem vizinha mais próxima do mesmo bloco.
        if (!parsed.time) {
            parsed.time = messageDisplayedTime(bubble);
        }

        if (!parsed.date && parsed.time) {
            parsed.date = messageNeighborDate(bubble);
        }

        const highlightElement =
'''

if old_parsed not in s:
    raise SystemExit('ERRO: bloco parsed/meta não encontrado')
s = s.replace(old_parsed, new_parsed, 1)

old_click = '''    document.addEventListener(
        'click',
        event => {
            if (
                !om30CtrlPressed ||
                !event.ctrlKey
            ) {
                return;
            }

            if (
'''

new_click = '''    document.addEventListener(
        'click',
        event => {
            const ctrlSelection =
                !!(
                    event.ctrlKey ||
                    om30CtrlPressed
                );

            // Para INICIAR uma seleção ainda é Ctrl + clique.
            // Depois da primeira mensagem marcada, o modo fica ativo e
            // basta clicar normalmente nas próximas mensagens para alternar.
            // Quando a última mensagem for desmarcada, o modo encerra e
            // um novo bloco volta a exigir Ctrl + clique.
            if (
                !ctrlSelection &&
                selected.size === 0
            ) {
                return;
            }

            if (
'''

if old_click not in s:
    raise SystemExit('ERRO: trava Ctrl+clique não encontrada')
s = s.replace(old_click, new_click, 1)

old_log = '''                    ctrl:
                            event.ctrlKey,
                        target:
'''
new_log = '''                    ctrl:
                            ctrlSelection,
                        selection_active:
                            selected.size > 0,
                        target:
'''
if old_log not in s:
    raise SystemExit('ERRO: log selection.not-found não encontrado')
s = s.replace(old_log, new_log, 1)

if '// @version      0.9.9' not in s:
    raise SystemExit('ERRO: versão pública 0.9.9 não encontrada')
s = s.replace('// @version      0.9.9', '// @version      0.9.10', 1)

old_internal = "const OM30_VERSION =\n        '0.9.9';"
new_internal = "const OM30_VERSION =\n        '0.9.10';"
if old_internal not in s:
    raise SystemExit('ERRO: versão interna 0.9.9 não encontrada')
s = s.replace(old_internal, new_internal, 1)

checks = [
    '// @version      0.9.10',
    "const OM30_VERSION =\n        '0.9.10';",
    'function messageDisplayedTime(bubble)',
    'function messageNeighborDate(bubble)',
    'selected.size === 0',
    'const ctrlSelection ='
]
for check in checks:
    if check not in s:
        raise SystemExit(f'ERRO: validação ausente: {check}')

p.write_text(s, encoding='utf-8')
print('Patch 0.9.10 aplicado com sucesso.')
