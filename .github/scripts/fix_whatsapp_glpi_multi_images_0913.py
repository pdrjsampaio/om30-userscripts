from pathlib import Path

p = Path('OM30-WhatsApp-GLPI.user.js')
s = p.read_text(encoding='utf-8')


def replace_between(text, start, end, replacement):
    i = text.find(start)
    if i < 0:
        raise SystemExit(f'ERRO: início não encontrado: {start[:80]}')
    j = text.find(end, i)
    if j < 0:
        raise SystemExit(f'ERRO: fim não encontrado: {end[:80]}')
    return text[:i] + replacement + text[j:]

# Versão
s = s.replace('// @version      0.9.12', '// @version      0.9.13', 1)
s = s.replace("const OM30_VERSION =\n        '0.9.12';", "const OM30_VERSION =\n        '0.9.13';", 1)
s = s.replace('OM30 WhatsApp → GLPI v0.9.9', 'OM30 WhatsApp → GLPI v0.9.13')
s = s.replace('OM30 v0.9.9 self-check', 'OM30 v0.9.13 self-check')
s = s.replace('OM30 WhatsApp v0.9.9 carregado', 'OM30 WhatsApp v0.9.13 carregado')

# Evita miniatura data: + imagem real blob: da mesma mensagem.
new_selected_media = r'''    function selectedMediaItems() {
        const seen = new Set();
        const out = [];

        for (const msg of orderedEvidence()) {
            const mediaList =
                (msg.media || [])
                    .filter(item => String(item?.src || '').trim());

            if (!mediaList.length) continue;

            // O WhatsApp costuma expor a mesma foto duas vezes:
            // uma miniatura data: e a imagem real blob:. Quando existir
            // blob:, usamos somente blob:; isso também preserva álbuns,
            // pois cada foto real terá seu próprio blob.
            const blobItems =
                mediaList.filter(item =>
                    /^blob:/i.test(String(item?.src || ''))
                );

            const preferred =
                blobItems.length
                    ? blobItems
                    : mediaList;

            for (const media of preferred) {
                const src = String(media?.src || '').trim();

                if (!src || seen.has(src)) continue;
                seen.add(src);

                out.push({
                    ...media,
                    message_id: msg.id,
                    message_meta: msg.meta || '',
                    message_time: msg.time || '',
                    message_date: msg.date || ''
                });
            }
        }

        return out;
    }

'''
s = replace_between(
    s,
    '    function selectedMediaItems() {',
    '    async function mediaSourceToDataUrl(',
    new_selected_media + '    async function mediaSourceToDataUrl('
)

# Em vez de montar um canvas vertical único, mantém cada evidência separada.
new_collect = r'''    async function collectEvidenceImages(basePrintBlob) {
        const result = [];
        const media = selectedMediaItems();
        const mediaErrors = [];

        for (let index = 0; index < media.length; index++) {
            const item = media[index];

            try {
                const dataUrl = await mediaSourceToDataUrl(item);

                result.push({
                    id: `message-${item.message_id || index}-${index}`,
                    kind: 'message',
                    message_id: item.message_id || '',
                    message_meta: item.message_meta || '',
                    message_time: item.message_time || '',
                    message_date: item.message_date || '',
                    dataUrl
                });

                om30Log(
                    'image.captured',
                    {
                        message_id: item.message_id,
                        meta: item.message_meta,
                        width: item.width,
                        height: item.height,
                        source: String(item.src).split(':')[0],
                        separate: true
                    }
                );
            } catch (error) {
                mediaErrors.push({
                    message_id: item.message_id,
                    meta: item.message_meta,
                    error: String(error?.message || error)
                });

                om30Log(
                    'image.capture-error',
                    { item, error },
                    'error'
                );
            }
        }

        if (media.length && result.length === 0) {
            throw new Error(
                'Você selecionou imagem(ns) do WhatsApp, mas não consegui capturá-las para anexar ao chamado. Baixe o LOG e me envie.'
            );
        }

        if (mediaErrors.length) {
            throw new Error(
                `Não consegui capturar ${mediaErrors.length} imagem(ns) selecionada(s). O chamado não foi enviado para evitar perder evidência.`
            );
        }

        // O print manual, quando existir, continua sendo uma evidência separada.
        if (basePrintBlob) {
            result.push({
                id: 'manual-print',
                kind: 'print',
                message_id: '',
                message_meta: '',
                message_time: '',
                message_date: '',
                dataUrl: await blobToDataURL(basePrintBlob)
            });
        }

        om30Log(
            'image.separate-list',
            {
                selected_images: media.length,
                includes_print: !!basePrintBlob,
                total_images: result.length
            }
        );

        return result;
    }

'''
s = replace_between(
    s,
    '    async function composeEvidenceImageDataUrl(',
    '    async function validateTicket() {',
    new_collect + '    async function validateTicket() {'
)

