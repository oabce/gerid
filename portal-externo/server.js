const express = require('express');
require('dotenv').config();
const nodemailer = require('nodemailer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const mysql = require('mysql2/promise');

function enviarWhatsApp(telefone, mensagem) {
    const numero = '55' + telefone.replace(/\D/g, '');
    const body = JSON.stringify({ number: numero, textMessage: { text: mensagem } });
    const url = new URL(`${process.env.WHATSAPP_URL}/message/sendText/${process.env.WHATSAPP_INSTANCE}`);
    const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'apikey': process.env.WHATSAPP_KEY,
            'Content-Length': Buffer.byteLength(body)
        }
    };
    const req = http.request(options, res => res.resume());
    req.on('error', err => console.error('[WhatsApp] Falha:', err.message));
    req.write(body);
    req.end();
}

// Configuração MariaDB
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

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
        const [rows] = await pool.query('SELECT id FROM chamados WHERE protocolo = ?', [protocolo]);
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
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use(cors());
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function salvarArquivo(buffer, nome) {
    const ext = path.extname(nome).toLowerCase() || '.bin';
    const nomeArq = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, nomeArq), buffer);
    return `/uploads/${nomeArq}`;
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
app.post('/api/chamados', async (req, res) => {
    try {
        const { nome, cpf, email, telefone, assunto, descricao, numero, arquivos: arquivosB64 = [] } = req.body;
        const cpfLimpo = cpf ? cpf.replace(/\D/g, '') : null;
        const oab = numero || '---';
        const portalUrl = process.env.PUBLIC_URL || 'http://localhost:3003';

        const parteInicial = email.split('@')[0].toLowerCase();
        if (['teste', 'test', 'asdf', '123456', 'abcde'].includes(parteInicial)) {
            return res.status(400).json({ error: 'Por favor, informe um e-mail válido.' });
        }
        if (!cpf || !validarCPF(cpf)) {
            return res.status(400).json({ error: 'O CPF informado é inválido.' });
        }

        const protocolo = await gerarProtocoloUnico();

        // Salva arquivos localmente
        const imageURLs = [];
        for (const arq of arquivosB64) {
            const buf = Buffer.from(arq.data, 'base64');
            imageURLs.push(salvarArquivo(buf, arq.name));
        }

        const historico = [{
            status: 'Aberto',
            observacao: 'Chamado aberto pelo solicitante',
            data: new Date().toISOString(),
            agente: 'Sistema'
        }];

        await pool.query(
            `INSERT INTO chamados (protocolo, nome, cpf, email, telefone, oab, assunto, descricao, status, imagens, historico, criado_em, atualizado_em)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [protocolo, nome, cpfLimpo, email, telefone, oab, assunto, descricao, 'Aberto', JSON.stringify(imageURLs), JSON.stringify(historico), new Date(), new Date()]
        );

        res.status(201).json({ message: 'Solicitação enviada com sucesso!', protocolo });

        // Emails (fire-and-forget)
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

        transporter.sendMail({
            from: process.env.SMTP_FROM,
            to: process.env.SMTP_TO,
            subject: `NOVO CHAMADO - PROTOCOLO #${protocolo} - ${assunto}`,
            html: htmlSuporte,
            attachments: arquivosB64.map(f => ({ filename: f.name, content: Buffer.from(f.data, 'base64') }))
        }).catch(err => console.error('[E-mail] Suporte:', err.message));

        transporter.sendMail({
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

        enviarWhatsApp(telefone,
            `✅ *OAB-CE | Chamado Aberto*\n\nOlá, ${nome}!\n\nSeu chamado foi registrado com sucesso.\n\n*Protocolo:* #${protocolo}\n*Assunto:* ${assunto}\n\nAcompanhe pelo link:\n${portalUrl}?aba=consultar`
        );

    } catch (error) {
        console.error('Erro ao criar chamado:', error.message);
        res.status(500).json({ error: 'Erro ao enviar sua solicitação. Tente novamente.' });
    }
});

// Listar Categorias
app.get('/api/public/categorias', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM categorias WHERE ativo = 1 ORDER BY nome ASC');
        res.json(rows || []);
    } catch (error) {
        console.error('[Categorias] Erro:', error.message);
        res.status(500).json({ error: 'Erro ao carregar categorias' });
    }
});

