const express = require('express');
require('dotenv').config();
const nodemailer = require('nodemailer');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');
const { convert } = require('html-to-text');
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

// Gerador de Protocolo Único com retry em caso de colisão
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

// Validador de CPF (Algoritmo Oficial)
function validarCPF(cpf) {
    cpf = cpf.replace(/[^\d]+/g, '');
    if (cpf.length !== 11 || !!cpf.match(/(\d)\1{10}/)) return false;
    let cpfs = cpf.split('').map(el => +el);
    const rest = (count) => (cpfs.slice(0, count - 12).reduce((soma, el, i) => soma + el * (count - i), 0) * 10) % 11 % 10;
    return rest(10) === cpfs[9] && rest(11) === cpfs[10];
}

// Desabilita verificação SSL apenas para o GLPI (certificado interno)
// Não usar em produção com serviços externos críticos

const app = express();
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');

fs.ensureDirSync(UPLOADS_DIR);
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// CONFIGURAÇÕES (MULTER & SMTP)
// ==========================================
const TIPOS_PERMITIDOS = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
const EXTENSOES_PERMITIDAS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf'];

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + ext);
    }
});

function fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (TIPOS_PERMITIDOS.includes(file.mimetype) && EXTENSOES_PERMITIDAS.includes(ext)) {
        cb(null, true);
    } else {
        cb(new Error('Tipo de arquivo não permitido. Envie apenas imagens ou PDF.'), false);
    }
}

const upload = multer({ storage, fileFilter, limits: { fileSize: 20 * 1024 * 1024 } });


const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'cloud54.mailgrid.net.br',
    port: process.env.SMTP_PORT || 587,
    secure: false, // true para 465, false para outras portas
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    },
    tls: { rejectUnauthorized: false }
});

// ==========================================
// SERVIÇO DE INTEGRAÇÃO COM O GLPI
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
                },
                httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
            });
            return res.data.session_token;
        } catch (error) {
            console.error("[GLPI] Erro de autenticação:", error.message);
            throw new Error("Falha ao conectar no GLPI");
        }
    }

    async desconectar(sessionToken) {
        if (!sessionToken) return;
        await axios.get(`${this.baseUrl}/killSession`, {
            headers: {
                'App-Token': this.appToken,
                'Session-Token': sessionToken
            },
            httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false })
        });
    }
}
const glpiAPI = new GlpiService();

// ==========================================
// ROTAS PÚBLICAS
// ==========================================