# Cada mensagem leva o ID para posicionar a imagem logo abaixo dela.
old_msg = """                        msg => ({\n                            meta:\n                                msg.meta || '',"""
new_msg = """                        msg => ({\n                            id:\n                                msg.id || '',\n                            meta:\n                                msg.meta || '',"""
if old_msg not in s:
    raise SystemExit('ERRO: bloco data.messages não encontrado')
s = s.replace(old_msg, new_msg, 1)

# Registra se a descrição foi alterada manualmente.
old_desc = """            description:\n                document.getElementById(\n                    'om30-description'\n                ).value.trim(),\n            evidence_mode:"""
new_desc = """            description:\n                document.getElementById(\n                    'om30-description'\n                ).value.trim(),\n            description_manual:\n                !!descriptionManual,\n            evidence_mode:"""
if old_desc not in s:
    raise SystemExit('ERRO: bloco description não encontrado')
s = s.replace(old_desc, new_desc, 1)

# Monta a lista de imagens separadas ao criar o job.
old_prepare = """            const printDataUrl =\n                await composeEvidenceImageDataUrl(\n                    printBlob\n                );"""
new_prepare = """            const evidenceImages =\n                await collectEvidenceImages(\n                    printBlob\n                );\n\n            // Mantido para compatibilidade com partes antigas do motor.\n            // A fonte oficial das imagens na v0.9.13 é evidenceImages.\n            const printDataUrl =\n                evidenceImages[0]?.dataUrl ||\n                '';"""
if old_prepare not in s:
    raise SystemExit('ERRO: preparo antigo do print não encontrado')
s = s.replace(old_prepare, new_prepare, 1)

old_log = """                    final_evidence_image:\n                        !!printDataUrl"""
new_log = """                    evidence_image_count:\n                        evidenceImages.length,\n                    final_evidence_image:\n                        !!printDataUrl"""
if old_log not in s:
    raise SystemExit('ERRO: log final_evidence_image não encontrado')
s = s.replace(old_log, new_log, 1)

old_job = """                data,\n                printDataUrl,\n                completed: {}"""
new_job = """                data,\n                evidenceImages,\n                printDataUrl,\n                completed: {}"""
if old_job not in s:
    raise SystemExit('ERRO: bloco do job não encontrado')
s = s.replace(old_job, new_job, 1)

# Faz o upload de cada imagem individualmente reutilizando o upload unitário já validado.
old_upload_head = """    async function silentUploadPrint(ctx, job) {\n        if (!job.printDataUrl) {"""
new_upload_head = r'''    async function silentUploadPrint(ctx, job) {
        const evidenceImages =
            Array.isArray(job.evidenceImages)
                ? job.evidenceImages.filter(item => item?.dataUrl)
                : [];

        if (
            evidenceImages.length &&
            !job.__singleEvidenceUpload
        ) {
            const uploads = [];
            const preparedImages = [];

            job.__singleEvidenceUpload = true;

            try {
                for (let index = 0; index < evidenceImages.length; index++) {
                    const evidence = evidenceImages[index];

                    job.printDataUrl = evidence.dataUrl;

                    const uploaded =
                        await silentUploadPrint(
                            ctx,
                            job
                        );

                    if (!uploaded) continue;

                    const preparedEvidence = {
                        ...evidence,
                        dataUrl: job.printDataUrl,
                        upload_index: index
                    };

                    preparedImages.push(preparedEvidence);
                    uploads.push({
                        ...uploaded,
                        evidence: preparedEvidence,
                        index
                    });
                }
            } finally {
                delete job.__singleEvidenceUpload;
            }

            job.evidenceImages = preparedImages;
            job.printDataUrl = preparedImages[0]?.dataUrl || '';

            saveGlpiJob(job);

            om30Log(
                'glpi.images.uploaded',
                {
                    job_id: job.id,
                    count: uploads.length,
                    messages: uploads.map(item => item.evidence?.message_id || ''),
                    kinds: uploads.map(item => item.evidence?.kind || '')
                }
            );

            return uploads;
        }

        if (!job.printDataUrl) {'''
if old_upload_head not in s:
    raise SystemExit('ERRO: início silentUploadPrint não encontrado')
s = s.replace(old_upload_head, new_upload_head, 1)