// Consultar Chamado por CPF
app.get('/api/public/chamados/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const cleanCPF = id.replace(/\D/g, '');

        const [chamados] = await pool.query(
            'SELECT * FROM chamados WHERE cpf = ? OR cpf = ? ORDER BY criado_em DESC',
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
app.patch('/api/public/chamados/:id/resolver', async (req, res) => {
    try {
        const { id } = req.params;
        const { nome, cpf, email, telefone, assunto, descricao, nova_observacao, arquivos: arquivosB64 = [] } = req.body;
        const portalUrl = process.env.PUBLIC_URL || 'http://localhost:3003';

        const [rows] = await pool.query('SELECT * FROM chamados WHERE id = ?', [id]);
        const chamado = rows[0];
        if (!chamado) return res.status(404).json({ error: 'Chamado não encontrado.' });

        const protocolo = chamado.protocolo;
        const imagensAtuais = parseJson(chamado.imagens);
        const historicoAtual = parseJson(chamado.historico);

        const novasUrls = [];
        for (const arq of arquivosB64) {
            const buf = Buffer.from(arq.data, 'base64');
            novasUrls.push(salvarArquivo(buf, arq.name));
        }

        const novoHistorico = [...historicoAtual, {
            status: 'Pendência Concluída',
            observacao: nova_observacao || 'Pendência resolvida pelo solicitante',
            data: new Date().toISOString(),
            agente: 'Solicitante'
        }];

        await pool.query(
            `UPDATE chamados SET nome=?, cpf=?, email=?, telefone=?, assunto=?, descricao=?, status=?, resposta_usuario=?, imagens=?, historico=?, atualizado_em=? WHERE id=?`,
            [nome, cpf, email, telefone, assunto, descricao, 'Pendência Concluída', nova_observacao || null, JSON.stringify([...imagensAtuais, ...novasUrls]), JSON.stringify(novoHistorico), new Date(), id]
        );

        res.json({ success: true, message: 'Pendência enviada com sucesso!' });

        transporter.sendMail({
            from: process.env.SMTP_FROM,
            to: process.env.SMTP_TO,
            subject: `PENDÊNCIA RESOLVIDA - ${assunto}`,
            html: `<div style="font-family:sans-serif;max-width:600px;color:#333">
                <h2 style="color:#D97706">Pendência Resolvida pelo Usuário</h2>
                <p><strong>${nome}</strong> atualizou as informações do chamado.</p>
                <p><strong>Observação:</strong> ${nova_observacao || 'Nenhuma.'}</p>
                <p>Verifique o painel do agente.</p></div>`,
            attachments: arquivosB64.map(f => ({ filename: f.name, content: Buffer.from(f.data, 'base64') }))
        }).catch(err => console.error('[E-mail] Suporte resolver:', err.message));

        transporter.sendMail({
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

        enviarWhatsApp(telefone,
            `📋 *OAB-CE | Pendência Recebida*\n\nOlá, ${nome}!\n\nRecebemos suas informações complementares.\n\n*Protocolo:* #${protocolo}\n*Novo Status:* Pendência Concluída\n\nAcompanhe pelo link:\n${portalUrl}?aba=consultar`
        );

    } catch (error) {
        console.error('Erro ao resolver pendência:', error.message);
        res.status(500).json({ error: 'Erro ao processar sua resolução.' });
    }
});

// Confirmação de dados pelo solicitante (chamados GERID)
app.patch('/api/public/chamados/:id/confirmar', async (req, res) => {
    try {
        const { id } = req.params;
        const [rows] = await pool.query('SELECT * FROM chamados WHERE id = ?', [id]);
        const chamado = rows[0];
        if (!chamado) return res.status(404).json({ error: 'Chamado não encontrado.' });

        const historicoAtual = parseJson(chamado.historico);
        const novoHistorico = [...historicoAtual, {
            status: chamado.status,
            observacao: 'Solicitante confirmou que os dados cadastrados são os mais atuais e verídicos.',
            data: new Date().toISOString(),
            agente: 'Solicitante'
        }];

        await pool.query(
            'UPDATE chamados SET historico = ?, atualizado_em = ? WHERE id = ?',
            [JSON.stringify(novoHistorico), new Date(), id]
        );

        res.json({ success: true });
    } catch (err) {
        console.error('[Confirmar] Erro:', err.message);
        res.status(500).json({ error: 'Erro ao confirmar dados.' });
    }
});

const PORT = process.env.PORT_PUBLICO || 3003;
app.listen(PORT, '0.0.0.0', () => console.log(`Portal Externo rodando na porta ${PORT}`));