// Criar Chamado no GLPI (Via E-mail para o Coletor)
app.post('/api/chamados', upload.array('imagens', 4), async (req, res) => {
    try {
        const { nome, cpf, email, telefone, oab, assunto, categoria, descricao, numero } = req.body;

        // Limpa o CPF para salvar apenas números no banco
        const cpfLimpo = cpf ? cpf.replace(/\D/g, '') : null;
        const oabForm = numero; // Mapeia o campo 'numero' do form para a variavel 'oab'
        const arquivos = req.files || [];
        const protocolo = await gerarProtocoloUnico();

        console.log(`[Portal Externo] Criando chamado. Protocolo: ${protocolo}`);

        // Validador de e-mail de teste (melhorado para não bloquear oabce)
        const parteInicial = email.split('@')[0].toLowerCase();
        const listaBloqueada = ['teste', 'test', 'asdf', '123456', 'abcde'];
        if (listaBloqueada.includes(parteInicial)) {
            return res.status(400).json({ error: 'Por favor, informe um e-mail válido e evite endereços de teste.' });
        }

        // Validador de CPF Real
        if (!cpf || !validarCPF(cpf)) {
            return res.status(400).json({ error: 'O CPF informado é inválido. Por favor, confira os números.' });
        }

        // 1. Gerar Links das Imagens
        const baseUrl = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
        const imageURLs = arquivos.map(file => `${baseUrl}/uploads/${path.basename(file.path)}`);

        // 2. SALVAR NO SUPABASE
        await pool.query(
            `INSERT INTO chamados (protocolo, nome, cpf, email, telefone, oab, assunto, descricao, status, imagens, criado_em)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [protocolo, nome, cpfLimpo, email, telefone, oab || '---', assunto, descricao, 'Aberto',
             JSON.stringify(imageURLs), new Date()]
        );

        const anexosFormatados = arquivos.map(file => ({
            filename: file.originalname,
            path: file.path
        }));

        // 3. ENVIAR E-MAIL DE AVISO (Para o suporte/você)
        const isGerid = assunto.toLowerCase().includes('gerid');

        const templateGerid = `
            <div style="font-family: sans-serif; max-width: 600px; color: #333;">
                <p><strong>Dados para inserir no chamado do INSS</strong></p>
                <br>
                <p><strong>Nome:</strong> ${nome}</p>
                <p><strong>OAB:</strong> ${oab || 'Não informado'}</p>
                <p><strong>CPF:</strong> ${cpf}</p>
                <p><strong>E-MAIL:</strong> ${email}</p>
                <p><strong>Telefone:</strong> ${telefone}</p>
                <br>
                <p><strong>Descrição:</strong></p>
                <p>${descricao}</p>
                <br>
                <hr>
                <p>Ordem dos Advogados do Brasil - Secção Ceará</p>
                <p>07375512000181</p>
                <p>Protocolo: ${protocolo}</p>
                <p>Link do Portal: <a href="http://localhost:3000">Acessar Portal</a></p>
            </div>
        `;

        const templatePadrao = `
            <div style="font-family: sans-serif; max-width: 600px; color: #333;">
                <p><strong>Novo chamado recebido via Portal</strong></p>
                <br>
                <p><strong>Nome:</strong> ${nome}</p>
                <p><strong>OAB:</strong> ${oab || 'Não informado'}</p>
                <p><strong>CPF:</strong> ${cpf}</p>
                <p><strong>E-MAIL:</strong> ${email}</p>
                <p><strong>Telefone:</strong> ${telefone}</p>
                <br>
                <p><strong>Assunto:</strong> ${assunto}</p>
                <p><strong>Descrição:</strong></p>
                <p>${descricao}</p>
                <hr>
                <p>Protocolo: ${protocolo}</p>
                <p>Link do Portal: <a href="http://localhost:3000">Acessar Portal</a></p>
            </div>
        `;

        const mailOptions = {
            from: process.env.SMTP_FROM,
            to: process.env.SMTP_TO,
            subject: `NOVO CHAMADO - PROTOCOLO #${protocolo} - ${assunto}`,
            html: isGerid ? templateGerid : templatePadrao,
            attachments: anexosFormatados
        };
        await transporter.sendMail(mailOptions);

        // 4. ENVIAR E-MAIL DE CONFIRMAÇÃO PARA O USUÁRIO (SOLICITANTE)
        const portalUrl = process.env.PUBLIC_URL || 'http://192.168.0.253:3003/';
        const userMailOptions = {
            from: process.env.SMTP_FROM,
            to: email,
            subject: `Confirmação de Abertura de Chamado - Protocolo #${protocolo}`,
            html: `
                <div style="font-family: sans-serif; max-width: 600px; color: #333;">
                    <h2 style="color: #3b82f6; border-bottom: 2px solid #3b82f6; pb-10px;">Recebemos sua solicitação!</h2>
                    <p>Olá <strong>${nome}</strong>,</p>
                    <p>Seu chamado foi registrado com sucesso em nosso sistema.</p>
                    <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                    <p><strong>Protocolo:</strong> <span style="font-size: 1.2em; font-weight: bold; color: #3b82f6;">${protocolo}</span></p>
                    <p><strong>Assunto:</strong> ${assunto}</p>
                    <p><strong>Status Inicial:</strong> <span style="color: #3b82f6; font-weight: bold;">Aberto</span></p>
                    <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                    <p>Você pode acompanhar o status do seu atendimento através do nosso portal:</p>
                    <p><a href="${portalUrl}" style="display: inline-block; padding: 12px 24px; background-color: #3b82f6; color: white; text-decoration: none; border-radius: 8px; font-weight: bold;">Acompanhar Status</a></p>
                    <br>
                    <p style="font-size: 11px; color: #777;">Atenciosamente,<br>Equipe de Tecnologia OAB-CE</p>
                    <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                    <p style="color: #d32f2f; font-weight: bold; text-align: center; font-size: 14px;">⚠️ Por favor, não responder esse e-mail.</p>
                </div>
            `
        };

        try {
            await transporter.sendMail(userMailOptions);
        } catch (err) {
            console.error(`[E-mail] Erro ao enviar confirmação para o usuário:`, err.message);
        }

        res.status(201).json({
            message: 'Sua solicitação foi enviada com sucesso! Você receberá uma confirmação por e-mail em breve.',
            protocolo: 'Enviado por e-mail'
        });

    } catch (error) {
        console.error("Erro ao processar solicitação:", error);
        res.status(500).json({ error: 'Erro ao enviar sua solicitação. Tente novamente mais tarde.' });
    }
});

