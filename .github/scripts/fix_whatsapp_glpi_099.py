from pathlib import Path

p = Path('OM30-WhatsApp-GLPI.user.js')
s = p.read_text(encoding='utf-8')

old = """        const shellHtml = shell.responseText || '';
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
"""

new = """        let shellHtml = shell.responseText || '';
        let shellFinal = shell.finalUrl || ticketUrl;

        if (silentLooksLikeLogin(shellHtml, shellFinal)) {
            return {
                authenticated: false,
                phase: 'shell',
                status: shell.status,
                rawHtml: shellHtml
            };
        }

        const profileState = await silentEnsureTiAtendimentoProfile(
            shellHtml,
            readGlpiJob()
        );

        if (profileState.changed) {
            const refreshedShell = await silentRequest({
                method: 'GET',
                url:
                    `${ticketUrl}${ticketUrl.includes('?') ? '&' : '?'}` +
                    `om30_profile_ready=${Date.now()}`,
                headers: {
                    'Accept':
                        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                }
            });

            shellHtml = refreshedShell.responseText || '';
            shellFinal = refreshedShell.finalUrl || ticketUrl;

            if (silentLooksLikeLogin(shellHtml, shellFinal)) {
                return {
                    authenticated: false,
                    phase: 'shell-after-profile',
                    status: refreshedShell.status,
                    rawHtml: shellHtml
                };
            }

            const confirmedProfile = silentDetectCurrentProfile(shellHtml);

            om30Log('glpi.profile.after-refresh', {
                job_id: readGlpiJob()?.id || '',
                current_profile_id: confirmedProfile.id,
                current_profile: confirmedProfile.name,
                source: confirmedProfile.source
            });

            if (
                confirmedProfile.id &&
                confirmedProfile.id !== '6' &&
                glpiNormalize(confirmedProfile.name) !== 'TI ATENDIMENTO'
            ) {
                throw new Error(
                    `Perfil TI | Atendimento não permaneceu ativo após a troca. ` +
                    `Perfil atual: ${confirmedProfile.name || confirmedProfile.id}.`
                );
            }
        }

        let parsed = silentFormFromHTML(shellHtml);
"""

if old not in s:
    raise SystemExit('ERRO: bloco alvo de silentGetTicketForm não encontrado')

s = s.replace(old, new, 1)
s = s.replace('// @version      0.9.8', '// @version      0.9.9', 1)
s = s.replace('0.9.6', '0.9.9')

checks = [
    '// @version      0.9.9',
    "const OM30_VERSION =\n        '0.9.9';",
    'await silentEnsureTiAtendimentoProfile(',
    "om30Log('glpi.profile.after-refresh'"
]
for check in checks:
    if check not in s:
        raise SystemExit(f'ERRO: validação ausente: {check}')

p.write_text(s, encoding='utf-8')
print('Patch 0.9.9 aplicado com sucesso.')
