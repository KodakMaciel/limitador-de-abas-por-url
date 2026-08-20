# Limitador de Abas por URL

Extensão para o Google Chrome (Manifest V3) que limita quantas abas de um
mesmo endereço podem ficar abertas ao mesmo tempo. Você cadastra um padrão de
URL com curinga (`*`) e um limite; a extensão nunca deixa esse número ser
ultrapassado.

Exemplo: cadastrar `https://portal.exemplo.com/mfa/*` com limite **3**
garante que nunca haverá mais de 3 abas desse endereço abertas ao mesmo tempo.

A extensão é 100% orientada a eventos: fica dormente quando nada acontece,
sem `setInterval`, sem `chrome.alarms`, sem nenhuma requisição de rede.

## Instalação

1. Baixe e extraia o `.zip` do projeto (ou use a pasta já extraída).
2. Abra `chrome://extensions` no Chrome.
3. Ative o **Modo do desenvolvedor** (canto superior direito).
4. Clique em **Carregar sem compactação** e selecione a pasta extraída
   (a que contém o arquivo `manifest.json`).
5. O ícone da extensão aparece na barra de ferramentas. Clique nele para
   abrir o painel de configuração.

Não é necessário nenhum cadastro, login ou conexão com a internet — tudo
roda localmente no seu navegador.

## Uso

### Cadastrar uma regra

1. Clique no ícone da extensão para abrir o popup.
2. Em **Nova regra**, digite o **padrão de URL** (veja a sintaxe abaixo) ou
   escolha uma das sugestões geradas a partir da aba que está ativa.
3. Opcionalmente dê um **nome** à regra, para identificá-la mais fácil.
4. Defina o **limite** (um número inteiro de 1 a 99) e a **ação**.
5. Clique em **Adicionar regra**.

### Editar, reordenar e remover

- **Limite** e **ação** de cada regra podem ser alterados diretamente na
  lista, com efeito imediato.
- O botão **Editar** permite alterar o padrão e o nome.
- Os botões **↑ ↓** mudam a prioridade da regra (veja "ordem das regras"
  abaixo).
- **Excluir** pede confirmação: um segundo clique remove a regra.
- A caixa **Ativa** liga e desliga a regra sem apagá-la.

### As quatro ações possíveis

| Ação | O que acontece quando o limite é atingido |
|---|---|
| **Fechar** | A aba nova é fechada e uma aba já aberta da mesma regra é focada. |
| **Fechar sozinho** | A aba nova é fechada e pronto: você continua na aba e na janela em que estava. |
| **Bloquear** | A aba fica aberta, mas mostra uma página de aviso em vez do site. |
| **Só avisar** | Nenhuma aba é fechada ou alterada; só aparece uma notificação. |

As duas primeiras fecham a aba; a diferença é só para onde você vai depois.
**Fechar sozinho** é o que você quer quando abre abas em segundo plano com
Ctrl+clique: a aba excedente simplesmente desaparece e nada tira você do lugar.
**Fechar** é mais útil quando a aba nova vem em primeiro plano, porque leva você
direto à aba que já está ocupando a vaga.

Há uma ação padrão global (escolhida no topo do popup) e cada regra pode
usar essa ação padrão ou ter a sua própria, individual.

**Importante:** a extensão nunca fecha uma aba que você já estava usando.
Se você navegar (clicar em um link, digitar um endereço) para dentro de uma
regra que já está no limite, é a sua aba que recebe a página de aviso — ela
não desaparece. Só uma aba **recém-criada** (nova aba, Ctrl+clique, etc.)
pode ser fechada pelas ações "Fechar" e "Fechar sozinho".

### Ordem das regras

As regras são avaliadas de cima para baixo e **a primeira que casar
vence** — os limites não se somam. Se você tiver uma regra específica
(`https://site.com/pasta/*`) e outra mais ampla para o mesmo domínio
(`https://site.com/*`), coloque a específica **antes** para que ela tenha
prioridade; use ↑ ↓ para isso.

### Sintaxe dos padrões

Um padrão é uma URL começando por `http://` ou `https://`, onde o caractere
`*` substitui **qualquer sequência de caracteres**, incluindo barras `/`.

| Exemplo de padrão | Casa com |
|---|---|
| `https://exemplo.com/mfa/*` | Qualquer página dentro de `/mfa/`, em qualquer profundidade |
| `https://exemplo.com/*` | Qualquer página do site inteiro |
| `https://*.exemplo.com/*` | Qualquer subdomínio de `exemplo.com` |
| `https://exemplo.com/pagina` | Só essa URL exata (sem curinga) |

Regras de comparação:

- O **esquema** (`http`/`https`) e o **host** são comparados sem diferenciar
  maiúsculas de minúsculas; o **caminho** (o que vem depois da primeira `/`)
  diferencia maiúsculas de minúsculas.
