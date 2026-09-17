from pathlib import Path

p = Path('OM30-WhatsApp-GLPI.user.js')
s = p.read_text(encoding='utf-8')

anchor = """    async function silentUploadPrint(ctx, job) {
        if (!job.printDataUrl) {
            return null;
        }
"""

helper = r'''    async function silentCompressPrintForGlpi(
        dataUrl,
        maxBytes = 900 * 1024
    ) {
        const originalFile =
            silentDataUrlToFile(
                dataUrl,
                'om30-print-original.png'
            );

        if (originalFile.size <= maxBytes) {
            return {
                dataUrl,
                compressed: false,
                originalBytes: originalFile.size,
                finalBytes: originalFile.size,
                mime: originalFile.type || 'image/png',
                width: 0,
                height: 0
            };
        }

        const image =
            await new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = () => reject(
                    new Error('Não consegui abrir o print para reduzir o tamanho.')
                );
                img.src = dataUrl;
            });

        const sourceWidth =
            Math.max(1, Number(image.naturalWidth || image.width || 1));
        const sourceHeight =
            Math.max(1, Number(image.naturalHeight || image.height || 1));

        // Evita canvases gigantes e preserva, quando possível, a largura original.
        let scale = Math.min(
            1,
            1800 / sourceWidth,
            16000 / sourceHeight
        );

        let best = null;

        for (let round = 0; round < 7; round++) {
            const width =
                Math.max(320, Math.round(sourceWidth * scale));
            const height =
                Math.max(1, Math.round(sourceHeight * scale));

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;

            const context = canvas.getContext('2d', { alpha: false });

            if (!context) {
                throw new Error('Canvas indisponível para compactar o print.');
            }

            // Fundo branco evita áreas pretas ao converter PNG transparente para JPEG.
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, width, height);
            context.drawImage(image, 0, 0, width, height);

            for (const quality of [0.84, 0.76, 0.68, 0.60, 0.52, 0.44]) {
                const candidate =
                    canvas.toDataURL('image/jpeg', quality);

                const candidateFile =
                    silentDataUrlToFile(
                        candidate,
                        'om30-print-reduzido.jpg'
                    );

                const item = {
                    dataUrl: candidate,
                    compressed: true,
                    originalBytes: originalFile.size,
                    finalBytes: candidateFile.size,
                    mime: 'image/jpeg',
                    width,
                    height,
                    quality
                };

                if (!best || item.finalBytes < best.finalBytes) {
                    best = item;
                }

                if (candidateFile.size <= maxBytes) {
                    return item;
                }
            }

            scale *= 0.82;
        }

        if (best) {
            return best;
        }

        throw new Error('Não consegui reduzir o print para envio ao GLPI.');
    }

''' + anchor

if anchor not in s:
    raise SystemExit('ERRO: início de silentUploadPrint não encontrado')

s = s.replace(anchor, helper, 1)

old = """        const uploadName =
            silentUploadName(
                job.printDataUrl
            );

        const file =
            silentDataUrlToFile(
                job.printDataUrl,
                uploadName
            );
"""

new = """        const preparedPrint =
            await silentCompressPrintForGlpi(
                job.printDataUrl
            );

        // A mesma imagem reduzida usada no upload também fica no conteúdo do
        // chamado. Assim não carregamos um data URL gigante no POST final.
        job.printDataUrl =
            preparedPrint.dataUrl;
        job.print_original_bytes =
            preparedPrint.originalBytes;
        job.print_upload_bytes =
            preparedPrint.finalBytes;
        job.print_compressed =
            !!preparedPrint.compressed;

        saveGlpiJob(job);

        om30Log(
            'glpi.print.prepared',
            {
                job_id: job.id,
                compressed: !!preparedPrint.compressed,
                original_bytes: preparedPrint.originalBytes,
                final_bytes: preparedPrint.finalBytes,
                mime: preparedPrint.mime,
                width: preparedPrint.width || 0,
                height: preparedPrint.height || 0,
                quality: preparedPrint.quality || null
            }
        );

        const uploadName =
            silentUploadName(
                job.printDataUrl
            );

        const file =
            silentDataUrlToFile(
                job.printDataUrl,
                uploadName
            );
"""

if old not in s:
    raise SystemExit('ERRO: bloco de criação do arquivo de upload não encontrado')

s = s.replace(old, new, 1)
s = s.replace('// @version      0.9.11', '// @version      0.9.12', 1)
s = s.replace("const OM30_VERSION =\n        '0.9.11';", "const OM30_VERSION =\n        '0.9.12';", 1)

checks = [
    '// @version      0.9.12',
    "const OM30_VERSION =\n        '0.9.12';",
    'async function silentCompressPrintForGlpi(',
    "'glpi.print.prepared'",
    'maxBytes = 900 * 1024'
]

for check in checks:
    if check not in s:
        raise SystemExit(f'ERRO: validação ausente: {check}')

p.write_text(s, encoding='utf-8')
print('Patch de upload 0.9.12 aplicado.')
