const express = require('express');
require('dotenv').config();
const nodemailer = require('nodemailer');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');

// Banco de dados (PostgreSQL via Supabase)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Supabase Storage (service role — somente no servidor, nunca exposto)
const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

function parseJson(val) {
    if (!val) return [];
    if (typeof val === 'object') return val;
    try { return JSON.parse(val); } catch { return []; }
}

async function gerarProtocoloUnico() {
    const ano = new Date().getFullYear();
    for (let tentativa = 0; tentativa < 5; tentativa++) {
        const random = Math.floor(1000 + Math.random() * 9000);
        const protocolo = `${ano}-${random}`;
        const { rows } = await pool.query('SELECT id FROM chamados WHERE protocolo = $1', [protocolo]);
        if (rows.length === 0) return protocolo;
    }
    throw new Error('Não foi possível gerar um protocolo único. Tente novamente.');
}

function validarCPF(cpf) {
    cpf = cpf.replace(/[^\d]+/g, '');
    if (cpf.length !== 11 || !!cpf.match(/(\d)\1{10}/)) return false;
    let cpfs = cpf.split('').map(el => +el);
    const rest = (count) => (cpfs.slice(0, count - 12).reduce((soma, el, i) => soma + el * (count - i), 0) * 10) % 11 % 10;
    return rest(10) === cpfs[9] && rest(11) === cpfs[10];
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Multer em memória — sem escrita em disco (compatível com Netlify Functions)
const TIPOS_PERMITIDOS = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
const EXTENSOES_PERMITIDAS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf'];

function fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (TIPOS_PERMITIDOS.includes(file.mimetype) && EXTENSOES_PERMITIDAS.includes(ext)) {
        cb(null, true);
    } else {
        cb(new Error('Tipo de arquivo não permitido. Envie apenas imagens ou PDF.'), false);
    }
}

const upload = multer({ storage: multer.memoryStorage(), fileFilter, limits: { fileSize: 20 * 1024 * 1024 } });

async function uploadParaStorage(protocolo, arquivo) {
    const nomeArq = `${protocolo}/${Date.now()}-${arquivo.originalname}`;
    const { error } = await supabaseAdmin.storage
        .from('chamados')
        .upload(nomeArq, arquivo.buffer, { contentType: arquivo.mimetype });
    if (error) { console.error('[Storage] Erro upload:', error.message); return null; }
    const { data } = supabaseAdmin.storage.from('chamados').getPublicUrl(nomeArq);
    return data.publicUrl;
}

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT || 587,
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    tls: { rejectUnauthorized: false }
});

// ==========================================
// ROTAS
// ==========================================

