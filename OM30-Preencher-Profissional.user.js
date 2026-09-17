// ==UserScript==
// @name         Preencher Profissional - Saúde Simples
// @namespace    saudesimples-guaruja
// @version      4.23
// @updateURL    https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Preencher-Profissional.meta.js
// @downloadURL  https://raw.githubusercontent.com/pdrjsampaio/om30-userscripts/main/OM30-Preencher-Profissional.user.js
// @description  Lê a Ficha de Cadastro (PDF AcroForm), preenche o profissional, deduz órgão de classe pelo CBO e consulta CNS/CNES pelo CPF. Atualização automática via GitHub.
// @author       Pedro Sampaio
// @match        https://guaruja.saudesimples.net/profissionais/new*
// @match        https://*.saudesimples.net/profissionais/new*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      cnes.datasus.gov.br
// @connect      cdnjs.cloudflare.com
// @require      https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    tipoCadastroPadrao: 'PADRÃO',
    tipoProfissionalPadrao: '',          // a ficha não informa; defina se quiser (ex.: 'Nível Superior')
    profissionalDeSaude: false,          // <- deixa "Não"
    cnesUrl: 'https://cnes.datasus.gov.br/services/profissionais?cpf={cpf}', // endpoint público confirmado
    municipesUrl: 'https://v3guaruja.saudesimples.net/municipes?current_menu_id=8' // fallback manual se o CNES não retornar
  };

  /* ---------- unidades Guarujá: NOME -> código CNES (para comparar com o CNES) ---------- */
  const UNIDADES_GUARUJA = [
    ['2059711','AMB REF EM ESPECIALIDADES E SAUDE DA MULHER ARE GUARUJA'],['4775791','AMBULATORIO TRANSEXUALIZADOR TRANSFORMA GUARUJA'],
    ['7908199','CAF CENTRAL DE ABASTECIMENTO FARMACEUTICO'],['2754835','CAPS ADII GUARUJA'],['2082500','CAPS DR JOSE FORSTHER JUNIOR GUARUJA'],
    ['7068913','CAPS III GUARUJA'],['2084864','CAPS INFANTIL GUARUJA'],['5840260','CASA SER'],['0982547','CENTRAL DE DISTRIBUICAO DE VACINAS GUARUJA'],
    ['6490794','CENTRAL DE REGULACAO MUNICIPAL GUARUJA'],['3716333','CENTRO DE ESPECIALIDADE ODONTOLOGICA CEO'],
    ['4720105','CENTRO DE ESPECIALIDADES DE VICENTE DE CARVALHO GUARUJA'],['6712150','CENTRO DE RECUPERACAO E FISIOTERAPIA DE VICENTE DE CARVALHO'],
    ['2054221','CENTRO DE RECUPERACAO E FISIOTERAPIA GUARUJA'],['6599443','CENTRO DE REF OTORRINO OFTALMO E FONOAUDIOLOGIA GUARUJA'],
    ['2062313','CENTRO REC DE PARAL INF E CER DO GUARUJA CRPI SOC BENEF'],['7490755','CONSULTORIO NA RUA GUARUJA'],['7619626','CTAPT GUARUJA'],
    ['6573002','FARMACIA DO CIDADAO FARMACEUTICO OSWALDO CAFARO V C'],['9353151','FARMACIA DO CIDADAO JAYRO GRACIOLA'],
    ['6417205','FARMACIA DO CIDADAO VILA JULIA GUARUJA'],['9663851','INSTITUTO DA MULHER CASA ROSA'],['2789345','PRONTO SOCORRO DE VICENTE DE CARVALHO GUARUJA'],
    ['5304717','PRONTO SOCORRO PEREQUE ANIBAL ARDEN DOS REIS GUARUJA'],['2789353','PRONTO SOCORRO PROF DR MATHEUS SANTAMARIA GUARUJA'],
    ['5920353','PRONTO SOCORRO SANTA CRUZ DOS NAVEGANTES GUARUJA'],['7517785','SAMU 192 MOTOLANCIA M1 145 GUARUJA'],['7453779','SAMU 192 SAV 836 GUARUJA'],
    ['7025327','SAMU 192 SBV 799 GUARUJA'],['7022883','SAMU 192 SBV 821 GUARUJA'],['7025300','SAMU 192 SBV 833 GUARUJA'],['6137377','SAMU 192 SBV 834 GUARUJA'],
    ['7022875','SAMU 192 SBV 837 GUARUJA'],['7453809','SAMU 192 SBV G9 721 GUARUJA'],['2047683','SECRETARIA DE SAUDE GUARUJA'],
    ['2065495','SERV DE VIG SANITARIA EPIDEMIO E CTRL DE ZOONOZES GUARUJA'],['5933293','SERVICO DE TRANSPORTE SANITARIO DO GUARUJA'],
    ['5933285','SIAD SERVICO DE INTERNACAO E ASSIST DOMICILIAR GUARUJA'],['2064472','UBS MORRINHOS GUARUJA'],['2050048','UBS PAE CARA GUARUJA'],
    ['2036126','UBS PERNAMBUCO GUARUJA'],['2034581','UBS PRAINHA VICENTE DE CARVALHO GUARUJA'],['2036134','UBS VILA ALICE KATIA GONCALVES DOS S SIQUEIRA GUARUJA'],
    ['2050323','UBS VILA BAIANA GUARUJA'],['4343506','UNAERP GUARUJA'],['2081504','UNIDADE COMPLEXA WILLIAM ROCHA'],
    ['9326499','UNIDADE DE ESPECIALIDADE EM DIABETES E OBESIDADE INFANTO JUV'],['2034573','UNIDADE DE SAUDE SANTA ROSA GUARUJA'],
    ['9061827','UNIDADE DE VIGILANCIA EM ZOONOSES DE GUARUJA'],['6885284','UPA ENSEADA PAULO FLAVIO AFONSO PIASENTI GUARUJA'],
    ['5294681','USAFA CIDADE ATLANTICA GUARUJA'],['2055031','USAFA JARDIM BOA ESPERANCA LUIZ MACIEL BRAIA GUARUJA'],
    ['7420404','USAFA JARDIM BRASIL GUSTAVO COELHO DE ALMEIDA GUARUJA'],['7610246','USAFA JARDIM CONCEICAOZINHA GENTIL NUNES NETO GUARUJA'],
    ['2754851','USAFA JARDIM DOS PASSAROS GUARUJA'],['7039972','USAFA JARDIM LAS PALMAS JANDUI DE SOUZA MOREIRA GUARUJA'],
    ['7070489','USAFA JARDIM PROGRESSO GUARUJA'],['2043963','USAFA PEREQUE GUARUJA'],['2072998','USAFA SANTA CRUZ DOS NAVEGANTES GUARUJA'],
    ['5306000','USAFA SITIO CONCEICAOZINHA GUARUJA'],['2064464','USAFA VILA AUREA GUARUJA'],['2060183','USAFA VILA EDNA MARCO ANTONIO GONZALEZ GUARUJA'],
    ['2052423','USAFA VILA RA GUARUJA'],['5521300','USAFA VILA ZILDA DR DAVID CAPISTRANO DA COSTA FILHO GUARUJA']
  ];
  const UnidadeCnes = (() => {
    const idx = new Map(UNIDADES_GUARUJA.map(([c,n]) => [norm(n), c]));
    return { porNome(nome){ const n = norm(nome); if (!n) return '';
      if (idx.has(n)) return idx.get(n);
      for (const [c,nm] of UNIDADES_GUARUJA){ const un = norm(nm); if (n.includes(un) || un.includes(n)) return c; }
      return ''; } };
  })();
  const nomeDaUnidade = (cnes) => { const u = UNIDADES_GUARUJA.find(x => x[0] === cnes); return u ? u[1] : ''; };

  /* ---------- apelidos de unidade aprendidos (persistem entre sessões) ---------- */
  const ALIAS_KEY = 'ps_alias_unidades_v1';
  function lerAlias(){ try{
    const raw = (typeof GM_getValue==='function') ? GM_getValue(ALIAS_KEY,'{}') : (localStorage.getItem(ALIAS_KEY)||'{}');
    return JSON.parse(raw||'{}'); }catch(e){ return {}; } }
  function gravarAlias(o){ const s=JSON.stringify(o);
    if (typeof GM_setValue==='function') GM_setValue(ALIAS_KEY,s); else try{ localStorage.setItem(ALIAS_KEY,s); }catch(e){} }
  function aliasGet(nomeFicha){ const a=lerAlias(); return a[norm(nomeFicha)] || null; }
  function aliasSet(nomeFicha, nome, cnes){ const a=lerAlias(); a[norm(nomeFicha)] = { nome, cnes }; gravarAlias(a); }

  // resolve o nome da ficha -> {nome canônico, cnes}; null se desconhecida
  function resolverUnidade(nomeFicha){
    if (!nomeFicha) return null;
    const al = aliasGet(nomeFicha);
    if (al && al.nome) return { nome: al.nome, cnes: al.cnes || UnidadeCnes.porNome(al.nome) };
    const cod = UnidadeCnes.porNome(nomeFicha);
    if (cod) return { nome: nomeDaUnidade(cod) || nomeFicha, cnes: cod };
    return null;
  }

  // pergunta ao usuário qual é a unidade e GUARDA o apelido p/ as próximas
  function perguntarUnidade(nomeFicha){
    return new Promise(resolve => {
      const box = elx('ps_ask'); if (!box) { resolve(null); return; }
      abrir(true);
      elx('ps_ask_lbl').textContent = 'Unidade "'+nomeFicha+'" não reconhecida. Qual é no Saúde Simples?';
      const sel = elx('ps_ask_sel');
      sel.innerHTML = '<option value="">— escolha a unidade —</option>' +
        UNIDADES_GUARUJA.slice().sort((a,b)=>a[1].localeCompare(b[1]))
          .map(([c,n]) => `<option value="${c}">${n}</option>`).join('');
      box.classList.add('show');
      const fin = (res) => { box.classList.remove('show'); elx('ps_ask_ok').onclick=null; elx('ps_ask_skip').onclick=null; resolve(res); };
      elx('ps_ask_ok').onclick = () => { const c = sel.value; if (!c) return;
        const n = nomeDaUnidade(c); aliasSet(nomeFicha, n, c); fin({ nome:n, cnes:c }); };
      elx('ps_ask_skip').onclick = () => fin(null);
    });
  }

  /* ---------- pdf.js worker ---------- */
  // O worker também é carregado por @require. Assim a leitura do PDF não precisa
  // baixar código via GM_xmlhttpRequest toda vez que o usuário clica em ler.
  async function prepararWorker() {
    if (typeof pdfjsLib === 'undefined')
      throw new Error('PDF.js não carregou. Reinstale/atualize o script e recarregue a página.');

    const w = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    pdfjsLib.GlobalWorkerOptions.workerSrc = w;

    if (typeof globalThis.pdfjsWorker === 'undefined') {
      console.warn('[Preencher] pdf.worker não apareceu no sandbox; PDF.js tentará o worker pela URL.');
    }
  }

  /* ---------- lê AcroForm; se a assinatura achatou os campos, usa o texto posicionado ---------- */
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

  /* ---------- AcroForm -> dados ---------- */

  // Se o município vier com UF no próprio texto (ex.: "Formosa - GO",
  // "Campinas/SP", "Curitiba PR"), separa município e estado.
  // Reconhece TODAS as 27 UFs brasileiras e só trata o sufixo como estado
  // quando ele for uma sigla oficial válida.
  const UFS_BRASIL = Object.freeze({
    AC:'Acre', AL:'Alagoas', AP:'Amapá', AM:'Amazonas', BA:'Bahia', CE:'Ceará',
    DF:'Distrito Federal', ES:'Espírito Santo', GO:'Goiás', MA:'Maranhão', MT:'Mato Grosso',
    MS:'Mato Grosso do Sul', MG:'Minas Gerais', PA:'Pará', PB:'Paraíba', PR:'Paraná',
    PE:'Pernambuco', PI:'Piauí', RJ:'Rio de Janeiro', RN:'Rio Grande do Norte', RS:'Rio Grande do Sul',
    RO:'Rondônia', RR:'Roraima', SC:'Santa Catarina', SP:'São Paulo', SE:'Sergipe', TO:'Tocantins'
  });

  // Se a própria ficha escrever a UF junto do município, separa os dois campos.
  // Exemplos aceitos: FORMOSA - GO | FORMOSA/GO | FORMOSA GO | FORMOSA (GO) | FORMOSA, GO
  // Não tenta adivinhar o estado pelo nome da cidade: só usa uma sigla oficial explicitamente escrita.
  function separarMunicipioUf(valor) {
    const raw = String(valor || '').replace(/\s+/g, ' ').trim();
    if (!raw) return { municipio:'', uf:'', original:'' };

    const padroes = [
      /^(.*?)\s*\(([A-Za-z]{2})\)\s*$/,
      /^(.*?)\s*[-–—\/,;:]\s*([A-Za-z]{2})\s*$/,
      /^(.*?)\s+([A-Za-z]{2})\s*$/
    ];

    let m = null;
    for (const re of padroes) {
      m = raw.match(re);
      if (m) break;
    }
    if (!m) return { municipio:raw, uf:'', original:raw };

    const uf = String(m[2] || '').toUpperCase();
    if (!Object.prototype.hasOwnProperty.call(UFS_BRASIL, uf)) {
      return { municipio:raw, uf:'', original:raw };
    }

    const municipio = String(m[1] || '')
      .replace(/[\s,;:\-–—\/]+$/g, '')
      .trim();
    if (!municipio) return { municipio:raw, uf:'', original:raw };

    return { municipio, uf, original:raw };
  }

  function montar(form) {
    const c = form.campos, m = form.marcados.map(x => norm(x.label));
    const get = (...n) => { for (const k of n) if (c[k] != null) return c[k]; return ''; };
    const data = (a,b,d) => { const p=[get(a),get(b),get(d)]; if(!p.every(Boolean)) return '';
      let y=p[2]; if(y.length===2) y='20'+y; return `${p[0]}/${p[1]}/${y}`; };
    const end = get('Endereço Completo'); let logr = end, num = '';
    let mm = end.match(/^(.*?),\s*(?:n[º°o.]?\s*)?(\d+[A-Za-z]?)\b/i)   // "..., 447" ou "..., nº 19"
          || end.match(/^(.+?)[,\s]+(\d{1,6}[A-Za-z]?)\s*$/);           // número no fim, sem vírgula
    if (mm) { logr = mm[1].replace(/[,\s]+$/,'').trim(); num = mm[2].trim(); }
    const tem = re => m.some(l => re.test(l));
    let sexo = ''; if (tem(/^m$|masculino/)) sexo='M'; if (tem(/^f$|feminino/)) sexo='F';

    const municipioNascRaw = get('Município de Nascimento','Munic\u00edpio de Nascimento');
    const municipioUf = separarMunicipioUf(municipioNascRaw);
    const ufNascFicha = String(get('UF1') || '').trim();
    // Quando o próprio município traz "- UF", essa informação explícita tem prioridade.
    // Ex.: "Formosa - GO" -> município Formosa + estado Goiás, mesmo se UF1 vier divergente.
    const ufNascFinal = municipioUf.uf || ufNascFicha;

    return {
      nome:get('Nome Completo'), nomeMae:get('Nome da Mãe','Nome da M\u00e3e'), nomePai:get('Nome do Pai'),
      email:get('Email').toLowerCase(), celular:soDig(get('CELULAR')), rg:get('RG'),
      cpf:[get('CPF1'),get('CPF2'),get('CPF3'),get('CPF4')].filter(Boolean).join(''),
      dataNascimento:data('NASC1','NASC2','NASC3'), dataAdmissao:data('ENTRADA1','ENTRADA2','ENTRADA3'),
      cep:soDig(get('CEP1')+get('CEP2')), logradouro:logr, numero:num, bairro:get('Bairro'),
      cidadeResid:get('Cidade'),
      municipioNasc:municipioUf.municipio,
      municipioNascOriginal:municipioUf.original,
      ufNascPeloMunicipio:municipioUf.uf,
      ufNascFicha,
      // UF1 = nascimento | UF2 = RG | UF3 = conselho. Não reutilizar uma UF em outro campo.
      // Se o município trouxer sufixo de UF válido, ele tem prioridade sobre UF1.
      ufNasc:ufNascFinal, ufRg:get('UF2'), ufConselho:get('UF3'), nacionalidade:get('Nacionalidade').trim(), raca:get('RAÇA/COR','RA\u00c7A/COR').trim(),
      escolaridade:get('Grau de Escolaridade'), conselho:get('N do Conselho'),
      funcaoCBO:get('Função CBO','Fun\u00e7\u00e3o CBO'), unidade:get('UNIDADES1').trim(),
      sexo, autonomo:tem(/autonomo|autônomo/)
    };
  }

  /* ---------- preenche ---------- */
  const rel = { ok: [], vazio: [] };
  let avisoCboPersistente = '';
  async function preencher(d) {
    rel.ok = []; rel.vazio = []; avisoCboPersistente = '';

    // Município com UF embutida tem prioridade sobre UF1.
    // Não é uma inferência por nome da cidade: a sigla precisa estar escrita na própria ficha.
    if (d.ufNascPeloMunicipio) {
      rel.ok.push('Município nascimento: ' + d.municipioNasc + ' / ' + d.ufNascPeloMunicipio);
      if (d.ufNascFicha && norm(d.ufNascFicha) !== norm(d.ufNascPeloMunicipio)) {
        rel.vazio.push(
          'UF nascimento divergente na ficha: município "' + d.municipioNascOriginal +
          '" indica ' + d.ufNascPeloMunicipio + ', mas UF1 informa ' + d.ufNascFicha +
          ' — usado ' + estado(d.ufNascPeloMunicipio)
        );
      }
    }

    if (CONFIG.tipoCadastroPadrao) setSel('profissional_tipo_cadastro_profissional_id', CONFIG.tipoCadastroPadrao);
    if (CONFIG.tipoProfissionalPadrao) setSel('profissional_tipo_profissional_id', CONFIG.tipoProfissionalPadrao);
    chk(CONFIG.profissionalDeSaude ? 'profissional_profissional_saude_true' : 'profissional_profissional_saude_false');

    setT('profissional_nome', d.nome, 'Nome');
    setT('profissional_nome_mae', d.nomeMae, 'Mãe');
    setT('profissional_nome_pai', d.nomePai, 'Pai');
    setT('profissional_data_nascimento', d.dataNascimento, 'Nascimento');
    setT('profissional_email', d.email, 'E-mail');
    setT('profissional_telefone_celular', d.celular, 'Celular');
    setT('profissional_cpf_numero', d.cpf, 'CPF');
    setT('profissional_identidade_numero', d.rg, 'RG');
    setT('profissional_numero_conselho', d.conselho, 'Conselho');
    setDataSemCalendario('profissional_data_admissao', d.dataAdmissao, 'Admissão');
    // carga horária: não preenchida de propósito

    if (d.sexo === 'M') chk('profissional_sexo_id_1');
    else if (d.sexo === 'F') chk('profissional_sexo_id_2');
    else rel.vazio.push('Sexo (confira)');
    chk(d.autonomo ? 'profissional_tipo_relacao_profissional_id_2' : 'profissional_tipo_relacao_profissional_id_1');
    rel.ok.push(d.autonomo ? 'Vínculo: Autônomo' : 'Vínculo: Com Vínculo');

    if (d.nacionalidade) setSel('profissional_nacionalidade_id', d.nacionalidade);
    if (d.raca) setSel('profissional_raca_cor_id', d.raca);
    if (d.escolaridade) setSel('profissional_grau_escolaridade_id', mapEscolaridade(d.escolaridade));

    // Normaliza a ocupação ANTES de qualquer dependência de conselho/CBO.
    // Atendente Administrativo e Estagiário usam Assistente Administrativo (4110-10).
    const ocupFicha = normalizarOcupacaoFicha(d.funcaoCBO);
    const avisoCboAposPreencher = ocupFicha.aviso || '';
    const ocupBusca = ocupFicha.busca;

    // 1) CEP PRIMEIRO. O Saúde Simples pode reconstruir vários selects enquanto
    //    resolve o endereço; por isso nenhum estado é definido antes desta etapa.
    if (d.cep) {
      await digitarCepDevagar('profissional_residencia_cep', d.cep);
      blur('profissional_residencia_cep');
      await esperarAutofillCepCompleto();
      rel.ok.push('CEP (autofill)');
    }
    setT('profissional_residencia_numero', d.numero, 'Número');

    // 2) UFs pessoais com origem independente na ficha:
    // UF1 = nascimento | UF2 = RG. Campo vazio na ficha = campo vazio no sistema.
    // A UF do conselho (UF3) só é aplicada DEPOIS do órgão de classe, porque esse
    // select pode ser reconstruído quando o conselho profissional é escolhido.
    await aplicarUfsPessoaisFicha(d);

    // AUTOCOMPLETES — só o município de NASCIMENTO (o de residência vem do CEP)
    if (d.municipioNasc) await selToken(['nascimento_municipio','nascimento'], d.municipioNasc, 'Município nascimento');

    // resolve a unidade: apelido salvo > mapa > pergunta (e aprende para a próxima)
    let uni = resolverUnidade(d.unidade);
    if (!uni && d.unidade) uni = await perguntarUnidade(d.unidade);
    const unidadeNome = uni ? uni.nome : d.unidade;
    const unidadeCod  = uni ? uni.cnes : '';

    // Ocupação + unidade e, com os dois preenchidos, clicar em "Incluir".
    // Para ocupações normalizadas, o CÓDIGO é a primeira chave de busca.
    if (ocupFicha.corrigido) {
      rel.ok.push('CBO ajustado: ' + ocupFicha.original + ' → ' + ocupFicha.busca + ' (' + ocupFicha.codigo + ')');
    }
    const okOcup = ocupBusca ? await selToken(['ocupacao'], ocupBusca, 'Ocupação', {
      searches: ocupFicha.codigo
        ? [soDig(ocupFicha.codigo), ocupFicha.codigo, ocupBusca, termoBusca(ocupBusca)]
        : [ocupBusca, termoBusca(ocupBusca)],
      code: ocupFicha.codigo,
      strict: true
    }) : '';

    // ÓRGÃO DE CLASSE É DEDUZIDO PELO CBO.
    // Quando a ficha traz apenas o código (ex.: 225125), usamos o texto da ocupação
    // realmente selecionada no Saúde Simples (ex.: MÉDICO ...) para descobrir CRM,
    // COREN, CRO, CRP, CRF, CREFITO etc. Se a profissão não exige conselho, fica vazio.
    const textoCboSelecionado = okOcup || ocupBusca || d.funcaoCBO || '';
    const orgaoClasse = mapOrgaoClasse(textoCboSelecionado);
    if (orgaoClasse) {
      await setSelPrefixoConfirmado('profissional_orgao_classe_id', orgaoClasse, 'Órgão classe ('+orgaoClasse+')');
    } else {
      await limparSelectConfirmado('profissional_orgao_classe_id', 'Órgão classe');
    }

    // UF3 pertence ao CONSELHO e só vem da ficha. Nunca é deduzida.
    await aplicarUfConselhoFicha(d);

    const okUni  = unidadeNome ? await selUnidade(unidadeNome, unidadeCod, d.unidade) : '';
    if (okOcup && okUni) { await espera(500); await clicarIncluir(); }
    else if (okOcup || okUni) rel.vazio.push('Incluir (preencha ocupação E unidade antes)');

    // BLINDAGEM FINAL: callbacks de ocupação/unidade podem reconstruir selects.
    // Reaplica somente o que tem origem válida: UFs pessoais da ficha, órgão de classe
    // deduzido do CBO e UF do conselho somente quando preenchida na ficha.
    await aplicarUfsPessoaisFicha(d);
    if (orgaoClasse) {
      await setSelPrefixoConfirmado('profissional_orgao_classe_id', orgaoClasse, 'Órgão classe ('+orgaoClasse+')');
    } else {
      await limparSelectConfirmado('profissional_orgao_classe_id', 'Órgão classe');
    }
    await aplicarUfConselhoFicha(d);

    // Só mostra a conversão depois que os campos principais já foram preenchidos
    // e a tentativa de inclusão da ocupação/unidade terminou.
    if (avisoCboAposPreencher) avisoCboPersistente = avisoCboAposPreencher;

    if (d.cpf) {
      status('Consultando o CNES pelo CPF...');
      try {
        const perfil = await buscarCnesPerfil(d.cpf);
        if (perfil) {
          if (perfil.cns) setT('profissional_codigo_cns', perfil.cns, 'CNS');
          else rel.vazio.push('CNS — não veio do CNES');
          const dComparacao = ocupFicha.corrigido ? Object.assign({}, d, { funcaoCBO: ocupFicha.busca }) : d;
          compararCnes(dComparacao, perfil, unidadeCod, unidadeNome);
        } else {
          rel.vazio.push('CNS — não encontrado no CNES'); avisarFallback();
          alerta('warn', 'Profissional não encontrado no CNES pelo CPF. Use o fluxo de munícipes (botão +) para puxar do DataSUS.');
        }
      } catch (e) { rel.vazio.push('CNES — falha'); avisarFallback(); console.warn('[CNES]', e); }
    } else if (avisoCboPersistente) {
      alerta('warn', avisoCboPersistente);
    }
    const resumo = '✓ ' + rel.ok.length + ' preenchidos' + (rel.vazio.length ? '  ·  ⚠ ' + rel.vazio.length + ' a conferir' : '');
    status(resumo);
    const det = elx('ps_det');
    if (det) det.innerHTML =
      '<b>Preenchidos:</b> ' + (rel.ok.map(esc).join(', ') || '—') +
      (rel.vazio.length ? '<br><b class="v">A conferir:</b> <span class="v">' + rel.vazio.map(esc).join(', ') + '</span>' : '');
  }
  function esc(s){ return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
  function avisarFallback(){ console.log('[CNS] Fluxo manual: ' + CONFIG.municipesUrl + ' > botão "+" > digite o CPF (puxa do DataSUS).'); }

  /* ---------- autocomplete (jQuery tokenInput): acha o campo, digita, espera a lista e clica ---------- */
  function tokensBusca(){ return Array.from(document.querySelectorAll('input[id^="token-input-"]')); }
  function acharTokenInput(matchers){
    const ms = matchers.map(m => m.toLowerCase());
    return tokensBusca().find(i => i.offsetParent !== null && !/new_profissionais/i.test(i.id)
      && ms.some(m => i.id.toLowerCase().includes(m)));
  }
  // Digita o CEP realmente da ESQUERDA PARA A DIREITA.
  // Não usa `e.value += ch`, porque campos com máscara podem manter placeholders
  // e posicionar o cursor no final (ex.: _____-___), fazendo o primeiro número entrar à direita.
  async function digitarCepDevagar(id, valor){
    const e = elx(id); if (!e || valor == null || valor === '') return;
    const digitos = soDig(String(valor)).slice(0, 8);
    if (!digitos) return;

    e.focus();

    // Limpeza forte + cursor explicitamente no primeiro caractere.
    e.value = '';
    try { e.setSelectionRange(0, 0); } catch (_) {}
    e.dispatchEvent(new Event('input', { bubbles:true }));
    jq(e, j => { try { j.val('').trigger('input').trigger('keyup'); } catch (_) {} });
    await espera(300);

    for (let i = 1; i <= digitos.length; i++) {
      const ch = digitos[i - 1];
      const crus = digitos.slice(0, i);
      // Monta nós mesmos o valor parcial. Assim o primeiro dígito SEMPRE fica à esquerda.
      const parcial = crus.length > 5 ? crus.slice(0, 5) + '-' + crus.slice(5) : crus;

      e.dispatchEvent(new KeyboardEvent('keydown', { bubbles:true, key:ch, code:'Digit'+ch }));
      e.value = parcial;
      try { e.setSelectionRange(e.value.length, e.value.length); } catch (_) {}

      try {
        e.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'insertText', data:ch }));
      } catch (_) {
        e.dispatchEvent(new Event('input', { bubbles:true }));
      }
      e.dispatchEvent(new KeyboardEvent('keyup', { bubbles:true, key:ch, code:'Digit'+ch }));
      jq(e, j => { try { j.trigger('input').trigger('keyup'); } catch (_) {} });
      await espera(240); // lento de propósito para o autofill acompanhar a digitação
    }

    // Garante o CEP final no formato esperado antes de blur/change.
    const finalCep = digitos.length > 5 ? digitos.slice(0, 5) + '-' + digitos.slice(5) : digitos;
    e.value = finalCep;
    try { e.setSelectionRange(e.value.length, e.value.length); } catch (_) {}
    e.dispatchEvent(new Event('input', { bubbles:true }));
    e.dispatchEvent(new Event('change', { bubbles:true }));
    jq(e, j => { try { j.trigger('input').trigger('change'); } catch (_) {} });
    await espera(450);
  }

  // Espera o autofill do CEP terminar de preencher e estabilizar os campos (até ~8s).
  async function esperarAutofillCepCompleto(){
    const ids = [
      'profissional_residencia_logradouro',
      'profissional_residencia_bairro',
      'profissional_residencia_cidade',
      'profissional_residencia_municipio',
      'profissional_residencia_estado_id'
    ];
    let anterior = '';
    let estavel = 0;

    for (let i=0; i<40; i++){
      await espera(200);
      const atual = ids.map(id => val(id)).join('|');
      const temEndereco = !!(val('profissional_residencia_logradouro') || val('profissional_residencia_bairro'));
      const uf = val('profissional_residencia_estado_id');

      if (atual && atual === anterior && temEndereco && uf) estavel++;
      else estavel = 0;

      anterior = atual;
      if (estavel >= 3) { // ~600 ms sem nenhuma mudança
        await espera(400);
        return true;
      }
    }
    await espera(500);
    return false;
  }
  // Inclui ocupação + unidade na grade SEM permitir que o formulário seja salvo.
  // A versão anterior tinha dois riscos aqui:
  // 1) o fallback também procurava input[type=submit], podendo alcançar o botão Salvar;
  // 2) disparava o clique duas vezes (dispatchEvent + jQuery.trigger).
  // Agora usamos somente o botão de inclusão, um único clique, e bloqueamos submit
  // temporariamente durante esta etapa.
  async function clicarIncluir(){
    let btn = document.getElementById('add_profissionais_unidades_saude_fields');

    if (!btn) {
      const candidatos = Array.from(document.querySelectorAll(
        'a[id*="add_profissionais_unidades"], a[onclick*="unidades_saude"], button[onclick*="unidades_saude"], input[type="button"]'
      )).filter(b => b && b.offsetParent !== null);

      btn = candidatos.find(b => {
        const txt = norm((b.textContent || b.value || '').trim());
        const meta = norm([
          b.id || '', b.name || '', b.getAttribute('href') || '',
          b.getAttribute('onclick') || '', b.className || ''
        ].join(' '));
        return /^(\+\s*)?incluir$/.test(txt) && /unidade|unidades_saude|profissionais_unidades/.test(meta);
      }) || null;
    }

    if (!btn) {
      rel.vazio.push('Incluir (botão específico da unidade não encontrado)');
      console.warn('[Incluir] botão específico da grade de unidade não encontrado. O Salvar NÃO foi acionado.');
      return false;
    }

    // Segurança: nunca aceitar um submit como botão de inclusão.
    const tipo = norm(btn.getAttribute && btn.getAttribute('type'));
    if ((btn.tagName === 'INPUT' || btn.tagName === 'BUTTON') && tipo === 'submit') {
      rel.vazio.push('Incluir (elemento encontrado era submit — bloqueado por segurança)');
      console.error('[Incluir] bloqueado: o elemento encontrado era type=submit.', btn);
      return false;
    }

    const form = btn.closest('form') || document.querySelector('form#new_profissional, form[action*="/profissionais"]');
    let submitTentado = false;
    const bloquearSubmit = ev => {
      submitTentado = true;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      console.warn('[Incluir] tentativa de salvar/submit bloqueada durante a inclusão da unidade.');
    };
    if (form) form.addEventListener('submit', bloquearSubmit, true);

    try {
      // Um único clique nativo. Nada de segundo trigger via jQuery.
      if (typeof btn.click === 'function') btn.click();
      else btn.dispatchEvent(new Event('click', { bubbles:true, cancelable:true }));

      // Dá tempo para o nested_fields inserir a linha na grade.
      await espera(900);

      if (submitTentado) {
        rel.vazio.push('Salvar foi bloqueado durante Incluir — confira a grade');
        alerta('warn', 'O sistema tentou salvar antes de incluir a unidade. O script BLOQUEOU o salvamento. Confira se a ocupação/unidade entrou na grade antes de salvar manualmente.');
      } else {
        rel.ok.push('Incluído na grade');
      }
      return !submitTentado;
    } finally {
      if (form) form.removeEventListener('submit', bloquearSubmit, true);
    }
  }
  // digita num campo de texto caractere a caractere (dispara máscara e autofill do site)
  async function digitarCampo(id, valor){
    const e = elx(id); if (!e || valor == null || valor === '') return;
    e.focus(); e.value = '';
    for (const ch of String(valor)) {
      e.value += ch;
      e.dispatchEvent(new KeyboardEvent('keydown', { bubbles:true, key: ch }));
      e.dispatchEvent(new Event('input', { bubbles:true }));
      e.dispatchEvent(new KeyboardEvent('keyup', { bubbles:true, key: ch }));
      jq(e, j => j.trigger('input'));
      await espera(25);
    }
    e.dispatchEvent(new Event('change', { bubbles:true })); jq(e, j => j.trigger('change'));
  }


  /* ---------- autocomplete específico de UNIDADE ---------- */
  // O Saúde Simples nem sempre encontra uma unidade quando recebe o nome oficial inteiro.
  // Por isso, a unidade usa buscas progressivamente menores e só clica quando há
  // correspondência segura com o nome/CNES esperado.
  const STOP_UNIDADE = new Set([
    'de','da','do','das','dos','e','em','para','prof','professor','dra','dr',
    'guaruja','municipal','municipio','unidade','saude'
  ]);

  function palavrasUnidade(s){
    return norm(s).replace(/[^a-z0-9 ]/g,' ').split(/\s+/)
      .filter(w => w && w.length >= 2 && !STOP_UNIDADE.has(w));
  }

  function scoreUnidade(esperado, candidato, cnes){
    const a = palavrasUnidade(esperado);
    const b = palavrasUnidade(candidato);
    if (!a.length || !b.length) return 0;

    const sa = new Set(a), sb = new Set(b);
    let inter = 0;
    sa.forEach(w => { if (sb.has(w)) inter++; });

    // Cobertura do nome esperado + leve bônus quando o começo (UBS/USAFA/UPA/CAPS...) coincide.
    let score = inter / Math.max(1, Math.min(sa.size, sb.size));
    const pa = a[0], pb = b[0];
    if (pa && pb && pa === pb) score += 0.12;

    // Se a lista do site exibir o CNES junto do nome, isso vira casamento praticamente exato.
    if (cnes && soDig(candidato).includes(String(cnes))) score = Math.max(score, 1.5);
    return score;
  }

  function termosBuscaUnidade(nome, cnes, nomeFicha){
    const base = [];
    const add = s => {
      s = String(s || '').replace(/\s+/g,' ').trim();
      if (s && !base.some(x => norm(x) === norm(s))) base.push(s);
    };

    add(nome);
    add(nomeFicha);

    // Retira apenas o sufixo "GUARUJA", que costuma não existir no autocomplete do sistema.
    add(String(nome || '').replace(/\s+GUARUJA\s*$/i,'').trim());
    add(String(nomeFicha || '').replace(/\s+GUARUJA\s*$/i,'').trim());

    const ws = palavrasUnidade(nome);
    if (ws.length) {
      // Mantém o tipo da unidade + palavras mais distintivas.
      add(ws.slice(0, Math.min(4, ws.length)).join(' '));
      if (ws.length > 2) add(ws.slice(-3).join(' '));
      if (ws.length > 1) add(ws.slice(-2).join(' '));
    }

    // Sigla + parte distintiva costuma ser a busca mais estável.
    const sig = String(nome || '').match(/^(UBS|USAFA|UPA|CAPS|SAMU|CAF|SIAD|CTAPT)\b/i);
    if (sig && ws.length) {
      const distintos = ws.filter(w => !/^(ubs|usafa|upa|caps|samu|caf|siad|ctapt)$/.test(w));
      if (distintos.length) add(sig[1].toUpperCase() + ' ' + distintos.slice(0,3).join(' '));
    }

    // Último recurso: alguns autocompletes também pesquisam pelo CNES.
    if (cnes) add(String(cnes));
    return base.slice(0, 8);
  }

  async function selUnidade(nome, cnes, nomeFicha){
    let input = acharTokenInput(['unidade_saude','unidade']);
    for (let k=0; k<18 && !input; k++){ await espera(200); input = acharTokenInput(['unidade_saude','unidade']); }
    if (!input || !nome) {
      rel.vazio.push('Unidade' + (input ? '' : ' (campo não encontrado)'));
      return '';
    }

    const lista = input.closest('ul.token-input-list, ul[class*="token-input"]');
    if (lista && lista.querySelector('li.token-input-token')) {
      const ja = lista.querySelector('li.token-input-token').textContent.trim();
      rel.ok.push('Unidade (já estava) → ' + ja.slice(0,50));
      return norm(ja);
    }

    const j = (typeof unsafeWindow!=='undefined' && unsafeWindow.jQuery) || window.jQuery;
    const buscas = termosBuscaUnidade(nome, cnes, nomeFicha);
    console.log('[Unidade] esperado:', nome, 'CNES:', cnes, 'buscas:', buscas);

    for (const busca of buscas) {
      input.focus();
      input.value = '';
      input.dispatchEvent(new Event('input', {bubbles:true}));
      if (j) { try { j(input).val('').trigger('keyup'); } catch(e){} }
      await espera(120);

      for (const ch of String(busca)) {
        input.value += ch;
        input.dispatchEvent(new Event('input', { bubbles:true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { bubbles:true, key: ch }));
        input.dispatchEvent(new KeyboardEvent('keyup', { bubbles:true, key: ch }));
        await espera(45);
      }
      if (j) { try { j(input).val(busca).trigger('input').trigger('keyup'); } catch(e){} }

      let melhor = null, melhorScore = 0;
      for (let i=0; i<34; i++) {
        await espera(150);
        if (j && i % 5 === 4) { try { j(input).trigger('keyup'); } catch(e){} }

        const dropdowns = Array.from(document.querySelectorAll('.token-input-dropdown'))
          .filter(d => {
            const cs = getComputedStyle(d);
            return cs.display !== 'none' && cs.visibility !== 'hidden' && d.querySelector('li');
          });
        if (!dropdowns.length) continue;

        const lis = dropdowns.flatMap(d => Array.from(d.querySelectorAll('li')))
          .filter(x => x.textContent.trim() && !/buscando|carregando|procurando|nenhum|searching|no results/i.test(x.textContent));
        if (!lis.length) continue;

        // 1) CNES exposto no item.
        if (cnes) {
          const porCnes = lis.find(x =>
            soDig(x.textContent).includes(String(cnes)) ||
            String(x.dataset?.cnes || x.getAttribute('data-cnes') || '') === String(cnes)
          );
          if (porCnes) { melhor = porCnes; melhorScore = 2; break; }
        }

        // 2) nome exato/contido.
        melhor = lis.find(x => norm(x.textContent) === norm(nome))
          || lis.find(x => norm(x.textContent).includes(norm(nome)) || norm(nome).includes(norm(x.textContent)));
        if (melhor) { melhorScore = 1.4; break; }

        // 3) semelhança por palavras importantes.
        for (const li of lis) {
          const sc = Math.max(
            scoreUnidade(nome, li.textContent, cnes),
            nomeFicha ? scoreUnidade(nomeFicha, li.textContent, cnes) : 0
          );
          if (sc > melhorScore) { melhorScore = sc; melhor = li; }
        }

        // >= 0.72 evita escolher outra unidade parecida por acidente.
        if (melhor && melhorScore >= 0.72) break;
      }

      if (melhor && melhorScore >= 0.72) {
        const escolhido = melhor.textContent.trim();
        console.log('[Unidade] busca:', busca, '→', escolhido, 'score:', melhorScore);
        // IMPORTANTE: não passe `view: window` aqui. Em Tampermonkey/Greasemonkey o
        // `window` do sandbox pode não ser aceito como Window pelo construtor nativo
        // de MouseEvent da página, causando: Failed to convert value to 'Window'.
        // Disparamos os eventos no mesmo realm do documento e só usamos jQuery como fallback.
        const W = (melhor.ownerDocument && melhor.ownerDocument.defaultView) || window;
        const ME = (W && W.MouseEvent) ? W.MouseEvent : MouseEvent;
        try {
          ['mousedown','mouseup','click'].forEach(t =>
            melhor.dispatchEvent(new ME(t, { bubbles:true, cancelable:true }))
          );
        } catch (e) {
          console.warn('[Unidade] clique DOM falhou; tentando click()/jQuery:', e);
          try { melhor.click(); } catch (_) {}
        }
        await espera(450);

        let token = lista && lista.querySelector('li.token-input-token');
        if (!token && j) {
          try { j(melhor).trigger('mousedown').trigger('mouseup').trigger('click'); } catch(e) {
            console.warn('[Unidade] fallback jQuery falhou:', e);
          }
          await espera(450);
          token = lista && lista.querySelector('li.token-input-token');
        }
        if (token) {
          const finalTxt = token.textContent.trim();
          rel.ok.push('Unidade → ' + finalTxt.slice(0,50));
          if (nomeFicha && cnes) aliasSet(nomeFicha, nome, cnes);
          return norm(finalTxt);
        }

        // Alguns temas fecham o dropdown antes do token ser redesenhado.
        // Se o clique ocorreu, dá mais uma pequena janela antes de considerar falha.
        await espera(500);
        const token2 = lista && lista.querySelector('li.token-input-token');
        if (token2) {
          const finalTxt = token2.textContent.trim();
          rel.ok.push('Unidade → ' + finalTxt.slice(0,50));
          if (nomeFicha && cnes) aliasSet(nomeFicha, nome, cnes);
          return norm(finalTxt);
        }
      }
    }

    rel.vazio.push('Unidade (não selecionada automaticamente — confira)');
    console.warn('[Unidade] não consegui selecionar:', {nome, cnes, nomeFicha, buscas});
    return '';
  }

  async function selToken(matchers, termo, label, opts) {
    opts = opts || {};
    let input = acharTokenInput(matchers);
    for (let k=0; k<15 && !input; k++){ await espera(200); input = acharTokenInput(matchers); }
    if (!input || !termo) { rel.vazio.push(label + (input ? '' : ' (campo não encontrado)')); return ''; }

    const tokenAtual = () => {
      const i = acharTokenInput(matchers) || input;
      const ul = i && i.closest('ul.token-input-list, ul[class*="token-input"]');
      return ul && ul.querySelector('li.token-input-token, li[class*="token-input-token"]');
    };
    const existente = tokenAtual();
    if (existente) { rel.ok.push(label + ' (já estava)'); return norm(existente.textContent); }

    const j = (typeof unsafeWindow!=='undefined' && unsafeWindow.jQuery) || window.jQuery;
    const alvo = norm(termo);
    const codigo = soDig(opts.code || '');
    const tentativas = [];
    const add = x => {
      x = String(x || '').trim();
      if (x && !tentativas.some(y => norm(y) === norm(x))) tentativas.push(x);
    };
    if (Array.isArray(opts.searches)) opts.searches.forEach(add);
    add(opts.search); add(opts.search2); add(termo);

    for (const digitar of tentativas) {
      input = acharTokenInput(matchers) || input;
      if (!input) break;
      input.focus();
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles:true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { bubbles:true, key:'Backspace' }));
      if (j) { try { j(input).val('').trigger('input').trigger('keyup'); } catch(e){} }
      await espera(120);

      // Digita como usuário para o tokenInput realmente consultar o servidor.
      for (const ch of String(digitar)) {
        input.value += ch;
        input.dispatchEvent(new Event('input', { bubbles:true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { bubbles:true, key:ch }));
        input.dispatchEvent(new KeyboardEvent('keyup', { bubbles:true, key:ch }));
        await espera(55);
      }
      if (j) { try { j(input).val(digitar).trigger('input').trigger('keyup'); } catch(e){} }

      let li = null;
      for (let i=0; i<32 && !li; i++) {
        await espera(160);
        if (j && i % 6 === 5) { try { j(input).trigger('keyup'); } catch(e){} }
        const dropdowns = Array.from(document.querySelectorAll('.token-input-dropdown'))
          .filter(d => { const cs=getComputedStyle(d); return cs.display!=='none' && cs.visibility!=='hidden' && d.querySelector('li'); });
        if (!dropdowns.length) continue;
        const lis = dropdowns.flatMap(dd => Array.from(dd.querySelectorAll('li')))
          .filter(x => x.textContent.trim() && !/buscando|carregando|procurando|nenhum|searching|no results/i.test(x.textContent));
        if (!lis.length) continue;

        // Para CBO normalizado, o código 4110-10/411010 ganha prioridade absoluta.
        if (codigo) li = lis.find(x => soDig(x.textContent).includes(codigo));
        if (!li) li = lis.find(x => norm(x.textContent) === alvo);
        if (!li) {
          let best=null, bs=0;
          for (const x of lis) { const sc=overlapCbo(alvo, x.textContent); if(sc>bs){bs=sc;best=x;} }
          if (best && bs >= 0.6) li=best;
          else if (!opts.strict) li=lis.find(x=>norm(x.textContent).includes(alvo)||alvo.includes(norm(x.textContent)))||lis[0];
        }
      }

      if (li) {
        try {
          li.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));
          li.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true}));
          li.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
        } catch(e) { try { li.click(); } catch(_){} }
        await espera(450);

        let tok = tokenAtual();
        if (!tok && j) {
          // Fallback específico para tokenInput antigo: mousedown jQuery seleciona o item.
          try { j(li).trigger('mousedown'); } catch(e){}
          await espera(350);
          tok = tokenAtual();
        }
        if (tok) {
          const txt = tok.textContent.trim();
          const tokDigitos = soDig(txt);
          const codeOk = !codigo || !tokDigitos || tokDigitos.includes(codigo);
          const nomeOk = overlapCbo(alvo, txt) >= 0.6 || norm(txt).includes(alvo);
          if (codeOk && nomeOk) {
            rel.ok.push(label + ' → ' + txt.slice(0,55));
            return norm(txt);
          }
          // Se selecionou item errado, remove o token e tenta de novo.
          const del = tok.querySelector('.token-input-delete-token, [class*="delete-token"]');
          if (del) { try { del.click(); } catch(_){} await espera(180); }
        }
      }
    }
    rel.vazio.push(label + (opts.strict ? ' (sem correspondência — confira manualmente)' : ' (lista não abriu)'));
    console.warn('[Token] falha ao selecionar', {label, termo, codigo, tentativas});
    return '';
  }

  /* ---------- CNES ---------- */
  function buscarCNS(cpf) {
    const base = 'https://cnes.datasus.gov.br';
    const url = CONFIG.cnesUrl.replace('{cpf}', encodeURIComponent(soDig(cpf)));
    return new Promise((res, rej) => GM_xmlhttpRequest({
      method:'GET', url, timeout:20000,
      headers:{ 'Accept':'application/json, text/plain, */*', 'Referer':base+'/', 'Origin':base, 'X-Requested-With':'XMLHttpRequest' },
      onload:r=>{
        if (r.status < 200 || r.status >= 300) { res(null); return; }   // 4xx/5xx -> sem CNS
        let cns = null;
        try {
          const lista = JSON.parse(r.responseText);
          if (Array.isArray(lista) && lista.length) cns = soDig(lista[0].cns || '');
          if (!cns) cns = achaCns(lista);
        } catch (e) { const x=(r.responseText||'').match(/\b(\d{15})\b/); cns = x?x[1]:null; }
        res(cns && cns.length === 15 ? cns : null);
      },
      onerror:rej, ontimeout:rej }));
  }
  function achaCns(o){ let r=null; (function w(o){ if(r||o==null)return;
    if(Array.isArray(o))return o.forEach(w);
    if(typeof o==='object')for(const k of Object.keys(o)){
      if(/cns|cartao|codigo.?nacional/i.test(k)&&/^\d{15}$/.test(String(o[k]).replace(/\D/g,''))){r=String(o[k]).replace(/\D/g,'');return;}
      w(o[k]); } })(o); return r; }

  // GET JSON no CNES (mesmos headers do auditor)
  function gmJson(url){
    const base='https://cnes.datasus.gov.br';
    return new Promise((res,rej)=>GM_xmlhttpRequest({ method:'GET', url, timeout:20000,
      headers:{ 'Accept':'application/json, text/plain, */*', 'Referer':base+'/', 'Origin':base, 'X-Requested-With':'XMLHttpRequest' },
      onload:r=>{ if(r.status<200||r.status>=300){res(null);return;} try{res(JSON.parse(r.responseText));}catch(e){res(null);} },
      onerror:rej, ontimeout:rej }));
  }
  // Perfil + vínculos ativos do profissional pelo CPF.
  async function buscarCnesPerfil(cpf){
    const base='https://cnes.datasus.gov.br';
    const lista = await gmJson(base+'/services/profissionais?cpf='+encodeURIComponent(soDig(cpf)));
    if (!Array.isArray(lista) || !lista.length || !lista[0].id) return null;
    const hash = lista[0].id;
    let det=null; try { det = await gmJson(base+'/services/profissionais/'+encodeURIComponent(hash)); } catch(e){}
    const vins = (det && Array.isArray(det.vinculos)) ? det.vinculos : [];
    const vinculos = vins.map(v => ({
      cnes: String(v.cnes||v.coUnidade||''), unidade: v.noFant||v.noFantasia||v.nome||'',
      cboDesc: v.dsCbo||v.dsAtivProf||v.cbo||'', cboCod: soDig(v.coCbo||v.cbo||'')
    }));
    const cns = soDig((lista[0].cns)||(det&&det.cns)||'');
    return { cns: cns.length===15?cns:'', nome:(det&&det.nome)||lista[0].nome||'', vinculos };
  }
  // dobra gênero/plural pra comparar CBO (farmaceutica = farmaceutico, cirurgião = cirurgiã, etc.)
  function foldCbo(s){
    return norm(s).replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim()
      .split(' ').filter(w=>w.length>=3 && !/^\d+$/.test(w))   // ignora código numérico (ex.: 225125)
      .map(w=>w.replace(/s$/,'').replace(/(ao|a|o)$/,''))
      .join(' ');
  }
  function overlapCbo(a,b){
    const sa=new Set(foldCbo(a).split(' ').filter(Boolean));
    const sb=new Set(foldCbo(b).split(' ').filter(Boolean));
    if(!sa.size||!sb.size) return 0;
    let inter=0; sa.forEach(w=>sb.has(w)&&inter++);
    return inter/Math.min(sa.size,sb.size);
  }
  // radical da palavra mais distintiva (sem terminação de gênero) para a BUSCA
  function termoBusca(s){
    const ws = norm(s).replace(/[^a-z0-9 ]/g,' ').trim().split(' ').filter(w=>w.length>=3);
    if(!ws.length) return norm(s);
    const longa = ws.sort((a,b)=>b.length-a.length)[0];
    return longa.replace(/[aeiou]+$/,'') || longa;
  }
  function cboBate(a,b){ return overlapCbo(a,b) >= 0.6; }
  // Compara a ficha com o CNES e dispara o alerta no painel.
  // REGRA DO NOME: o CNES serve apenas para CONFERÊNCIA. Se o nome divergir,
  // o script mantém o nome que veio da ficha e avisa para NÃO substituir pelo CNES.
  function compararCnes(d, perfil, cod, unidadeNome){
    cod = cod || UnidadeCnes.porNome(d.unidade);
    unidadeNome = unidadeNome || d.unidade;
    const vins = perfil.vinculos || [];
    const listaTxt = vins.length ? vins.map(v=>`${v.unidade||v.cnes}: ${v.cboDesc}`).join('  •  ') : 'sem vínculos ativos no CNES';
    const naUnidade = cod ? vins.filter(v => String(v.cnes) === String(cod)) : [];

    // Compara ignorando apenas acentos, caixa e espaços extras. Qualquer outra
    // diferença é tratada como divergência real e NÃO altera o campo Nome.
    const nomeFicha = String(d.nome || '').trim();
    const nomeCnes = String(perfil.nome || '').trim();
    const nomeDivergente = !!(nomeFicha && nomeCnes && norm(nomeFicha) !== norm(nomeCnes));
    const avisoNome = nomeDivergente
      ? `⚠ NOME DIFERENTE NO CNES!\nFicha: ${nomeFicha}\nCNES: ${nomeCnes}\n\nMANTENHA O NOME EXATAMENTE COMO ESTÁ NA FICHA. Não troque pelo nome do CNES. Confira antes de salvar.`
      : '';

    if (nomeDivergente) {
      rel.vazio.push('Nome divergente no CNES — manter exatamente como está na ficha');
      console.warn('[CNES] Nome divergente. Ficha:', nomeFicha, '| CNES:', nomeCnes);
    }

    let tipo = 'info';
    let msg = '';
    if (naUnidade.length){
      const bate = naUnidade.some(v => cboBate(d.funcaoCBO, v.cboDesc));
      if (bate) {
        tipo = 'ok';
        msg = `OK — já consta no CNES em ${unidadeNome} com a mesma ocupação (${d.funcaoCBO}).`;
      } else {
        tipo = 'erro';
        msg = `⚠ CBO DIFERENTE em ${unidadeNome}!\nFicha: ${d.funcaoCBO}\nCNES: ${naUnidade.map(v=>v.cboDesc).join(' / ')}\nConfira antes de salvar.`;
      }
    } else if (!cod){
      tipo = 'warn';
      msg = `Não consegui casar a unidade "${unidadeNome}" com um código CNES.\nVínculos no CNES: ${listaTxt}`;
    } else {
      tipo = 'info';
      msg = `Sem vínculo em ${unidadeNome} no CNES ainda (cadastro novo).\nNo CNES o profissional está em: ${listaTxt}`;
    }

    // Divergência de nome é sempre prioridade visual e fica no mesmo cartão
    // junto com o resultado de CBO/unidade, para o aviso não ser sobrescrito.
    if (avisoNome) {
      msg = avisoNome + (msg ? '\n\n' + msg : '');
      if (tipo !== 'erro') tipo = 'warn';
    }
    alerta(tipo, msg);
  }

  /* ---------- mapeamentos ---------- */
  // Corrige nomes de ocupação da ficha conforme a regra operacional da OM30/Guarujá.
  // A ficha continua preservada no relatório; somente a ocupação usada no cadastro é normalizada.
  function normalizarOcupacaoFicha(funcao){
    const original = String(funcao || '').trim();
    const n = norm(original);

    if (/^atendente\s+administrativ[oa]$/.test(n) || /^estagiari[oa]$/.test(n)) {
      return {
        original,
        busca: 'Assistente Administrativo',
        codigo: '4110-10',
        corrigido: true,
        necessitaConfirmacao: false,
        aviso: 'Ajuste automático de CBO aplicado após a leitura da ficha:\n' +
               '“' + original + '” → ASSISTENTE ADMINISTRATIVO — CBO 4110-10.\n' +
               'Confira os dados antes de salvar.'
      };
    }

    // Quando a ficha já traz o CBO numérico (ex.: 225125), o código é a chave exata
    // de pesquisa no autocomplete. Não tentamos adivinhar a descrição.
    const codigoNumerico = soDig(original);
    if (/^\d{6}$/.test(codigoNumerico) && codigoNumerico === original.replace(/\D/g,'')) {
      return { original, busca: codigoNumerico, codigo: codigoNumerico, corrigido: false, necessitaConfirmacao: false, aviso: '' };
    }

    return { original, busca: original, codigo: '', corrigido: false, necessitaConfirmacao: false, aviso: '' };
  }

  function mapOrgaoClasse(funcao){ const s=norm(funcao); if(!s) return '';
    const t=[[/odonto|dentista/,'CRO'],[/enfermeir/,'COREN'],[/farmac/,'CRF'],
      [/fisioterap|terap.*ocup/,'CREFITO'],[/psicolog/,'CRP'],[/nutri/,'CRN'],
      [/fonoaud|fono/,'CRFO'],[/biomedic/,'CRBM'],[/biolog/,'CRBIO'],
      [/veterinar/,'CRMV'],[/assist.*social|servico social/,'CRESS'],
      [/educa.*fisic/,'CREF'],[/contab/,'CRC'],[/\badministrador[ao]?\b/,'CRA'],[/quimic/,'CRQ'],
      [/radiolog/,'CRTR'],[/advog/,'OAB'],[/medic|médic/,'CRM']];
    for(const [re,sig] of t) if(re.test(s)) return sig; return ''; }
  function mapEscolaridade(s){ s=norm(s);
    const inc = /incompleto|cursando|em curso|nao concluid/.test(s);
    if(/doutor/.test(s)) return 'Doutorado';
    if(/mestr/.test(s)) return 'Mestrado';
    if(/especializ|residencia|pos.?gradua/.test(s)) return 'Especialização/Residência';
    if(/superior|3.?\s*grau|graduac|graduad|ensino superior/.test(s)) return inc ? 'Superior incompleto (3° grau incompleto)' : 'Superior completo (3° grau completo)';
    if(/medio|2.?\s*grau/.test(s)) return inc ? 'Médio incompleto (2° grau incompleto)' : 'Médio completo (2° grau completo)';
    if(/fundamental|1.?\s*grau/.test(s)) return inc ? 'Fundamental incompleto (1° grau incompleto)' : 'Fundamental completo (1° grau completo)';
    if(/alfabetizad/.test(s)) return 'Alfabetizado';
    if(/nao.*(ler|escrever|alfabetiz)|analfabet/.test(s)) return 'Não saber ler/escrever';
    return ''; }
  function estado(uf){ const sigla=String(uf||'').toUpperCase().trim(); return UFS_BRASIL[sigla] || uf; }

  /* ---------- helpers ---------- */
  function elx(id){ return document.getElementById(id); }
  function val(id){ const e=elx(id); return e?e.value:''; }
  function soDig(s){ return (s||'').replace(/\D/g,''); }
  function norm(s){ return (s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim(); }
  function jq(e,fn){ try{ const j=(typeof unsafeWindow!=='undefined'&&unsafeWindow.jQuery)||window.jQuery; if(j)fn(j(e)); }catch(x){} }
  function espera(ms){ return new Promise(r=>setTimeout(r,ms)); }
  function setT(id,v,nome){ const e=elx(id); if(!e){ if(nome)rel.vazio.push(nome+' (sem campo)'); return; }
    if(v==null||v===''){ if(nome)rel.vazio.push(nome); return; }
    e.focus(); e.value=v; ['input','keyup','change'].forEach(ev=>e.dispatchEvent(new Event(ev,{bubbles:true})));
    jq(e,j=>j.trigger('input').trigger('change')); if(nome)rel.ok.push(nome); }
  function setDataSemCalendario(id,v,nome){
    const e=elx(id);
    if(!e){ if(nome)rel.vazio.push(nome+' (sem campo)'); return; }
    if(v==null||v===''){ if(nome)rel.vazio.push(nome); return; }

    // Não chama focus(): era isso que abria o calendário e o deixava pendurado na tela.
    e.value=v;
    e.dispatchEvent(new Event('input',{bubbles:true}));
    e.dispatchEvent(new Event('change',{bubbles:true}));
    jq(e,j=>{
      try { j.val(v).trigger('input').trigger('change'); } catch(_){}
      try { if (typeof j.datepicker === 'function') j.datepicker('hide'); } catch(_){}
      try { if (typeof j.datetimepicker === 'function') j.datetimepicker('hide'); } catch(_){}
    });
    try { if (e._flatpickr && typeof e._flatpickr.close === 'function') e._flatpickr.close(); } catch(_){}
    try { e.blur(); } catch(_){}
    // Escape também fecha datepickers antigos sem clicar em outro campo.
    try { e.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Escape',code:'Escape'})); } catch(_){}
    if(nome)rel.ok.push(nome);
  }
  function blur(id){ const e=elx(id); if(!e)return; e.dispatchEvent(new Event('blur',{bubbles:true})); jq(e,j=>j.trigger('blur')); }
  function chk(id){ const e=elx(id); if(!e)return; e.checked=true;
    e.dispatchEvent(new Event('click',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); jq(e,j=>j.trigger('change')); }
  function setSel(id,texto){ const e=elx(id); if(!e||!texto)return; const a=norm(texto);
    const fold=s=>norm(s).split(' ').map(w=>w.replace(/[oa]$/,'')).join(' '); const fa=fold(texto);
    const o=Array.from(e.options).find(o=>norm(o.text)===a)
      || Array.from(e.options).find(o=>fold(o.text)===fa)              // dobra gênero: pardo=parda, brasileiro=brasileira
      || Array.from(e.options).find(o=>a.length>=5 && norm(o.text).includes(a));
    if(o){ e.value=o.value; e.dispatchEvent(new Event('change',{bubbles:true})); jq(e,j=>j.trigger('change')); rel.ok.push('('+texto+')'); }
    else rel.vazio.push('Select '+id.replace('profissional_','').replace('_id','')+' ('+texto+')'); }
  function limparSelectSePossivel(id){
    const e = elx(id);
    if (!e) return false;
    let vazio = Array.from(e.options || []).find(o => !String(o.value || '').trim() || /selecione|escolha|--/.test(norm(o.text)));
    if (!vazio) {
      vazio = document.createElement('option');
      vazio.value = '';
      vazio.textContent = '';
      vazio.setAttribute('data-om30-empty','1');
      e.insertBefore(vazio, e.firstChild || null);
    }
    Array.from(e.options || []).forEach(o => { o.selected = false; });
    vazio.selected = true;
    e.value = '';
    return true;
  }

  // Campo vazio na ficha precisa ficar realmente vazio, mesmo quando o Saúde Simples
  // usa o primeiro estado (Acre) como fallback visual. Se não houver option vazia,
  // criamos uma option vazia local para que nenhum estado seja enviado por engano.
  async function limparSelectConfirmado(id, label){
    for (let tentativa=0; tentativa<5; tentativa++) {
      let e = elx(id);
      if (!e) { await espera(120); continue; }
      limparSelectSePossivel(id);
      e = elx(id);
      if (!e) continue;
      e.dispatchEvent(new Event('input',{bubbles:true}));
      e.dispatchEvent(new Event('change',{bubbles:true}));
      jq(e,j=>{ try { j.val('').trigger('input').trigger('change'); } catch(_){} });
      await espera(220);
      e = elx(id);
      if (!e) continue;
      const valor = String(e.value || '').trim();
      if (!valor) {
        // confirmação adicional sem foco: não deixa o navegador escolher o primeiro item.
        await espera(350);
        const e2 = elx(id);
        if (e2 && !String(e2.value || '').trim()) return true;
      }
    }
    // Último reforço visual/DOM, sem disparar novo change para não provocar fallback.
    limparSelectSePossivel(id);
    console.warn('[Ficha] campo deveria ficar vazio:', label || id);
    return !String((elx(id) && elx(id).value) || '').trim();
  }

  async function setSelConfirmado(id, texto, label){
    if (!texto) { if (label) rel.vazio.push(label + ' (sem valor)'); return false; }

    // O Saúde Simples pode SUBSTITUIR o elemento inteiro. Portanto nunca guardamos
    // uma referência única: em toda tentativa buscamos novamente pelo ID.
    for (let tentativa=0; tentativa<6; tentativa++) {
      let e = elx(id);
      if (!e) { await espera(180); continue; }

      let alvo = Array.from(e.options || []).find(o => norm(o.text) === norm(texto));
      if (!alvo) { await espera(180); continue; }
      const valorAlvo = alvo.value;

      e.value = valorAlvo;
      e.dispatchEvent(new Event('input',{bubbles:true}));
      e.dispatchEvent(new Event('change',{bubbles:true}));
      jq(e,j=>j.val(valorAlvo).trigger('input').trigger('change'));
      await espera(320);

      // Rebusca o elemento; se foi reconstruído, esta é a referência válida.
      e = elx(id);
      if (!e) { await espera(180); continue; }
      let selecionado = e.options && e.selectedIndex >= 0 ? e.options[e.selectedIndex].text : '';
      if (norm(selecionado) !== norm(texto)) { await espera(220); continue; }

      // Confirma que permaneceu correto por mais de meio segundo.
      await espera(650);
      const e2 = elx(id);
      selecionado = e2 && e2.options && e2.selectedIndex >= 0 ? e2.options[e2.selectedIndex].text : '';
      if (e2 && norm(selecionado) === norm(texto)) {
        rel.ok.push((label || id) + ': ' + texto);
        return true;
      }
    }

    const atual = elx(id);
    const atualTxt = atual && atual.options && atual.selectedIndex >= 0 ? atual.options[atual.selectedIndex].text : '—';
    rel.vazio.push((label || id) + ' (esperado ' + texto + '; ficou ' + atualTxt + ')');
    console.warn('[UF] não permaneceu selecionada', {id, esperado:texto, atual:atualTxt});
    return false;
  }

  async function aplicarUfsPessoaisFicha(d){
    if (d.ufNasc) await setSelConfirmado('profissional_nascimento_estado_id', estado(d.ufNasc), 'UF nascimento');
    else await limparSelectConfirmado('profissional_nascimento_estado_id', 'UF nascimento');

    if (d.ufRg) await setSelConfirmado('profissional_identidade_estado_id', estado(d.ufRg), 'UF RG');
    else await limparSelectConfirmado('profissional_identidade_estado_id', 'UF RG');
  }

  async function aplicarUfConselhoFicha(d){
    if (d.ufConselho) await setSelConfirmado('profissional_orgao_classe_estado_id', estado(d.ufConselho), 'UF conselho');
    else await limparSelectConfirmado('profissional_orgao_classe_estado_id', 'UF conselho');
  }

  async function setSelPrefixoConfirmado(id, sigla, label){
    if (!sigla) return false;
    const alvoNorm = norm(sigla);

    // O campo também pode ser reconstruído pelo JavaScript do Saúde Simples.
    // Por isso rebuscamos o elemento em toda tentativa e confirmamos depois.
    for (let tentativa=0; tentativa<6; tentativa++) {
      let e = elx(id);
      if (!e) { await espera(160); continue; }

      const o = Array.from(e.options || []).find(o => {
        const tx = norm(o.text);
        return tx === alvoNorm || tx.startsWith(alvoNorm + ' ') || tx.startsWith(alvoNorm + ' -');
      });
      if (!o) { await espera(180); continue; }

      const valor = o.value;
      e.value = valor;
      e.dispatchEvent(new Event('input',{bubbles:true}));
      e.dispatchEvent(new Event('change',{bubbles:true}));
      jq(e,j=>{ try { j.val(valor).trigger('input').trigger('change'); } catch(_){} });
      await espera(320);

      e = elx(id);
      if (!e) continue;
      const txt = e.options && e.selectedIndex >= 0 ? norm(e.options[e.selectedIndex].text) : '';
      if (!(txt === alvoNorm || txt.startsWith(alvoNorm + ' ') || txt.startsWith(alvoNorm + ' -'))) continue;

      await espera(500);
      const e2 = elx(id);
      const txt2 = e2 && e2.options && e2.selectedIndex >= 0 ? norm(e2.options[e2.selectedIndex].text) : '';
      if (txt2 === alvoNorm || txt2.startsWith(alvoNorm + ' ') || txt2.startsWith(alvoNorm + ' -')) {
        rel.ok.push(label || sigla);
        return true;
      }
    }

    rel.vazio.push((label || sigla) + ' (não permaneceu selecionado)');
    return false;
  }

  function setSelPrefixo(id,sigla,label){ const e=elx(id); if(!e||!sigla)return; const a=norm(sigla)+' ';
    const o=Array.from(e.options).find(o=>norm(o.text).startsWith(a))||Array.from(e.options).find(o=>norm(o.text)===norm(sigla));
    if(o){ e.value=o.value; e.dispatchEvent(new Event('change',{bubbles:true})); jq(e,j=>j.trigger('change')); rel.ok.push(label||sigla); }
    else rel.vazio.push((label||sigla)+' (opção não achada)'); }

  /* ---------- painel · identidade OM30 ---------- */
  const OM30_LOGO = 'data:image/png;base64,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';

  const ST = document.createElement('style');
  ST.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700;800&display=swap');

    #ps-fab{position:fixed;bottom:22px;right:22px;z-index:99999;height:52px;display:flex;align-items:center;gap:10px;
      padding:0 17px 0 9px;border:1px solid rgba(255,255,255,.10);border-radius:15px;cursor:pointer;
      background:linear-gradient(135deg,#1C242D 0%,#111820 100%);color:#fff;
      font:700 13px/1 'Outfit','Segoe UI',Arial,sans-serif;letter-spacing:.01em;
      box-shadow:0 14px 36px rgba(0,0,0,.32);transition:transform .15s ease,box-shadow .15s ease}
    #ps-fab:hover{transform:translateY(-2px);box-shadow:0 18px 44px rgba(0,0,0,.40)}
    #ps-fab .fab-logo{width:34px;height:34px;border-radius:10px;background:#E70036;display:grid;place-items:center;flex:0 0 auto}
    #ps-fab .fab-logo img{display:block;width:21px;height:25px;object-fit:contain}
    #ps-fab .fab-txt{display:flex;flex-direction:column;align-items:flex-start;gap:2px}
    #ps-fab .fab-txt small{font-size:8px;line-height:1;text-transform:uppercase;letter-spacing:.16em;color:#fda4b8;font-weight:700}
    #ps-fab .fab-txt b{font-size:12.5px;line-height:1.1;color:#fff;font-weight:700}

    #ps-panel{position:fixed;bottom:22px;right:22px;z-index:99999;width:390px;max-width:calc(100vw - 28px);
      max-height:88vh;display:flex;flex-direction:column;background:#f5f7fa;border-radius:20px;overflow:hidden;
      font:12.5px/1.45 'Outfit','Segoe UI',Arial,sans-serif;color:#1C242D;
      box-shadow:0 24px 70px rgba(0,0,0,.36);border:1px solid rgba(28,36,45,.14);
      opacity:0;transform:translateY(10px) scale(.985);pointer-events:none;
      transition:opacity .16s ease,transform .16s ease}
    #ps-panel.open{opacity:1;transform:none;pointer-events:auto}
    #ps-panel *{box-sizing:border-box}

    #ps-panel .hd{flex:0 0 auto;min-height:82px;padding:14px 50px 13px 16px;position:relative;
      display:flex;align-items:center;background:linear-gradient(135deg,#1C242D 0%,#111820 100%);color:#fff}
    #ps-panel .brand{display:flex;align-items:center;gap:12px;min-width:0}
    #ps-panel .brand-logo{width:38px;height:44px;object-fit:contain;flex:0 0 auto}
    #ps-panel .brand-copy{min-width:0}
    #ps-panel .brand-kicker{display:block;margin-bottom:3px;color:#fb8ba5;font-size:9px;font-weight:800;line-height:1;
      text-transform:uppercase;letter-spacing:.13em}
    #ps-panel .hd b{display:block;font-size:17px;line-height:1.08;font-weight:700;letter-spacing:-.015em;color:#fff}
    #ps-panel .hd small{display:block;margin-top:4px;color:#aeb8c4;font-size:10.5px;font-weight:500;white-space:nowrap}
    #ps-panel .x{position:absolute;right:13px;top:23px;width:33px;height:33px;border:1px solid rgba(255,255,255,.08);
      border-radius:10px;background:rgba(255,255,255,.06);color:#aeb8c4;cursor:pointer;font:500 20px/1 Arial;
      display:flex;align-items:center;justify-content:center;transition:background .15s,color .15s}
    #ps-panel .x:hover{background:rgba(255,255,255,.12);color:#fff}
    #ps-panel .brand-line{height:4px;background:linear-gradient(90deg,#E70036 0%,#E70036 68%,#620020 100%);flex:0 0 auto}

    #ps-panel .bd{flex:1 1 auto;overflow-y:auto;overflow-x:hidden;padding:16px}
    #ps-panel .intro{margin:0 1px 12px}
    #ps-panel .intro b{display:block;color:#1C242D;font-size:13px;font-weight:700;margin-bottom:2px}
    #ps-panel .intro span{display:block;color:#697586;font-size:11px;font-weight:500}

    #ps-file{position:relative;display:flex;width:100%;min-height:112px;align-items:center;gap:13px;padding:17px 15px;
      border:1.5px dashed #b9c1cb;border-radius:14px;background:#fff;cursor:pointer;text-align:left;overflow:hidden;
      box-shadow:0 5px 16px rgba(28,36,45,.045);transition:border-color .16s,background .16s,transform .16s,box-shadow .16s}
    #ps-file::after{content:'';position:absolute;left:0;top:0;bottom:0;width:4px;background:#E70036;opacity:0;transition:opacity .16s}
    #ps-file:hover{border-color:#E70036;background:#fffafb;box-shadow:0 8px 22px rgba(98,0,32,.09);transform:translateY(-1px)}
    #ps-file:hover::after,#ps-file.drag::after,#ps-file.has-file::after{opacity:1}
    #ps-file.drag{border-color:#E70036;border-style:solid;background:#fff3f6;box-shadow:0 0 0 4px rgba(231,0,54,.08)}
    #ps-file.has-file{border-style:solid;border-color:#d5dae1;background:#fff}
    #ps-file .upload-ico{width:48px;height:48px;border-radius:13px;display:grid;place-items:center;flex:0 0 auto;
      background:#f1f3f6;color:#1C242D;transition:background .16s,color .16s}
    #ps-file:hover .upload-ico,#ps-file.drag .upload-ico{background:#E70036;color:#fff}
    #ps-file.has-file .upload-ico{background:#1C242D;color:#fff}
    #ps-file .upload-ico svg{width:24px;height:24px}
    #ps-file .upload-copy{min-width:0;flex:1}
    #ps-file .upload-copy strong{display:block;color:#1C242D;font-size:13px;font-weight:700;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #ps-file .upload-copy span{display:block;margin-top:4px;color:#778292;font-size:10.5px;font-weight:500;line-height:1.35}
    #ps-file .pdf-tag{flex:0 0 auto;padding:5px 7px;border-radius:7px;background:#f5dce3;color:#620020;
      font-size:8.5px;font-weight:800;letter-spacing:.08em}
    #ps-file.drag .upload-copy strong{color:#620020}

    #ps-file-ok{display:none;align-items:center;gap:7px;margin:8px 2px 0;color:#566171;font-size:10.5px;font-weight:600}
    #ps-file-ok.show{display:flex}
    #ps-file-ok .ok-dot{width:17px;height:17px;border-radius:999px;background:#1C242D;color:#fff;display:grid;place-items:center;font-size:10px;line-height:1}


    #ps-panel .acts{display:grid;grid-template-columns:.82fr 1.18fr;gap:9px;margin-top:14px}
    #ps-panel .acts button{height:43px;border-radius:11px;cursor:pointer;font:700 11.5px/1 'Outfit','Segoe UI',Arial,sans-serif;
      transition:transform .12s,filter .15s,background .15s,border-color .15s;letter-spacing:.005em}
    #ps-panel .acts button:active{transform:translateY(1px)}
    #ps-test{border:1px solid #c7cdd5;background:#fff;color:#1C242D}
    #ps-test:hover{background:#f1f3f6;border-color:#9da6b2}
    #ps-go{border:0;background:linear-gradient(135deg,#E70036 0%,#c9002f 100%);color:#fff;box-shadow:0 8px 20px rgba(231,0,54,.20)}
    #ps-go:hover{filter:brightness(1.05)}

    #ps_status{position:relative;margin-top:12px;font-size:11.5px;color:#29323d;font-weight:600;line-height:1.45;
      background:#fff;border:1px solid #dce1e7;border-radius:11px;padding:10px 11px 10px 34px;display:none;box-shadow:0 3px 10px rgba(28,36,45,.035)}
    #ps_status::before{content:'•';position:absolute;left:13px;top:9px;color:#E70036;font-size:22px;line-height:12px}
    #ps_status.show{display:block}

    #ps_alert{margin-top:10px;font-size:11px;white-space:pre-wrap;border-radius:11px;padding:10px 11px;display:none;border:1px solid;max-height:160px;overflow:auto;font-weight:600}
    #ps_alert.show{display:block}
    #ps_alert.ok{background:#edf8f1;border-color:#b6dfc2;color:#235b34}
    #ps_alert.info{background:#eef4fb;border-color:#bfd2ea;color:#294c73}
    #ps_alert.warn{background:#fff8e7;border-color:#eed99a;color:#75570f}
    #ps_alert.erro{background:#fff0f2;border-color:#efb4bf;color:#8c1830;font-weight:700}

    #ps_ask{display:none;margin-top:10px;padding:12px;border:1px solid #e3cad1;background:#fff8fa;border-radius:12px}
    #ps_ask.show{display:block}
    #ps_ask_lbl{font-size:11.5px;color:#620020;margin-bottom:8px;font-weight:700}
    #ps_ask_sel{width:100%;height:38px;padding:0 9px;border:1px solid #cbd2da;border-radius:9px;font:500 11px 'Outfit','Segoe UI',Arial;background:#fff;color:#1C242D;outline:none}
    #ps_ask_sel:focus{border-color:#E70036;box-shadow:0 0 0 3px rgba(231,0,54,.08)}
    #ps_ask .askbtns{display:flex;gap:8px;margin-top:9px}
    #ps_ask .askbtns button{flex:1;height:36px;border-radius:9px;cursor:pointer;font:700 10.5px/1 'Outfit','Segoe UI',Arial;border:0}
    #ps_ask_ok{background:#E70036;color:#fff}
    #ps_ask_skip{background:#e8ebef;color:#404a57}

    #ps_more{margin-top:12px;border-top:1px solid #e0e4e9;padding-top:8px}
    #ps_more>summary{cursor:pointer;font-size:10.5px;font-weight:600;color:#697586;list-style:none;user-select:none;padding:5px 1px}
    #ps_more>summary::-webkit-details-marker{display:none}
    #ps_more>summary::before{content:'▸ ';color:#E70036}
    #ps_more[open]>summary::before{content:'▾ '}
    #ps_det{font-size:10.5px;color:#566171;margin:7px 1px;line-height:1.55;background:#fff;border:1px solid #e0e4e9;border-radius:10px;padding:9px}
    #ps_det .v{color:#9a5a00}
    #ps_dbg{width:100%;height:108px;resize:vertical;border:1px solid #26303a;border-radius:10px;padding:9px;
      font:10.5px/1.45 Consolas,'Courier New',monospace;background:#1C242D;color:#d8dee6;outline:none}
    #ps_dbg::placeholder{color:#7f8b99}
  `;
  document.head.appendChild(ST);

  const fab = document.createElement('button');
  fab.id = 'ps-fab';
  fab.innerHTML = '<span class="fab-logo"><img src="'+OM30_LOGO+'" alt="OM30"></span>'+
    '<span class="fab-txt"><small>OM30</small><b>Preencher ficha</b></span>';
  document.body.appendChild(fab);

  const pnl = document.createElement('div');
  pnl.id = 'ps-panel';
  pnl.innerHTML =
    '<div class="hd">'+
      '<div class="brand"><img class="brand-logo" src="'+OM30_LOGO+'" alt="OM30">'+
        '<div class="brand-copy"><span class="brand-kicker">OM30 · Saúde Simples</span>'+
        '<b>Preencher Profissional</b><small>Ficha PDF · CNES · v4.23</small></div></div>'+
      '<button class="x" id="ps-close" title="Fechar">×</button>'+
    '</div>'+
    '<div class="brand-line"></div>'+
    '<div class="bd">'+
      '<div class="intro"><b>Ficha de cadastro</b><span>Envie a ficha preenchida para ler e completar o cadastro automaticamente.</span></div>'+
      '<input type="file" id="ps_pdf" accept="application/pdf" style="display:none"/>'+
      '<label for="ps_pdf" id="ps-file">'+
        '<span class="upload-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="m9 15 3-3 3 3"/></svg></span>'+
        '<span class="upload-copy"><strong id="ps-file-title">Arraste a ficha aqui</strong><span id="ps-file-sub">ou clique para escolher o PDF</span></span>'+
        '<span class="pdf-tag">PDF</span>'+
      '</label>'+
      '<div id="ps-file-ok"><span class="ok-dot">✓</span><span id="ps-file-ok-txt">Ficha pronta para leitura</span></div>'+
      '<div class="acts"><button id="ps_test">Conferir ficha</button>'+
      '<button id="ps_go">Ler e preencher</button></div>'+
      '<div id="ps_status"></div>'+
      '<div id="ps_alert"></div>'+
      '<div id="ps_ask">'+
        '<div id="ps_ask_lbl"></div>'+
        '<select id="ps_ask_sel"></select>'+
        '<div class="askbtns"><button id="ps_ask_ok">Confirmar e lembrar</button>'+
        '<button id="ps_ask_skip">Pular</button></div>'+
      '</div>'+
      '<details id="ps_more"><summary>Dados lidos e detalhes técnicos</summary>'+
        '<div id="ps_det"></div>'+
        '<textarea id="ps_dbg" placeholder="Os campos lidos da ficha aparecem aqui"></textarea>'+
      '</details>'+
    '</div>';
  document.body.appendChild(pnl);

  function abrir(v){ pnl.classList.toggle('open', v); fab.style.display = v ? 'none' : 'flex'; }
  fab.addEventListener('click', () => abrir(true));
  elx('ps-close').addEventListener('click', () => abrir(false));
  abrir(false); // começa FECHADO — abre só quando você clicar

  let arquivoPdf = null;
  function tamanhoArquivo(bytes){
    if (!Number.isFinite(bytes)) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024*1024) return (bytes/1024).toFixed(bytes < 10240 ? 1 : 0) + ' KB';
    return (bytes/(1024*1024)).toFixed(1) + ' MB';
  }
  function definirArquivo(f){
    if (!f) return;
    if (f.type !== 'application/pdf' && !/\.pdf$/i.test(f.name)) { status('Esse arquivo não é um PDF.'); return; }
    const mudouArquivo = !arquivoPdf || arquivoPdf.name !== f.name || arquivoPdf.size !== f.size || arquivoPdf.lastModified !== f.lastModified;
    arquivoPdf = f;
    const dz = elx('ps-file');
    const titulo = elx('ps-file-title');
    const sub = elx('ps-file-sub');
    const ok = elx('ps-file-ok');
    const okTxt = elx('ps-file-ok-txt');
    if (dz) dz.classList.add('has-file');
    if (titulo) titulo.textContent = f.name;
    if (sub) sub.textContent = tamanhoArquivo(f.size) + ' · clique para trocar a ficha';
    if (ok) ok.classList.add('show');
    if (okTxt) okTxt.textContent = 'PDF carregado e pronto para leitura';
    status('');
  }
  elx('ps_pdf').addEventListener('change', e => definirArquivo(e.target.files[0]));

  // arrastar-e-soltar na área do arquivo (e no painel todo)
  const dropZone = elx('ps-file');
  ['dragenter','dragover'].forEach(ev => dropZone.addEventListener(ev, e => {
    e.preventDefault(); e.stopPropagation(); dropZone.classList.add('drag');
    const t=elx('ps-file-title'), s=elx('ps-file-sub');
    if(t) t.textContent='Solte a ficha aqui';
    if(s) s.textContent='O PDF será carregado automaticamente';
  }));
  ['dragleave','dragend'].forEach(ev => dropZone.addEventListener(ev, e => {
    e.preventDefault(); e.stopPropagation(); dropZone.classList.remove('drag');
    if(arquivoPdf) definirArquivo(arquivoPdf);
    else { const t=elx('ps-file-title'),s=elx('ps-file-sub'); if(t)t.textContent='Arraste a ficha aqui'; if(s)s.textContent='ou clique para escolher o PDF'; }
  }));
  dropZone.addEventListener('drop', e => {
    e.preventDefault(); e.stopPropagation(); dropZone.classList.remove('drag');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    definirArquivo(f);
  });
  // evita que o navegador abra o PDF se soltar fora da zona
  pnl.addEventListener('dragover', e => e.preventDefault());
  pnl.addEventListener('drop', e => { if (e.target !== dropZone && !dropZone.contains(e.target)) { e.preventDefault();
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; definirArquivo(f); } });

  function status(m){ const s = elx('ps_status'); if (s) { s.textContent = m || ''; s.classList.toggle('show', !!m); } }
  function alerta(tipo, msg){
    const a = elx('ps_alert'); if (!a) return;
    let texto = msg || '';
    let classe = tipo || '';

    // Se a ficha trouxe um CBO inválido, o aviso não pode desaparecer quando
    // a consulta ao CNES escrever outro resultado no mesmo cartão.
    if (avisoCboPersistente) {
      if (texto && texto !== avisoCboPersistente) texto = avisoCboPersistente + '\n\n' + texto;
      else if (!texto) texto = avisoCboPersistente;
      if (classe !== 'erro') classe = 'warn';
    }

    a.className = texto ? ('show ' + classe) : '';
    a.textContent = texto;
  }


  async function ler(){ const f = arquivoPdf || elx('ps_pdf').files[0]; if(!f){status('Escolha ou arraste o PDF.');return null;}
    alerta('', ''); status('Lendo ficha...'); const form=await lerFormulario(f); const d=montar(form);
    elx('ps_dbg').value=JSON.stringify(d,null,1); console.log('[Preencher] dados:',d,form); return d; }
  elx('ps_test').addEventListener('click', async()=>{ try{ const d=await ler();
      if(d){ const m=elx('ps_more'); if(m) m.open=true; status('Leitura OK — veja os dados abaixo.'); } }
    catch(e){ status('ERRO: '+e.message); console.error(e); } });
  elx('ps_go').addEventListener('click', async()=>{ try{ const d=await ler(); if(d) await preencher(d); }
    catch(e){ status('ERRO: '+e.message); console.error(e); } });

  /* CNS: consulta primeiro o CNES pelo CPF. Se não houver retorno, o fluxo manual
     de Munícipes do Saúde Simples continua disponível em CONFIG.municipesUrl.
     A automação direta do CADSUS/Cadweb só deve ser adicionada após capturar a
     requisição real usada pelo Saúde Simples, sem adivinhar endpoint/credenciais. */
})();