from pathlib import Path

TARGET = Path('OM30-WhatsApp-GLPI.user.js')
text = TARGET.read_text(encoding='utf-8')


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f'{label}: esperado 1 match, encontrado {count}')
    return source.replace(old, new, 1)


version_count = text.count('0.9.13')
if version_count != 7:
    raise SystemExit(
        f'versao: esperado 7 ocorrencias de 0.9.13, encontrado {version_count}'
    )
text = text.replace('0.9.13', '0.9.14')

text = replace_once(
    text,
    '        "Impressora": { 1: ["Impressora"], 2: ["Impressora"] }',
    '        "Impressora": { 1: ["Falha/Defeito","Manutenção em Geral"], 2: ["Falha/Defeito","Manutenção em Geral"] }',
    'categorias de impressora',
)

text = replace_once(
    text,
    '                system: "Impressora",\n'
    '                category: "Impressora",\n'
    '                title: "Problema na impressora",',
    '                system: "Impressora",\n'
    '                category: "Falha/Defeito",\n'
    '                title: "Problema na impressora",',
    'classificacao de impressora',
)

anchor = '    async function silentResolveCategory(ctx, data) {'
fixed_map = '''    // IDs confirmados diretamente no Select2 do GLPI.
    // Categorias conhecidas não dependem mais de busca textual/autocomplete.
    const SILENT_CONFIRMED_CATEGORIES = Object.freeze({
        'Saúde Simples': Object.freeze({
            'Agendamento': 76,
            'Ambulatorial': 77,
            'Aplicativo': 120,
            'Configurações': 121,
            'Atenção Primária': 78,
            'Atestado e Declaração': 79,
            'Cadastro': 80,
            'Configuração de Agenda': 137,
            'Consolidação de Munícipe': 140,
            'Munícipes': 139,
            'Profissionais': 136,
            'Consulta em banco': 116,
            'Estoque': 81,
            'Ferramentas': 82,
            'Implantação de novos processos': 117,
            'Nova unidade/módulo/funcionalidade': 113,
            'Odontológico': 83,
            'Ouvidoria': 84,
            'Produção BPA': 85,
            'Produção e-SUS': 86,
            'Produção RAAS': 87,
            'Pronto Atendimento': 88,
            'Prontuário Eletrônico': 89,
            'Regulação': 90,
            'Relatórios': 91,
            'Tele Saúde': 122,
            'Terapia': 92,
            'Transporte': 93,
            'Treinamento': 114,
            'Urgência e Emergência': 94,
            'Vacinação': 95,
            'Vigilância em Saúde': 96,
            'Instabilidade no Sistema': 110,
        }),
        'Totem': Object.freeze({
            'Touch': 52,
        }),
        'Painel de Senha': Object.freeze({
            'Erro': 109,
        }),
        'Impressora': Object.freeze({
            'Falha/Defeito': 22,
            'Manutenção em Geral': 24,
        }),
    });

    function silentResolveConfirmedCategory(data) {
        const system = String(data?.system || '').trim();
        const category = String(data?.category || '').trim();
        const id = SILENT_CONFIRMED_CATEGORIES[system]?.[category];

        if (!id) return null;

        return {
            id: String(id),
            text: category,
            fullText: `${system} > ${category}`,
            confirmed: true,
        };
    }

    async function silentResolveCategory(ctx, data) {
        const confirmed = silentResolveConfirmedCategory(data);

        if (confirmed?.id) {
            om30Log(
                'glpi.category.resolved-fixed',
                {
                    operation_id: data.operation_id,
                    operation: data.operation,
                    requested: `${data.system} > ${data.category}`,
                    id: confirmed.id,
                    text: confirmed.text,
                }
            );

            console.log(
                '✅ OM30 categoria resolvida pelo mapa confirmado:',
                {
                    sistema: data.system,
                    categoria: data.category,
                    id: confirmed.id,
                }
            );

            return confirmed;
        }
'''

text = replace_once(text, anchor, fixed_map, 'resolver de categoria')

# Garantias mínimas antes de escrever.
checks = [
    '// @version      0.9.14',
    "const OM30_VERSION =\n        '0.9.14';",
    "'Painel de Senha': Object.freeze({\n            'Erro': 109,",
    "'Totem': Object.freeze({\n            'Touch': 52,",
    "'Cadastro': 80,",
    "'Produção BPA': 85,",
    "'Produção RAAS': 87,",
    "'Falha/Defeito': 22,",
    "category: \"Falha/Defeito\"",
]

for expected in checks:
    if expected not in text:
        raise SystemExit(f'validacao final falhou: {expected!r}')

TARGET.write_text(text, encoding='utf-8')
print('Patch v0.9.14 aplicado com sucesso.')