// Criar Chamado
app.post('/api/chamados', upload.array('imagens', 4), async (req, res) => {
    try {
        const { nome, cpf, email, telefone, assunto, descricao, numero } = req.body;
        const cpfLimpo = cpf ? cpf.replace(/\D/g, '') : null;
        const oab = numero || '---';
        const arquivos = req.files || [];
        const protocolo = await gerarProtocoloUnico();
        const portalUrl = process.env.PUBLIC_URL || 'https://gerid.netlify.app';

        const parteInicial = email.split('@')[0].toLowerCase();
        if (['teste', 'test', 'asdf', '123456', 'abcde'].includes(parteInicial)) {
            return res.status(400).json({ error: 'Por favor, informe um e-mail válido.' });
        }
        if (!cpf || !validarCPF(cpf)) {
            return res.status(400).json({ error: 'O CPF informado é inválido.' });
        }

        // Upload dos arquivos para Supabase Storage
        const imageURLs = [];
        for (const arquivo of arquivos) {
            const url = await uploadParaStorage(protocolo, arquivo);
            if (url) imageURLs.push(url);
        }

        const historico = JSON.stringify([{
            status: 'Aberto',
            observacao: 'Chamado aberto pelo solicitante',
            data: new Date().toISOString(),
            agente: 'Sistema'
        }]);

        await pool.query(
            `INSERT INTO chamados (protocolo, nome, cpf, email, telefone, oab, assunto, descricao, status, imagens, historico, criado_em, atualizado_em)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
            [protocolo, nome, cpfLimpo, email, telefone, oab, assunto, descricao,
             'Aberto', JSON.stringify(imageURLs), historico, new Date()]
        );

        const isGerid = assunto.toLowerCase().includes('gerid');
        const htmlSuporte = isGerid ? `
            <div style="font-family:sans-serif;max-width:600px;color:#333">
                <p><strong>Dados para inserir no chamado do INSS</strong></p>
                <p><strong>Nome:</strong> ${nome}</p>
                <p><strong>OAB:</strong> ${oab}</p>
                <p><strong>CPF:</strong> ${cpf}</p>
                <p><strong>E-mail:</strong> ${email}</p>
                <p><strong>Telefone:</strong> ${telefone}</p>
                <p><strong>Descrição:</strong> ${descricao}</p>
                <hr><p>Protocolo: ${protocolo}</p>
            </div>` : `
            <div style="font-family:sans-serif;max-width:600px;color:#333">
                <p><strong>Novo chamado recebido via Portal</strong></p>
                <p><strong>Nome:</strong> ${nome}</p>
                <p><strong>OAB:</strong> ${oab}</p>
                <p><strong>CPF:</strong> ${cpf}</p>
                <p><strong>E-mail:</strong> ${email}</p>
                <p><strong>Telefone:</strong> ${telefone}</p>
                <p><strong>Assunto:</strong> ${assunto}</p>
                <p><strong>Descrição:</strong> ${descricao}</p>
                <hr><p>Protocolo: ${protocolo}</p>
            </div>`;

        await transporter.sendMail({
            from: process.env.SMTP_FROM,
            to: process.env.SMTP_TO,
            subject: `NOVO CHAMADO - PROTOCOLO #${protocolo} - ${assunto}`,
            html: htmlSuporte,
            attachments: arquivos.map(f => ({ filename: f.originalname, content: f.buffer }))
        });

        await transporter.sendMail({
            from: process.env.SMTP_FROM,
            to: email,
            subject: `Confirmação de Abertura de Chamado - Protocolo #${protocolo}`,
            html: `
                <div style="font-family:sans-serif;max-width:600px;color:#333">
                    <h2 style="color:#3b82f6;border-bottom:2px solid #3b82f6">Recebemos sua solicitação!</h2>
                    <p>Olá <strong>${nome}</strong>,</p>
                    <p>Seu chamado foi registrado com sucesso.</p>
                    <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
                    <p><strong>Protocolo:</strong> <span style="color:#3b82f6;font-weight:bold">${protocolo}</span></p>
                    <p><strong>Assunto:</strong> ${assunto}</p>
                    <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
                    <p><a href="${portalUrl}?aba=consultar" style="display:inline-block;padding:12px 24px;background-color:#3b82f6;color:white;text-decoration:none;border-radius:8px;font-weight:bold">Acompanhar Status</a></p>
                    <p style="font-size:11px;color:#777">Atenciosamente,<br>Equipe de Tecnologia OAB-CE</p>
                    <p style="color:#d32f2f;font-weight:bold;text-align:center;font-size:14px">⚠️ Por favor, não responder esse e-mail.</p>
                </div>`
        }).catch(err => console.error('[E-mail] Confirmação usuário:', err.message));

        res.status(201).json({ message: 'Solicitação enviada com sucesso!', protocolo });

    } catch (error) {
        console.error('Erro ao criar chamado:', error.message);
        res.status(500).json({ error: 'Erro ao enviar sua solicitação. Tente novamente.' });
    }
});

// Listar Categorias
app.get('/api/public/categorias', async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM categorias WHERE ativo = true ORDER BY nome ASC');
        res.json(rows || []);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao carregar categorias' });
    }
});

// Consultar Chamado por CPF ou Protocolo
app.get('/api/public/chamados/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const cleanCPF = id.replace(/\D/g, '');
        const { rows: chamados } = await pool.query(
            'SELECT * FROM chamados WHERE cpf = $1 OR cpf = $2 ORDER BY criado_em DESC',
            [cleanCPF, id]
        );

        if (!chamados || chamados.length === 0) {
            return res.status(404).json({ error: 'Nenhum chamado encontrado para este CPF.' });
        }

        const formatados = chamados.map(c => {
            const historico = parseJson(c.historico);
            const historicoFinal = historico.length > 0 ? historico : [
                { status: 'Aberto', data: c.criado_em, observacao: 'Chamado recebido pelo portal.', agente: 'Sistema' },
                ...(c.status !== 'Aberto' ? [{
                    status: c.status,
                    data: c.atualizado_em || new Date().toISOString(),
                    observacao: c.observacao || 'Seu chamado está sendo processado.',
                    agente: 'Suporte'
                }] : [])
            ];

            return {
                id: c.id, protocolo: c.protocolo, nome: c.nome,
                cpf: c.cpf, email: c.email, telefone: c.telefone,
                oab: c.oab, assunto: c.assunto, descricao: c.descricao,
                status: c.status || 'Aberto',
                data: c.criado_em,
                imagens: parseJson(c.imagens),
                historico: historicoFinal
            };
        });

        res.status(200).json(formatados);
    } catch (error) {
        console.error('Erro ao consultar:', error.message);
        res.status(500).json({ error: 'Erro ao consultar chamado' });
    }
});