# HTML: imagem entra logo depois da mensagem correspondente, como Ctrl+V em sequência.
new_description = r'''    function silentDescriptionHTML(job, uploadInput = []) {
        const uploads =
            Array.isArray(uploadInput)
                ? uploadInput
                : (uploadInput ? [uploadInput] : []);

        const imageHtml = upload => {
            const src =
                upload?.evidence?.dataUrl ||
                '';

            if (!src) return '';

            const imageId =
                upload?.imageId ||
                '';

            return (
                `<p><img` +
                `${imageId ? ` id="${directEscapeHtml(imageId)}"` : ''}` +
                ` src="${src}"></p>`
            );
        };

        const messages =
            Array.isArray(job.data?.messages)
                ? job.data.messages
                : [];

        // Na descrição automática conseguimos preservar exatamente a ordem
        // da conversa: linha da mensagem -> foto daquela mensagem -> próxima.
        if (
            !job.data?.description_manual &&
            messages.length
        ) {
            const parts = [];
            const used = new Set();

            for (const msg of messages) {
                let head = '';
                if (msg.time) head += `[${msg.time}]`;
                if (msg.sender) head += `${head ? ' ' : ''}${msg.sender}:`;

                const text =
                    String(msg.text || '')
                        .replace(/\s*\n+\s*/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim();

                const line =
                    [head, text]
                        .filter(Boolean)
                        .join(' ');

                if (line) {
                    parts.push(
                        `<p>${directEscapeHtml(line)}</p>`
                    );
                }

                for (let index = 0; index < uploads.length; index++) {
                    const upload = uploads[index];

                    if (
                        String(upload?.evidence?.message_id || '') ===
                        String(msg.id || '')
                    ) {
                        const html = imageHtml(upload);
                        if (html) parts.push(html);
                        used.add(index);
                    }
                }
            }

            // Print manual ou qualquer imagem sem mensagem vinculada fica ao final.
            for (let index = 0; index < uploads.length; index++) {
                if (used.has(index)) continue;
                const html = imageHtml(uploads[index]);
                if (html) parts.push(html);
            }

            return parts.join('');
        }

        // Se o atendente alterou a descrição manualmente, não reescrevemos o texto;
        // apenas colocamos as imagens separadas depois dele.
        const text =
            directEscapeHtml(
                job.data?.description || ''
            )
                .replace(/\r?\n/g, '<br>');

        return (
            `<p>${text}</p>` +
            uploads.map(imageHtml).join('')
        );
    }

'''
s = replace_between(
    s,
    "    function silentDescriptionHTML(job, imageId = '') {",
    '    function silentExpectedActors(userId) {',
    new_description + '    function silentExpectedActors(userId) {'
)

# FormData suporta N arquivos: _filename[0], [1], ... e uma tag para cada imagem.
func_start = s.find('    function silentPrepareCreateFormData(')
if func_start < 0:
    raise SystemExit('ERRO: silentPrepareCreateFormData não encontrada')
block_start = s.find('        if (upload) {', func_start)
block_end = s.find('        const add =', block_start)
if block_start < 0 or block_end < 0:
    raise SystemExit('ERRO: bloco upload do FormData não encontrado')
new_form_upload = r'''        const uploads =
            Array.isArray(upload)
                ? upload
                : (upload ? [upload] : []);

        fd.set(
            'content',
            silentDescriptionHTML(
                job,
                uploads
            )
        );

        uploads.forEach((item, index) => {
            fd.set(
                `_filename[${index}]`,
                String(item.fileData?.name || '')
            );
            fd.set(
                `_prefix_filename[${index}]`,
                String(item.fileData?.prefix || '')
            );
            fd.set(
                `_tag_filename[${index}]`,
                String(item.tagData?.name || '')
            );
        });

'''
s = s[:block_start] + new_form_upload + s[block_end:]

checks = [
    '// @version      0.9.13',
    "const OM30_VERSION =\n        '0.9.13';",
    'async function collectEvidenceImages(basePrintBlob)',
    'evidenceImages,',
    "event: 'glpi.images.uploaded'" if False else "'glpi.images.uploaded'",
    'const uploads =\n            Array.isArray(upload)',
    'description_manual:\n                !!descriptionManual'
]

for check in checks:
    if check not in s:
        raise SystemExit(f'ERRO: validação ausente: {check}')

if 'async function composeEvidenceImageDataUrl(' in s:
    raise SystemExit('ERRO: compositor antigo ainda existe')

p.write_text(s, encoding='utf-8')
print('Patch multi-imagens v0.9.13 aplicado.')
