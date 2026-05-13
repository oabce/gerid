const express = require('express');
require('dotenv').config();
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');

// Configuração Supabase (PostgreSQL)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

function parseJson(val) {
    if (!val) return [];
    if (typeof val === 'object') return val;
    try { return JSON.parse(val); } catch { return []; }
}

const crypto = require('crypto');
const sessoes = new Map();

function gerarToken() {
    return crypto.randomBytes(32).toString('hex');
}

function autenticar(req, res, next) {
    const token = req.headers['x-auth-token'];
    if (!token || !sessoes.has(token)) {
        return res.status(401).json({ error: 'Não autorizado' });
    }
    next();
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

// ==========================================
// CONFIGURAÇÃO GLPI API
// ==========================================
class GlpiService {
    constructor() {
        this.baseUrl = process.env.GLPI_URL;
        this.appToken = process.env.GLPI_APP_TOKEN;
        this.userToken = process.env.GLPI_USER_TOKEN;
    }

    async conectar() {
        try {
            const res = await axios.get(`${this.baseUrl}/initSession`, {
                headers: {
                    'App-Token': this.appToken,
                    'Authorization': `user_token ${this.userToken}`
                }
            });
            return res.data.session_token;
        } catch (error) {
            console.error("[GLPI] Erro de autenticação:", error.message);
            return null;
        }
    }

    async desconectar(sessionToken) {
        if (!sessionToken) return;
        try {
            await axios.get(`${this.baseUrl}/killSession`, {
                headers: { 'App-Token': this.appToken, 'Session-Token': sessionToken }
            });
        } catch (e) {}
    }
}
const glpiAPI = new GlpiService();

// Configuração do Transportador de E-mail
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
// LOGIN
// ==========================================
app.post('/api/login', (req, res) => {
    const { usuario, senha } = req.body;
    if (usuario === process.env.AGENT_USER && senha === process.env.AGENT_PASS) {
        const token = gerarToken();
        sessoes.set(token, Date.now());
        return res.json({ token });
    }
    return res.status(401).json({ error: 'Usuário ou senha inválidos' });
});

// ==========================================
// ROTAS DO PAINEL DO AGENTE
// ==========================================

// Listar chamados
app.get('/api/chamados', autenticar, async (req, res) => {
    try {
        const { rows: data } = await pool.query('SELECT * FROM chamados ORDER BY criado_em DESC');
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

// Atualizar chamado (Status/Observação) + GLPI + Limpeza
app.patch('/api/chamados/:id', autenticar, async (req, res) => {
    const { id } = req.params;
    const { status, observacao } = req.body;

    if (!status || !STATUS_VALIDOS.includes(status)) {
        return res.status(400).json({ error: `Status inválido. Valores aceitos: ${STATUS_VALIDOS.join(', ')}` });
    }
    let sessionToken = null;

    try {
        // 1. Busca dados do chamado
        const { rows } = await pool.query('SELECT * FROM chamados WHERE id = $1', [id]);
        const chamado = rows[0];
        if (!chamado) throw new Error("Chamado não encontrado");

        chamado.imagens = parseJson(chamado.imagens);
        chamado.historico = parseJson(chamado.historico);

        // 2. Monta histórico
        let historicoAtual = chamado.historico;
        console.log(`[DEBUG] Histórico atual do chamado ${id}:`, historicoAtual);

        if (!Array.isArray(historicoAtual)) historicoAtual = [];

        // Se o histórico estiver vazio, adiciona a abertura como primeira entrada
        if (historicoAtual.length === 0) {
            historicoAtual.push({
                status: 'Aberto',
                observacao: 'Chamado aberto pelo solicitante',
                data: chamado.criado_em || new Date().toISOString(),
                agente: 'Sistema'
            });
        }

        const novaEntrada = {
            status: status,
            observacao: observacao || (status === 'Aberto' ? 'Chamado aberto pelo solicitante' : 'Status atualizado'),
            data: new Date().toISOString(),
            agente: 'Técnico TI'
        };

        const novoHistorico = [...historicoAtual, novaEntrada];

        // 3. Atualiza no Supabase
        const values = [status, observacao, JSON.stringify(novoHistorico), new Date()];
        const setClauses = ['status = $1', 'observacao = $2', 'historico = $3', 'atualizado_em = $4'];

        if (req.body.prioridade) {
            values.push(req.body.prioridade);
            setClauses.push(`prioridade = $${values.length}`);
        }
        if (status === 'Concluído' || status === 'Cancelado') {
            values.push(new Date());
            setClauses.push(`finalizado_em = $${values.length}`);
        }
        values.push(id);

        await pool.query(`UPDATE chamados SET ${setClauses.join(', ')} WHERE id = $${values.length}`, values);
        console.log(`[DEBUG] Chamado ${id} atualizado com sucesso. Novo histórico:`, novoHistorico.length, "itens");

        // 4. Tenta Sincronizar com o GLPI (Se for Solucionado ou Fechado)
        if (status === 'Concluído' || status === 'Cancelado') {
            sessionToken = await glpiAPI.conectar();
            if (sessionToken) {
                // Procura o chamado no GLPI pelo protocolo no título
                const searchUrl = `${glpiAPI.baseUrl}/search/Ticket?sort=2&order=DESC&range=0-50`;
                const glpiRes = await axios.get(searchUrl, {
                    headers: { 'App-Token': glpiAPI.appToken, 'Session-Token': sessionToken }
                });
                const rawGlpi = glpiRes.data.data || [];
                const ticketGlpi = rawGlpi.find(t => (t[1] || "").includes(chamado.protocolo));

                if (ticketGlpi) {
                    const glpiId = ticketGlpi[2];
                    const statusId = (status === 'Cancelado') ? 6 : 5; // 6 = Fechado, 5 = Solucionado
                    const prefixo = status.toUpperCase();

                    // Atualiza Status no GLPI
                    await axios.put(`${glpiAPI.baseUrl}/Ticket/${glpiId}`, {
                        input: { id: glpiId, status: statusId }
                    }, {
                        headers: { 'App-Token': glpiAPI.appToken, 'Session-Token': sessionToken }
                    });

                    // Adiciona acompanhamento no GLPI com o motivo
                    const conteudoGlpi = `[PORTAL - ${prefixo}] ${observacao || 'Sem observações adicionais.'}`;
                    await axios.post(`${glpiAPI.baseUrl}/ITILFollowup`, {
                        input: { items_id: glpiId, itemtype: 'Ticket', content: conteudoGlpi }
                    }, {
                        headers: { 'App-Token': glpiAPI.appToken, 'Session-Token': sessionToken }
                    });
                    console.log(`[Sincronização] Chamado ${chamado.protocolo} atualizado no GLPI.`);
                }
            }
            // NOTA: A exclusão imediata foi removida para respeitar o prazo de 2 dias.
        }

        // 5. Envia E-mail de Notificação para o Solicitante
        const getStatusColor = (s) => {
            const colors = {
                'Aberto': '#3b82f6',
                'Em Atendimento': '#a855f7',
                'Pendente': '#f59e0b',
                'Concluído': '#10b981',
                'Cancelado': '#ef4444',
                'Pendência Concluída': '#0ea5e9'
            };
            return colors[s] || '#8D3046';
        };

        const portalUrl = process.env.PUBLIC_URL || 'http://192.168.0.253:3003/';
        const mailOptions = {
            from: process.env.SMTP_FROM,
            to: chamado.email,
            subject: `Atualização de Chamado [${status}] - Protocolo #${chamado.protocolo}`,
            html: `
                <div style="font-family: sans-serif; max-width: 600px; color: #333;">
                    <h2 style="color: ${getStatusColor(status)}; border-bottom: 2px solid ${getStatusColor(status)}; pb-10px;">Atualização no seu Atendimento: ${status}</h2>
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
                    <p style="color: #d32f2f; font-weight: bold; text-align: center; font-size: 14px;">⚠️ Por favor, não responder esse e-mail.</p>
                </div>
            `
        };

        try {
            await transporter.sendMail(mailOptions);
            console.log(`[E-mail] Notificação enviada para ${chamado.email}`);
        } catch (mailError) {
            console.error(`[E-mail] Falha ao enviar notificação:`, mailError.message);
            // Não lançamos o erro aqui para não falhar a operação de salvamento que já deu certo no banco
        }

        // 6. Retorna chamado atualizado
        const { rows: updatedRows } = await pool.query('SELECT * FROM chamados WHERE id = $1', [id]);
        const updatedChamado = updatedRows[0];
        if (!updatedChamado) throw new Error("Erro ao recuperar chamado atualizado");
        updatedChamado.imagens = parseJson(updatedChamado.imagens);
        updatedChamado.historico = parseJson(updatedChamado.historico);

        res.json(updatedChamado);

    } catch (error) {
        console.error("Erro na operação:", error.message);
        res.status(500).json({ error: error.message });
    } finally {
        if (sessionToken) await glpiAPI.desconectar(sessionToken);
    }
});

// ==========================================
// TAREFA DE LIMPEZA AUTOMÁTICA (2 DIAS)
// ==========================================
setInterval(async () => {
    console.log("[Auto-Cleanup] Verificando chamados antigos...");
    try {
        const doisDiasAtras = new Date();
        doisDiasAtras.setDate(doisDiasAtras.getDate() - 2);

        await pool.query(
            'DELETE FROM chamados WHERE finalizado_em IS NOT NULL AND finalizado_em < $1',
            [doisDiasAtras]
        );
        console.log(`[Auto-Cleanup] Limpeza concluída.`);
    } catch (error) {
        console.error("[Auto-Cleanup] Erro:", error.message);
    }
}, 1000 * 60 * 60); // Roda a cada 1 hora

const PORT = process.env.PORT || process.env.PORT_INTERNO || 3002;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Painel do Agente (Standalone) rodando na porta ${PORT}`);
});
