-- ============================================================
-- Schema do Sistema de Chamados - OAB-CE
-- Banco de Dados: Supabase (PostgreSQL)
-- Execute no SQL Editor do painel do Supabase
-- ============================================================

CREATE TABLE IF NOT EXISTS chamados (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    protocolo        VARCHAR(20)  UNIQUE NOT NULL,
    nome             VARCHAR(255),
    cpf              VARCHAR(20),
    email            VARCHAR(255),
    telefone         VARCHAR(30),
    oab              VARCHAR(50),
    assunto          VARCHAR(500),
    descricao        TEXT,
    status           VARCHAR(50)  DEFAULT 'Aberto',
    imagens          JSONB        DEFAULT '[]',
    historico        JSONB        DEFAULT '[]',
    observacao       TEXT,
    resposta_usuario TEXT,
    prioridade       VARCHAR(50),
    criado_em        TIMESTAMPTZ,
    atualizado_em    TIMESTAMPTZ,
    finalizado_em    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS categorias (
    id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nome  VARCHAR(255) NOT NULL,
    ativo BOOLEAN      DEFAULT TRUE
);

-- Categorias padrão
INSERT INTO categorias (nome, ativo) VALUES
    ('INSS/GERID',         TRUE),
    ('Email profissional', TRUE),
    ('Computadores SAP',   TRUE),
    ('Outros',             TRUE);
