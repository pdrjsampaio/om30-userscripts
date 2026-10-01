from pathlib import Path

p = Path('OM30-Preencher-Profissional.user.js')
s = p.read_text(encoding='utf-8')

s = s.replace('// @version      4.26', '// @version      4.27', 1)

s = s.replace(
"      let li = null;\n      for (let i=0; i<32 && !li; i++) {",
"      let li = null;\n      let liCasouPorCodigo = false;\n      let liCasouPorNomeExato = false;\n      for (let i=0; i<32 && !li; i++) {",
1)

old = '''        // Para CBO normalizado, o código 4110-10/411010 ganha prioridade absoluta.
        if (codigo) li = lis.find(x => soDig(x.textContent).includes(codigo));
        if (!li) li = lis.find(x => norm(x.textContent) === alvo);
        if (!li) {
          let best=null, bs=0;
          for (const x of lis) { const sc=overlapCbo(alvo, x.textContent); if(sc>bs){bs=sc;best=x;} }
          if (best && bs >= 0.6) li=best;
          else if (!opts.strict) li=lis.find(x=>norm(x.textContent).includes(alvo)||alvo.includes(norm(x.textContent)))||lis[0];
        }
'''
new = '''        // Em modo strict (ocupação), NUNCA escolher por semelhança parcial.
        // Ex.: "Médico Clínico" não pode casar com "Médico oncologista clínico".
        if (codigo) {
          li = lis.find(x => codigoCboExato(x.textContent, codigo));
          liCasouPorCodigo = !!li;
        }
        if (!li) {
          li = lis.find(x => nomeCboExato(x.textContent, termo));
          liCasouPorNomeExato = !!li;
        }
        if (!li && !opts.strict) {
          let best=null, bs=0;
          for (const x of lis) { const sc=overlapCbo(alvo, x.textContent); if(sc>bs){bs=sc;best=x;} }
          if (best && bs >= 0.6) li=best;
          else li=lis.find(x=>norm(x.textContent).includes(alvo)||alvo.includes(norm(x.textContent)))||lis[0];
        }
'''
if old not in s:
    raise SystemExit('bloco de seleção CBO não encontrado')
s = s.replace(old, new, 1)

old = '''          const txt = tok.textContent.trim();
          const tokDigitos = soDig(txt);
          const codeOk = !codigo || !tokDigitos || tokDigitos.includes(codigo);
          const nomeOk = overlapCbo(alvo, txt) >= 0.6 || norm(txt).includes(alvo);
          if (codeOk && nomeOk) {
'''
new = '''          const txt = tok.textContent.trim();
          const codeOk = !codigo || liCasouPorCodigo || codigoCboExato(txt, codigo);
          const nomeOk = codigo
            ? codeOk
            : (opts.strict ? (liCasouPorNomeExato || nomeCboExato(txt, termo))
                           : (overlapCbo(alvo, txt) >= 0.6 || norm(txt).includes(alvo)));
          if (codeOk && nomeOk) {
'''
if old not in s:
    raise SystemExit('bloco de validação CBO não encontrado')
s = s.replace(old, new, 1)

needle = '  function overlapCbo(a,b){\n'
helpers = '''  function nomeCboLimpo(s){
    return norm(s)
      .replace(/\\b\\d{4}\\s*-?\\s*\\d{2}\\b/g,' ')
      .replace(/\\b\\d{6}\\b/g,' ')
      .replace(/^[\\s\\-–—:]+|[\\s\\-–—:]+$/g,'')
      .replace(/\\s+/g,' ')
      .trim();
  }
  function nomeCboExato(a,b){ return nomeCboLimpo(a) === nomeCboLimpo(b); }
  function codigoCboExato(texto,codigo){
    codigo = soDig(codigo);
    if (!codigo) return true;
    const achados = String(texto||'').match(/\\b\\d{4}\\s*-?\\s*\\d{2}\\b|\\b\\d{6}\\b/g) || [];
    return achados.some(x => soDig(x) === codigo);
  }

'''
if needle not in s:
    raise SystemExit('ponto de helpers CBO não encontrado')
s = s.replace(needle, helpers + needle, 1)

old = '''  async function aplicarUfConselhoFicha(d){
    if (d.ufConselho) await setSelConfirmado('profissional_orgao_classe_estado_id', estado(d.ufConselho), 'UF conselho');
    else await limparSelectConfirmado('profissional_orgao_classe_estado_id', 'UF conselho');
  }
'''
new = '''  async function aplicarUfConselhoFicha(d){
    const uf = String(d.ufConselho || '').trim().toUpperCase();
    // AC/Acre já apareceu como primeiro item/fallback mesmo quando a ficha não informou UF.
    // Por segurança, não aplicamos AC automaticamente: deixamos vazio para conferência.
    if (uf === 'AC') {
      await limparSelectConfirmado('profissional_orgao_classe_estado_id', 'UF conselho');
      if (!rel.vazio.some(x => /UF conselho.*AC\\/Acre/i.test(x)))
        rel.vazio.push('UF conselho veio como AC/Acre — não preenchido automaticamente; confira a ficha');
      return;
    }
    if (uf && Object.prototype.hasOwnProperty.call(UFS_BRASIL, uf))
      await setSelConfirmado('profissional_orgao_classe_estado_id', estado(uf), 'UF conselho');
    else
      await limparSelectConfirmado('profissional_orgao_classe_estado_id', 'UF conselho');
  }
'''
if old not in s:
    raise SystemExit('bloco UF conselho não encontrado')
s = s.replace(old, new, 1)

p.write_text(s, encoding='utf-8')

meta = Path('OM30-Preencher-Profissional.meta.js')
ms = meta.read_text(encoding='utf-8')
ms = ms.replace('// @version      4.26', '// @version      4.27', 1)
meta.write_text(ms, encoding='utf-8')
