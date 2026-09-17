from pathlib import Path

p = Path('OM30-WhatsApp-GLPI.user.js')
s = p.read_text(encoding='utf-8')

old = """    function cleanCategoryText(text) {
        return glpiNormalize(
            String(text || '')
                .replace(/^[\\s»›>·\\-]+/g, '')
                .trim()
        );
    }
"""

new = """    function cleanCategoryText(text) {
        return glpiNormalize(
            String(text || '')
                .replace(/^[\\s»›>·\\-]+/g, '')
                // O GLPI pode devolver a folha como \"Erro (109)\".
                // O número entre parênteses é o ID da própria categoria;
                // ignoramos somente esse sufixo para comparar com \"Erro\".
                .replace(/\\s*\\(\\d+\\)\\s*$/g, '')
                .trim()
        );
    }
"""

if old not in s:
    raise SystemExit('ERRO: cleanCategoryText alvo não encontrado')

s = s.replace(old, new, 1)
s = s.replace('// @version      0.9.10', '// @version      0.9.11', 1)
s = s.replace("const OM30_VERSION =\n        '0.9.10';", "const OM30_VERSION =\n        '0.9.11';", 1)

checks = [
    '// @version      0.9.11',
    "const OM30_VERSION =\n        '0.9.11';",
    ".replace(/\\s*\\(\\d+\\)\\s*$/g, '')"
]
for check in checks:
    if check not in s:
        raise SystemExit(f'ERRO: validação ausente: {check}')

p.write_text(s, encoding='utf-8')
print('Patch categoria 0.9.11 aplicado.')
