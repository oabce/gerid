# Sistema de Chamados — OAB-CE

Portal de abertura e gerenciamento de chamados de suporte técnico.

## Estrutura do Projeto

```
sistema-chamados/
├── portal-externo/   # Portal público (abertura e consulta de chamados)
├── portal-interno/   # Painel do agente (gerenciamento de chamados)
└── schema.sql        # Script de criação do banco de dados
```

---

## Pré-requisitos

- **Node.js** 18 ou superior
- **MariaDB** 10.5 ou superior (ou MySQL 8.0+)
- **Docker** (opcional, se for rodar via container)

---

## 1. Configuração do Banco de Dados

### 1.1 Criar o banco e o usuário

Acesse o MariaDB como root e execute:

```sql
CREATE DATABASE IF NOT EXISTS dbSistemas
    CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'dbAgente'@'%' IDENTIFIED BY 'SUA_SENHA_AQUI';

GRANT ALL PRIVILEGES ON dbSistemas.* TO 'dbAgente'@'%';

FLUSH PRIVILEGES;
```

> **Nota:** Substitua `SUA_SENHA_AQUI` por uma senha segura.  
> O `'%'` permite conexão de qualquer host. Se o Node.js rodar na mesma máquina, use `'localhost'` no lugar de `'%'`.

### 1.2 Criar as tabelas e categorias iniciais

Com o banco criado, execute o arquivo `schema.sql`:

**Via terminal:**
```bash
mysql -u root -p dbSistemas < schema.sql
```

**Via Webmin (MariaDB):**
1. Acesse **Servidor de banco de dados MariaDB**
2. Clique em **dbSistemas**
3. Clique em **Executar SQL**
4. Cole o conteúdo do arquivo `schema.sql` e execute

**Via MySQL Workbench ou DBeaver:**
1. Conecte ao servidor MariaDB
2. Selecione o banco `dbSistemas`
3. Abra e execute o arquivo `schema.sql`

### 1.3 Verificar a criação

```sql
USE dbSistemas;
SHOW TABLES;
SELECT * FROM categorias;
```

Resultado esperado:

```
+------------+
| Tables     |
+------------+
| categorias |
| chamados   |
+------------+

+----+---------------------+-------+
| id | nome                | ativo |
+----+---------------------+-------+
|  1 | INSS/GERID          |     1 |
|  2 | Email profissional  |     1 |
|  3 | Computadores SAP    |     1 |
|  4 | Outros              |     1 |
+----+---------------------+-------+
```

---

## 2. Configuração das Variáveis de Ambiente

Cada portal tem seu próprio arquivo `.env`. Copie os exemplos abaixo e preencha com os valores do seu ambiente.

### portal-externo/.env

```env
# Banco de Dados
DB_HOST=localhost          # IP do servidor MariaDB (172.17.0.1 se rodar via Docker)
DB_USER=dbAgente
DB_PASS=SUA_SENHA_AQUI
DB_NAME=dbSistemas
DB_PORT=3306

# SMTP (envio de e-mails)
SMTP_HOST=seu.servidor.smtp.com
SMTP_PORT=587
SMTP_USER=seu@email.com
SMTP_FROM=seu@email.com
SMTP_PASS=SUA_SENHA_SMTP
SMTP_TO=destino@email.com  # E-mail que recebe os chamados novos

# GLPI (integração opcional)
GLPI_URL=https://seu-glpi.com/apirest.php
GLPI_APP_TOKEN=SEU_APP_TOKEN
GLPI_USER_TOKEN=SEU_USER_TOKEN

# URL pública do portal (usada nos links dos e-mails e nas imagens)
PUBLIC_URL=https://seu-dominio.com/gerid

# Porta do servidor
PORT_PUBLICO=3003
```

### portal-interno/.env

```env
# Banco de Dados
DB_HOST=localhost          # IP do servidor MariaDB (172.17.0.1 se rodar via Docker)
DB_USER=dbAgente
DB_PASS=SUA_SENHA_AQUI
DB_NAME=dbSistemas
DB_PORT=3306

# SMTP (envio de e-mails)
SMTP_HOST=seu.servidor.smtp.com
SMTP_PORT=587
SMTP_USER=seu@email.com
SMTP_FROM=seu@email.com
SMTP_PASS=SUA_SENHA_SMTP
SMTP_TO=destino@email.com

# GLPI (integração opcional)
GLPI_URL=https://seu-glpi.com/apirest.php
GLPI_APP_TOKEN=SEU_APP_TOKEN
GLPI_USER_TOKEN=SEU_USER_TOKEN

# Credenciais do painel do agente
AGENT_USER=adm
AGENT_PASS=SENHA_SEGURA_AQUI

# URL pública do portal externo (usada nos links dos e-mails)
PUBLIC_URL=https://seu-dominio.com/gerid

# CORS — origem permitida para acessar a API do painel interno
ALLOWED_ORIGIN=https://seu-dominio.com

# Porta do servidor
PORT_INTERNO=3002
```

---

## 3. Instalação das Dependências

```bash
# Portal Externo
cd portal-externo
npm install

# Portal Interno
cd ../portal-interno
npm install
```

---

## 4. Executar Localmente

```bash
# Portal Externo (porta 3003)
cd portal-externo
npm start

# Portal Interno (porta 3002) — em outro terminal
cd portal-interno
npm start
```

---

## 5. Executar via Docker

Cada portal tem seu próprio `Dockerfile`. Para subir ambos:

```bash
docker-compose up -d
```

> **Atenção:** Se o MariaDB estiver instalado no host (fora do Docker), defina  
> `DB_HOST=172.17.0.1` nos arquivos `.env` (gateway padrão do Docker no Linux).  
> Certifique-se também de que o MariaDB está configurado para aceitar conexões  
> externas (`bind-address = 0.0.0.0` em `/etc/mysql/mariadb.conf.d/50-server.cnf`).

---

## 6. Configuração do Nginx (Proxy Reverso)

Se for usar Nginx para expor os portais num único domínio:

```nginx
# Portal Interno (Agente) — acessível em /agente/
location /agente/ {
    proxy_pass http://127.0.0.1:3002/;
    include proxy_params;
}

# Portal Externo (Público) — acessível em /gerid/
location /gerid/ {
    proxy_pass http://127.0.0.1:3003/;
    include proxy_params;
}
```

Após editar, recarregue o Nginx:

```bash
nginx -t && systemctl reload nginx
```

---

## 7. Primeiro Acesso

| Portal | URL | Acesso |
|---|---|---|
| Público (abertura de chamados) | `https://seu-dominio.com/gerid/` | Aberto ao público |
| Agente (painel interno) | `https://seu-dominio.com/agente/` | Usuário e senha do `.env` |

As credenciais iniciais do painel do agente são as definidas em `AGENT_USER` e `AGENT_PASS` no `.env` do portal-interno.

---

## 8. Adicionar ou Editar Categorias

As categorias são gerenciadas diretamente no banco de dados:

```sql
-- Adicionar categoria
INSERT INTO categorias (nome, ativo) VALUES ('Nova Categoria', 1);

-- Desativar categoria (sem deletar)
UPDATE categorias SET ativo = 0 WHERE nome = 'Nome da Categoria';

-- Listar todas
SELECT * FROM categorias;
```

---

## Tecnologias

- **Backend:** Node.js + Express
- **Banco de dados:** MariaDB / MySQL
- **Frontend:** HTML + Tailwind CSS
- **E-mail:** Nodemailer (SMTP)
- **Uploads:** Multer (imagens e PDF)
- **Integração:** GLPI REST API