// Resolver Pendência
app.patch('/api/public/chamados/:id/resolver', upload.array('imagens', 4), async (req, res) => {
    try {
        const { id } = req.params;
        const { nome, cpf, email, telefone, assunto, descricao, nova_observacao } = req.body;
        const arquivos = req.files || [];
        const portalUrl = process.env.PUBLIC_URL || 'https://gerid.netlify.app';

        const { rows } = await pool.query('SELECT imagens, historico, protocolo FROM chamados WHERE id = $1', [id]);
        if (!rows[0]) return res.status(404).json({ error: 'Chamado não encontrado.' });

        const { protocolo, imagens, historico } = rows[0];
        const imagensAtuais = parseJson(imagens);
        const historicoAtual = parseJson(historico);

        // Upload dos novos arquivos
        const novasUrls = [];
        for (const arquivo of arquivos) {
            const url = await uploadParaStorage(protocolo, arquivo);
            if (url) novasUrls.push(url);
        }

        const novoHistorico = [...historicoAtual, {
            status: 'Pendência Concluída',
            observacao: nova_observacao || 'Pendência resolvida pelo solicitante',
            data: new Date().toISOString(),
            agente: 'Solicitante'
        }];

        await pool.query(
            `UPDATE chamados SET nome=$1, cpf=$2, email=$3, telefone=$4, assunto=$5, descricao=$6,
             status=$7, resposta_usuario=$8, imagens=$9, historico=$10, atualizado_em=$11 WHERE id=$12`,
            [nome, cpf, email, telefone, assunto, descricao, 'Pendência Concluída',
             nova_observacao || null, JSON.stringify([...imagensAtuais, ...novasUrls]),
             JSON.stringify(novoHistorico), new Date(), id]
        );

        await transporter.sendMail({
            from: process.env.SMTP_FROM,
            to: process.env.SMTP_TO,
            subject: `PENDÊNCIA RESOLVIDA - ${assunto}`,
            html: `<div style="font-family:sans-serif;max-width:600px;color:#333">
                <h2 style="color:#D97706">Pendência Resolvida pelo Usuário</h2>
                <p><strong>${nome}</strong> atualizou as informações do chamado.</p>
                <p><strong>Observação:</strong> ${nova_observacao || 'Nenhuma.'}</p>
                <p>Verifique o painel do agente.</p></div>`,
            attachments: arquivos.map(f => ({ filename: f.originalname, content: f.buffer }))
        });

        await transporter.sendMail({
            from: process.env.SMTP_FROM,
            to: email,
            subject: `Pendência Recebida - Protocolo #${protocolo}`,
            html: `<div style="font-family:sans-serif;max-width:600px;color:#333">
                <h2 style="color:#10b981;border-bottom:2px solid #10b981">Informações Recebidas</h2>
                <p>Olá <strong>${nome}</strong>, recebemos suas informações complementares.</p>
                <p><strong>Novo Status:</strong> <span style="color:#10b981;font-weight:bold">Pendência Concluída</span></p>
                <p><a href="${portalUrl}?aba=consultar" style="display:inline-block;padding:12px 24px;background:#10b981;color:white;text-decoration:none;border-radius:8px;font-weight:bold">Acompanhar Status</a></p>
                <p style="font-size:11px;color:#777">Atenciosamente,<br>Equipe de Tecnologia OAB-CE</p>
                <p style="color:#d32f2f;font-weight:bold;text-align:center;font-size:14px">⚠️ Por favor, não responder esse e-mail.</p>
            </div>`
        }).catch(err => console.error('[E-mail] Confirmação resolver:', err.message));

        res.json({ success: true, message: 'Pendência enviada com sucesso!' });

    } catch (error) {
        console.error('Erro ao resolver pendência:', error.message);
        res.status(500).json({ error: 'Erro ao processar sua resolução.' });
    }
});

// Exporta o app para uso como Netlify Function
// e mantém o listen para desenvolvimento local
if (require.main === module) {
    const PORT = process.env.PORT_PUBLICO || 3000;
    app.listen(PORT, () => console.log(`Portal Público rodando na porta ${PORT}`));
}

module.exports = app;