// Listar Categorias
app.get('/api/public/categorias', async (req, res) => {
    try {
        const { rows: data } = await pool.query('SELECT * FROM categorias WHERE ativo = true ORDER BY nome ASC');
        res.json(data || []);
    } catch (error) {
        console.error("Erro ao carregar categorias:", error.message);
        res.status(500).json({ error: 'Erro ao carregar categorias' });
    }
});

// Consultar Chamado (Por Protocolo ou CPF)
app.get('/api/public/chamados/:id', async (req, res) => {
    try {
        const { id } = req.params;

        // Busca flexível: tenta encontrar pelo CPF limpo (apenas números) ou pelo valor original formatado
        const cleanCPF = id.replace(/\D/g, '');
        const { rows: chamados } = await pool.query(
            'SELECT * FROM chamados WHERE cpf = $1 OR cpf = $2 ORDER BY criado_em DESC',
            [cleanCPF, id]
        );

        chamados.forEach(c => {
            c.imagens = parseJson(c.imagens);
            c.historico = parseJson(c.historico);
        });

        if (!chamados || chamados.length === 0) {
            return res.status(404).json({ error: 'Nenhum chamado encontrado para este CPF.' });
        }

        // Formata os dados para o frontend (incluindo um histórico básico baseado no status atual)
        const formatados = chamados.map(c => {
            let obsHistorico = c.observacao || 'Seu chamado está sendo processado.';

            // Se for pendência concluída, mostra uma mensagem padrão no público
            if (c.status === 'Pendência Concluída') {
                obsHistorico = 'Informações recebidas. Aguardando análise do suporte.';
            }

            return {
                id: c.id,
                protocolo: c.protocolo,
                nome: c.nome,
                cpf: c.cpf,
                email: c.email,
                telefone: c.telefone,
                assunto: c.assunto,
                descricao: c.descricao,
                status: c.status || 'Novo',
                data: c.criado_em,
                historico: [
                    {
                        status: 'Aberto',
                        data: c.criado_em,
                        observacao: 'Chamado recebido pelo portal.'
                    },
                    ...(c.status !== 'Novo' ? [{
                        status: c.status,
                        data: new Date().toISOString(),
                        observacao: obsHistorico
                    }] : [])
                ]
            };
        });

        res.status(200).json(formatados);

    } catch (error) {
        console.error("Erro ao consultar:", error.message);
        res.status(500).json({ error: 'Erro ao consultar chamado' });
    }
});