- O **fragmento** da URL (a parte depois de `#`) é ignorado na comparação.
- A **query string** (a parte depois de `?`) **faz parte** da comparação. Por
  isso um padrão sem curinga, como `https://exemplo.com/login`, não casa
  `https://exemplo.com/login?sessao=abc`. Termine o padrão com `*` quando o
  endereço puder ter parâmetros: `https://exemplo.com/login*`.
- O curinga precisa estar no **caminho** para incluir subpáginas. Um curinga
  apenas no host, como `https://*.exemplo.com/login`, ainda casa somente esse
  caminho exato — o popup avisa quando isso acontece.
- O curinga não pode vir logo depois do host, sem barra: `https://exemplo.com*`
  é recusado, porque seria ambíguo. Escreva `https://exemplo.com/*`.
- Só `http://` e `https://` são aceitos. Endereços internos do navegador
  (`chrome://`, `edge://`, `about:`, `chrome-extension://`, `file://`, etc.)
  nunca podem ser limitados.

### Contagem de abas

- A contagem soma as abas de **todas as janelas normais do seu perfil**.
  Janelas anônimas nunca são contadas nem afetadas.
- O ícone da extensão mostra `contagem/limite` (por exemplo, `3/3`) quando a
  aba ativa casa com alguma regra.
- Reiniciar o Chrome com mais abas restauradas do que o limite **não fecha
  nada automaticamente** — a extensão apenas reconta. Se preferir que o
  excesso seja tratado já na abertura, ligue **"Aplicar os limites às abas
  restauradas ao abrir o Chrome"** nas configurações do popup.

## Limitações conhecidas

- Só funciona com `http://` e `https://`; não é possível limitar páginas
  internas do navegador ou arquivos locais (`file://`).
- As regras não sincronizam entre computadores ou perfis — cada instalação
  tem seu próprio conjunto de regras, salvo localmente
  (`chrome.storage.local`).
- Não funciona em janelas anônimas: abas anônimas nunca são contadas nem
  limitadas, por design.
- O curinga (`*`) é o único operador de padrão; não há suporte a expressões
  regulares completas nem a múltiplos curingas com significados diferentes.
- A extensão não sabe distinguir uma aba de outra dentro do mesmo endereço
  além da URL — duas abas na mesma página contam como duas abas.
- Quando o endereço limitado é alcançado por **redirecionamento** (você clica
  em `/login` e o servidor manda para `/mfa/...`), as ações `Fechar` e
  `Fechar sozinho` se comportam como `Bloquear`: a aba fica aberta com a página
  de aviso em vez de ser fechada. O limite continua sendo respeitado. Isso é deliberado — no momento
  do redirecionamento a extensão não tem como saber se a aba nasceu há
  instantes ou se é uma aba que você já usava, e a regra de nunca fechar uma
  aba em uso tem precedência.
- Abas **restauradas** ao abrir o navegador e abas **duplicadas** não são
  limitadas no instante em que aparecem, justamente para que a restauração de
  sessão não feche nada. Elas passam a ser limitadas na próxima navegação.

## Estrutura do projeto

```
extensao/
├─ manifest.json              # Configuração da extensão (Manifest V3)
├─ src/
│  ├─ background.js           # Service worker: listeners e motor de enforcement
│  ├─ lib/
│  │  ├─ matcher.js           # Padrão de URL -> RegExp, validação, sugestões
│  │  ├─ storage.js           # Schema de dados, CRUD de regras, migração
│  │  └─ counter.js           # Contagem de abas por regra e badge
│  ├─ popup/                  # Interface de configuração (ícone da extensão)
│  └─ blocked/                # Página mostrada quando a ação é "Bloquear"
├─ icons/                     # Ícones da extensão (16, 32, 48, 128 px)
└─ tests/                     # Testes automatizados (páginas HTML locais)
```

## Testes

O projeto não usa npm nem nenhum framework de testes; os testes são páginas
HTML com asserções próprias, abertas diretamente no navegador:

1. Com a extensão carregada, copie o ID mostrado em `chrome://extensions`.
2. Abra `chrome-extension://<ID>/tests/matcher.test.html` — testa o
   reconhecimento de padrões de URL e a persistência das regras no storage.
3. Abra `chrome-extension://<ID>/tests/counter.test.html` — testa os
   casos-limite da contagem de abas (rajadas de abertura simultânea, ordem
   de eventos, várias janelas, regras independentes).

Ambas as páginas devem mostrar "✓ TODAS AS ASSERÇÕES VERDES" no topo.
Abrir os testes por `file://` não funciona — o Chrome bloqueia módulos ES
nesse esquema; é necessário abrir pela URL `chrome-extension://`.

## Privacidade

A extensão não faz nenhuma requisição de rede, não usa nenhum serviço
externo e não coleta nem envia dados de navegação para lugar nenhum. As
permissões solicitadas (`tabs`, `storage`, `notifications`) servem apenas
para: ler a URL das abas e contá-las, salvar as regras localmente e mostrar
os avisos de limite atingido.
