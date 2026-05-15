const express = require('express');
require('dotenv').config();
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const nodemailer = require('nodemailer');
const mysql = require('mysql2/promise');
const { PDFDocument } = require('pdf-lib');

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

const STATUS_VALIDOS = ['Aberto', 'Em Atendimento', 'Pendente', 'Pendência Concluída', 'Concluído', 'Cancelado'];
const ORIGEM_PERMITIDA = process.env.ALLOWED_ORIGIN || 'http://192.168.0.253';

const app = express();
app.use(cors({ origin: ORIGEM_PERMITIDA, credentials: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get(['/', '/login.html'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'agente.html'));
});

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: false,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    },
    tls: { rejectUnauthorized: false }
});

// ==========================================
// ROTAS DO PAINEL DO AGENTE
// ==========================================

app.get('/api/chamados', async (req, res) => {
    try {
        const [data] = await pool.query('SELECT * FROM chamados ORDER BY criado_em DESC');
        data.forEach(c => {
            c.imagens = parseJson(c.imagens);
            c.historico = parseJson(c.historico);
        });
        res.json(data || []);
    } catch (error) {
        console.error("Erro ao buscar chamados:", error.message);
        res.status(500).json({ error: 'Erro ao buscar chamados' });
    }
});

app.patch('/api/chamados/:id', async (req, res) => {
    const { id } = req.params;
    const { status, observacao } = req.body;

    if (!status || !STATUS_VALIDOS.includes(status)) {
        return res.status(400).json({ error: `Status inválido. Valores aceitos: ${STATUS_VALIDOS.join(', ')}` });
    }

    try {
        const [rows] = await pool.query('SELECT * FROM chamados WHERE id = ?', [id]);
        const chamado = rows[0];
        if (!chamado) throw new Error("Chamado não encontrado");

        chamado.imagens = parseJson(chamado.imagens);
        chamado.historico = parseJson(chamado.historico);

        let historicoAtual = chamado.historico;
        if (!Array.isArray(historicoAtual)) historicoAtual = [];

        if (historicoAtual.length === 0) {
            historicoAtual.push({
                status: 'Aberto',
                observacao: 'Chamado aberto pelo solicitante',
                data: chamado.criado_em || new Date().toISOString(),
                agente: 'Sistema'
            });
        }

        historicoAtual.push({
            status,
            observacao: observacao || 'Status atualizado',
            data: new Date().toISOString(),
            agente: 'Técnico TI'
        });

        const setClauses = ['status = ?', 'observacao = ?', 'historico = ?', 'atualizado_em = ?'];
        const values = [status, observacao, JSON.stringify(historicoAtual), new Date()];

        if (req.body.prioridade) {
            setClauses.push('prioridade = ?');
            values.push(req.body.prioridade);
        }
        if (status === 'Concluído' || status === 'Cancelado') {
            setClauses.push('finalizado_em = ?');
            values.push(new Date());
        }
        values.push(id);

        await pool.query(`UPDATE chamados SET ${setClauses.join(', ')} WHERE id = ?`, values);

        const getStatusColor = (s) => ({
            'Aberto': '#3b82f6',
            'Em Atendimento': '#a855f7',
            'Pendente': '#f59e0b',
            'Concluído': '#10b981',
            'Cancelado': '#ef4444',
            'Pendência Concluída': '#0ea5e9'
        }[s] || '#8D3046');

        const portalUrl = process.env.PUBLIC_URL || 'http://192.168.0.253:3003/';
        transporter.sendMail({
            from: process.env.SMTP_FROM,
            to: chamado.email,
            subject: `Atualização de Chamado [${status}] - Protocolo #${chamado.protocolo}`,
            html: `
                <div style="font-family: sans-serif; max-width: 600px; color: #333;">
                    <h2 style="color: ${getStatusColor(status)}; border-bottom: 2px solid ${getStatusColor(status)}; padding-bottom: 10px;">Atualização no seu Atendimento: ${status}</h2>
                    <p>Olá <strong>${chamado.nome}</strong>,</p>
                    <p>Houve uma atualização no seu chamado: <strong>${chamado.assunto}</strong>.</p>
                    <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                    <p><strong>Novo Status:</strong> <span style="color: ${getStatusColor(status)}; font-weight: bold;">${status}</span></p>
                    <p><strong>Observação do Agente:</strong> ${observacao || 'Sem observações adicionais.'}</p>
                    <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                    <p>Você pode acompanhar o status detalhado pelo link abaixo:</p>
                    <p><a href="${portalUrl}?aba=consultar" style="display: inline-block; padding: 12px 24px; background-color: ${getStatusColor(status)}; color: white; text-decoration: none; border-radius: 8px; font-weight: bold;">Acompanhar meu Chamado</a></p>
                    <br>
                    <p style="font-size: 11px; color: #777;">Atenciosamente,<br>Equipe de Suporte OAB-CE</p>
                    <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                    <p style="color: #d32f2f; font-weight: bold; text-align: center; font-size: 14px;">Por favor, não responder esse e-mail.</p>
                </div>
            `
        }).catch(err => console.error('[E-mail] Falha:', err.message));

        enviarWhatsApp(chamado.telefone,
            `🔔 *OAB-CE | Atualização de Chamado*\n\nOlá, ${chamado.nome}!\n\nSeu chamado foi atualizado.\n\n*Protocolo:* #${chamado.protocolo}\n*Novo Status:* ${status}\n*Observação:* ${observacao || 'Sem observações adicionais.'}\n\nAcompanhe pelo link:\n${portalUrl}?aba=consultar`
        );

        const [updatedRows] = await pool.query('SELECT * FROM chamados WHERE id = ?', [id]);
        const updatedChamado = updatedRows[0];
        updatedChamado.imagens = parseJson(updatedChamado.imagens);
        updatedChamado.historico = parseJson(updatedChamado.historico);

        res.json(updatedChamado);

    } catch (error) {
        console.error("Erro na operação:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// Limpeza automática de chamados finalizados há mais de 2 dias
setInterval(async () => {
    try {
        const doisDiasAtras = new Date();
        doisDiasAtras.setDate(doisDiasAtras.getDate() - 2);
        await pool.query(
            'DELETE FROM chamados WHERE finalizado_em IS NOT NULL AND finalizado_em < ?',
            [doisDiasAtras]
        );
    } catch (error) {
        console.error("[Auto-Cleanup] Erro:", error.message);
    }
}, 1000 * 60 * 60);

const COUNTER_PATH = path.join(__dirname, 'oficio_counter.txt');
function proximoNumeroOficio() {
    let atual = 94;
    if (fs.existsSync(COUNTER_PATH)) {
        const conteudo = fs.readFileSync(COUNTER_PATH, 'utf8').trim();
        atual = parseInt(conteudo) || 94;
    }
    const proximo = atual + 1;
    fs.writeFileSync(COUNTER_PATH, String(proximo));
    return String(proximo).padStart(4, '0');
}

// Gerar Ofício GERID em PDF
app.get('/api/chamados/:id/oficio', async (req, res) => {
    try {
        const { id } = req.params;
        const [rows] = await pool.query('SELECT * FROM chamados WHERE id = ?', [id]);
        const chamado = rows[0];
        if (!chamado) return res.status(404).send('Chamado não encontrado');

        const templatePath = path.join(__dirname, 'public', 'templates', 'oficio.pdf');
        if (!fs.existsSync(templatePath)) return res.status(500).send('Template não encontrado em public/templates/oficio.pdf');

        const templateBytes = fs.readFileSync(templatePath);
        const pdfDoc = await PDFDocument.load(templateBytes);

        const hoje = new Date();
        const meses = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];
        const dataStr = `${hoje.getDate()} de ${meses[hoje.getMonth()]} de ${hoje.getFullYear()}`;
        const cpf = (chamado.cpf || '').replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
        const oab = (chamado.oab && chamado.oab !== '---') ? chamado.oab : '';

        const form = pdfDoc.getForm();
        const campos = form.getFields();
        campos.forEach(f => console.log('[Ofício] Campo:', JSON.stringify(f.getName()), f.constructor.name));

        const preencher = (nome, valor) => {
            try { form.getTextField(nome).setText(valor || ''); } catch(_) {}
        };

        const numOficio = proximoNumeroOficio();
        // Tenta variantes do nome do campo Nº Ofício (nome truncado no log anterior)
        ['Nº Ofício', 'Nº Oficio', 'Número Ofício', 'Nº O', 'NumeroOficio', 'Oficio'].forEach(n => preencher(n, numOficio));
        preencher('Data', dataStr);
        preencher('Nome Advogado (a)', chamado.nome || '');
        preencher('CPF', cpf);
        preencher('Text7', oab);
        preencher('e-mail', chamado.email || '');
        preencher('Celular', chamado.telefone || '');

        form.flatten();

        const pdfBytes = await pdfDoc.save();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="oficio-${chamado.protocolo || id}.pdf"`);
        res.send(Buffer.from(pdfBytes));
    } catch (err) {
        console.error('[Ofício] Erro:', err.message);
        res.status(500).send('Erro ao gerar ofício: ' + err.message);
    }
});

const PORT = process.env.PORT || process.env.PORT_INTERNO || 3002;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Painel do Agente rodando na porta ${PORT}`);
});