// Resolver Pendência (Pelo Usuário)
app.patch('/api/public/chamados/:id/resolver', upload.array('imagens', 4), async (req, res) => {
    try {
        const { id } = req.params;
        const { nome, cpf, email, telefone, assunto, descricao, nova_observacao } = req.body;
        const arquivos = req.files || [];

        console.log(`[Portal Externo] Usuário resolvendo pendência no chamado: ${id}`);

        // 1. Gerar Links das Novas Imagens
        const baseUrl = process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
        const novasImagens = arquivos.map(file => `${baseUrl}/uploads/${path.basename(file.path)}`);

        // 2. Busca imagens atuais para não sobrescrever (Merge)
        const { rows } = await pool.query('SELECT imagens, protocolo FROM chamados WHERE id = $1', [id]);
        const chamadoAtual = rows[0];
        if (!chamadoAtual) {
            return res.status(404).json({ error: 'Chamado não encontrado.' });
        }
        const protocoloOriginal = chamadoAtual.protocolo;

        const imagensAtuais = parseJson(chamadoAtual?.imagens);
        const imagensAtualizadas = [...imagensAtuais, ...novasImagens];

        // 3. Atualiza no Supabase
        await pool.query(
            `UPDATE chamados SET nome=$1, cpf=$2, email=$3, telefone=$4, assunto=$5, descricao=$6,
             status=$7, resposta_usuario=$8, imagens=$9 WHERE id=$10`,
            [nome, cpf, email, telefone, assunto, descricao, 'Pendência Concluída',
             nova_observacao || null, JSON.stringify(imagensAtualizadas), id]
        );

        // 4. Envia E-mail de Aviso para o Suporte
        const mailOptions = {
            from: process.env.SMTP_FROM,
            to: process.env.SMTP_TO,
            subject: `PENDÊNCIA RESOLVIDA - ${assunto}`,
            html: `
                <div style="font-family: sans-serif; max-width: 600px; color: #333;">
                    <h2 style="color: #D97706;">Pendência Resolvida pelo Usuário</h2>
                    <p>O usuário <strong>${nome}</strong> atualizou as informações do chamado.</p>
                    <hr>
                    <p><strong>Observação do Usuário:</strong> ${nova_observacao || 'Nenhuma observação enviada.'}</p>
                    <hr>
                    <p>Verifique o painel do agente para processar o atendimento.</p>
                </div>
            `,
            attachments: arquivos.map(f => ({ filename: f.originalname, path: f.path }))
        };

        await transporter.sendMail(mailOptions);

        // 5. ENVIA E-MAIL DE CONFIRMAÇÃO PARA O USUÁRIO
        const portalUrl = process.env.PUBLIC_URL || 'http://192.168.0.253:3003/';
        const userMailOptions = {
            from: process.env.SMTP_FROM,
            to: email,
            subject: `Pendência Recebida - Protocolo #${protocoloOriginal}`,
            html: `
                <div style="font-family: sans-serif; max-width: 600px; color: #333;">
                    <h2 style="color: #10b981; border-bottom: 2px solid #10b981; pb-10px;">Informações Recebidas: Pendência Concluída</h2>
                    <p>Olá <strong>${nome}</strong>,</p>
                    <p>Recebemos as informações complementares para o seu chamado.</p>
                    <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                    <p><strong>Novo Status:</strong> <span style="color: #10b981; font-weight: bold;">Pendência Concluída</span></p>
                    <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                    <p>Nossa equipe foi notificada e em breve você receberá uma nova atualização sobre o seu atendimento.</p>
                    <p>Você pode continuar acompanhando pelo portal:</p>
                    <p><a href="${portalUrl}" style="display: inline-block; padding: 12px 24px; background-color: #10b981; color: white; text-decoration: none; border-radius: 8px; font-weight: bold;">Acompanhar Status</a></p>
                    <br>
                    <p style="font-size: 11px; color: #777;">Atenciosamente,<br>Equipe de Tecnologia OAB-CE</p>
                    <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                    <p style="color: #d32f2f; font-weight: bold; text-align: center; font-size: 14px;">⚠️ Por favor, não responder esse e-mail.</p>
                </div>
            `
        };

        await transporter.sendMail(userMailOptions);
        console.log(`[Notificação] Confirmação de pendência enviada para ${email}`);

        res.json({ success: true, message: 'Pendência enviada com sucesso!' });

    } catch (error) {
        console.error("Erro ao resolver pendência:", error.message);
        res.status(500).json({ error: 'Erro ao processar sua resolução.' });
    }
});

// Inicialização do Servidor
const PORT = process.env.PORT_PUBLICO || 3000;

async function iniciarServidor() {
    try {
        const tokenTeste = await glpiAPI.conectar();
        if (tokenTeste) {
            console.log('✅ Integração GLPI (Público): Ativa!');
            await glpiAPI.desconectar(tokenTeste);
        }
    } catch (error) {
        console.error('❌ Erro na integração GLPI:', error.message);
    }

    app.listen(PORT, () => {
        console.log(`🚀 Portal Público rodando na porta ${PORT}`);
    });
}

iniciarServidor();
