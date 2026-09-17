from pathlib import Path

p = Path('OM30-Preencher-Profissional.user.js')
s = p.read_text(encoding='utf-8')

ini = s.index('  /* ---------- lê os CAMPOS do AcroForm + caixas marcadas ---------- */')
fim = s.index('  /* ---------- AcroForm -> dados ---------- */', ini)

novo = r'''  /* ---------- lê AcroForm; se a assinatura achatou os campos, usa o texto posicionado ---------- */
  function agruparLinhasPdf(textos) {
    const linhas = [];
    const itens = (textos || [])
      .filter(t => t && String(t.s || '').trim())
      .map(t => ({ s:String(t.s || '').trim(), x:Number(t.x || 0), y:Number(t.y || 0), w:Number(t.w || 0) }))
      .sort((a,b) => (b.y - a.y) || (a.x - b.x));

    for (const t of itens) {
      let linha = linhas.find(l => Math.abs(l.y - t.y) <= 3.5);
      if (!linha) {
        linha = { y:t.y, items:[] };
        linhas.push(linha);
      }
      linha.items.push(t);
      linha.y = linha.items.reduce((acc,i)=>acc+i.y,0) / linha.items.length;
    }

    for (const l of linhas) {
      l.items.sort((a,b)=>a.x-b.x);
      l.text = l.items.map(i=>i.s).join(' ').replace(/\s+/g,' ').trim();
    }
    return linhas;
  }

  function ehMarcaPdf(s) {
    s = String(s || '').trim();
    if (!s) return false;
    if (/^[✓✔☑]$/.test(s)) return true;
    return s.length === 1 && s.charCodeAt(0) >= 0xE000 && s.charCodeAt(0) <= 0xF8FF;
  }

  function itemPdf(linha, re, depoisX) {
    if (!linha) return null;
    const rx = re instanceof RegExp ? re : new RegExp(String(re), 'i');
    const min = Number.isFinite(depoisX) ? depoisX : -Infinity;
    return linha.items.find(i => i.x >= min && rx.test(i.s)) || null;
  }

  function itemUtilPdf(i) {
    if (!i) return false;
    const s = String(i.s || '').trim();
    if (!s || ehMarcaPdf(s)) return false;
    if (/^[_\s/]+$/.test(s)) return false;
    return true;
  }

  function textoEntrePdf(linha, reEsq, reDir) {
    if (!linha) return '';
    const esq = itemPdf(linha, reEsq);
    if (!esq) return '';
    const inicio = esq.x + Math.max(0, esq.w) - 1;
    let fim = Infinity;
    if (reDir) {
      const dir = itemPdf(linha, reDir, esq.x + 0.1);
      if (dir) fim = dir.x - 1;
    }
    return linha.items
      .filter(i => i.x >= inicio && i.x < fim && itemUtilPdf(i))
      .map(i => i.s)
      .join(' ')
      .replace(/\s+/g,' ')
      .trim();
  }

  function partesDigitosPdf(linha, reEsq, reDir) {
    const s = textoEntrePdf(linha, reEsq, reDir);
    return s.match(/\d+/g) || [];
  }

  function extrairFormularioFlattened(textos, campos, marcados) {
    const linhas = agruparLinhasPdf(textos);
    const achar = (...termos) => linhas.find(l => {
      const n = norm(l.text);
      return termos.every(t => n.includes(norm(t)));
    }) || null;
    const set = (k,v) => {
      v = String(v == null ? '' : v).replace(/\s+/g,' ').trim();
      if (v && !String(campos[k] || '').trim()) campos[k] = v;
    };
    const setPartes = (prefixos, partes) => {
      prefixos.forEach((k,i) => { if (partes[i]) set(k, partes[i]); });
    };
    const marcar = label => {
      if (!label) return;
      if (!marcados.some(x => norm(x.label) === norm(label))) marcados.push({ label });
    };

    let l;

    l = achar('estabelecimento', 'saude:');
    if (l) {
      const cnes = soDig(textoEntrePdf(l, /SA[ÚU]DE:$/i));
      if (cnes) set('UNIDADES1', nomeDaUnidade(cnes) || cnes);
    }

    l = achar('entrada', 'estabelecimento:');
    if (l) setPartes(['ENTRADA1','ENTRADA2','ENTRADA3'], partesDigitosPdf(l, /ESTABELECIMENTO:$/i));

    l = achar('cpf:', 'sexo:');
    if (l) {
      setPartes(['CPF1','CPF2','CPF3','CPF4'], partesDigitosPdf(l, /^CPF:$/i, /^Sexo:$/i));
      const marca = l.items.find(i => ehMarcaPdf(i.s));
      if (marca) {
        const opcoes = [
          ['M', itemPdf(l, /^M$/i)],
          ['F', itemPdf(l, /^F$/i)],
          ['OUTRO', itemPdf(l, /^OUTRO:$/i)]
        ].filter(x => x[1]).map(([lab,it]) => ({ lab, dx:it.x - marca.x }))
          .filter(x => x.dx >= -2 && x.dx <= 42)
          .sort((a,b)=>a.dx-b.dx);
        if (opcoes[0]) marcar(opcoes[0].lab);
      }
    }

    l = achar('nome', 'completo:');
    if (l) set('Nome Completo', textoEntrePdf(l, /^Completo:$/i));

    l = achar('nome', 'mae:');
    if (l) set('Nome da Mãe', textoEntrePdf(l, /^Mãe:$/i));

    l = achar('nome', 'pai:');
    if (l) set('Nome do Pai', textoEntrePdf(l, /^Pai:$/i));

    l = achar('data', 'nascimento:', 'raca/cor:');
    if (l) {
      setPartes(['NASC1','NASC2','NASC3'], partesDigitosPdf(l, /^Nascimento:$/i, /^Raça\/Cor:$/i));
      set('RAÇA/COR', textoEntrePdf(l, /^Raça\/Cor:$/i));
    }

    l = achar('municipio', 'nascimento:', 'estado:', 'nacionalidade:');
    if (l) {
      set('Município de Nascimento', textoEntrePdf(l, /^Nascimento:$/i, /^Estado:$/i));
      set('UF1', textoEntrePdf(l, /^Estado:$/i, /^Nacionalidade:$/i));
      set('Nacionalidade', textoEntrePdf(l, /^Nacionalidade:$/i));
    }

    l = achar('e-mail:', 'celular:');
    if (l) {
      set('Email', textoEntrePdf(l, /^E-mail:$/i, /^Celular:$/i));
      set('CELULAR', textoEntrePdf(l, /^Celular:$/i));
    }

    l = achar('rg:', 'uf:', 'emissao:');
    if (l) {
      set('RG', textoEntrePdf(l, /^RG:$/i, /^UF:$/i));
      set('UF2', textoEntrePdf(l, /^UF:$/i, /^Emissão:$/i));
    }

    l = achar('endereco', 'completo:');
    if (l) set('Endereço Completo', textoEntrePdf(l, /^Completo:$/i));

    l = achar('bairro:', 'cidade:', 'cep:');
    if (l) {
      set('Bairro', textoEntrePdf(l, /^Bairro:$/i, /^Cidade:$/i));
      set('Cidade', textoEntrePdf(l, /^Cidade:$/i, /^CEP:$/i));
      setPartes(['CEP1','CEP2'], partesDigitosPdf(l, /^CEP:$/i));
    }

    l = achar('funcao', 'cbo', 'conselho:');
    if (l) {
      set('Função CBO', textoEntrePdf(l, /^\(CBO\):$/i, /^N[º°o]$/i));
      set('N do Conselho', textoEntrePdf(l, /^Conselho:$/i, /^UF:$/i));
      set('UF3', textoEntrePdf(l, /^UF:$/i));
    }

    l = achar('grau', 'escolaridade:');
    if (l) set('Grau de Escolaridade', textoEntrePdf(l, /^Escolaridade:$/i, /^Médico$/i));

    l = achar('autonomo', 'terceirizado');
    if (l) {
      const aut = itemPdf(l, /^Autônomo$/i);
      const marca = l.items.find(i => ehMarcaPdf(i.s) && aut && i.x < aut.x && (aut.x - i.x) <= 42);
      if (marca) marcar('Autônomo');
    }
  }

  async function lerFormulario(file) {
    await prepararWorker();
    const bytes = await file.arrayBuffer();
    const tarefaPdf = pdfjsLib.getDocument({ data: bytes });
    const pdf = await Promise.race([
      tarefaPdf.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('A leitura do PDF demorou mais de 20 segundos. Feche e abra a ficha novamente ou recarregue a página.')), 20000))
    ]);

    const campos = {}, marcados = [];
    let achouAcroFormUtil = false;
    let usouFallbackTexto = false;

    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const anns = await page.getAnnotations();
      const tc = await page.getTextContent();
      const textos = tc.items.map(it => ({
        s: it.str,
        x: it.transform[4],
        y: it.transform[5],
        w: Number(it.width || 0)
      }));

      anns.filter(a => a.subtype === 'Widget').forEach(a => {
        const nome = (a.fieldName || '').trim();
        if (a.fieldType === 'Tx' || a.fieldType === 'Ch') {
          if (a.fieldValue != null && a.fieldValue !== '') {
            campos[nome] = String(a.fieldValue).trim();
            achouAcroFormUtil = true;
          }
        } else if (a.fieldType === 'Btn') {
          const fv = a.fieldValue;
          const on = fv && fv !== 'Off' && (a.buttonValue === fv || a.exportValue === fv || a.checkBox);
          if (on) {
            marcados.push({ label: rotuloMaisProximo(a.rect, textos) });
            achouAcroFormUtil = true;
          }
        }
      });

      const antes = Object.keys(campos).length + marcados.length;
      extrairFormularioFlattened(textos, campos, marcados);
      if (Object.keys(campos).length + marcados.length > antes) usouFallbackTexto = true;
    }

    if (!Object.keys(campos).length) {
      throw new Error('Não consegui localizar os dados da ficha. O PDF não tem campos AcroForm nem texto posicionado reconhecível.');
    }

    if (!achouAcroFormUtil && usouFallbackTexto) {
      console.log('[Preencher] Ficha assinada/achatada detectada: dados lidos pela posição do texto.');
    }
    return { campos, marcados };
  }

  function rotuloMaisProximo(rect, textos) {
    const cy = (rect[1] + rect[3]) / 2, x2 = rect[2]; let melhor = null, dist = 1e9;
    textos.forEach(t => { if (!t.s.trim()) return; if (Math.abs(t.y - cy) > 7) return;
      const dx = t.x - x2; if (dx < -3) return; if (dx < dist) { dist = dx; melhor = t.s.trim(); } });
    return melhor || '';
  }

'''

s = s[:ini] + novo + s[fim:]
s = s.replace('// @version      4.22', '// @version      4.23', 1)
s = s.replace('Ficha PDF · CNES · v4.22', 'Ficha PDF · CNES · v4.23')
p.write_text(s, encoding='utf-8')

meta = Path('OM30-Preencher-Profissional.meta.js')
if meta.exists():
    ms = meta.read_text(encoding='utf-8').replace('// @version      4.22', '// @version      4.23', 1)
    meta.write_text(ms, encoding='utf-8')
