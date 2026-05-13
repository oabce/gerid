-- ============================================================
-- Schema do Sistema de Chamados - OAB-CE
-- Banco de Dados: MariaDB 10.x ou superior
-- Execute este arquivo no banco de dados dbSistemas
-- ============================================================

CREATE TABLE IF NOT EXISTS chamados (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    protocolo       VARCHAR(20)  UNIQUE NOT NULL,
    nome            VARCHAR(255),
    cpf             VARCHAR(20),
    email           VARCHAR(255),
    telefone        VARCHAR(30),
    oab             VARCHAR(50),
    assunto         VARCHAR(500),
    descricao       TEXT,
    status          VARCHAR(50)  DEFAULT 'Aberto',
    imagens         JSON,
    historico       JSON,
    observacao      TEXT,
    resposta_usuario TEXT,
    prioridade      VARCHAR(50),
    criado_em       DATETIME,
    atualizado_em   DATETIME,
    finalizado_em   DATETIME
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS categorias (
    id    INT AUTO_INCREMENT PRIMARY KEY,
    nome  VARCHAR(255) NOT NULL,
    ativo TINYINT(1)   DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Categorias padrão
INSERT INTO categorias (nome, ativo) VALUES
    ('INSS/GERID',          1),
    ('Email profissional',  1),
    ('Computadores SAP',    1),
    ('Outros',              1);
